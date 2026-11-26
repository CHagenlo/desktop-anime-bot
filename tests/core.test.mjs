import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DEFAULT_CONFIG, sanitizeConfig, applyPreferences, sanitizeRule } from '../src/core/config.mjs';
import { assertWindowPermission, PermissionGate, sanitizeAction, sameWindow } from '../src/core/policy.mjs';
import { SettingsStore, SecretStore, electronSecretCodec } from '../src/core/storage.mjs';
import { CompanionApplication } from '../src/core/application.mjs';
import { validateVrm } from '../src/core/avatar.mjs';

const target = { handle: '1234', pid: 99, exePath: 'C:\\Apps\\Personal.exe', processName: 'Personal', title: 'Personal notes',
  bounds: { x: 100, y: 200, width: 900, height: 600 }, minimized: false };
const connection = { id: 'connection-a', name: 'Local A', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'my-model', supportsVision: true, workspaceId: '', anthropicVersion: '' };
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function allowedConfig() {
  const config = clone(DEFAULT_CONFIG);
  config.connections = [clone(connection), { ...connection, id: 'connection-b', name: 'Hosted B', provider: 'openai', baseUrl: 'https://api.example.test/v1' }];
  config.activeConnectionId = connection.id;
  config.privacy.seeWindowContents = true; config.privacy.manageWindows = true;
  config.privacy.rules = [sanitizeRule({ ...target, label: 'Personal', layout: true, vision: true, manage: true })];
  return config;
}
async function fixture(overrides = {}) {
  const calls = { requests: [], captures: 0, actions: 0, cancels: 0, saves: 0 };
  const providers = {
    PROVIDER_PRESETS: [{ id: 'ollama', label: 'Ollama', baseUrl: connection.baseUrl }, { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.example.test/v1' }],
    validateConnection(c, options = {}) {
      if (options.localOnly && c.provider !== 'ollama') throw new Error('Local-only mode blocks this connection.');
      return { ...c, baseUrl: c.baseUrl.replace(/\/$/, '') };
    },
    async listModels() { return [{ id: 'my-model', name: 'My model', supportsVision: true, remote: false }]; },
    async generateReply(c, options) { calls.requests.push({ connection: clone(c), messages: clone(options.messages), image: options.image, system: options.system }); return 'A reply from ' + c.id; },
    ...overrides.providers
  };
  const native = {
    async listWindows() { return [clone(target)]; },
    async inspectWindow() { return clone(target); },
    async captureWindow() { calls.captures += 1; return { mimeType: 'image/png', base64: 'aW1hZ2U=' }; },
    async performAction(t, action) { calls.actions += 1; return { ...clone(t), bounds: { ...t.bounds, x: t.bounds.x + (action.dx || 0), y: t.bounds.y + (action.dy || 0) } }; },
    cancelPending() { calls.cancels += 1; }, dispose() {}, ...overrides.native
  };
  const secrets = { async load() {}, has() { return false; }, async get() { return ''; }, async put() {}, async remove() {}, ...overrides.secrets };
  const settings = { async load() { return allowedConfig(); }, async save() { calls.saves += 1; }, ...overrides.settings };
  const app = new CompanionApplication({ settings, secrets, native, providers, platform: 'win32', ownPid: 1 });
  await app.initialize();
  await app.savePreferences({ privacy: { paused: false } });
  app.selectedWindow = clone(target);
  return { app, calls, native, providers, secrets };
}

test('public configuration sanitization strips API keys and unknown fields', () => {
  const config = sanitizeConfig({ ...allowedConfig(), apiKey: 'secret', connections: [{ ...connection, apiKey: 'secret', hasKey: true, arbitrary: 'unsafe' }] });
  assert.equal(JSON.stringify(config).includes('secret'), false);
  assert.equal(Object.hasOwn(config.connections[0], 'hasKey'), false);
});
test('the three capabilities are independent; Work and Play preserve choices', () => {
  let config = allowedConfig();
  config = applyPreferences(config, { privacy: { reactToWindows: false, seeWindowContents: true, manageWindows: false } });
  config = applyPreferences(config, { privacy: { mode: 'work' } });
  assert.deepEqual([config.privacy.reactToWindows, config.privacy.seeWindowContents, config.privacy.manageWindows], [false, false, false]);
  config = applyPreferences(config, { privacy: { mode: 'play' } });
  assert.deepEqual([config.privacy.reactToWindows, config.privacy.seeWindowContents, config.privacy.manageWindows], [false, true, false]);
  config = applyPreferences(config, { character: { playfulness: 'quiet' } });
  assert.equal(config.privacy.seeWindowContents, true);
});
test('protected apps override allowed flags in every mode', () => {
  let config = allowedConfig(); config.privacy.rules[0].protected = true;
  config = applyPreferences(config, { privacy: { mode: 'play' } });
  for (const capability of ['layout', 'vision', 'manage']) assert.throws(() => assertWindowPermission(config, target, capability));
});
test('unknown apps and minimized image targets are denied', () => {
  const config = allowedConfig();
  assert.throws(() => assertWindowPermission(config, { ...target, exePath: 'C:\\Other\\Work.exe' }, 'vision'));
  assert.throws(() => assertWindowPermission(config, { ...target, minimized: true }, 'vision'));
});
test('window identity includes title, process and executable', () => {
  assert(sameWindow(target, { ...target, exePath: target.exePath.toUpperCase() }));
  for (const changed of [{ title: 'Work tab' }, { pid: 98 }, { handle: '5678' }, { exePath: 'C:\\Work.exe' }]) assert(!sameWindow(target, { ...target, ...changed }));
});
test('revocation aborts old operations and allows a new lease', () => {
  const gate = new PermissionGate(), first = gate.lease(); gate.revoke();
  assert(first.signal.aborted); assert.throws(() => first.assertActive());
  const next = gate.lease(); assert.doesNotThrow(() => next.assertActive()); next.release();
});
test('desktop actions reject arbitrary commands and excessive coordinates', () => {
  for (const value of [{ type: 'close' }, { type: 'shell', command: 'whoami' }, { type: 'move', dx: Infinity, dy: 0 }, { type: 'resize', width: 0, height: 0 }]) assert.throws(() => sanitizeAction(value));
  assert.deepEqual(sanitizeAction({ type: 'move', dx: 50, dy: 0, command: 'ignored' }), { type: 'move', dx: 50, dy: 0 });
});
test('saved settings never contain plaintext credentials', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-test-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new SettingsStore(directory);
  await store.save({ ...allowedConfig(), connections: [{ ...connection, apiKey: 'DO-NOT-SAVE' }] });
  assert(!(await fs.readFile(store.file, 'utf8')).includes('DO-NOT-SAVE'));
});
test('credential storage encrypts keys and binds them to endpoints', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-secrets-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const encryptionKey = randomBytes(32);
  const codec = {
    async encrypt(plain) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv); const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
    async decrypt(bytes) { const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'); }
  };
  const store = new SecretStore(directory, codec); await store.load();
  await store.put(connection, 'sample-secret-that-must-not-be-plaintext');
  assert(!(await fs.readFile(store.file, 'utf8')).includes('sample-secret'));
  assert.equal(await store.get(connection), 'sample-secret-that-must-not-be-plaintext');
  assert.equal(await store.get({ ...connection, baseUrl: 'https://different.example/v1' }), '');
  await store.remove(connection.id); assert.equal(store.has(connection), false);
});
test('Windows credential codec refuses unavailable protection and other platforms', async () => {
  await assert.rejects(electronSecretCodec({ isAsyncEncryptionAvailable: async () => false }, 'win32').encrypt('key'));
  await assert.rejects(electronSecretCodec({}, 'linux').encrypt('key'));
});
test('application starts paused and never persists conversational messages', async () => {
  const { app } = await fixture();
  const another = await fixture({ settings: { async save(config) { assert(!Object.hasOwn(config, 'messages')); } } });
  await another.app.sendMessage({ text: 'Hello' });
  await another.app.savePreferences({ character: { name: 'Nova' } });
  await app.initialize(); assert.equal(app.config.privacy.paused, true);
});
test('switching provider connections keeps their histories separate', async () => {
  const { app, calls } = await fixture();
  await app.sendMessage({ text: 'Personal context A' });
  await app.selectConnection('connection-b');
  await app.sendMessage({ text: 'Hello B' });
  assert.deepEqual(calls.requests[1].messages, [{ role: 'user', content: 'Hello B' }]);
  await app.selectConnection('connection-a');
  await app.sendMessage({ text: 'Continue A' });
  assert(calls.requests[2].messages.some(m => m.content === 'Personal context A'));
  assert(!calls.requests[2].messages.some(m => m.content === 'Hello B'));
});
test('screen images and image-derived replies do not enter later text history', async () => {
  const { app, calls } = await fixture();
  await app.describeWindow({ question: 'Describe this' });
  await app.sendMessage({ text: 'New text question' });
  assert(calls.requests[0].image);
  assert.equal(calls.requests[1].image, null);
  assert.deepEqual(calls.requests[1].messages, [{ role: 'user', content: 'New text question' }]);
});
test('protected windows are neither captured nor manipulated', async () => {
  const { app, calls } = await fixture();
  await app.saveRule({ ...target, protected: true, layout: true, vision: true, manage: true });
  await assert.rejects(app.describeWindow({ question: 'Read it' }));
  await assert.rejects(app.windowAction({ type: 'move', dx: 20, dy: 0 }));
  assert.equal(calls.captures, 0); assert.equal(calls.actions, 0); assert.equal(calls.requests.length, 0);
});
test('local-only mode rejects a hosted destination before a request', async () => {
  const { app, calls } = await fixture(); await app.selectConnection('connection-b');
  await app.savePreferences({ privacy: { localOnly: true } });
  await assert.rejects(app.sendMessage({ text: 'Private question' }));
  await assert.rejects(app.describeWindow({ question: 'Private screenshot' }));
  assert.equal(calls.requests.length, 0); assert.equal(calls.captures, 0);
});
test('revocation while unlocking a key prevents the model request', async () => {
  const entered = deferred(), released = deferred();
  const { app, calls } = await fixture({ secrets: { async get() { entered.resolve(); return released.promise; } } });
  const request = app.sendMessage({ text: 'Pending question' });
  const rejection = assert.rejects(request, /cancel/i);
  await entered.promise; await app.savePreferences({ privacy: { paused: true } });
  released.resolve('test-key'); await rejection;
  assert.equal(calls.requests.length, 0);
});
test('disabling vision during capture discards the image before any provider call', async () => {
  const entered = deferred(), released = deferred();
  const { app, calls } = await fixture({ native: { async captureWindow() { entered.resolve(); return released.promise; } } });
  const request = app.describeWindow({ question: 'Pending image' });
  const rejection = assert.rejects(request, /cancel/i);
  await entered.promise; await app.savePreferences({ privacy: { seeWindowContents: false } });
  released.resolve({ mimeType: 'image/png', base64: 'aW1hZ2U=' }); await rejection;
  assert.equal(calls.requests.length, 0); assert(calls.cancels > 0);
});
test('window title changes cause capture to fail closed', async () => {
  const { app, calls } = await fixture({ native: { async inspectWindow() { return { ...clone(target), title: 'Sensitive work tab' }; } } });
  await assert.rejects(app.describeWindow({ question: 'Read it' }), /changed/i);
  assert.equal(calls.captures, 0); assert.equal(calls.requests.length, 0); assert.equal(app.selectedWindow, null);
});
test('an endpoint change never silently reuses its old credential', async () => {
  const { app } = await fixture({ secrets: { has() { return true; } } });
  await assert.rejects(app.saveConnection({ ...connection, baseUrl: 'http://127.0.0.1:9999', apiKey: '' }), /new key|removal/i);
});
test('requests cannot start while an asynchronous credential update is pending', async () => {
  const entered = deferred(), released = deferred();
  const { app, calls } = await fixture({ secrets: { async put() { entered.resolve(); await released.promise; } } });
  const saving = app.saveConnection({ ...connection, apiKey: 'new-key' });
  await entered.promise;
  await assert.rejects(app.sendMessage({ text: 'Do not use the old provider' }), /being saved/i);
  await assert.rejects(app.describeWindow({ question: 'Do not capture yet' }), /being saved/i);
  await assert.rejects(app.listModels(connection.id), /being saved/i);
  released.resolve(); await saving;
  assert.equal(calls.requests.length, 0); assert.equal(calls.captures, 0);
  await app.sendMessage({ text: 'Now use the committed configuration' });
  assert.equal(calls.requests.length, 1);
});
test('long discovered model identifiers are preserved and excessive identifiers are rejected', async () => {
  const { app } = await fixture();
  const model = 'local/'.repeat(60) + 'model';
  await app.saveConnection({ ...connection, model });
  assert.equal(app.config.connections[0].model, model);
  assert.equal(sanitizeConfig(app.config).connections[0].model, model);
  await assert.rejects(app.saveConnection({ ...connection, model: 'x'.repeat(513) }));
});
test('removing an optional API key clears the previous authentication context history', async () => {
  const { app, calls } = await fixture();
  await app.sendMessage({ text: 'Old authenticated context' });
  await app.saveConnection({ ...connection, removeKey: true });
  await app.sendMessage({ text: 'Fresh unauthenticated context' });
  assert.deepEqual(calls.requests[1].messages, [{ role: 'user', content: 'Fresh unauthenticated context' }]);
});
test('Undo after minimizing uses restored coordinates rather than minimized sentinel bounds', async () => {
  let current = clone(target); const actions = [];
  const { app } = await fixture({ native: {
    async inspectWindow() { return clone(current); },
    async performAction(_selected, action) {
      actions.push(clone(action));
      if (action.type === 'minimize') current = { ...current, minimized: true, bounds: { x: -32000, y: -32000, width: 160, height: 28 } };
      else if (action.type === 'restore') current = clone(target);
      else if (action.type === 'resize') current.bounds = { ...current.bounds, width: action.width, height: action.height };
      else if (action.type === 'move') { current.bounds.x += action.dx; current.bounds.y += action.dy; }
      return clone(current);
    }
  } });
  await app.windowAction({ type: 'minimize' });
  await app.windowAction({ type: 'undo' });
  assert.deepEqual(current.bounds, target.bounds); assert.equal(current.minimized, false);
  assert(!actions.some(a => a.type === 'move' && (Math.abs(a.dx) > 1000 || Math.abs(a.dy) > 1000)));
});
test('model text cannot invoke actions; explicit local commands can', async () => {
  const { app, calls } = await fixture({ providers: { async generateReply() { return '{"type":"move","dx":200,"dy":0}'; } } });
  await app.sendMessage({ text: 'Hello' }); assert.equal(calls.actions, 0);
  await app.sendMessage({ text: '/window left' }); assert.equal(calls.actions, 1);
});
test('invalid or externally referenced VRM assets are rejected', () => {
  const make = object => { let json = Buffer.from(JSON.stringify(object)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]); const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + json.length, 8); header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16); return Buffer.concat([header, json]); };
  assert.doesNotThrow(() => validateVrm(make({ extensions: { VRMC_vrm: {} }, buffers: [{}] })));
  assert.throws(() => validateVrm(make({ extensions: { VRMC_vrm: {} }, images: [{ uri: 'https://external.example/track.png' }] })));
  assert.throws(() => validateVrm(make({ extensions: {} })));
});
