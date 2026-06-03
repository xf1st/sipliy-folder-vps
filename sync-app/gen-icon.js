// Запустить через: node gen-icon.js
// Генерирует assets/icon.png без внешних зависимостей
const fs = require('fs');
const path = require('path');

// Минимальный PNG encoder (1×1 → 256×256 solid color заглушка не нужна,
// делаем нормальную иконку через raw PNG с нужными пикселями)
// Используем встроенный zlib для сжатия

const zlib = require('zlib');

const W = 256, H = 256;
const pixels = new Uint8Array(W * H * 4); // RGBA

// Рисуем пиксели вручную
function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = a;
}

function fillCircle(cx, cy, radius, r, g, b, a = 255) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx*dx + dy*dy <= radius*radius) setPixel(x, y, r, g, b, a);
    }
  }
}

function fillRect(x1, y1, x2, y2, r, g, b, a = 255) {
  for (let y = y1; y <= y2; y++)
    for (let x = x1; x <= x2; x++)
      setPixel(x, y, r, g, b, a);
}

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

// ── Background (rounded rect, dark purple-gray) ──────────────────────────
const rr = 52; // corner radius
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = Math.hypot(x / W, y / H);
    const bg_r = lerp(0x1c, 0x20, t);
    const bg_g = lerp(0x1b, 0x1f, t);
    const bg_b = lerp(0x1b, 0x1f, t);

    // Rounded corner check
    let inCorner = false;
    const corners = [[rr,rr],[W-rr,rr],[W-rr,H-rr],[rr,H-rr]];
    if (x < rr && y < rr) { const dx=x-rr,dy=y-rr; inCorner=dx*dx+dy*dy>rr*rr; }
    else if (x > W-rr && y < rr) { const dx=x-(W-rr),dy=y-rr; inCorner=dx*dx+dy*dy>rr*rr; }
    else if (x > W-rr && y > H-rr) { const dx=x-(W-rr),dy=y-(H-rr); inCorner=dx*dx+dy*dy>rr*rr; }
    else if (x < rr && y > H-rr) { const dx=x-rr,dy=y-(H-rr); inCorner=dx*dx+dy*dy>rr*rr; }

    if (!inCorner) setPixel(x, y, bg_r, bg_g, bg_b, 255);
    // else transparent (alpha = 0 by default)
  }
}

// ── Cloud body (purple gradient) ─────────────────────────────────────────
// Просто рисуем несколько кругов для формы облака
const cloudColor = (x, y) => {
  const t = (x - 44) / (180 - 44);
  return [lerp(0xa7, 0x7c, t), lerp(0x8b, 0x3a, t), lerp(0xfa, 0xed, t), 230];
};

// Основное тело
fillCircle(80, 148, 40, 0x90, 0x60, 0xd0, 230);
fillCircle(110, 132, 32, 0x98, 0x68, 0xd8, 230);
fillCircle(140, 124, 38, 0x9a, 0x50, 0xe0, 230);
fillCircle(166, 136, 28, 0x88, 0x44, 0xcc, 230);

// Заливаем промежутки внизу
fillRect(80, 148, 180, 168, 0x8a, 0x45, 0xce, 230);

// Перерисовываем с градиентом
for (let y = 100; y < 170; y++) {
  for (let x = 44; x < 192; x++) {
    const i = (y * W + x) * 4;
    if (pixels[i+3] > 200) {
      const t = Math.min(1, Math.max(0, (x - 44) / (180 - 44)));
      pixels[i]   = lerp(0xa7, 0x7c, t);
      pixels[i+1] = lerp(0x8b, 0x3a, t);
      pixels[i+2] = lerp(0xfa, 0xed, t);
      pixels[i+3] = 235;
    }
  }
}

// ── Sync arrows (white thick lines) ──────────────────────────────────────
function drawLine(x0, y0, x1, y1, thickness, r, g, b) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const steps = Math.ceil(len * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = Math.round(x0 + dx * t);
    const cy = Math.round(y0 + dy * t);
    fillCircle(cx, cy, thickness, r, g, b);
  }
}

const W_C = 255, T = 4; // white, thickness

// Левая стрелка (вниз)
drawLine(100, 160, 100, 196, T, W_C, W_C, W_C);
drawLine(82, 178, 100, 196, T, W_C, W_C, W_C);
drawLine(100, 196, 118, 178, T, W_C, W_C, W_C);

// Правая стрелка (вверх)
drawLine(156, 196, 156, 160, T, W_C, W_C, W_C);
drawLine(138, 178, 156, 160, T, W_C, W_C, W_C);
drawLine(156, 160, 174, 178, T, W_C, W_C, W_C);

// ── Encode PNG ────────────────────────────────────────────────────────────
function uint32BE(n) {
  return Buffer.from([(n>>24)&0xff,(n>>16)&0xff,(n>>8)&0xff,n&0xff]);
}
function crc32(buf) {
  let c = 0xffffffff;
  const table = [];
  for (let i=0;i<256;i++){let n=i;for(let j=0;j<8;j++)n=n&1?(0xedb88320^(n>>>1)):(n>>>1);table[i]=n;}
  for (let i=0;i<buf.length;i++) c=table[(c^buf[i])&0xff]^(c>>>8);
  return uint32BE((c^0xffffffff)>>>0);
}

function pngChunk(type, data) {
  const typeB = Buffer.from(type);
  const lenB  = uint32BE(data.length);
  const crcData = Buffer.concat([typeB, data]);
  return Buffer.concat([lenB, typeB, data, crc32(crcData)]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8]=8; ihdr[9]=6; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0; // 8-bit RGBA

// Raw image data (filter byte 0 per scanline)
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W*4)] = 0; // filter type None
  for (let x = 0; x < W; x++) {
    const src = (y * W + x) * 4;
    const dst = y * (1 + W*4) + 1 + x*4;
    raw[dst]   = pixels[src];
    raw[dst+1] = pixels[src+1];
    raw[dst+2] = pixels[src+2];
    raw[dst+3] = pixels[src+3];
  }
}

const compressed = zlib.deflateSync(raw, { level: 6 });

const png = Buffer.concat([
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), // PNG signature
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', compressed),
  pngChunk('IEND', Buffer.alloc(0)),
]);

const outPath = path.join(__dirname, 'assets', 'icon.png');
fs.writeFileSync(outPath, png);
console.log('✓ assets/icon.png создан (' + png.length + ' bytes)');
