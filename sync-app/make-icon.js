/**
 * Генерирует иконку приложения в SVG и встраивает её как data-URL в HTML.
 * Запусти: node make-icon.js
 * Результат: assets/icon.svg (и инструкция как конвертировать в .ico)
 */
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir);

// SVG иконка — облако со стрелками синхронизации
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1c1b1b"/>
      <stop offset="100%" stop-color="#201f1f"/>
    </linearGradient>
    <linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#a78bfa"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>
  <!-- Background -->
  <rect width="256" height="256" rx="52" fill="url(#bg)"/>
  <!-- Cloud shape -->
  <path d="M180 148 A36 36 0 0 0 144 112 A52 52 0 0 0 44 136 A32 32 0 0 0 76 168 L180 168 A28 28 0 0 0 180 148Z"
        fill="url(#grad)" opacity="0.9"/>
  <!-- Sync arrows -->
  <g stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none">
    <!-- Arrow down-left -->
    <polyline points="118,178 100,196 82,178"/>
    <path d="M100,196 L100,168"/>
    <!-- Arrow up-right -->
    <polyline points="138,158 156,140 174,158"/>
    <path d="M156,140 L156,168"/>
  </g>
</svg>`;

fs.writeFileSync(path.join(assetsDir, 'icon.svg'), svg);
console.log('✓ assets/icon.svg создан');

// Создаём PNG-заглушку через встроенный модуль (без canvas)
// Просто копируем SVG как data и пишем HTML для preview
const htmlPreview = `<!DOCTYPE html><html><body style="background:#131313;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<img src="icon.svg" width="128" height="128">
<div style="color:#e5e2e1;font-family:sans-serif;margin-left:20px">
  <b>VPS Sync Manager Icon</b><br>
  Чтобы создать icon.ico для Windows:<br>
  1. Открой assets/icon.svg в браузере<br>
  2. Или используй https://convertio.co/svg-ico/<br>
  3. Сохрани как assets/icon.ico (256x256)
</div>
</body></html>`;
fs.writeFileSync(path.join(assetsDir, 'preview.html'), htmlPreview);
console.log('✓ assets/preview.html создан — открой в браузере чтобы увидеть иконку');
console.log('');
console.log('Для конвертации SVG → ICO используй:');
console.log('  https://convertio.co/svg-ico/');
console.log('  Или npm i -g sharp-ico (если нужно автоматизировать)');
