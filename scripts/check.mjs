import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Source/package checks only. These do not substitute for running on Windows.
const root = fileURLToPath(new URL('../', import.meta.url));
const failures = [];
let scriptsChecked = 0;

async function requireFile(relative) {
  try { await fs.access(path.join(root, relative)); }
  catch { failures.push('Missing file: ' + relative); }
}

async function checkScripts(relative) {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) await checkScripts(child);
    else if (/\.(?:[cm]?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path.join(root, child)], { encoding: 'utf8' });
      scriptsChecked += 1;
      if (result.status !== 0) failures.push(child + ': ' + (result.stderr || result.error?.message || 'Syntax check failed.').trim());
    }
  }
}

for (const directory of ['src', 'renderer', 'scripts', 'tests']) await checkScripts(directory);
for (const file of ['README.md', 'package-lock.json', 'assets/icon.png', 'src/native/windows-helper.ps1']) await requireFile(file);

for (const name of ['settings', 'overlay']) {
  const html = await fs.readFile(path.join(root, 'renderer', name + '.html'), 'utf8');
  const javascript = await fs.readFile(path.join(root, 'renderer', name + '.js'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) failures.push(name + '.html has a duplicate element ID.');
  for (const match of javascript.matchAll(/(?:\$\(|getElementById\()["']([\w-]+)["']\)/g)) {
    if (!idSet.has(match[1])) failures.push(name + '.js references a missing element: ' + match[1]);
  }
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    if (!/^(?:[a-z]+:|#)/i.test(match[1])) await requireFile(path.join('renderer', match[1]));
  }
  for (const match of html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)) {
    const digest = createHash('sha256').update(match[1]).digest('base64');
    if (!html.includes("'sha256-" + digest + "'")) failures.push(name + '.html import-map CSP hash is incorrect.');
    const map = JSON.parse(match[1]);
    for (const file of Object.values(map.imports || {})) await requireFile(path.join('renderer', file));
  }
}

const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
for (const section of ['dependencies', 'devDependencies']) {
  for (const [name, version] of Object.entries(manifest[section] || {})) {
    if (lock.packages?.['']?.[section]?.[name] !== version || lock.packages?.['node_modules/' + name]?.version !== version) {
      failures.push('Dependency lock differs from package.json: ' + name);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Source checks passed: ${scriptsChecked} JavaScript files, renderer references, import-map CSP, assets, and dependency lock.`);
}
