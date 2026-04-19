// Генератор PNG-иконок для расширения. Запуск: node gen-icons.js
// Создаёт icons/icon-16.png, icon-32.png, icon-48.png, icon-128.png
// с круглой "S" на фиолетовом градиенте (стиль Sipliy Folder).

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

// 5x7 пиксельная буква "S"
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
  // Цвета градиента (от primary к primary-container)
  const c1 = [107, 80, 154];   // #6b509a
  const c2 = [160, 131, 209];  // #a083d1
  const radius = size / 2 - 0.5;
  const cx = (size - 1) / 2, cy = (size - 1) / 2;
  const cornerR = size * 0.22;

  // Размер буквы
  const letterW = Math.floor(size * 0.45);
  const letterH = Math.floor(letterW * (FONT_S.length / FONT_S[0].length));
  const letterX = Math.floor((size - letterW) / 2);
  const letterY = Math.floor((size - letterH) / 2);

  // Пиксельный буфер: RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // фильтр None
    for (let x = 0; x < size; x++) {
      // Маска: скруглённый квадрат
      const dx = Math.max(0, Math.abs(x - cx) - (size / 2 - cornerR - 0.5));
      const dy = Math.max(0, Math.abs(y - cy) - (size / 2 - cornerR - 0.5));
      const dist = Math.sqrt(dx * dx + dy * dy);
      let alpha = 255;
      if (dist > cornerR) alpha = 0;
      else if (dist > cornerR - 1) alpha = Math.round(255 * (cornerR - dist));

      // Градиент сверху вниз
      const t = y / (size - 1);
      let r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      let g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      let b = Math.round(c1[2] + (c2[2] - c1[2]) * t);

      // Рисуем "S" белым внутри
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
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, 'icons');
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
[16, 32, 48, 128].forEach(s => {
  fs.writeFileSync(path.join(dir, `icon-${s}.png`), makePNG(s));
  console.log(`✓ icon-${s}.png`);
});
