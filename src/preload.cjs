const { contextBridge, ipcRenderer } = require('electron');

const invoke = (method, payload) => ipcRenderer.invoke('companion:' + method, payload);
const api = {
  getState: () => invoke('getState'),
  savePreferences: value => invoke('savePreferences', value),
  saveConnection: value => invoke('saveConnection', value),
  selectConnection: id => invoke('selectConnection', id),
  removeConnection: id => invoke('removeConnection', id),
  listModels: id => invoke('listModels', id),
  sendMessage: value => invoke('sendMessage', value),
  clearChat: () => invoke('clearChat'),
  cancelReply: () => invoke('cancelReply'),
  listWindows: () => invoke('listWindows'),
  selectWindow: handle => invoke('selectWindow', handle),
  saveRule: value => invoke('saveRule', value),
  describeWindow: value => invoke('describeWindow', value),
  windowAction: value => invoke('windowAction', value),
  importAvatar: () => invoke('importAvatar'),
  getAvatar: () => invoke('getAvatar'),
  openSettings: () => invoke('openSettings'),
  toggleOverlay: () => invoke('toggleOverlay'),
  quit: () => invoke('quit'),
  pauseAll: () => invoke('pauseAll'),
  setOverlayInteractive: value => ipcRenderer.send('companion:overlay-interactive', value === true),
  dragOverlay: value => ipcRenderer.send('companion:overlay-drag', value),
  onEvent: callback => {
    if (typeof callback !== 'function') throw new Error('An event callback is required.');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('companion:event', listener);
    return () => ipcRenderer.removeListener('companion:event', listener);
  }
};
contextBridge.exposeInMainWorld('companion', Object.freeze(api));
