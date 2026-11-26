import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeConfig } from './config.mjs';

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('A settings file could not be read. Keep a backup before resetting the app data.'); }
}
async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

export class SettingsStore {
  constructor(directory) { this.file = path.join(directory, 'settings.json'); }
  async load() { return sanitizeConfig(await readJson(this.file, {})); }
  async save(config) { await atomicJson(this.file, sanitizeConfig(config)); }
}

export function secretBinding(connection) {
  return connection.provider + '\n' + new URL(connection.baseUrl).href.replace(/\/$/, '') + '\n' + (connection.workspaceId || '');
}

export class SecretStore {
  constructor(directory, codec) { this.file = path.join(directory, 'credentials.enc.json'); this.codec = codec; this.entries = {}; }
  async load() {
    const entries = await readJson(this.file, {});
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('The credential store is not valid.');
    this.entries = entries;
  }
  has(connection) {
    const entry = this.entries[connection.id];
    return !!entry && entry.binding === secretBinding(connection) && typeof entry.encrypted === 'string';
  }
  async put(connection, key) {
    if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[\r\n\u0000]/.test(key)) throw new Error('Enter a valid API key.');
    const encrypted = await this.codec.encrypt(key.trim());
    const next = { ...this.entries, [connection.id]: { binding: secretBinding(connection), encrypted: Buffer.from(encrypted).toString('base64') } };
    await atomicJson(this.file, next);
    this.entries = next;
  }
  async get(connection) {
    if (!this.has(connection)) return '';
    try { return await this.codec.decrypt(Buffer.from(this.entries[connection.id].encrypted, 'base64')); }
    catch { throw new Error('The saved key could not be unlocked. Enter it again in AI connections.'); }
  }
  async remove(id) {
    const next = { ...this.entries }; delete next[id];
    await atomicJson(this.file, next); this.entries = next;
  }
}

export function electronSecretCodec(safeStorage, platform = process.platform) {
  async function ready() {
    if (platform !== 'win32') throw new Error('Saving API keys in this prototype requires Windows protection.');
    const available = typeof safeStorage.isAsyncEncryptionAvailable === 'function'
      ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
    if (!available) throw new Error('Windows key protection is unavailable. The key was not saved.');
  }
  return {
    async encrypt(key) {
      await ready();
      return typeof safeStorage.encryptStringAsync === 'function' ? await safeStorage.encryptStringAsync(key) : safeStorage.encryptString(key);
    },
    async decrypt(buffer) {
      await ready();
      if (typeof safeStorage.decryptStringAsync === 'function') {
        const result = await safeStorage.decryptStringAsync(buffer);
        return typeof result === 'string' ? result : result.result;
      }
      return safeStorage.decryptString(buffer);
    }
  };
}
