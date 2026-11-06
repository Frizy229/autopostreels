'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Ответ передаём как есть ({ok, data, error, code}): contextBridge теряет у ошибок все поля, кроме текста,
// и окно не узнало бы код NO_TOKEN. Ошибку собирает обратно app.js.
const call = async (name, ...args) => ({ ...(await ipcRenderer.invoke(name, ...args)), __ipc: true });
const on = (ch, cb) => ipcRenderer.on(ch, (_e, v) => cb(v));

contextBridge.exposeInMainWorld('api', {
  getConfig: () => call('cfg:get'),
  setConfig: (patch) => call('cfg:set', patch),
  setToken: (t) => call('token:set', t),
  checkConnection: () => call('conn:check'),
  refresh: () => call('data:refresh'),
  pickFolder: () => call('folder:pick'),
  inspect: (p, lane) => call('folder:inspect', p, lane),
  upload: (p, opts) => call('folder:upload', p, opts),
  deleteFolder: (name, lane) => call('folder:delete', name, lane),
  folderTexts: (lane, name) => call('folder:texts', lane, name),
  saveFolderTexts: (lane, name, texts) => call('folder:saveTexts', lane, name, texts),
  saveNetTexts: (net, texts) => call('net:saveTexts', net, texts),
  pauseNet: (net, on) => call('net:pause', net, on),
  run: (inputs) => call('run', inputs),
  ttPreview: (rel) => call('tt:preview', rel),
  ttCaption: (rel, account) => call('tt:caption', rel, account),
  ttConfirm: (p) => call('tt:confirm', p),
  setKeys: (k) => call('keys:set', k),
  loginStart: (o) => call('acc:loginStart', o),
  loginPasted: (t) => call('acc:loginPasted', t),
  accToken: (t) => call('acc:token', t),
  accSave: (o) => call('acc:save', o),
  accSaveMany: (o) => call('acc:saveMany', o),
  accRemove: (o) => call('acc:remove', o),
  repoReset: (name) => call('repo:reset', name),
  openUrl: (u) => call('open:url', u),
  hide: () => call('win:hide'),
  quit: () => call('win:quit'),
  pin: (v) => call('win:pin', v),
  pathFor: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => on('upload:progress', cb),
  onAppearance: (cb) => on('appearance', cb),
  onRefresh: (cb) => on('refresh', cb),
  onHandoff: (cb) => on('handoff', cb),
  onConfig: (cb) => on('cfg', cb),
});
