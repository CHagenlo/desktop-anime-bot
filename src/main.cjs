const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, globalShortcut, dialog, screen, safeStorage, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { prepareSmoke } = require('./smoke.cjs');

const ROOT = path.resolve(__dirname, '..');
const SETTINGS_URL = pathToFileURL(path.join(ROOT, 'renderer/settings.html')).href;
const OVERLAY_URL = pathToFileURL(path.join(ROOT, 'renderer/overlay.html')).href;
let settingsWindow, overlayWindow, tray, service, speechController, cursorTimer, perchTimer;
let dragging = null, perchAttached = true, polling = false, priorHandle = null, priorReact = false;
let shuttingDown = false;
let smoke = null;

function broadcast(event) {
  if (event.type === 'state') {
    speechController?.checkState();
    if (speechController) event = { ...event, state: speechController.decorate(event.state) };
    const state = event.state;
    const handle = state.selectedWindow?.handle || null;
    const react = state.config.privacy.reactToWindows;
    if (handle !== priorHandle || (react && !priorReact)) perchAttached = true;
    priorHandle = handle; priorReact = react;
    updateTray();
  }
  for (const win of [settingsWindow, overlayWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('companion:event', event);
  }
}
function secureWindow(win, url) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, destination) => { if (destination !== url) event.preventDefault(); });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
}
function trusted(event, overlayAllowed = false) {
  const frame = event.senderFrame;
  if (!frame || frame.routingId !== event.sender.mainFrame.routingId) return false;
  if (settingsWindow && event.sender.id === settingsWindow.webContents.id && frame.url === SETTINGS_URL) return true;
  return overlayAllowed && overlayWindow && event.sender.id === overlayWindow.webContents.id && frame.url === OVERLAY_URL;
}
function register(method, handler, overlayAllowed = false) {
  ipcMain.handle('companion:' + method, async (event, payload) => {
    if (!trusted(event, overlayAllowed)) throw new Error('This operation is not available to that window.');
    const result = await handler(payload);
    return result?.config && speechController ? speechController.decorate(result) : result;
  });
}
function openSettings() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  if (settingsWindow.isMinimized()) settingsWindow.restore();
  settingsWindow.show(); settingsWindow.focus();
}
function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.showInactive();
}
function togglePause() {
  speechController?.cancel('Recording stopped because the companion was paused.');
  return service.pauseAll();
}
function updateTray() {
  if (!tray || !service) return;
  const paused = service.config.privacy.paused;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open companion settings', click: openSettings },
    { label: 'Show / hide character', click: toggleOverlay },
    { label: paused ? 'Resume companion' : 'Pause companion', click: () => togglePause().catch(() => {}) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.setToolTip(paused ? 'Desktop Anime Bot — paused' : 'Desktop Anime Bot');
}
function placeOverlay(x, y) {
  const bounds = overlayWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: Math.round(x + bounds.width / 2), y: Math.round(y + bounds.height / 2) });
  const area = display.workArea;
  const maxX = Math.max(area.x, area.x + area.width - bounds.width);
  const maxY = Math.max(area.y, area.y + area.height - bounds.height);
  overlayWindow.setPosition(Math.round(Math.max(area.x, Math.min(x, maxX))), Math.round(Math.max(area.y, Math.min(y, maxY))), false);
}
async function importAvatar() {
  const result = await dialog.showOpenDialog(settingsWindow, { title: 'Choose your VRM avatar', properties: ['openFile'], filters: [{ name: 'VRM avatar', extensions: ['vrm'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const selected = result.filePaths[0];
  const stat = await fs.stat(selected);
  if (stat.size > 50 * 1024 * 1024) throw new Error('Choose a VRM model smaller than 50 MB.');
  const bytes = await fs.readFile(selected);
  const { validateVrm } = await import('./core/avatar.mjs');
  validateVrm(bytes);
  const avatarPath = path.join(app.getPath('userData'), 'avatar.vrm');
  await fs.writeFile(avatarPath + '.tmp', bytes);
  await fs.rename(avatarPath + '.tmp', avatarPath);
  const name = path.basename(selected).slice(0, 120) + ' · ' + createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  await service.setAvatarName(name);
  return { name };
}
async function getAvatar() {
  try {
    const bytes = await fs.readFile(path.join(app.getPath('userData'), 'avatar.vrm'));
    return { name: service.config.character.modelName, bytes: new Uint8Array(bytes) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('The saved avatar could not be read. Import it again.'); }
}
function registerApi() {
  const methods = ['savePreferences', 'saveConnection', 'selectConnection', 'removeConnection', 'listModels', 'sendMessage',
    'clearChat', 'clearAllMemory', 'cancelReply', 'listWindows', 'selectWindow', 'saveRule', 'describeWindow', 'windowAction'];
  const cancelsMicrophone = new Set(['savePreferences', 'saveConnection', 'selectConnection', 'removeConnection',
    'clearChat', 'clearAllMemory', 'cancelReply', 'sendMessage', 'describeWindow']);
  for (const method of methods) register(method, payload => {
    if (cancelsMicrophone.has(method)) speechController?.cancel('Recording cancelled because another activity started.');
    return service[method](payload);
  });
  register('saveSpeech', input => speechController.save(input));
  register('beginMicrophone', () => speechController.begin(settingsWindow.webContents.id));
  register('transcribeAudio', input => speechController.submit(input, settingsWindow.webContents.id));
  register('cancelMicrophone', input => { speechController.cancel('Recording discarded.', input?.token); return null; });
  register('getState', () => service.getState(), true);
  register('pauseAll', togglePause, true);
  register('getAvatar', getAvatar, true);
  register('importAvatar', importAvatar);
  register('openSettings', () => openSettings(), true);
  register('toggleOverlay', () => toggleOverlay(), true);
  register('quit', () => app.quit(), true);
  ipcMain.on('companion:overlay-interactive', (event, interactive) => {
    if (!trusted(event, true) || event.sender.id !== overlayWindow.webContents.id || typeof interactive !== 'boolean') return;
    overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
  });
  ipcMain.on('companion:overlay-drag', (event, input) => {
    if (!trusted(event, true) || event.sender.id !== overlayWindow.webContents.id || !input) return;
    if (input.phase === 'start' && !service.config.privacy.paused) {
      const pointer = screen.getCursorScreenPoint(), bounds = overlayWindow.getBounds();
      dragging = { dx: pointer.x - bounds.x, dy: pointer.y - bounds.y };
      perchAttached = false;
      broadcast({ type: 'dragging', active: true });
    } else if (input.phase === 'end') {
      dragging = null;
      broadcast({ type: 'dragging', active: false });
    }
  });
}
async function start() {
  const [{ SettingsStore, SecretStore, electronSecretCodec }, { CompanionApplication }, { WindowsBridge }, providers,
    { ConversationStore }, { SpeechController, allowsMicrophone }] = await Promise.all([
    import('./core/storage.mjs'), import('./core/application.mjs'), import('./native/windows.mjs'), import('./providers/index.mjs'),
    import('./core/memory.mjs'), import('./audio/controller.mjs')
  ]);
  const directory = app.getPath('userData');
  await fs.mkdir(directory, { recursive: true });
  service = new CompanionApplication({ settings: new SettingsStore(directory), secrets: new SecretStore(directory, electronSecretCodec(safeStorage)),
    memory: new ConversationStore(directory, electronSecretCodec(safeStorage)),
    native: new WindowsBridge({ excludedPids: [process.pid], packaged: app.isPackaged,
      helperExecutablePath: app.isPackaged ? path.join(process.resourcesPath, 'native', 'desktop-window-helper.exe') : undefined,
      allowPowerShellFallback: !app.isPackaged }), providers, emit: broadcast });
  await service.initialize();
  speechController = new SpeechController({ service, emit: broadcast });
  const microphonePermission = (webContents, permission, details = {}, check = false) => allowsMicrophone({
    permission, senderId: webContents?.id, expectedId: settingsWindow?.webContents.id,
    frameUrl: details.requestingUrl, expectedUrl: SETTINGS_URL, isMainFrame: details.isMainFrame,
    mediaTypes: details.mediaTypes, mediaType: details.mediaType, check,
    recording: !!webContents && webContents.getURL() === SETTINGS_URL && speechController.canRecord(webContents.id)
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => callback(microphonePermission(webContents, permission, details)));
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => microphonePermission(webContents, permission, details, true));
  // Renderers load only packaged files. All model network requests originate in the main process.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  settingsWindow = new BrowserWindow({ width: 1100, height: 820, minWidth: 640, minHeight: 620, title: 'Desktop Anime Bot',
    backgroundColor: '#16131e', show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false } });
  const area = screen.getPrimaryDisplay().workArea;
  overlayWindow = new BrowserWindow({ width: 380, height: 490, x: area.x + area.width - 400, y: area.y + area.height - 510,
    transparent: true, backgroundColor: '#00000000', frame: false, alwaysOnTop: true, hasShadow: false,
    resizable: false, skipTaskbar: true, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  secureWindow(settingsWindow, SETTINGS_URL); secureWindow(overlayWindow, OVERLAY_URL);
  smoke?.attach(settingsWindow, 'settings'); smoke?.attach(overlayWindow, 'character');
  settingsWindow.on('close', event => { if (!shuttingDown) { event.preventDefault(); settingsWindow.hide(); } });
  settingsWindow.on('hide', () => speechController.cancel('Recording stopped because Settings was hidden.'));
  settingsWindow.on('minimize', () => speechController.cancel('Recording stopped because Settings was minimized.'));
  settingsWindow.webContents.on('render-process-gone', () => speechController.cancel());
  settingsWindow.webContents.on('did-start-loading', () => speechController.cancel());
  overlayWindow.on('close', () => { if (!shuttingDown) app.quit(); });
  registerApi();
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png')));
  tray.on('double-click', openSettings); updateTray();
  await Promise.all([settingsWindow.loadURL(SETTINGS_URL), overlayWindow.loadURL(OVERLAY_URL)]);
  settingsWindow.show(); overlayWindow.showInactive(); overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  for (const [shortcut, action] of [
    ['Control+Shift+Space', openSettings], ['Control+Shift+H', toggleOverlay],
    ['Control+Shift+P', () => togglePause().catch(() => {})]
  ]) {
    if (!globalShortcut.register(shortcut, action)) broadcast({ type: 'status', text: 'A global shortcut is already used by another app. The tray menu remains available.' });
  }
  cursorTimer = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
    const pointer = screen.getCursorScreenPoint();
    if (dragging && !service.config.privacy.paused) placeOverlay(pointer.x - dragging.dx, pointer.y - dragging.dy);
    const bounds = overlayWindow.getBounds();
    overlayWindow.webContents.send('companion:event', { type: 'cursor', x: pointer.x - bounds.x, y: pointer.y - bounds.y });
  }, 50);
  perchTimer = setInterval(async () => {
    if (polling || dragging || !perchAttached || !overlayWindow?.isVisible()) return;
    polling = true;
    try {
      const target = await service.currentPerchTarget();
      if (!target || !perchAttached || dragging) return;
      const a = process.platform === 'win32' ? screen.screenToDipPoint({ x: target.bounds.x, y: target.bounds.y }) : target.bounds;
      const b = process.platform === 'win32' ? screen.screenToDipPoint({ x: target.bounds.x + target.bounds.width, y: target.bounds.y }) : { x: target.bounds.x + target.bounds.width };
      const bounds = overlayWindow.getBounds();
      placeOverlay((a.x + b.x) / 2 - bounds.width / 2, a.y - bounds.height + 95);
      overlayWindow.webContents.send('companion:event', { type: 'pose', pose: 'perched' });
    } finally { polling = false; }
  }, 700);
  service.publish();
  if (smoke) await smoke.verify({ settingsWindow, overlayWindow, service, speechController, credentialCodec: electronSecretCodec(safeStorage) });
}

app.setName('DesktopAnimeBot');
if (process.platform === 'win32') app.setAppUserModelId('io.github.chagenlo.desktopanimebot');
smoke = prepareSmoke(app);
if (!smoke) {
  const profileDirectory = path.join(app.getPath('appData'), 'DesktopAnimeBot');
  fsSync.mkdirSync(profileDirectory, { recursive: true });
  app.setPath('userData', profileDirectory);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => openSettings());
  app.whenReady().then(start).catch(async error => {
    if (smoke) { await smoke.fail(error); return; }
    dialog.showErrorBox('Desktop Anime Bot could not start', error.message || 'Startup failed.');
    app.quit();
  });
}
app.on('before-quit', () => {
  shuttingDown = true; clearInterval(cursorTimer); clearInterval(perchTimer);
  globalShortcut.unregisterAll(); speechController?.dispose(); service?.dispose(); tray?.destroy();
});
app.on('window-all-closed', () => app.quit());
