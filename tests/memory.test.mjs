import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DEFAULT_CONFIG, sanitizeRule } from '../src/core/config.mjs';
import { SettingsStore, SecretStore } from '../src/core/storage.mjs';
import { ConversationStore, MEMORY_LIMITS, conversationBinding } from '../src/core/memory.mjs';
import { CompanionApplication } from '../src/core/application.mjs';

const connection = { id: 'profile-a', name: 'Local A', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'model-a', supportsVision: true, workspaceId: '', anthropicVersion: '' };
const other = { ...connection, id: 'profile-b', name: 'Local B', model: 'model-b' };
const target = { handle: '1234', pid: 99, exePath: 'C:\\Apps\\Personal.exe', title: 'Disposable notes', bounds: { x: 20, y: 40, width: 600, height: 400 }, minimized: false };
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const absent = file => assert.rejects(fs.access(file), { code: 'ENOENT' });

function encryptedCodec() {
  const key = randomBytes(32);
  return {
    async isAvailable() { return true; },
    async encrypt(plain) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    async decrypt(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }
  };
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-memory-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const codec = encryptedCodec();
  const config = clone(DEFAULT_CONFIG);
  config.connections = [clone(connection), clone(other)]; config.activeConnectionId = connection.id;
  config.memory = { enabled: true };
  config.privacy.seeWindowContents = true;
  config.privacy.rules = [sanitizeRule({ ...target, vision: true })];
  await new SettingsStore(directory).save(config);
  const start = async (overrides = {}) => {
    const requests = [], events = [];
    const memory = new ConversationStore(directory, overrides.memoryCodec || codec);
    const secrets = new SecretStore(directory, codec);
    const providers = {
      PROVIDER_PRESETS: [{ id: 'ollama', label: 'Ollama', baseUrl: connection.baseUrl }, { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.example.test/v1' }],
      validateConnection(value) { return { ...value, baseUrl: value.baseUrl.replace(/\/$/, '') }; },
      async generateReply(value, options) {
        requests.push({ id: value.id, messages: clone(options.messages), image: options.image });
        return overrides.generateReply ? overrides.generateReply(value, options) : 'Reply for ' + options.messages.at(-1).content;
      }
    };
    const native = { async inspectWindow() { return clone(target); }, async captureWindow() { return { mimeType: 'image/png', base64: 'PRIVATE_IMAGE_BYTES' }; }, cancelPending() {}, dispose() {} };
    const app = new CompanionApplication({ settings: new SettingsStore(directory), secrets, memory, providers, native, platform: 'win32', ownPid: 1, emit: event => events.push(clone(event)) });
    await app.initialize();
    if (overrides.resume !== false) await app.savePreferences({ privacy: { paused: false } });
    app.selectedWindow = clone(target);
    return { app, memory, secrets, requests, events };
  };
  return { directory, codec, start, ...(await start()) };
}

test('encrypted text conversations survive restart and remain isolated between profiles', async t => {
  const { app, memory, directory, start } = await fixture(t);
  await app.sendMessage({ text: 'Private conversation A' });
  await app.selectConnection(other.id);
  await app.sendMessage({ text: 'Private conversation B' });
  const disk = await fs.readFile(memory.file, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(disk)).sort(), ['encrypted', 'version']);
  assert(!disk.includes('Private conversation')); assert(!disk.includes(connection.id));
  assert(!(await fs.readFile(path.join(directory, 'settings.json'), 'utf8')).includes('Private conversation'));
  const next = await start({ resume: false });
  assert.equal(next.app.getState().config.privacy.paused, true);
  assert.deepEqual(next.app.getState().messages.map(message => message.content), ['Private conversation B', 'Reply for Private conversation B']);
  await next.app.selectConnection(connection.id);
  await next.app.savePreferences({ privacy: { paused: false } });
  await next.app.sendMessage({ text: 'Continue A' });
  assert(next.requests[0].messages.some(message => message.content === 'Private conversation A'));
  assert(!next.requests[0].messages.some(message => message.content.includes('conversation B')));
  assert.equal(next.app.getState().status.memoryAvailable, true);
});

test('Clear chat erases its saved profile and Clear all memory removes every saved chat', async t => {
  const { app, memory, secrets, start } = await fixture(t);
  await app.saveConnection({ ...connection, apiKey: 'test-key-kept-when-chat-is-cleared' });
  await app.sendMessage({ text: 'A to erase' });
  await app.selectConnection(other.id); await app.sendMessage({ text: 'B to preserve' });
  await app.selectConnection(connection.id); await app.clearChat();
  const next = await start();
  assert.deepEqual(next.app.getState().messages, []);
  await next.app.selectConnection(other.id);
  assert.equal(next.app.getState().messages[0].content, 'B to preserve');
  await next.app.clearAllMemory();
  await absent(memory.file); await absent(memory.file + '.tmp');
  assert.equal(await secrets.get(connection), 'test-key-kept-when-chat-is-cleared');
  const after = await start();
  assert.deepEqual(after.app.getState().messages, []);
});

test('disabling memory erases saved and current chats; enabling never backfills private session text', async t => {
  const { app, memory, start } = await fixture(t);
  await app.sendMessage({ text: 'Saved before disabling' });
  await app.savePreferences({ memory: { enabled: false } });
  await absent(memory.file); assert.deepEqual(app.getState().messages, []);
  await app.sendMessage({ text: 'Session-only private text' });
  assert.equal(app.getState().messages.length, 2); await absent(memory.file);
  const off = await start();
  assert.equal(off.app.getState().config.memory.enabled, false);
  assert.deepEqual(off.app.getState().messages, []);
  await app.savePreferences({ memory: { enabled: true } });
  assert.deepEqual(app.getState().messages, []);
  await app.sendMessage({ text: 'New retained conversation' });
  const on = await start();
  assert.deepEqual(on.app.getState().messages.map(message => message.content), ['New retained conversation', 'Reply for New retained conversation']);
});

test('profile edits preserve cosmetic changes and clear changed provider/model/key contexts on disk', async t => {
  const changes = [
    ['model', { model: 'new-model' }],
    ['endpoint', { baseUrl: 'http://127.0.0.1:19999', apiKey: 'replacement-key' }],
    ['provider', { provider: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'replacement-key' }],
    ['workspace', { workspaceId: 'new-workspace', apiKey: 'replacement-key' }],
    ['key', { apiKey: 'replacement-key' }],
    ['removed key', { removeKey: true }]
  ];
  for (const [name, patch] of changes) await t.test(name, async t => {
    const { app, start } = await fixture(t);
    await app.saveConnection({ ...connection, apiKey: 'original-key' });
    await app.sendMessage({ text: 'Prior authenticated context' });
    await app.saveConnection({ ...connection, name: 'Cosmetic name change' });
    assert.equal((await start()).app.getState().messages.length, 2);
    await app.saveConnection({ ...connection, ...patch });
    const next = await start();
    assert.deepEqual(next.app.getState().messages, []);
    await next.app.sendMessage({ text: 'Fresh request' });
    assert.deepEqual(next.requests[0].messages, [{ role: 'user', content: 'Fresh request' }]);
  });
});

test('credential changes that precede a crash invalidate the previous encrypted history on restart', async t => {
  const { app, secrets, start } = await fixture(t);
  await app.saveConnection({ ...connection, apiKey: 'old-key' });
  await app.sendMessage({ text: 'Old key context' });
  await secrets.put(connection, 'new-key-written-before-history-removal');
  const next = await start();
  assert.deepEqual(next.app.getState().messages, []);
  await absent(next.memory.file);
});

test('deleted profiles and externally changed model bindings do not restore their saved history', async t => {
  const { app, directory, start } = await fixture(t);
  await app.sendMessage({ text: 'Old model context' });
  const settings = new SettingsStore(directory), config = await settings.load();
  config.connections[0].model = 'externally-changed-model'; await settings.save(config);
  const next = await start();
  assert.deepEqual(next.app.getState().messages, []);
  await next.app.sendMessage({ text: 'New model context' });
  await next.app.removeConnection(connection.id);
  const after = await start();
  assert.equal(after.app.getState().config.connections.some(value => value.id === connection.id), false);
  await absent(after.memory.file);
});

test('screen descriptions, image bytes, and raw audio fields never enter encrypted text memory', async t => {
  const { start, codec } = await fixture(t);
  const { app, memory } = await start({ generateReply: async (_connection, options) => options.image ? 'PRIVATE_SCREEN_DESCRIPTION' : 'Ordinary text reply' });
  await app.describeWindow({ question: 'PRIVATE_SCREEN_QUESTION' });
  await absent(memory.file);
  await app.sendMessage({ text: 'Ordinary text question', audio: 'PRIVATE_RAW_AUDIO', image: 'PRIVATE_EXTRA_IMAGE' });
  const envelope = JSON.parse(await fs.readFile(memory.file, 'utf8'));
  const plaintext = await codec.decrypt(Buffer.from(envelope.encrypted, 'base64'));
  for (const forbidden of ['PRIVATE_SCREEN_DESCRIPTION', 'PRIVATE_SCREEN_QUESTION', 'PRIVATE_IMAGE_BYTES', 'PRIVATE_RAW_AUDIO', 'PRIVATE_EXTRA_IMAGE']) assert(!plaintext.includes(forbidden));
  const messages = JSON.parse(plaintext).profiles[0].messages;
  assert.deepEqual(messages, [{ role: 'user', content: 'Ordinary text question' }, { role: 'assistant', content: 'Ordinary text reply' }]);
});

test('corrupt memory is reported without crashing or overwriting it and can be explicitly cleared', async t => {
  const { memory, start } = await fixture(t);
  await fs.writeFile(memory.file, '{corrupt encrypted memory');
  const next = await start();
  assert.equal(next.app.getState().status.memoryAvailable, false);
  assert.match(next.app.getState().status.memoryMessage, /could not be unlocked or read/i);
  await next.app.sendMessage({ text: 'Usable session chat' });
  assert.equal(next.app.getState().messages.length, 2);
  assert.equal(await fs.readFile(memory.file, 'utf8'), '{corrupt encrypted memory');
  await next.app.clearAllMemory(); await absent(memory.file);
  await next.app.sendMessage({ text: 'New saved chat after reset' });
  assert.equal((await start()).app.getState().messages[0].content, 'New saved chat after reset');
});

test('unavailable protection preserves encrypted data, uses session-only chat, and still allows deletion', async t => {
  const { app, memory, codec, start } = await fixture(t);
  await app.sendMessage({ text: 'Previously saved text' });
  const original = await fs.readFile(memory.file, 'utf8');
  const next = await start({ memoryCodec: { ...codec, async isAvailable() { return false; } } });
  assert.equal(next.app.getState().status.memoryAvailable, false);
  assert.match(next.app.getState().status.memoryMessage, /Windows protection/);
  await next.app.sendMessage({ text: 'New session-only text' });
  assert.equal(await fs.readFile(memory.file, 'utf8'), original);
  await next.app.clearAllMemory(); await absent(memory.file);
  assert.equal(next.app.getState().status.memoryAvailable, false);
});

test('encryption failure does not lose a reply, leak an exception secret, or fall back to plaintext', async t => {
  const { start, codec } = await fixture(t);
  const next = await start({ memoryCodec: { ...codec, async encrypt() { throw new Error('codec detail SECRET_NOT_FOR_UI'); } } });
  assert.equal((await next.app.sendMessage({ text: 'Still receive this reply' })).text, 'Reply for Still receive this reply');
  assert.equal(next.app.getState().messages.length, 2);
  assert.equal(next.app.getState().status.memoryAvailable, false);
  assert(!next.app.getState().status.memoryMessage.includes('SECRET_NOT_FOR_UI'));
  await absent(next.memory.file); await absent(next.memory.file + '.tmp');
  await next.app.clearChat();
  assert.deepEqual(next.app.getState().messages, []);
  assert.equal(next.app.getState().status.memoryAvailable, false);
});

test('clearing during a provider request prevents a late reply from restoring disk or session history', async t => {
  const { app, start, memory } = await fixture(t);
  await app.sendMessage({ text: 'Old chat to clear' });
  const entered = deferred(), released = deferred();
  const next = await start({ generateReply: async () => { entered.resolve(); return released.promise; } });
  const pending = next.app.sendMessage({ text: 'Pending private question' });
  const rejected = assert.rejects(pending, /cancel/i);
  await entered.promise; await next.app.clearChat();
  released.resolve('Late private reply'); await rejected;
  assert.deepEqual(next.app.getState().messages, []); await absent(memory.file);
  assert.deepEqual((await start()).app.getState().messages, []);
});

test('clear-all and disabling win races against an encrypted save already in progress', async t => {
  for (const action of ['clear', 'disable']) await t.test(action, async t => {
    const { app, codec, start } = await fixture(t);
    await app.sendMessage({ text: 'Earlier retained chat' });
    const entered = deferred(), released = deferred();
    const next = await start({ memoryCodec: { ...codec, async encrypt(plain) {
      if (plain.includes('Pending persistence')) { entered.resolve(); await released.promise; }
      return codec.encrypt(plain);
    } } });
    const pending = next.app.sendMessage({ text: 'Pending persistence' });
    const rejected = assert.rejects(pending, /cancel/i);
    await entered.promise;
    const clearing = action === 'clear' ? next.app.clearAllMemory() : next.app.savePreferences({ memory: { enabled: false } });
    released.resolve(); await Promise.all([rejected, clearing]);
    await absent(next.memory.file); await absent(next.memory.file + '.tmp');
    assert.deepEqual(next.app.getState().messages, []);
    assert.deepEqual((await start()).app.getState().messages, []);
  });
});

test('cancelling during encryption keeps the previously committed history unchanged', async t => {
  const { app, memory, codec, start } = await fixture(t);
  await app.sendMessage({ text: 'Committed chat' });
  const original = await fs.readFile(memory.file, 'utf8');
  const entered = deferred(), released = deferred();
  const next = await start({ memoryCodec: { ...codec, async encrypt(plain) {
    if (plain.includes('Cancel this save')) { entered.resolve(); await released.promise; }
    return codec.encrypt(plain);
  } } });
  const pending = next.app.sendMessage({ text: 'Cancel this save' });
  const rejected = assert.rejects(pending, /cancel/i);
  await entered.promise; next.app.cancelReply(); released.resolve(); await rejected;
  assert.equal(await fs.readFile(memory.file, 'utf8'), original);
  assert.deepEqual(next.app.getState().messages.map(message => message.content), ['Committed chat', 'Reply for Committed chat']);
  assert.equal((await start()).app.getState().messages.length, 2);
});

test('erase failures are reported instead of claiming saved memory was removed', async t => {
  const { app, memory } = await fixture(t);
  await app.sendMessage({ text: 'Saved before filesystem failure' });
  await fs.rm(memory.file); await fs.mkdir(memory.file);
  await assert.rejects(app.clearAllMemory(), /could not be erased/i);
  assert.equal(app.getState().status.memoryAvailable, false);
  assert.deepEqual(app.getState().messages, []);
});

test('retained history has a larger bounded window than the context sent to providers', async t => {
  const { app, requests, start } = await fixture(t);
  for (let index = 0; index < 105; index += 1) await app.sendMessage({ text: 'Turn ' + index });
  const messages = app.getState().messages;
  assert.equal(messages.length, MEMORY_LIMITS.messagesPerProfile);
  assert.equal(messages[0].content, 'Turn 5');
  assert(requests.every(request => request.messages.length <= MEMORY_LIMITS.contextMessages + 1));
  assert.equal((await start()).app.getState().messages.length, MEMORY_LIMITS.messagesPerProfile);
  const large = await start({ generateReply: async () => 'r'.repeat(10000) });
  for (let index = 0; index < 8; index += 1) await large.app.sendMessage({ text: 'u'.repeat(10000) });
  assert(large.requests.every(request => request.messages.reduce((sum, message) => sum + message.content.length, 0) <= MEMORY_LIMITS.contextChars));
  assert(large.app.getState().messages.length > large.requests.at(-1).messages.length);
});

test('saved profile and global character limits bound oversized histories and evict oldest profiles', async t => {
  const { directory, codec } = await fixture(t);
  const store = new ConversationStore(directory, codec);
  const profiles = Array.from({ length: 6 }, (_, index) => ({ ...connection, id: 'bounded-' + index }));
  const bindings = profiles.map(value => ({ id: value.id, binding: conversationBinding(value) }));
  await store.load(bindings);
  for (const { id, binding } of bindings) {
    const messages = Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index) + 'x'.repeat(124999) }));
    await store.save(id, binding, messages);
  }
  const next = new ConversationStore(directory, codec);
  const histories = await next.load(bindings);
  assert.equal(histories.size, 4);
  assert(!histories.has('bounded-0')); assert(!histories.has('bounded-1'));
  let total = 0;
  for (const messages of histories.values()) {
    const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
    assert(chars <= MEMORY_LIMITS.charsPerProfile); total += chars;
  }
  assert(total <= MEMORY_LIMITS.totalChars);
  assert((await fs.stat(store.file)).size <= MEMORY_LIMITS.fileBytes);
});
