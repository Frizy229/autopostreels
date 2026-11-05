'use strict';
// Копирует нужные иконки Lucide (ISC) в renderer/icons, чтобы не тащить весь пакет (55 МБ) в установщик.
const fs = require('fs');
const path = require('path');
const ICONS = ['search', 'film', 'scissors', 'layout-template', 'users', 'package', 'settings', 'folder-open', 'link', 'plus', 'play',
  'check', 'x', 'trash-2', 'scan-face', 'crop', 'download', 'refresh-cw', 'triangle-alert', 'circle-check', 'external-link', 'captions',
  'gamepad-2', 'clock', 'eye', 'square-check', 'square', 'list-video', 'audio-lines', 'shield-check', 'file-video', 'arrow-right',
  'cpu', 'hash', 'message-square', 'type', 'minus', 'circle-stop', 'sparkle', 'radio'];
const src = path.join(__dirname, '..', 'node_modules', 'lucide-static', 'icons');
const dst = path.join(__dirname, '..', 'renderer', 'icons');
fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const i of ICONS) {
  const f = path.join(src, `${i}.svg`);
  if (!fs.existsSync(f)) { console.warn('нет иконки', i); continue; }
  const svg = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->\s*/g, '');
  fs.writeFileSync(path.join(dst, `${i}.svg`), svg);
  n++;
}
fs.copyFileSync(path.join(src, '..', 'LICENSE'), path.join(dst, 'LICENSE')) ;
console.log(`иконок: ${n}`);
