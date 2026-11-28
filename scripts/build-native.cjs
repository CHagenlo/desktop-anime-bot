'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const HELPER_FILENAME = 'desktop-window-helper.exe';
const ASSEMBLIES = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'];

function discoverCompiler(windowsRoot, fsImpl = fs) {
  const candidates = ['Framework64', 'Framework'].map(folder =>
    path.win32.join(windowsRoot, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe'));
  const compiler = candidates.find(candidate => fsImpl.existsSync(candidate));
  if (!compiler) {
    throw new Error('The in-box .NET Framework C# compiler was not found. Build on Windows 10/11 with .NET Framework 4.8 or later.');
  }
  return compiler;
}

function discoverAssembly(filename, compilerDirectory, windowsRoot, fsImpl = fs) {
  const direct = [
    path.win32.join(compilerDirectory, filename),
    path.win32.join(windowsRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319', filename),
    path.win32.join(windowsRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', filename),
  ];
  for (const candidate of direct) if (fsImpl.existsSync(candidate)) return candidate;
  const assemblyName = filename.slice(0, -4);
  for (const cache of ['GAC_MSIL', 'GAC_64', 'GAC_32']) {
    const folder = path.win32.join(windowsRoot, 'Microsoft.NET', 'assembly', cache, assemblyName);
    let versions;
    try { versions = fsImpl.readdirSync(folder).filter(value => /^v4\.0_/.test(value)).sort().reverse(); }
    catch { continue; }
    for (const version of versions) {
      const candidate = path.win32.join(folder, version, filename);
      if (fsImpl.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Required .NET Framework assembly is missing: ' + filename);
}

function assertX64Executable(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('The native build did not produce a Windows executable.');
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset > buffer.length - 6 || buffer.readUInt32LE(peOffset) !== 0x00004550 ||
      buffer.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error('The native helper must be a Windows x64 PE executable.');
  }
}

function buildNative({
  platform = process.platform,
  env = process.env,
  projectRoot = PROJECT_ROOT,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== 'win32') {
    throw new Error('The native helper must be compiled on Windows. This build does not execute or emulate Windows binaries on another OS.');
  }
  const windowsRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  const compiler = discoverCompiler(windowsRoot, fsImpl);
  const references = ASSEMBLIES.map(name =>
    discoverAssembly(name, path.win32.dirname(compiler), windowsRoot, fsImpl));
  const source = path.join(projectRoot, 'src', 'native', 'windows-helper.cs');
  const manifest = path.join(projectRoot, 'src', 'native', 'windows-helper.manifest');
  if (!fsImpl.existsSync(source) || !fsImpl.existsSync(manifest)) throw new Error('The native helper source or manifest is missing.');
  const outputDirectory = path.join(projectRoot, 'build', 'native');
  const output = path.join(outputDirectory, HELPER_FILENAME);
  fsImpl.mkdirSync(outputDirectory, { recursive: true });
  // Do not let a failed build leave an old executable eligible for packaging.
  fsImpl.rmSync(output, { force: true });
  const args = [
    '/nologo', '/noconfig', '/target:exe', '/platform:x64', '/langversion:5', '/optimize+',
    '/out:' + output,
    '/win32manifest:' + manifest,
    ...references.map(reference => '/reference:' + reference),
    source,
  ];
  const result = spawnSyncImpl(compiler, args, {
    cwd: projectRoot, windowsHide: true, shell: false, encoding: 'utf8',
    timeout: 60000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fsImpl.rmSync(output, { force: true });
    const diagnostics = String(result.stderr || result.stdout || result.error?.message || 'Unknown compiler error').trim().slice(0, 8000);
    throw new Error('Native helper compilation failed.\n' + diagnostics);
  }
  try {
    assertX64Executable(fsImpl.readFileSync(output));
    const smoke = spawnSyncImpl(output, ['--self-test'], {
      cwd: projectRoot, windowsHide: true, shell: false, encoding: 'utf8',
      timeout: 15000, maxBuffer: 64 * 1024,
    });
    if (smoke.error || smoke.status !== 0) throw new Error('The compiled helper failed its protocol self-test.');
    let response;
    try { response = JSON.parse(String(smoke.stdout).replace(/^\uFEFF/, '').trim()); }
    catch { throw new Error('The compiled helper self-test returned invalid JSON.'); }
    if (response.type !== 'self-test' || response.protocol !== 1 || response.ok !== true) {
      throw new Error('The compiled helper protocol self-test did not pass.');
    }
  } catch (error) {
    fsImpl.rmSync(output, { force: true });
    throw error;
  }
  return { output, compiler, architecture: 'x64', protocol: 1 };
}

module.exports = { buildNative, discoverCompiler, discoverAssembly, assertX64Executable };

if (require.main === module) {
  try {
    const result = buildNative();
    process.stdout.write('Built native Windows helper: ' + result.output + '\n');
    process.stdout.write('Verified x64 executable and JSON protocol self-test.\n');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
