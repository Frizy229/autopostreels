'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Ответ как есть ({ok, data, error, code}): contextBridge теряет у ошибок поля, кроме текста. Ошибку собирает app.js.
const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('api', {
  info: call('app:info'),
  getSettings: call('settings:get'),
  setSettings: call('settings:set'),
  toolsStatus: call('tools:status'),
  install: call('tools:install'),
  testEncoder: call('tools:testEncoder'),
  search: call('search'),
  addUrl: call('project:addUrl'),
  addFiles: call('project:addFiles'),
  addPath: call('project:addPath'),
  projects: call('project:list'),
  project: call('project:get'),
  updateProject: call('project:update'),
  removeProject: call('project:remove'),
  addMoment: call('project:addMoment'),
  frame: call('project:frame'),
  analyze: call('project:analyze'),
  check: call('project:check'),
  clip: call('project:clip'),
  build: call('build:start'),
  cancel: call('job:cancel'),
  pickFolder: call('dialog:folder'),
  openPath: call('open:path'),
  showItem: call('open:show'),
  openUrl: call('open:url'),
  pathOf: (file) => webUtils.getPathForFile(file),
  onJob: (cb) => ipcRenderer.on('job', (_e, v) => cb(v)),
});
