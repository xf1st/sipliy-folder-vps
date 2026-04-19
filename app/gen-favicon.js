// Генератор фавикона для сайта Sipliy Folder VPS
// Запуск: node gen-favicon.js
// Создаёт public/favicon-{32,180,192,512}.png и public/favicon.ico (PNG-as-ICO)

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const FONT_S = [
  [0,1,1,1,0],
  [1,0,0,0,0],
  [1,0,0,0,0],
  [0,1,1,0,0],
  [0,0,0,1,0],
  [0,0,0,1,0],
  [1,1,1,0,0],
];

function makePNG(size) {
  const c1 = [107, 80, 154];
  const c2 = [160, 131, 209];
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const cornerR = size * 0.22;

  const letterW = Math.floor(size * 0.45);
  const letterH = Math.floor(letterW * (FONT_S.length / FONT_S[0].length));
  const letterX = Math.floor((size - letterW) / 2);
  const letterY = Math.floor((size - letterH) / 2);

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      const dx = Math.max(0, Math.abs(x - cx) - (size / 2 - cornerR - 0.5));
      const dy = Math.max(0, Math.abs(y - cy) - (size / 2 - cornerR - 0.5));
      const dist = Math.sqrt(dx * dx + dy * dy);
      let alpha = 255;
      if (dist > cornerR) alpha = 0;
      else if (dist > cornerR - 1) alpha = Math.round(255 * (cornerR - dist));

      const t = y / (size - 1);
      let r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      let g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      let b = Math.round(c1[2] + (c2[2] - c1[2]) * t);

      const lx = x - letterX, ly = y - letterY;
      if (lx >= 0 && ly >= 0 && lx < letterW && ly < letterH && alpha > 0) {
        const fx = Math.floor(lx * FONT_S[0].length / letterW);
        const fy = Math.floor(ly * FONT_S.length / letterH);
        if (FONT_S[fy] && FONT_S[fy][fx]) {
          r = 255; g = 255; b = 255;
        }
      }

      row[1 + x * 4 + 0] = r;
      row[1 + x * 4 + 1] = g;
      row[1 + x * 4 + 2] = b;
      row[1 + x * 4 + 3] = alpha;
    }
    rows.push(row);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const compressed = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO-контейнер с встроенным PNG (поддерживается всеми браузерами)
function pngToIco(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: 1 = ICO
  header.writeUInt16LE(1, 4);   // count: 1 image

  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;  // width
  entry[1] = size === 256 ? 0 : size;  // height
  entry[2] = 0;                         // palette
  entry[3] = 0;                         // reserved
  entry.writeUInt16LE(1, 4);            // planes
  entry.writeUInt16LE(32, 6);           // bpp
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);          // offset (6 + 16)

  return Buffer.concat([header, entry, pngBuf]);
}

const dir = path.join(__dirname, 'public');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const sizes = { 32: 'favicon-32.png', 180: 'apple-touch-icon.png', 192: 'favicon-192.png', 512: 'favicon-512.png' };
Object.entries(sizes).forEach(([size, name]) => {
  const png = makePNG(parseInt(size));
  fs.writeFileSync(path.join(dir, name), png);
  console.log(`✓ ${name}`);
});

// favicon.ico = PNG 32x32, обёрнутый в ICO-контейнер
fs.writeFileSync(path.join(dir, 'favicon.ico'), pngToIco(makePNG(32), 32));
console.log('✓ favicon.ico');

// Web manifest для PWA
const manifest = {
  name: 'Sipliy Folder VPS',
  short_name: 'Sipliy',
  description: 'Личный VPS-загрузчик',
  start_url: '/',
  display: 'standalone',
  background_color: '#faf9fe',
  theme_color: '#6b509a',
  icons: [
    { src: '/favicon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/favicon-512.png', sizes: '512x512', type: 'image/png' },
  ],
};
fs.writeFileSync(path.join(dir, 'site.webmanifest'), JSON.stringify(manifest, null, 2));
console.log('✓ site.webmanifest');
