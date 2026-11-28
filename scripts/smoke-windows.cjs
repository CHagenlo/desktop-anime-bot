const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

function terminateTree(child) {
  if (!Number.isInteger(child.pid) || child.pid <= 0 || child.exitCode !== null || child.signalCode !== null) return;
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  // A portable launcher owns an Electron process tree; stop only this test's PID tree.
  const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
    shell: false, windowsHide: true, timeout: 5000, stdio: 'ignore'
  });
  if (result.error || result.status !== 0) child.kill();
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The packaged application smoke check requires Windows.');
  const root = path.resolve(__dirname, '..');
  const executable = path.resolve(process.argv[2] || path.join(root, 'dist', 'win-unpacked', 'Desktop Anime Bot.exe'));
  const label = process.argv[3] || 'unpacked';
  if (!/^[a-z0-9-]{1,32}$/.test(label)) throw new Error('Use a short lowercase label for smoke results.');
  await fs.access(executable);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-anime-bot-smoke-'));
  const output = path.join(directory, 'result.json');
  const destination = path.join(root, 'dist', 'smoke', label);
  await fs.mkdir(destination, { recursive: true });
  let processOutput = '';
  let timeout;
  const child = spawn(executable, ['--smoke-test', '--smoke-output=' + output], {
    cwd: path.dirname(executable), windowsHide: false, shell: false, stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    processOutput = (processOutput + bytes.toString()).slice(-24000);
  });
  try {
    const exit = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('The packaged app did not finish its smoke check within 90 seconds.'));
        terminateTree(child);
      }, 90000);
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timeout);
    const report = JSON.parse(await fs.readFile(output, 'utf8'));
    await fs.copyFile(output, path.join(destination, 'result.json'));
    for (const name of ['settings.png', 'character.png']) {
      try { await fs.copyFile(path.join(directory, name), path.join(destination, name)); }
      catch (error) { if (report.ok || error.code !== 'ENOENT') throw error; }
    }
    await fs.writeFile(path.join(destination, 'process.log'), processOutput);
    if (exit.code !== 0 || exit.signal) throw new Error('The packaged app exited abnormally: ' + (exit.signal || exit.code));
    if (!report.ok) throw new Error('Packaged app smoke check failed: ' + report.error);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await fs.writeFile(path.join(destination, 'process.log'), processOutput);
    if (processOutput) console.error(processOutput);
    throw error;
  } finally {
    clearTimeout(timeout);
    terminateTree(child);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
