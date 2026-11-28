import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { secretBinding } from './storage.mjs';

export const MEMORY_LIMITS = Object.freeze({
  profiles: 40, messagesPerProfile: 200, charsPerProfile: 512 * 1024,
  totalChars: 2 * 1024 * 1024, contextMessages: 20, contextChars: 32 * 1024,
  fileBytes: 16 * 1024 * 1024
});
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const cleanContent = value => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const characterCount = messages => messages.reduce((total, message) => total + message.content.length, 0);
const cancelled = () => new DOMException('Conversation save cancelled.', 'AbortError');

// The encrypted record includes its destination and credential identity, never an API key.
export function conversationBinding(connection, credentialFingerprint = '') {
  return createHash('sha256').update(JSON.stringify([
    secretBinding(connection), connection.model || '', connection.anthropicVersion || '', credentialFingerprint
  ])).digest('hex');
}

// Keep complete text turns. Images, audio, tool data, and system messages have no storage shape.
export function boundedHistory(messages, { maxMessages = MEMORY_LIMITS.messagesPerProfile, maxChars = MEMORY_LIMITS.charsPerProfile } = {}) {
  if (!Array.isArray(messages)) return [];
  const turns = [];
  for (let index = 0; index < messages.length - 1; index += 1) {
    const user = messages[index], assistant = messages[index + 1];
    if (user?.role !== 'user' || assistant?.role !== 'assistant' ||
        typeof user.content !== 'string' || typeof assistant.content !== 'string') continue;
    const turn = [{ role: 'user', content: cleanContent(user.content) }, { role: 'assistant', content: cleanContent(assistant.content) }];
    if (turn.every(message => message.content.trim())) turns.push(turn);
    index += 1;
  }
  const kept = [];
  let chars = 0;
  for (let index = turns.length - 1; index >= 0 && kept.length + 2 <= maxMessages; index -= 1) {
    const turn = turns[index], size = characterCount(turn);
    if (chars + size > maxChars) break;
    kept.unshift(...turn); chars += size;
  }
  return kept;
}

export function conversationContext(history, message) {
  const user = { role: 'user', content: message };
  return [...boundedHistory(history, {
    maxMessages: MEMORY_LIMITS.contextMessages,
    maxChars: Math.max(0, MEMORY_LIMITS.contextChars - message.length)
  }), user];
}

function boundedEntries(entries) {
  const next = new Map();
  for (const [id, entry] of entries) {
    const messages = boundedHistory(entry.messages);
    if (messages.length) next.set(id, { binding: entry.binding, messages });
  }
  let chars = [...next.values()].reduce((total, entry) => total + characterCount(entry.messages), 0);
  while (next.size > MEMORY_LIMITS.profiles || chars > MEMORY_LIMITS.totalChars) {
    const [id, entry] = next.entries().next().value;
    chars -= characterCount(entry.messages); next.delete(id);
  }
  return next;
}

export class ConversationStore {
  constructor(directory, codec) {
    this.file = path.join(directory, 'conversations.enc.json');
    this.codec = codec;
    this.entries = new Map();
    this.queue = Promise.resolve();
    this.revision = 0;
    this.profileRevisions = new Map();
    this.enabled = true;
    this.blocked = false;
    this.raw = null;
    this.status = { memoryAvailable: false, memoryMessage: 'Encrypted conversation memory has not been checked.' };
  }
  getStatus() { return { ...this.status }; }
  setStatus(available, message) { this.status = { memoryAvailable: available, memoryMessage: message }; }
  readyMessage() { return 'Text conversations are saved with Windows protection, separately for each AI profile.'; }
  disabledMessage() { return 'Saved conversation memory is off. New chats stay in this session only.'; }
  serial(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
  async checkProtection() {
    try {
      if (!this.codec || typeof this.codec.encrypt !== 'function' || typeof this.codec.decrypt !== 'function') throw new Error();
      if (typeof this.codec.isAvailable === 'function') {
        if (!await this.codec.isAvailable()) throw new Error();
      } else await this.codec.encrypt('conversation-memory-protection-check');
      this.setStatus(true, this.readyMessage());
      return true;
    } catch {
      this.blocked = true;
      this.setStatus(false, 'Saved conversation memory is unavailable because Windows protection could not be used. Chats stay in this session.');
      return false;
    }
  }
  async eraseFiles() {
    await fs.rm(this.file, { force: true });
    await fs.rm(this.file + '.tmp', { force: true });
    this.raw = null;
  }
  async load(bindings, { enabled = true } = {}) {
    this.enabled = enabled === true;
    this.revision += 1;
    return this.serial(async () => {
      this.entries.clear(); this.raw = null; this.blocked = false;
      if (!this.enabled) {
        try { await this.eraseFiles(); this.setStatus(true, this.disabledMessage()); }
        catch { this.blocked = true; this.setStatus(false, 'Memory is off, but saved conversations could not be erased. Check access to the app data folder and use Clear all memory again.'); }
        return new Map();
      }
      if (!await this.checkProtection()) return new Map();
      try {
        const stat = await fs.stat(this.file);
        if (stat.size > MEMORY_LIMITS.fileBytes) throw new Error();
        const raw = await fs.readFile(this.file, 'utf8');
        const envelope = JSON.parse(raw);
        if (envelope?.version !== 1 || typeof envelope.encrypted !== 'string' || !envelope.encrypted ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(envelope.encrypted)) throw new Error();
        const decoded = await this.codec.decrypt(Buffer.from(envelope.encrypted, 'base64'));
        const payload = JSON.parse(decoded);
        if (payload?.version !== 1 || !Array.isArray(payload.profiles) || payload.profiles.length > MEMORY_LIMITS.profiles) throw new Error();
        const expected = new Map(bindings.map(({ id, binding }) => [id, binding]));
        const seen = new Set();
        for (const entry of payload.profiles) {
          if (!validId(entry?.id) || seen.has(entry.id) || typeof entry.binding !== 'string' || !/^[a-f0-9]{64}$/.test(entry.binding) ||
              !Array.isArray(entry.messages) || entry.messages.length > MEMORY_LIMITS.messagesPerProfile ||
              entry.messages.some(message => !['user', 'assistant'].includes(message?.role) || typeof message.content !== 'string')) throw new Error();
          seen.add(entry.id);
          if (expected.get(entry.id) === entry.binding) this.entries.set(entry.id, { binding: entry.binding, messages: boundedHistory(entry.messages) });
        }
        this.raw = raw;
        this.entries = boundedEntries(this.entries);
        // Removed profiles and changed authentication/model destinations cannot return after restart.
        const reconciled = JSON.stringify(this.payload(this.entries));
        if (reconciled !== JSON.stringify(payload)) await this.writeEntries(this.entries);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.entries.clear(); this.blocked = true;
          this.setStatus(false, 'Saved conversations could not be unlocked or read. Chats stay in this session. Use Clear all memory to reset the saved file.');
        }
      }
      return new Map([...this.entries].map(([id, entry]) => [id, structuredClone(entry.messages)]));
    });
  }
  payload(entries) { return { version: 1, profiles: [...entries].map(([id, entry]) => ({ id, ...entry })) }; }
  async restoreRaw(raw) {
    if (raw === null) { await this.eraseFiles(); return; }
    await fs.writeFile(this.file + '.tmp', raw, { mode: 0o600 });
    await fs.rename(this.file + '.tmp', this.file);
  }
  async writeEntries(entries, assertActive = () => {}) {
    assertActive();
    const previousRaw = this.raw;
    let renamed = false;
    try {
      if (!entries.size) {
        await this.eraseFiles();
        try { assertActive(); }
        catch (error) { await this.restoreRaw(previousRaw); this.raw = previousRaw; throw error; }
        this.entries = entries;
        return;
      }
      const encrypted = await this.codec.encrypt(JSON.stringify(this.payload(entries)));
      assertActive();
      const raw = JSON.stringify({ version: 1, encrypted: Buffer.from(encrypted).toString('base64') });
      if (Buffer.byteLength(raw, 'utf8') > MEMORY_LIMITS.fileBytes) throw new Error('Memory size limit exceeded.');
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      assertActive();
      await fs.writeFile(this.file + '.tmp', raw, { mode: 0o600 });
      assertActive();
      await fs.rename(this.file + '.tmp', this.file); renamed = true;
      assertActive();
      this.entries = entries; this.raw = raw;
    } catch (error) {
      if (renamed) {
        try { await this.restoreRaw(previousRaw); }
        catch { this.blocked = true; this.setStatus(false, 'A conversation save could not be cancelled on disk. Use Clear all memory and check access to the app data folder.'); }
      }
      throw error;
    } finally { await fs.rm(this.file + '.tmp', { force: true }).catch(() => {}); }
  }
  save(id, binding, messages, { signal } = {}) {
    if (!validId(id) || typeof binding !== 'string' || !/^[a-f0-9]{64}$/.test(binding)) throw new Error('Invalid conversation destination.');
    const snapshot = boundedHistory(messages);
    const revision = this.revision, profileRevision = this.profileRevisions.get(id) || 0;
    const assertActive = () => {
      if (signal?.aborted || revision !== this.revision || profileRevision !== (this.profileRevisions.get(id) || 0) || !this.enabled) throw cancelled();
    };
    return this.serial(async () => {
      assertActive();
      if (this.blocked) return false;
      const next = new Map(this.entries);
      next.delete(id);
      if (snapshot.length) next.set(id, { binding, messages: snapshot });
      try {
        await this.writeEntries(boundedEntries(next), assertActive);
        this.setStatus(true, this.readyMessage());
        return true;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        this.blocked = true;
        this.setStatus(false, 'The conversation could not be saved securely. Chats stay in this session. Check access to the app data folder; Clear all memory can reset the saved file.');
        return false;
      }
    });
  }
  remove(id) {
    this.profileRevisions.set(id, (this.profileRevisions.get(id) || 0) + 1);
    return this.serial(async () => {
      if (this.blocked) {
        try { await fs.access(this.file); }
        catch (error) {
          if (error.code === 'ENOENT') { this.entries.delete(id); return true; }
        }
        this.setStatus(false, 'This conversation could not be erased from the unavailable saved file. Use Clear all memory to delete the whole file.');
        return false;
      }
      const next = new Map(this.entries); next.delete(id);
      try {
        await this.writeEntries(next);
        this.setStatus(true, this.enabled ? this.readyMessage() : this.disabledMessage());
        return true;
      } catch {
        this.blocked = true;
        this.setStatus(false, 'The saved conversation could not be erased. Check access to the app data folder and try Clear all memory.');
        return false;
      }
    });
  }
  clear() {
    this.revision += 1;
    return this.serial(async () => {
      this.entries.clear();
      try {
        await this.eraseFiles(); this.blocked = false;
        if (this.enabled) await this.checkProtection();
        else this.setStatus(true, this.disabledMessage());
        return true;
      } catch {
        this.blocked = true;
        this.setStatus(false, 'Saved conversations could not be erased. Check access to the app data folder and use Clear all memory again.');
        return false;
      }
    });
  }
  setEnabled(enabled) {
    this.enabled = enabled === true;
    // A change in retention never backfills messages sent while saving was off.
    return this.clear();
  }
}
