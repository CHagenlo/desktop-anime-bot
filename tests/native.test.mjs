import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { WindowsBridge, resolveWindowsHelperLaunch } from '../src/native/windows.mjs';

const target = {
  handle: '123456',
  pid: 4242,
  exePath: 'C:\\Apps\\Personal\\editor.exe',
  processName: 'editor',
  title: 'Personal document',
  bounds: { x: 80, y: 100, width: 800, height: 600 },
  minimized: false,
};
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

function fakeHelper(onRequest) {
  const calls = [];
  const children = [];
  const packets = [];
  const spawnImpl = (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.send = packet => child.stdout.write(JSON.stringify(packet) + '\n');
    child.stdin = new Writable({
      write(chunk, encoding, callback) {
        const packet = JSON.parse(chunk.toString('utf8'));
        packets.push(packet);
        callback();
        queueMicrotask(() => onRequest(packet, child, children.length));
      },
    });
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => child.emit('close', 0));
      return true;
    };
    children.push(child);
    queueMicrotask(() => child.send({ type: 'ready', protocol: 1 }));
    return child;
  };
  return { spawnImpl, calls, children, packets };
}

function compiledBridge(fake, options = {}) {
  return new WindowsBridge({
    platform: 'win32', spawnImpl: fake.spawnImpl,
    helperExecutablePath: 'C:\\Program Files\\Desktop Anime Bot\\resources\\native\\desktop-window-helper.exe',
    existsSyncImpl: () => true,
    ...options,
  });
}

test('non-Windows methods fail before spawning anything', async () => {
  let count = 0;
  const bridge = new WindowsBridge({ platform: 'linux', spawnImpl() { count++; } });
  await assert.rejects(bridge.listWindows(), { code: 'UNSUPPORTED_PLATFORM' });
  await assert.rejects(bridge.inspectWindow(target.handle), { code: 'UNSUPPORTED_PLATFORM' });
  await assert.rejects(bridge.performAction(target, { type: 'minimize' }), { code: 'UNSUPPORTED_PLATFORM' });
  await assert.rejects(bridge.captureWindow(target), { code: 'UNSUPPORTED_PLATFORM' });
  assert.equal(count, 0);
});

test('uses fixed hidden helper arguments and transports all identity text as JSON', async t => {
  const fake = fakeHelper((packet, child) => child.send({ id: packet.id, ok: true, result: { ...target, ...packet.target } }));
  const bridge = compiledBridge(fake);
  t.after(() => bridge.dispose());
  const unusual = { ...target, title: 'quote"; Start-Process example; $(anything)\nUnicode: 雪' };
  await bridge.performAction(unusual, { type: 'move', dx: -12, dy: 5 });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fake.calls[0].options.windowsHide, true);
  assert.deepEqual(fake.calls[0].args, []);
  assert(fake.calls[0].executable.endsWith('\\native\\desktop-window-helper.exe'));
  assert(!fake.calls[0].args.some(value => value.includes('Start-Process')));
  assert(!fake.calls[0].args.includes('-ExecutionPolicy'));
  assert.deepEqual(fake.packets[0].target, {
    handle: unusual.handle, pid: unusual.pid, exePath: unusual.exePath, title: unusual.title,
  });
  assert.deepEqual(fake.packets[0].action, { type: 'move', dx: -12, dy: 5 });
});

test('reuses its worker and omits excluded processes from enumeration', async t => {
  const fake = fakeHelper((packet, child) => child.send({
    id: packet.id, ok: true, result: packet.command === 'list' ? [target, { ...target, pid: 8888 }] : target,
  }));
  const bridge = compiledBridge(fake, { excludedPids: [8888] });
  t.after(() => bridge.dispose());
  assert.deepEqual(await bridge.listWindows(), [target]);
  assert.deepEqual(await bridge.inspectWindow(target.handle), target);
  assert.equal(fake.calls.length, 1);
  assert(fake.packets[0].excludedPids.includes(process.pid));
  assert(fake.packets[0].excludedPids.includes(8888));
});

test('rejects unsupported and malformed actions before starting the helper', async () => {
  let count = 0;
  const bridge = new WindowsBridge({ platform: 'win32', spawnImpl() { count++; } });
  for (const action of [
    { type: 'close' },
    { type: 'shell', command: 'anything' },
    { type: 'move', dx: NaN, dy: 0 },
    { type: 'resize', width: 100000, height: 200 },
  ]) {
    await assert.rejects(bridge.performAction(target, action), { code: 'INVALID_REQUEST' });
  }
  await assert.rejects(bridge.inspectWindow('123; anything'), { code: 'INVALID_REQUEST' });
  await assert.rejects(bridge.performAction({ ...target, pid: 0 }, { type: 'restore' }), { code: 'INVALID_REQUEST' });
  assert.equal(count, 0);
});

test('accepts PNG capture only and sends an expected target identity', async t => {
  const fake = fakeHelper((packet, child) => child.send({ id: packet.id, ok: true, result: { mimeType: 'image/png', base64: png } }));
  const bridge = compiledBridge(fake);
  t.after(() => bridge.dispose());
  assert.deepEqual(await bridge.captureWindow(target), { mimeType: 'image/png', base64: png });
  assert.equal(fake.packets[0].command, 'capture');
  assert.equal(fake.packets[0].target.title, target.title);
});

test('reports native identity or capture failures without exposing diagnostic text', async t => {
  const fake = fakeHelper((packet, child) => child.send({
    id: packet.id, ok: false, error: { code: 'TARGET_CHANGED', message: 'private diagnostic must not escape' },
  }));
  const bridge = compiledBridge(fake);
  t.after(() => bridge.dispose());
  await assert.rejects(bridge.captureWindow(target), error => {
    assert.equal(error.code, 'TARGET_CHANGED');
    assert(!error.message.includes('private diagnostic'));
    return true;
  });
});

test('rejects a successful action result for a different target identity', async t => {
  const fake = fakeHelper((packet, child) => child.send({
    id: packet.id, ok: true, result: { ...target, title: 'A different document' },
  }));
  const bridge = compiledBridge(fake);
  t.after(() => bridge.dispose());
  await assert.rejects(bridge.performAction(target, { type: 'move', dx: 10, dy: 0 }), { code: 'TARGET_CHANGED' });
});

test('revocation kills queued work, rejects pending calls, and permits a fresh worker', async t => {
  const fake = fakeHelper((packet, child, count) => {
    if (count > 1) child.send({ id: packet.id, ok: true, result: [target] });
  });
  const bridge = compiledBridge(fake);
  t.after(() => bridge.dispose());
  const first = bridge.listWindows();
  const second = bridge.captureWindow(target);
  const checks = [
    assert.rejects(first, { code: 'CANCELLED' }),
    assert.rejects(second, { code: 'CANCELLED' }),
  ];
  bridge.cancelPending();
  await Promise.all(checks);
  assert.equal(fake.children[0].killed, true);
  assert.deepEqual(await bridge.listWindows(), [target]);
  assert.equal(fake.children.length, 2);
  bridge.dispose();
  await assert.rejects(bridge.listWindows(), { code: 'BRIDGE_DISPOSED' });
});

test('a helper that does not respond is terminated on timeout', async () => {
  const fake = fakeHelper(() => {});
  const bridge = compiledBridge(fake, { timeoutMs: 100 });
  await assert.rejects(bridge.listWindows(), { code: 'HELPER_TIMEOUT' });
  assert.equal(fake.children[0].killed, true);
  bridge.dispose();
});

test('unexpected protocol messages terminate the worker', async () => {
  const fake = fakeHelper((packet, child) => child.send({ id: packet.id + 100, ok: true, result: [] }));
  const bridge = compiledBridge(fake);
  await assert.rejects(bridge.listWindows(), { code: 'HELPER_PROTOCOL' });
  assert.equal(fake.children[0].killed, true);
  bridge.dispose();
});

test('packaged helper resolution uses only the bundled executable', () => {
  const expected = 'C:\\Installed\\Companion\\resources\\native\\desktop-window-helper.exe';
  const checked = [];
  const launch = resolveWindowsHelperLaunch({
    packaged: true, resourcesPath: 'C:\\Installed\\Companion\\resources',
    existsSyncImpl(candidate) { checked.push(candidate); return candidate === expected; },
  });
  assert.deepEqual(launch, { executable: expected, args: [], kind: 'compiled' });
  assert.deepEqual(checked, [expected]);
});

test('missing packaged or explicitly configured binaries never fall back to PowerShell', () => {
  const checked = [];
  assert.throws(() => resolveWindowsHelperLaunch({
    packaged: true, resourcesPath: 'C:\\Installed\\Companion\\resources', allowPowerShellFallback: true,
    existsSyncImpl(candidate) { checked.push(candidate); return candidate.endsWith('.ps1'); },
  }), { code: 'HELPER_NOT_FOUND' });
  assert.equal(checked.length, 1);
  assert(checked[0].endsWith('.exe'));
  assert.throws(() => resolveWindowsHelperLaunch({
    helperExecutablePath: 'C:\\Missing\\helper.exe', allowPowerShellFallback: true,
    existsSyncImpl: candidate => candidate.endsWith('.ps1'),
  }), { code: 'HELPER_NOT_FOUND' });
});

test('development prefers a compiled helper and can explicitly disable the script fallback', () => {
  const launch = resolveWindowsHelperLaunch({
    packaged: false, existsSyncImpl: candidate => candidate.endsWith('.exe'),
  });
  assert.equal(launch.kind, 'compiled');
  assert.deepEqual(launch.args, []);
  assert(launch.executable.endsWith('desktop-window-helper.exe'));
  assert.throws(() => resolveWindowsHelperLaunch({
    packaged: false, allowPowerShellFallback: false,
    existsSyncImpl: candidate => candidate.endsWith('.ps1'),
  }), { code: 'HELPER_NOT_FOUND' });
});

test('development script fallback preserves the fixed protocol without changing execution policy', async t => {
  const fake = fakeHelper((packet, child) => child.send({ id: packet.id, ok: true, result: [target] }));
  const bridge = new WindowsBridge({
    platform: 'win32', spawnImpl: fake.spawnImpl, packaged: false, allowPowerShellFallback: true,
    existsSyncImpl: candidate => candidate.endsWith('.ps1'),
  });
  t.after(() => bridge.dispose());
  assert.deepEqual(await bridge.listWindows(), [target]);
  assert(fake.calls[0].executable.endsWith('\\powershell.exe'));
  assert.deepEqual(fake.calls[0].args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-File']);
  assert(!fake.calls[0].args.includes('-ExecutionPolicy'));
});

test('compiled helper startup failure stays a compiled failure and never tries a script', async () => {
  const fake = fakeHelper((packet, child) => child.send({
    id: null, ok: false, error: { code: 'HELPER_START_FAILED' },
  }));
  const bridge = compiledBridge(fake, { packaged: true });
  await assert.rejects(bridge.listWindows(), { code: 'HELPER_START_FAILED' });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].args, []);
  bridge.dispose();
});
