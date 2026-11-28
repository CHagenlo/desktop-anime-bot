import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildNative, discoverAssembly, assertX64Executable } = require('../scripts/build-native.cjs');
const windowsRoot = 'C:\\Windows';
const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';

function executable(machine = 0x8664) {
  const buffer = Buffer.alloc(512);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

function fixture({ compileFailure = false, smokeFailure = false, machine = 0x8664 } = {}) {
  const projectRoot = path.resolve('test-native-build-root');
  const output = path.join(projectRoot, 'build', 'native', 'desktop-window-helper.exe');
  const compiler = path.win32.join(framework, 'csc.exe');
  const files = new Map([
    [compiler, Buffer.from('compiler')],
    [path.join(projectRoot, 'src', 'native', 'windows-helper.cs'), Buffer.from('source')],
    [path.join(projectRoot, 'src', 'native', 'windows-helper.manifest'), Buffer.from('manifest')],
  ]);
  for (const name of ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll']) {
    files.set(path.win32.join(framework, name), Buffer.from('assembly'));
  }
  const fsImpl = {
    existsSync: candidate => files.has(candidate),
    mkdirSync() {},
    rmSync: candidate => files.delete(candidate),
    readFileSync(candidate) { if (!files.has(candidate)) throw new Error('Missing file'); return files.get(candidate); },
    readdirSync(folder) {
      const prefix = folder + '\\';
      const values = [...new Set([...files.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length).split('\\')[0]))];
      if (!values.length) throw new Error('Missing directory');
      return values;
    },
  };
  const calls = [];
  const spawnSyncImpl = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === compiler) {
      if (compileFailure) return { status: 1, stderr: 'Example compiler error' };
      files.set(output, executable(machine));
      return { status: 0, stdout: '' };
    }
    assert.equal(command, output);
    assert.deepEqual(args, ['--self-test']);
    return { status: smokeFailure ? 1 : 0, stdout: JSON.stringify({ type: 'self-test', protocol: 1, ok: !smokeFailure }) };
  };
  return { options: { platform: 'win32', env: { SystemRoot: windowsRoot }, projectRoot, fsImpl, spawnSyncImpl }, files, calls, output, compiler, fsImpl };
}

test('native build compiles x64 without a shell and runs the compiled protocol self-test', () => {
  const f = fixture();
  const result = buildNative(f.options);
  assert.equal(result.output, f.output);
  assert.equal(result.architecture, 'x64');
  assert.equal(f.calls.length, 2);
  assert(f.calls[0].args.includes('/platform:x64'));
  assert(f.calls[0].args.includes('/langversion:5'));
  assert(f.calls[0].args.includes('/noconfig'));
  assert(f.calls[0].args.some(value => value.startsWith('/win32manifest:')));
  assert.equal(f.calls[0].options.shell, false);
  assert.equal(f.calls[1].options.shell, false);
  assert.equal(f.calls[0].options.windowsHide, true);
});

test('native build refuses non-Windows hosts before any compiler invocation', () => {
  const f = fixture();
  assert.throws(() => buildNative({ ...f.options, platform: 'linux' }), /must be compiled on Windows/);
  assert.equal(f.calls.length, 0);
});

test('failed compilation removes stale output and never launches it', () => {
  const f = fixture({ compileFailure: true });
  f.files.set(f.output, executable());
  assert.throws(() => buildNative(f.options), /compilation failed/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.files.has(f.output), false);
});

test('wrong architecture and failed protocol checks prevent packaging the helper', () => {
  const wrong = fixture({ machine: 0x14c });
  assert.throws(() => buildNative(wrong.options), /x64 PE executable/);
  assert.equal(wrong.calls.length, 1);
  assert.equal(wrong.files.has(wrong.output), false);
  const failed = fixture({ smokeFailure: true });
  assert.throws(() => buildNative(failed.options), /protocol self-test/);
  assert.equal(failed.files.has(failed.output), false);
  assert.throws(() => assertX64Executable(Buffer.from('not a binary')), /Windows executable/);
});

test('assembly discovery can use the in-box Framework GAC without an SDK', () => {
  const f = fixture();
  f.files.delete(path.win32.join(framework, 'System.Web.Extensions.dll'));
  const expected = 'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\System.Web.Extensions\\v4.0_4.0.0.0__31bf3856ad364e35\\System.Web.Extensions.dll';
  f.files.set(expected, Buffer.from('assembly'));
  assert.equal(discoverAssembly('System.Web.Extensions.dll', framework, windowsRoot, f.fsImpl), expected);
});
