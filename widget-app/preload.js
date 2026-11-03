'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (name, ...args) => {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) { const e = new Error(r.error); e.code = r.code; throw e; }
  return r.data;
};
const on = (ch, cb) => ipcRenderer.on(ch, (_e, v) => cb(v));

contextBridge.exposeInMainWorld('api', {
  getConfig: () => call('cfg:get'),
  setConfig: (patch) => call('cfg:set', patch),
  setToken: (t) => call('token:set', t),
  checkConnection: () => call('conn:check'),
  refresh: () => call('data:refresh'),
  pickFolder: () => call('folder:pick'),
  inspect: (p) => call('folder:inspect', p),
  upload: (p) => call('folder:upload', p),
  openUrl: (u) => call('open:url', u),
  hide: () => call('win:hide'),
  quit: () => call('win:quit'),
  pin: (v) => call('win:pin', v),
  pathFor: (file) => webUtils.getPathForFile(file),
  onProgress: (cb) => on('upload:progress', cb),
  onAppearance: (cb) => on('appearance', cb),
  onRefresh: (cb) => on('refresh', cb),
  onConfig: (cb) => on('cfg', cb),
});
