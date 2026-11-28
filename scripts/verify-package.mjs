import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { extractFile, listPackage } from '@electron/asar';
import { init, parse } from 'es-module-lexer';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'dist', 'win-unpacked');
const archive = path.join(directory, 'resources', 'app.asar');
const unpackedOnly = process.argv.includes('--unpacked-only');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const appFiles = new Set(listPackage(archive).map(file => file.replace(/^[/\\]+/, '').replace(/\\/g, '/')));
// ASAR's lookup splits directories on the host separator, while module IDs use forward slashes.
const readPackagedFile = file => extractFile(archive, path.normalize(file));
const requireFile = file => {
  if (!appFiles.has(file)) throw new Error('The packaged application is missing ' + file);
};
for (const file of ['package.json', 'src/main.cjs', 'src/preload.cjs', 'src/core/application.mjs', 'src/core/storage.mjs',
  'src/native/windows.mjs', 'src/providers/index.mjs', 'renderer/settings.html', 'renderer/settings.js',
  'renderer/settings.css', 'renderer/overlay.html', 'renderer/overlay.js', 'renderer/overlay.css', 'assets/icon.png',
  'node_modules/three/build/three.module.js', 'node_modules/three/build/three.core.js',
  'node_modules/three/examples/jsm/loaders/GLTFLoader.js', 'node_modules/three/examples/jsm/utils/BufferGeometryUtils.js',
  'node_modules/@pixiv/three-vrm/lib/three-vrm.module.js']) requireFile(file);

for (const file of appFiles) {
  if (/^(?:tests|scripts|\.github)\//.test(file) || /(?:^|\/)(?:\.env(?:\.[^/]*)?|credentials[^/]*\.json|settings\.json|avatar\.vrm)$/.test(file)
      || /^node_modules\/(?:electron(?:-builder)?|@electron\/asar)\//.test(file) || /\.(?:ps1|cs)$/.test(file)) {
    throw new Error('A development or runtime-only file was included in the app: ' + file);
  }
}
const packedManifest = JSON.parse(readPackagedFile('package.json').toString('utf8'));
if (packedManifest.version !== manifest.version || packedManifest.main !== manifest.main) throw new Error('Packaged version or entry point differs from the source.');

// Resolve the actual renderer module graph inside app.asar. This catches omitted addon dependencies.
const aliases = {
  three: 'node_modules/three/build/three.module.js',
  '@pixiv/three-vrm': 'node_modules/@pixiv/three-vrm/lib/three-vrm.module.js'
};
const pending = ['renderer/overlay.js'];
const checked = new Set();
await init();
while (pending.length) {
  const file = pending.pop();
  if (checked.has(file)) continue;
  requireFile(file); checked.add(file);
  const source = readPackagedFile(file).toString('utf8');
  const [imports] = parse(source, file);
  for (const entry of imports) {
    // Nonliteral dynamic imports cannot be resolved statically; Electron's runtime smoke covers startup.
    if (typeof entry.specifier !== 'string' || entry.glob) continue;
    const specifier = entry.specifier;
    let target;
    if (specifier.startsWith('.')) target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    else if (specifier.startsWith('three/addons/')) target = 'node_modules/three/examples/jsm/' + specifier.slice('three/addons/'.length);
    else target = aliases[specifier];
    if (!target) throw new Error('An unhandled renderer module import is present: ' + specifier);
    requireFile(target); pending.push(target);
  }
}

async function verifyExecutable(file, expectedMachine) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    if ((await handle.read(header, 0, 64, 0)).bytesRead !== 64 || header.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid executable: ' + path.basename(file));
    const offset = header.readUInt32LE(60), pe = Buffer.alloc(6);
    if ((await handle.read(pe, 0, 6, offset)).bytesRead !== 6 || pe.readUInt32LE(0) !== 0x4550) throw new Error('Invalid PE header: ' + path.basename(file));
    if (expectedMachine && pe.readUInt16LE(4) !== expectedMachine) throw new Error('Unexpected executable architecture: ' + path.basename(file));
  } finally { await handle.close(); }
}
const executable = path.join(directory, 'Desktop Anime Bot.exe');
const helper = path.join(directory, 'resources', 'native', 'desktop-window-helper.exe');
await verifyExecutable(executable, 0x8664);
await verifyExecutable(helper, 0x8664);
const compiledHelper = await fs.readFile(path.join(root, 'build', 'native', 'desktop-window-helper.exe'));
if (!compiledHelper.equals(await fs.readFile(helper))) throw new Error('The packaged native helper differs from the compiled helper.');

async function smokeNativeHelper() {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', ready = false, result = false, finished = false;
    const timer = setTimeout(() => finish(new Error('Packaged native helper timed out.')), 15000);
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve();
    };
    child.on('error', () => finish(new Error('Could not start the packaged native helper.')));
    child.stdin.on('error', () => finish(new Error('The packaged native helper input closed unexpectedly.')));
    child.stderr.on('data', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 8 * 1024 * 1024) return finish(new Error('Packaged native helper output exceeded the limit.'));
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline).replace(/^\uFEFF/, '').trim(); output = output.slice(newline + 1);
        if (!line) continue;
        let packet;
        try { packet = JSON.parse(line); } catch { return finish(new Error('Packaged native helper returned invalid JSON.')); }
        if (!ready && packet.type === 'ready' && packet.protocol === 1) {
          ready = true;
          child.stdin.write(JSON.stringify({ id: 1, command: 'list', excludedPids: [process.pid] }) + '\n');
        } else if (ready && packet.id === 1 && packet.ok === true && Array.isArray(packet.result)) {
          result = true; child.stdin.end();
        }
        else return finish(new Error('Packaged native helper returned an unexpected protocol response.'));
      }
    });
    child.on('close', code => finish(code === 0 && ready && result ? null : new Error('Packaged native helper smoke check failed.')));
  });
}
if (process.platform === 'win32') await smokeNativeHelper();

const artifacts = [];
if (!unpackedOnly) {
  for (const kind of ['Setup', 'Portable']) {
    const filename = `Desktop-Anime-Bot-${kind}-${manifest.version}-x64.exe`;
    const file = path.join(root, 'dist', filename);
    await verifyExecutable(file);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    artifacts.push({ filename, sha256: hash.digest('hex'), bytes: (await fs.stat(file)).size });
  }
  await fs.writeFile(path.join(root, 'dist', 'SHA256SUMS.txt'), artifacts.map(item => `${item.sha256}  ${item.filename}\n`).join(''));
}
const result = { status: 'passed', version: manifest.version, rendererModulesChecked: checked.size,
  nativeHelperSmoke: process.platform === 'win32' ? 'passed' : 'not run: requires Windows', artifacts };
await fs.writeFile(path.join(root, 'dist', 'package-verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
