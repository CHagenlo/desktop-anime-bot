const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Explicit packaging diagnostics. Always use a disposable profile, never a
// person's saved connections, keys, avatar, or application permissions.
function prepareSmoke(app) {
  if (!process.argv.includes('--smoke-test')) return null;
  const argument = process.argv.find(value => value.startsWith('--smoke-output='));
  if (!argument) throw new Error('Smoke mode requires a report path in a temporary smoke directory.');
  const output = path.resolve(argument.slice('--smoke-output='.length));
  const directory = fs.realpathSync(path.dirname(output));
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const relative = path.relative(temporaryRoot, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      !path.basename(directory).startsWith('desktop-anime-bot-smoke-') || path.basename(output) !== 'result.json') {
    throw new Error('Smoke reports must use a dedicated directory under the system temporary folder.');
  }
  const profile = path.join(directory, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  const rendererErrors = [];
  let finished = false;

  async function finish(report) {
    if (finished) return;
    finished = true;
    try {
      await fsp.writeFile(output, JSON.stringify({ ...report, version: app.getVersion(),
        platform: process.platform, arch: process.arch, packaged: app.isPackaged,
        isolatedProfile: true, rendererErrors }, null, 2) + '\n');
    } finally {
      process.exitCode = report.ok ? 0 : 1;
      app.quit();
    }
  }

  async function poll(window, expression, ready) {
    const deadline = Date.now() + 20000;
    let value;
    while (Date.now() < deadline) {
      if (rendererErrors.length) throw new Error(rendererErrors.join('\n'));
      value = await window.webContents.executeJavaScript(expression);
      if (value?.error) throw new Error(value.error);
      if (ready(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The packaged renderer did not become ready: ' + JSON.stringify(value));
  }

  return {
    attach(window, label) {
      window.webContents.on('preload-error', (_event, _file, error) => rendererErrors.push(label + ': preload: ' + error.message));
      window.webContents.on('render-process-gone', (_event, details) => rendererErrors.push(label + ': renderer exited: ' + details.reason));
      window.webContents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
        if (mainFrame) rendererErrors.push(label + ': load ' + code + ': ' + description);
      });
      window.webContents.on('console-message', details => {
        if (details.level === 'error') rendererErrors.push(label + ': ' + details.message.slice(0, 1500));
      });
    },
    async verify({ settingsWindow, overlayWindow, service, credentialCodec }) {
      try {
        if (process.platform !== 'win32' || !app.isPackaged) throw new Error('Run this check using the packaged Windows application.');
        const settings = await poll(settingsWindow, `(() => ({
          bridge: typeof window.companion?.getState === 'function',
          initialized: document.getElementById('pause-all')?.textContent === 'Resume companion',
          providers: document.getElementById('connection-provider')?.options.length || 0,
          error: document.getElementById('app-status')?.dataset.tone === 'error' ? document.getElementById('app-status').textContent : ''
        }))()`, value => value.bridge && value.initialized && value.providers >= 9);
        const state = await settingsWindow.webContents.executeJavaScript('window.companion.getState()');
        if (!state.config.privacy.paused || state.config.connections.length || state.config.character.modelName) {
          throw new Error('The smoke check did not receive a clean paused profile through the preload bridge.');
        }
        const overlay = await poll(overlayWindow, `(() => {
          const canvas = document.getElementById('avatar-canvas');
          const error = document.getElementById('overlay-error');
          return { bridge: typeof window.companion?.getState === 'function',
            rendered: canvas?.dataset.rendered === 'true', width: canvas?.width || 0, height: canvas?.height || 0,
            avatar: document.getElementById('avatar-type')?.textContent || '',
            error: error && !error.hidden ? error.textContent : '' };
        })()`, value => value.bridge && value.rendered && value.width > 0 && value.height > 0 && value.avatar.startsWith('Prototype avatar'));
        const nativeWindows = await service.listWindows();
        const sample = 'packaging-smoke-check';
        const encrypted = await credentialCodec.encrypt(sample);
        if (await credentialCodec.decrypt(encrypted) !== sample) throw new Error('Windows credential encryption round-trip failed.');
        for (const [name, window] of [['settings', settingsWindow], ['character', overlayWindow]]) {
          const capture = await window.webContents.capturePage();
          if (capture.isEmpty()) throw new Error(name + ' did not produce a rendered image.');
          await fsp.writeFile(path.join(directory, name + '.png'), capture.toPNG());
        }
        if (rendererErrors.length) throw new Error(rendererErrors.join('\n'));
        await finish({ ok: true, checks: { settingsPreload: settings.bridge, settingsInitialized: settings.initialized,
          providerChoices: settings.providers, overlayPreload: overlay.bridge, avatarFrameRendered: overlay.rendered,
          startsPaused: true, nativeHelperEnumeration: true, nativeWindowCount: nativeWindows.length,
          windowsCredentialEncryption: true, windowImagesWritten: true } });
      } catch (error) { await finish({ ok: false, error: error.message || String(error) }); }
    },
    fail: error => finish({ ok: false, error: error.message || String(error) })
  };
}

module.exports = { prepareSmoke };
