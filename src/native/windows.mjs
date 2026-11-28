import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER_PATH = fileURLToPath(new URL('./windows-helper.ps1', import.meta.url));
const DEVELOPMENT_EXECUTABLE = fileURLToPath(new URL('../../build/native/desktop-window-helper.exe', import.meta.url));
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_BASE64 = 12 * 1024 * 1024;
const ACTIONS = new Set(['move', 'resize', 'minimize', 'restore']);
const MESSAGES = {
  UNSUPPORTED_PLATFORM: 'Native window integration is available on Windows only.',
  BRIDGE_DISPOSED: 'The native window bridge has been closed.',
  INVALID_REQUEST: 'The native window request is invalid.',
  TARGET_UNAVAILABLE: 'That window is no longer available. Select it again.',
  TARGET_CHANGED: 'The selected window changed. Select it again before continuing.',
  TARGET_EXCLUDED: 'The companion cannot act on its own windows.',
  TARGET_MINIMIZED: 'Restore the selected window before moving, resizing, or capturing it.',
  WINDOW_ACTION_FAILED: 'Windows could not complete or confirm that window action.',
  CAPTURE_PROTECTED: 'The selected window prevents capture.',
  CAPTURE_UNSUPPORTED: 'The selected window could not be captured in isolation.',
  CAPTURE_BLANK: 'The selected window did not render usable content. Capture stopped.',
  CAPTURE_TOO_LARGE: 'The selected window is too large for this prototype to capture.',
  HELPER_NOT_FOUND: 'The Windows helper is missing. Reinstall the app, or build the native helper when running from source.',
  HELPER_START_FAILED: 'The bundled Windows helper could not start. Check that Windows can run the app installation.',
  DEVELOPMENT_HELPER_START_FAILED: 'The development helper could not start. Build the compiled native helper; no execution-policy change is required.',
  HELPER_EXITED: 'The Windows helper stopped before the operation completed.',
  HELPER_TIMEOUT: 'The selected application or Windows helper did not respond in time.',
  HELPER_PROTOCOL: 'The Windows helper returned an invalid response.',
  CANCELLED: 'The native desktop operation was cancelled.',
};

export class WindowsBridgeError extends Error {
  constructor(code) {
    const knownCode = Object.hasOwn(MESSAGES, code) ? code : 'HELPER_PROTOCOL';
    super(MESSAGES[knownCode]);
    this.name = 'WindowsBridgeError';
    this.code = knownCode;
  }
}

function fail(code) {
  throw new WindowsBridgeError(code);
}

function integer(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('INVALID_REQUEST');
  return value;
}

function handleValue(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) fail('INVALID_REQUEST');
  if (BigInt(value) > 9223372036854775807n) fail('INVALID_REQUEST');
  return value;
}

function textValue(value, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!allowEmpty && !value)) {
    fail('INVALID_REQUEST');
  }
  return value;
}

function targetIdentity(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) fail('INVALID_REQUEST');
  const exePath = textValue(target.exePath, 32768);
  if (!path.win32.isAbsolute(exePath)) fail('INVALID_REQUEST');
  return {
    handle: handleValue(target.handle),
    pid: integer(target.pid, 1, 0xffffffff),
    exePath,
    title: textValue(target.title, 32768, true),
  };
}

function windowInfo(value) {
  try {
    const identity = targetIdentity(value);
    if (!value.bounds || typeof value.minimized !== 'boolean') fail('INVALID_REQUEST');
    return {
      ...identity,
      processName: textValue(value.processName, 1024),
      bounds: {
        x: integer(value.bounds.x, -2147483648, 2147483647),
        y: integer(value.bounds.y, -2147483648, 2147483647),
        width: integer(value.bounds.width, 1, 32768),
        height: integer(value.bounds.height, 1, 32768),
      },
      minimized: value.minimized,
    };
  } catch {
    fail('HELPER_PROTOCOL');
  }
}

function normalizedAction(action) {
  if (!action || !ACTIONS.has(action.type)) fail('INVALID_REQUEST');
  if (action.type === 'move') {
    return { type: 'move', dx: integer(action.dx, -32768, 32768), dy: integer(action.dy, -32768, 32768) };
  }
  if (action.type === 'resize') {
    return { type: 'resize', width: integer(action.width, 64, 8192), height: integer(action.height, 64, 8192) };
  }
  return { type: action.type };
}

/** Resolve only app-owned helper locations. A packaged app never falls back to a script. */
export function resolveWindowsHelperLaunch({
  helperExecutablePath,
  resourcesPath = process.resourcesPath,
  packaged = false,
  allowPowerShellFallback = !packaged,
  existsSyncImpl = existsSync,
  systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
} = {}) {
  const compiled = candidate => {
    if (typeof candidate !== 'string' || !path.win32.isAbsolute(candidate) ||
        path.win32.extname(candidate).toLowerCase() !== '.exe' || candidate.includes('\0')) fail('INVALID_REQUEST');
    if (!existsSyncImpl(candidate)) fail('HELPER_NOT_FOUND');
    return { executable: candidate, args: [], kind: 'compiled' };
  };
  if (helperExecutablePath !== undefined) return compiled(helperExecutablePath);
  if (packaged) {
    if (typeof resourcesPath !== 'string' || !path.win32.isAbsolute(resourcesPath)) fail('HELPER_NOT_FOUND');
    return compiled(path.win32.join(resourcesPath, 'native', 'desktop-window-helper.exe'));
  }
  if (existsSyncImpl(DEVELOPMENT_EXECUTABLE)) {
    return { executable: DEVELOPMENT_EXECUTABLE, args: [], kind: 'compiled' };
  }
  if (!allowPowerShellFallback || !existsSyncImpl(HELPER_PATH)) fail('HELPER_NOT_FOUND');
  return {
    executable: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', HELPER_PATH],
    kind: 'powershell',
  };
}

/**
 * Fixed NDJSON protocol to a hidden, persistent compiled Windows helper.
 * A development-only PowerShell loader is available when explicitly allowed.
 * No shell is used, and no user/model text is interpolated into commands.
 * Bounds and movement amounts are physical pixels, not Electron DIP values.
 */
export class WindowsBridge {
  constructor({
    platform = process.platform,
    spawnImpl = spawn,
    timeoutMs = 12000,
    excludedPids = [process.pid],
    helperExecutablePath,
    resourcesPath = process.resourcesPath,
    packaged = false,
    allowPowerShellFallback = !packaged,
    existsSyncImpl = existsSync,
  } = {}) {
    this.platform = platform;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = integer(timeoutMs, 100, 60000);
    this.excludedPids = [...new Set([process.pid, ...excludedPids])].map(pid => integer(pid, 1, 0xffffffff));
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.disposed = false;
    this.launchOptions = { helperExecutablePath, resourcesPath, packaged, allowPowerShellFallback, existsSyncImpl };
  }

  async listWindows() {
    const result = await this.request('list', {});
    if (!Array.isArray(result) || result.length > 2048) fail('HELPER_PROTOCOL');
    return result.map(windowInfo).filter(item => !this.excludedPids.includes(item.pid));
  }

  async inspectWindow(handle) {
    const expectedHandle = handleValue(handle);
    const result = windowInfo(await this.request('inspect', { handle: expectedHandle }));
    if (result.handle !== expectedHandle) fail('HELPER_PROTOCOL');
    return result;
  }

  async performAction(target, action) {
    const expected = targetIdentity(target);
    const result = windowInfo(await this.request('action', {
      target: expected,
      action: normalizedAction(action),
    }));
    if (result.handle !== expected.handle || result.pid !== expected.pid ||
        result.exePath.toLowerCase() !== expected.exePath.toLowerCase() ||
        result.title !== expected.title) fail('TARGET_CHANGED');
    return result;
  }

  async captureWindow(target) {
    const result = await this.request('capture', { target: targetIdentity(target) });
    if (!result || result.mimeType !== 'image/png' || typeof result.base64 !== 'string' ||
        result.base64.length > MAX_CAPTURE_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.base64) ||
        !result.base64.startsWith('iVBORw0KGgo')) fail('HELPER_PROTOCOL');
    return { mimeType: 'image/png', base64: result.base64 };
  }

  /** Kill queued/current native work on permission revocation. Future calls may restart the worker. */
  cancelPending() {
    this.stopWorker('CANCELLED');
  }

  dispose() {
    this.disposed = true;
    this.stopWorker('CANCELLED');
  }

  request(command, payload) {
    if (this.platform !== 'win32') return Promise.reject(new WindowsBridgeError('UNSUPPORTED_PLATFORM'));
    if (this.disposed) return Promise.reject(new WindowsBridgeError('BRIDGE_DISPOSED'));
    if (!['list', 'inspect', 'action', 'capture'].includes(command) || this.pending.size >= 32) {
      return Promise.reject(new WindowsBridgeError('INVALID_REQUEST'));
    }
    try {
      this.ensureWorker();
    } catch (error) {
      return Promise.reject(error instanceof WindowsBridgeError ? error : new WindowsBridgeError('HELPER_START_FAILED'));
    }
    const id = this.nextId++;
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) this.stopWorker('HELPER_TIMEOUT');
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, worker });
      const packet = JSON.stringify({ id, command, ...payload, excludedPids: this.excludedPids }) + '\n';
      try {
        worker.child.stdin.write(packet, 'utf8', error => {
          if (error && this.worker === worker) this.stopWorker('HELPER_EXITED');
        });
      } catch {
        if (this.worker === worker) this.stopWorker('HELPER_EXITED');
      }
    });
  }

  ensureWorker() {
    if (this.worker) return;
    const launch = resolveWindowsHelperLaunch(this.launchOptions);
    const child = this.spawnImpl(launch.executable, launch.args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const worker = { child, buffer: '', started: false, kind: launch.kind };
    this.worker = worker;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.receive(worker, chunk));
    // Never surface raw helper diagnostics; they may contain local paths or request data.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {
      if (this.worker === worker) this.stopWorker(worker.started ? 'HELPER_EXITED' : this.startFailureCode(worker));
    });
    child.on('error', () => {
      if (this.worker === worker) this.stopWorker(this.startFailureCode(worker));
    });
    child.on('close', () => {
      if (this.worker === worker) this.stopWorker(worker.started ? 'HELPER_EXITED' : this.startFailureCode(worker));
    });
  }

  startFailureCode(worker) {
    return worker.kind === 'powershell' ? 'DEVELOPMENT_HELPER_START_FAILED' : 'HELPER_START_FAILED';
  }

  receive(worker, chunk) {
    if (this.worker !== worker) return;
    worker.buffer += chunk;
    if (Buffer.byteLength(worker.buffer, 'utf8') > MAX_RESPONSE_BYTES) {
      this.stopWorker('HELPER_PROTOCOL');
      return;
    }
    let newline;
    while ((newline = worker.buffer.indexOf('\n')) >= 0) {
      const line = worker.buffer.slice(0, newline).replace(/\r$/, '');
      worker.buffer = worker.buffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line.replace(/^\uFEFF/, ''));
      } catch {
        this.stopWorker('HELPER_PROTOCOL');
        return;
      }
      if (response.type === 'ready' && response.protocol === 1) {
        worker.started = true;
        continue;
      }
      if (response.id === null && response.ok === false) {
        this.stopWorker(this.startFailureCode(worker));
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending || pending.worker !== worker || typeof response.ok !== 'boolean') {
        this.stopWorker('HELPER_PROTOCOL');
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new WindowsBridgeError(response.error?.code));
    }
  }

  stopWorker(code) {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      try { worker.child.stdin.end(); } catch {}
      try { worker.child.kill(); } catch {}
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new WindowsBridgeError(code));
    }
    this.pending.clear();
  }
}
