const path = require('path');
const config = require('./config');
const { SITE_VERSION } = config;
const db = require('./db');
const { loadUsers } = db;
const { htmlEscape } = require('./utils');

function sharePasswordPage(token, errorMsg = '') {
  return '<!DOCTYPE html><html lang="ru"><head><title>Защищенная ссылка</title>' + HEAD + '</head>' +
  '<body class="bg-background font-body text-on-surface min-h-screen flex items-center justify-center">' +
  '<div class="absolute inset-0 overflow-hidden pointer-events-none">' +
    '<div class="absolute -top-40 -right-40 w-96 h-96 bg-primary/5 rounded-full blur-3xl"></div>' +
    '<div class="absolute -bottom-40 -left-40 w-96 h-96 bg-primary-container/10 rounded-full blur-3xl"></div>' +
  '</div>' +
  '<div class="relative w-full max-w-sm mx-4">' +
    '<div class="bg-surface-container-lowest/80 glass rounded-4xl p-10 shadow-[0_32px_80px_rgba(107,80,154,0.08)] text-center">' +
      '<div class="w-14 h-14 mx-auto rounded-3xl bg-gradient-to-tr from-primary to-primary-container flex items-center justify-center shadow-lg shadow-purple-200 mb-6">' +
        '<span class="material-symbols-outlined text-white text-2xl">lock</span>' +
      '</div>' +
      '<h1 class="text-2xl font-headline font-extrabold text-on-primary-container tracking-tight">Доступ ограничен</h1>' +
      '<p class="text-secondary text-sm font-label mt-2 mb-6">Эта ссылка защищена паролем. Введите пароль для получения доступа.</p>' +
      '<form method="POST" action="/share/' + token + '/auth" class="space-y-4">' +
        '<div>' +
          '<input name="password" type="password" required class="w-full bg-surface-container-low border-none rounded-2xl px-5 py-3.5 text-on-surface font-body focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-outline" placeholder="Пароль доступа"/>' +
        '</div>' +
        (errorMsg ? '<div style="font-size:12px;font-weight:bold;color:#ffb4ab;margin-top:8px">' + htmlEscape(errorMsg) + '</div>' : '') +
        '<button type="submit" class="w-full btn-primary bg-primary hover:bg-primary-container text-white rounded-2xl py-3.5 font-bold transition-all shadow-md mt-4" style="width:100%">Подтвердить</button>' +
      '</form>' +
    '</div>' +
  '</div>' +
  '</body></html>';
}
function shareNotFoundPage() {
  return '<!DOCTYPE html><html lang="ru"><head><title>Ссылка недействительна</title>' + HEAD + '</head>' +
  '<body class="bg-background font-body text-on-surface min-h-screen flex items-center justify-center">' +
  '<div class="text-center">' +
    '<span class="material-symbols-outlined text-7xl text-outline-variant">link_off</span>' +
    '<h1 class="text-2xl font-headline font-bold text-on-primary-container mt-4 mb-2">Ссылка недействительна</h1>' +
    '<p class="text-secondary font-body">Файл был удалён или ссылка отозвана.</p>' +
  '</div>' +
  '</body></html>';
}
// ─── HTML ────────────────────────────────────────────────────────
function sharePreviewPage(s, token, filename, sizeStr) {
  const isVideo = ['.mp4','.webm','.ogg','.mov','.mkv'].includes(path.extname(filename).toLowerCase());
  const isImg = ['.png','.jpg','.jpeg','.gif','.webp','.svg','.bmp'].includes(path.extname(filename).toLowerCase());
  const isAudio = ['.mp3','.wav','.ogg','.m4a','.aac'].includes(path.extname(filename).toLowerCase());
  const dlUrl = '/share/' + token + '?dl=1';
  let previewHtml = '';
  let plyrInit = '';
  if (isVideo) {
    previewHtml = `<video id="plyr-player" src="${dlUrl}" playsinline controls style="max-width:100%; max-height:70vh; border-radius:8px;"></video>`;
    plyrInit = `<script>
      (function(){
        try {
          const player = new Plyr('#plyr-player', {
            controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen'],
            settings: ['captions', 'quality', 'speed', 'loop']
          });
          const key = "plyr_time_" + encodeURIComponent("${filename}");
          player.on('ready', () => { const t = localStorage.getItem(key); if(t) player.currentTime = parseFloat(t); });
          player.on('timeupdate', () => { localStorage.setItem(key, player.currentTime); });
        } catch(e) { console.error("Plyr error:", e); }
      })();
    </script>`;
  } else if (isImg) {
    previewHtml = `<img src="${dlUrl}" style="max-width:100%; max-height:70vh; border-radius:8px; object-fit:contain; background:#1e1a25;">`;
  } else if (isAudio) {
    previewHtml = `<div style="padding:40px; background:#1e1a25; border-radius:8px; text-align:center; width:100%; box-sizing:border-box;"><span class="material-symbols-outlined" style="font-size:64px; color:#a078ff;">audio_file</span><br><br><audio id="plyr-player" src="${dlUrl}" controls playsinline></audio></div>`;
    plyrInit = `<script>
      (function(){
        try {
          const player = new Plyr('#plyr-player', {
            controls: ['play', 'progress', 'current-time', 'duration', 'mute', 'volume']
          });
          const key = "plyr_time_" + encodeURIComponent("${filename}");
          player.on('ready', () => { const t = localStorage.getItem(key); if(t) player.currentTime = parseFloat(t); });
          player.on('timeupdate', () => { localStorage.setItem(key, player.currentTime); });
        } catch(e) { console.error("Plyr audio error:", e); }
      })();
    </script>`;
  } else {
    previewHtml = `<div style="padding:60px 40px; background:#1e1a25; border-radius:8px; text-align:center; width:100%;"><span class="material-symbols-outlined" style="font-size:64px; color:#a078ff;">insert_drive_file</span><div style="margin-top:15px; color:#cbc3d7; font-size:16px;">Предпросмотр недоступен для этого формата файла</div></div>`;
  }
  
  const escFn = (str) => String(str).replace(/[&<>'"]/g, match => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[match]));
  return '<!DOCTYPE html><html lang="ru"><head><title>' + escFn(filename) + '</title>' + HEAD + '</head>' +
  '<body style="background:#15121b; color:#fff; font-family:sans-serif; margin:0; display:flex; flex-direction:column; align-items:center; min-height:100vh;">' +
  '<div style="max-width:1000px; width:100%; padding:20px 20px 40px; box-sizing:border-box;">' +
    '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:15px; padding-top:20px;">' +
      '<div style="flex:1; min-width:200px;">' +
        '<div style="font-size:24px; font-weight:bold; color:#fff; word-break:break-all;">' + escFn(filename) + '</div>' +
        '<div style="color:#958ea0; font-size:15px; margin-top:6px;">' + sizeStr + ' • ' + (s.downloads||0) + ' скачиваний</div>' +
      '</div>' +
      '<a href="' + dlUrl + '" style="background:#a078ff; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold; display:inline-flex; align-items:center; gap:8px; transition:background 0.2s;" onmouseover="this.style.background=\'#b291ff\'" onmouseout="this.style.background=\'#a078ff\'">Скачать файл <span class="material-symbols-outlined">download</span></a>' +
    '</div>' +
    '<div style="display:flex; justify-content:center; align-items:center; background:#1e1a25; border-radius:12px; padding:20px; box-shadow:0 10px 30px rgba(0,0,0,0.3);">' +
      previewHtml +
    '</div>' +
  '</div>' + plyrInit +
  '</body></html>';
}
const HEAD = `<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link rel="icon" type="image/x-icon" href="/favicon.ico"/>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png"/>
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"/>
<link rel="manifest" href="/site.webmanifest"/>
<meta name="theme-color" content="#6b509a"/>
<script>if(localStorage.theme==='dark'||(!localStorage.theme&&matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')</script>
<script src="https://cdn.tailwindcss.com?plugins=forms"></script>
<script src="https://cdn.jsdelivr.net/npm/motion@10.18.0/dist/motion.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css" />
<script src="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.polyfilled.js"></script>
<style>
:root { --plyr-color-main: #a078ff; }
.media-viewer .plyr { height: 100%; width: 100%; border-radius: 14px; box-shadow: 0 24px 90px rgba(0,0,0,.55); background: #000; }
.media-viewer .plyr video, .media-viewer .plyr audio { max-height: 100%; width: 100%; object-fit: contain; }
</style>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>
<script>
if(window.tailwind)tailwind.config={darkMode:'class',theme:{extend:{colors:{"background":"rgb(var(--c-bg)/<alpha-value>)","surface":"rgb(var(--c-bg)/<alpha-value>)","surface-container-lowest":"rgb(var(--c-s0)/<alpha-value>)","surface-container-low":"rgb(var(--c-s1)/<alpha-value>)","surface-container":"rgb(var(--c-s2)/<alpha-value>)","surface-container-high":"rgb(var(--c-s3)/<alpha-value>)","surface-container-highest":"rgb(var(--c-s4)/<alpha-value>)","surface-variant":"rgb(var(--c-sv)/<alpha-value>)","primary":"rgb(var(--c-p)/<alpha-value>)","primary-container":"rgb(var(--c-pc)/<alpha-value>)","on-primary":"rgb(var(--c-op)/<alpha-value>)","on-primary-container":"rgb(var(--c-opc)/<alpha-value>)","primary-fixed-dim":"rgb(var(--c-pfd)/<alpha-value>)","secondary":"rgb(var(--c-sec)/<alpha-value>)","secondary-container":"rgb(var(--c-secc)/<alpha-value>)","on-secondary-container":"rgb(var(--c-osec)/<alpha-value>)","outline":"rgb(var(--c-out)/<alpha-value>)","outline-variant":"rgb(var(--c-outv)/<alpha-value>)","on-surface":"rgb(var(--c-os)/<alpha-value>)","on-surface-variant":"rgb(var(--c-osv)/<alpha-value>)","error":"rgb(var(--c-err)/<alpha-value>)","tertiary":"rgb(var(--c-ter)/<alpha-value>)"},fontFamily:{headline:["Plus Jakarta Sans"],body:["Manrope"],label:["Manrope"]},borderRadius:{"xl":"0.75rem","2xl":"1rem","3xl":"1.5rem","4xl":"2rem","full":"9999px"}}}}
</script>
<style>
:root{
  --c-bg:250 249 254;--c-s0:255 255 255;--c-s1:244 243 248;--c-s2:238 237 242;--c-s3:232 231 236;--c-s4:227 226 231;
  --c-sv:227 226 231;--c-p:107 80 154;--c-pc:160 131 209;--c-op:255 255 255;--c-opc:53 25 98;--c-pfd:213 187 255;
  --c-sec:99 91 110;--c-secc:234 222 245;--c-osec:105 97 116;--c-out:122 117 126;--c-outv:203 196 206;
  --c-os:26 28 31;--c-osv:73 69 78;--c-err:186 26 26;--c-ter:102 96 38;
}
html.dark{
  --c-bg:20 18 24;--c-s0:15 13 19;--c-s1:29 27 32;--c-s2:33 31 38;--c-s3:43 41 48;--c-s4:54 52 59;
  --c-sv:73 69 79;--c-p:208 188 255;--c-pc:79 55 139;--c-op:56 30 114;--c-opc:234 221 255;--c-pfd:208 188 255;
  --c-sec:204 194 220;--c-secc:74 68 88;--c-osec:204 194 220;--c-out:147 143 153;--c-outv:73 69 79;
  --c-os:230 225 229;--c-osv:202 196 207;--c-err:242 184 181;--c-ter:211 188 141;
}
html.dark aside{background:rgba(29,27,32,0.8)!important}
html.dark #vt-modal>div,html.dark #settings-modal>div{background:rgb(33,31,38)!important;border:1px solid rgb(73,69,79)}
html.dark #vt-modal .border-b,html.dark #settings-modal .border-b{border-color:rgb(73,69,79)!important}
html.dark .bg-white{background:rgb(33,31,38)!important}
html.dark [style*="background:#f4f3f8"]{background:rgb(43,41,48)!important;color:rgb(230,225,229)!important}
html.dark [style*="color:#1a1c1f"]{color:rgb(230,225,229)!important}
html.dark [style*="color:#635b6e"]{color:rgb(204,194,220)!important}
html.dark [style*="background:#fee2e2"]{background:rgba(242,184,181,0.15)!important}
body,aside,main,.file-card{transition:background-color 0.25s,border-color 0.25s,color 0.25s}
.glass{backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}
.material-symbols-outlined{font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24;vertical-align:middle}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgb(var(--c-outv));border-radius:9999px}
</style>`;
function landingPage() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sipliy Folder — VPS Downloader</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d0d12;--surf:#18171f;--surf2:#211f2a;--border:rgba(255,255,255,.08);--accent:#a78bfa;--accent2:#7c3aed;--text:#e8e3f4;--muted:#8b82a0;--green:#4ade80;--red:#f87171}
html{scroll-behavior:smooth}
body{font-family:Manrope,system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
a{color:inherit;text-decoration:none}
/* nav */
nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 32px;height:64px;border-bottom:1px solid var(--border);background:rgba(13,13,18,.85);backdrop-filter:blur(20px)}
.nav-logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:17px}
.nav-logo-icon{width:32px;height:32px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:900;color:#fff}
.nav-links{display:flex;align-items:center;gap:6px}
.btn-nav{padding:8px 18px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:.15s}
.btn-ghost-nav{background:transparent;color:var(--muted);border:1px solid var(--border)}
.btn-ghost-nav:hover{color:var(--text);background:rgba(255,255,255,.06)}
.btn-primary-nav{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff}
.btn-primary-nav:hover{opacity:.9}
/* hero */
.hero{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:100px 24px 80px;text-align:center;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-200px;left:50%;transform:translateX(-50%);width:700px;height:700px;background:radial-gradient(circle,rgba(124,58,237,.22) 0%,transparent 70%);pointer-events:none}
.hero::after{content:'';position:absolute;bottom:-100px;right:-100px;width:400px;height:400px;background:radial-gradient(circle,rgba(167,139,250,.1) 0%,transparent 70%);pointer-events:none}
.badge{display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border-radius:20px;background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.25);font-size:12px;font-weight:600;color:var(--accent);margin-bottom:28px;letter-spacing:.04em}
.badge-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(.85)}}
h1{font-size:clamp(36px,6vw,72px);font-weight:800;line-height:1.1;letter-spacing:-.03em;margin-bottom:22px;background:linear-gradient(135deg,#fff 30%,var(--accent));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.hero-sub{font-size:clamp(15px,2.5vw,20px);color:var(--muted);max-width:540px;line-height:1.6;margin-bottom:44px;font-weight:500}
.hero-btns{display:flex;gap:14px;flex-wrap:wrap;justify-content:center;margin-bottom:64px}
.btn-hero-primary{padding:14px 30px;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;font-size:15px;font-weight:700;border:none;cursor:pointer;transition:.15s;display:inline-flex;align-items:center;gap:8px}
.btn-hero-primary:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(124,58,237,.45)}
.btn-hero-ghost{padding:14px 30px;border-radius:14px;background:transparent;color:var(--text);font-size:15px;font-weight:600;border:1.5px solid var(--border);cursor:pointer;transition:.15s}
.btn-hero-ghost:hover{border-color:rgba(167,139,250,.4);background:rgba(167,139,250,.06)}
/* feature grid */
section{padding:80px 24px;max-width:1100px;margin:0 auto}
.section-label{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);margin-bottom:14px;text-align:center}
.section-title{font-size:clamp(26px,4vw,40px);font-weight:800;letter-spacing:-.02em;text-align:center;margin-bottom:52px}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}
.feat-card{background:var(--surf);border:1px solid var(--border);border-radius:20px;padding:28px;transition:.2s}
.feat-card:hover{border-color:rgba(167,139,250,.3);transform:translateY(-3px)}
.feat-icon{width:46px;height:46px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:18px}
.feat-title{font-size:16px;font-weight:700;margin-bottom:8px}
.feat-desc{font-size:14px;color:var(--muted);line-height:1.6}
/* how it works */
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:24px;margin-top:48px}
.step{text-align:center;padding:0 16px}
.step-num{width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#fff;margin:0 auto 16px}
.step-title{font-size:15px;font-weight:700;margin-bottom:6px}
.step-desc{font-size:13px;color:var(--muted);line-height:1.55}
/* ext preview */
.preview-box{background:var(--surf);border:1px solid var(--border);border-radius:24px;padding:36px;text-align:center;margin-top:60px;position:relative;overflow:hidden}
.preview-box::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent)}
/* cta */
.cta-section{padding:80px 24px;text-align:center}
.cta-box{max-width:600px;margin:0 auto;background:var(--surf);border:1px solid rgba(167,139,250,.2);border-radius:28px;padding:52px 40px;position:relative;overflow:hidden}
.cta-box::before{content:'';position:absolute;top:-100px;left:50%;transform:translateX(-50%);width:400px;height:300px;background:radial-gradient(circle,rgba(124,58,237,.18) 0%,transparent 70%);pointer-events:none}
.cta-title{font-size:clamp(22px,4vw,36px);font-weight:800;margin-bottom:14px;letter-spacing:-.02em}
.cta-sub{color:var(--muted);font-size:15px;margin-bottom:36px;line-height:1.55}
/* footer */
footer{border-top:1px solid var(--border);padding:28px 32px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;font-size:13px;color:var(--muted)}
footer a{color:var(--muted);transition:.15s}
footer a:hover{color:var(--accent)}
@media(max-width:600px){nav{padding:0 16px}.hero-btns{flex-direction:column;align-items:center}.cta-box{padding:36px 24px}footer{justify-content:center;text-align:center}}
</style>
</head>
<body>

<nav>
  <div class="nav-logo">
    <div class="nav-logo-icon">S</div>
    Sipliy Folder
  </div>
  <div class="nav-links">
    <a href="/privacy" class="btn-nav btn-ghost-nav">Privacy</a>
    <a href="/login" class="btn-nav btn-primary-nav">Войти</a>
  </div>
</nav>

<!-- HERO -->
<div class="hero">
  <div class="badge"><span class="badge-dot"></span>Self-hosted · Open &amp; Private</div>
  <h1>Скачай всё<br>на свой VPS</h1>
  <p class="hero-sub">Один клик — и файл уже на сервере. YouTube, Vimeo, прямые ссылки. Следи за прогрессом и забирай на ПК прямо из браузерного расширения.</p>
  <div class="hero-btns">
    <a href="/login" class="btn-hero-primary">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/></svg>
      Открыть CloudSpace
    </a>
    <a href="#features" class="btn-hero-ghost">Что умеет →</a>
  </div>
</div>

<!-- FEATURES -->
<section id="features">
  <div class="section-label">Возможности</div>
  <div class="section-title">Всё что нужно для загрузок</div>
  <div class="features">
    <div class="feat-card">
      <div class="feat-icon" style="background:rgba(167,139,250,.14)">📥</div>
      <div class="feat-title">Загрузка по URL</div>
      <div class="feat-desc">Вставь любую ссылку — прямой файл, YouTube, Vimeo и сотни других площадок. VPS скачает сам, пока ты занимаешься другим.</div>
    </div>
    <div class="feat-card">
      <div class="feat-icon" style="background:rgba(74,222,128,.1)">🎬</div>
      <div class="feat-title">Медиа с выбором качества</div>
      <div class="feat-desc">Видео до 4K, MP3-аудио, лучший доступный формат. Селекторы разрешения и контейнера (MP4/MKV) прямо в диалоге.</div>
    </div>
    <div class="feat-card">
      <div class="feat-icon" style="background:rgba(96,165,250,.1)">🗂</div>
      <div class="feat-title">Файловый менеджер</div>
      <div class="feat-desc">Папки, предпросмотр, публичные ссылки с паролями и лимитами скачиваний. Всё в браузере, без FTP.</div>
    </div>
    <div class="feat-card">
      <div class="feat-icon" style="background:rgba(251,191,36,.1)">⚡</div>
      <div class="feat-title">Прогресс в реальном времени</div>
      <div class="feat-desc">Видишь скорость, ETA и текущую фазу — «Загрузка видео», «Слияние файлов». Не нужно гадать завершилось ли.</div>
    </div>
    <div class="feat-card">
      <div class="feat-icon" style="background:rgba(248,113,113,.1)">🧩</div>
      <div class="feat-title">Расширение для браузера</div>
      <div class="feat-desc">Кнопка прямо на YouTube. Правый клик по любой ссылке → «Скачать на VPS». Прогресс загрузки прямо в попапе расширения.</div>
    </div>
    <div class="feat-card">
      <div class="feat-icon" style="background:rgba(52,211,153,.1)">🔒</div>
      <div class="feat-title">Приватно и самохостинг</div>
      <div class="feat-desc">Данные хранятся только на твоём VPS. Никаких облаков третьих сторон, никакой аналитики, никаких логов.</div>
    </div>
  </div>
</section>

<!-- HOW IT WORKS -->
<section id="how">
  <div class="section-label">Как это работает</div>
  <div class="section-title">Три шага — и файл на месте</div>
  <div class="steps">
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-title">Вставь ссылку</div>
      <div class="step-desc">В CloudSpace, правым кликом через расширение или кнопкой прямо на YouTube</div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-title">VPS скачивает</div>
      <div class="step-desc">Сервер тянет файл напрямую — со скоростью дата-центра, даже если ты закрыл браузер</div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-title">Забери на ПК</div>
      <div class="step-desc">Один клик в файловом менеджере или прямо из попапа расширения — файл у тебя</div>
    </div>
  </div>
</section>

<!-- CTA -->
<div class="cta-section">
  <div class="cta-box">
    <div class="cta-title">Готов попробовать?</div>
    <p class="cta-sub">CloudSpace уже запущен. Войди в аккаунт или установи расширение для браузера.</p>
    <div style="display:flex;gap:14px;flex-wrap:wrap;justify-content:center">
      <a href="/login" class="btn-hero-primary" style="padding:12px 26px;font-size:14px">Открыть CloudSpace</a>
      <a href="/ext/update" class="btn-hero-ghost" style="padding:12px 26px;font-size:14px">Скачать расширение</a>
    </div>
  </div>
</div>

<footer>
  <div style="display:flex;align-items:center;gap:8px">
    <div class="nav-logo-icon" style="width:24px;height:24px;border-radius:7px;font-size:11px">S</div>
    <span>Sipliy Folder VPS</span>
  </div>
  <div style="display:flex;gap:20px">
    <a href="/privacy">Privacy Policy</a>
    <a href="/ext/update">Extension</a>
    <a href="/login">Login</a>
  </div>
</footer>

</body>
</html>`;
}

function privacyPage() {
  const updated = 'June 3, 2025';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy — Sipliy Folder VPS</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d0d12;--surf:#18171f;--border:rgba(255,255,255,.08);--accent:#a78bfa;--text:#e8e3f4;--muted:#8b82a0}
body{font-family:Manrope,system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7;font-size:15px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header{border-bottom:1px solid var(--border);padding:20px 32px;display:flex;align-items:center;justify-content:space-between}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:16px}
.logo-icon{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#a78bfa,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;color:#fff}
.container{max-width:740px;margin:0 auto;padding:56px 24px 80px}
.meta{font-size:13px;color:var(--muted);margin-bottom:48px}
h1{font-size:32px;font-weight:800;letter-spacing:-.02em;margin-bottom:10px}
h2{font-size:18px;font-weight:700;margin:40px 0 12px;color:var(--text)}
p{color:#c4bdd6;margin-bottom:14px}
ul{color:#c4bdd6;padding-left:22px;margin-bottom:14px}
ul li{margin-bottom:6px}
.highlight{background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.2);border-radius:12px;padding:18px 22px;margin:24px 0;font-size:14px;color:var(--text)}
.highlight strong{color:var(--accent)}
footer{border-top:1px solid var(--border);padding:24px 32px;text-align:center;font-size:13px;color:var(--muted)}
</style>
</head>
<body>

<header>
  <a href="/" style="text-decoration:none;color:inherit">
    <div class="logo"><div class="logo-icon">S</div>Sipliy Folder VPS</div>
  </a>
  <a href="/" style="font-size:13px;color:var(--muted)">← Back</a>
</header>

<div class="container">
  <h1>Privacy Policy</h1>
  <p class="meta">Last updated: ${updated}</p>

  <div class="highlight">
    <strong>Short version:</strong> Sipliy Folder VPS is a self-hosted application. All your data stays on <strong>your own server</strong>. We do not collect, store, or transmit any personal information to third parties.
  </div>

  <h2>1. What is Sipliy Folder VPS?</h2>
  <p>Sipliy Folder VPS is a self-hosted download manager consisting of a Node.js server application and a companion browser extension. You install and run this software on your own VPS (Virtual Private Server). We do not operate any shared servers or cloud services on your behalf.</p>

  <h2>2. Data We Do Not Collect</h2>
  <p>Because this is self-hosted software, <strong>we (the developers) collect no data whatsoever</strong>. Specifically:</p>
  <ul>
    <li>No usage analytics or telemetry</li>
    <li>No crash reports sent to external servers</li>
    <li>No account information shared with third parties</li>
    <li>No download history or file metadata sent anywhere</li>
  </ul>

  <h2>3. Data Stored on Your Server</h2>
  <p>The following data is stored <strong>only on your own VPS</strong>, under your full control:</p>
  <ul>
    <li><strong>Account credentials</strong> — usernames and bcrypt-hashed passwords in a local JSON file</li>
    <li><strong>Session tokens</strong> — stored in memory or on disk, used to keep you logged in</li>
    <li><strong>Download history</strong> — URLs you submitted and job status, stored locally</li>
    <li><strong>Files</strong> — files downloaded to your VPS are stored in your designated downloads folder</li>
    <li><strong>Extension settings</strong> — server URL and bearer token, stored in <code>chrome.storage.sync</code> (synced via your own Google account, subject to Google's privacy policy)</li>
  </ul>

  <h2>4. Browser Extension — Permissions</h2>
  <p>The Sipliy Folder VPS browser extension requests the following permissions:</p>
  <ul>
    <li><strong>contextMenus</strong> — to add a "Download to VPS" right-click menu item</li>
    <li><strong>storage</strong> — to save your server URL, token, and preferences locally</li>
    <li><strong>notifications</strong> — to show download completion notifications</li>
    <li><strong>downloads</strong> — to download completed files from your VPS to your PC</li>
    <li><strong>cookies</strong> — to read YouTube authentication cookies and pass them to your VPS server, enabling yt-dlp to download age-restricted or member-only videos on your behalf. Cookies are sent <strong>only to your own VPS server</strong> and nowhere else.</li>
    <li><strong>alarms</strong> — to periodically refresh the download status badge</li>
  </ul>
  <p>The extension communicates <strong>exclusively</strong> with the server URL you configure. No data is sent to any other destination.</p>

  <h2>5. Third-Party Services</h2>
  <p>The server application uses <strong>yt-dlp</strong> to download media from platforms such as YouTube. When you request a download, your VPS sends a network request to the target platform directly. This is subject to that platform's own terms of service and privacy policy.</p>
  <p>The landing page loads fonts from Google Fonts. This request is made by your browser directly to Google's servers and is subject to <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google's Privacy Policy</a>.</p>

  <h2>6. Data Retention &amp; Deletion</h2>
  <p>Since all data lives on your own server, you have complete control over retention and deletion. You can delete accounts, download history, and files at any time through the application interface or directly on the server filesystem.</p>

  <h2>7. Children's Privacy</h2>
  <p>This software is not directed at children under 13. We do not knowingly collect any information from children.</p>

  <h2>8. Changes to This Policy</h2>
  <p>We may update this Privacy Policy occasionally. The "Last updated" date at the top of this page reflects the most recent revision. Continued use of the software after changes constitutes acceptance of the updated policy.</p>

  <h2>9. Contact</h2>
  <p>If you have questions about this Privacy Policy, you can open an issue on the project repository or contact the developer directly.</p>
</div>

<footer>© 2025 Sipliy Folder VPS · <a href="/">Home</a> · Self-hosted software</footer>

</body>
</html>`;
}

function loginPage(error) {
  return '<!DOCTYPE html><html lang="ru"><head><title>VPS Downloader</title>' + HEAD + '</head>' +
  '<body class="bg-background font-body text-on-surface min-h-screen flex items-center justify-center">' +
  '<div class="absolute inset-0 overflow-hidden pointer-events-none">' +
    '<div class="absolute -top-40 -right-40 w-96 h-96 bg-primary/5 rounded-full blur-3xl"></div>' +
    '<div class="absolute -bottom-40 -left-40 w-96 h-96 bg-primary-container/10 rounded-full blur-3xl"></div>' +
  '</div>' +
  '<div class="relative w-full max-w-sm mx-4">' +
    '<div class="bg-surface-container-lowest/80 glass rounded-4xl p-10 shadow-[0_32px_80px_rgba(107,80,154,0.08)]">' +
      '<div class="flex flex-col items-center mb-8">' +
        '<div class="w-14 h-14 rounded-3xl bg-gradient-to-tr from-primary to-primary-container flex items-center justify-center shadow-lg shadow-purple-200 mb-4">' +
          '<span class="material-symbols-outlined text-white text-2xl">cloud_download</span>' +
        '</div>' +
        '<h1 class="text-2xl font-headline font-extrabold text-on-primary-container tracking-tight">VPS Downloader</h1>' +
        '<p class="text-secondary text-sm font-label mt-1">Войдите в свой аккаунт</p>' +
      '</div>' +
      '<form method="POST" action="/login" class="space-y-4">' +
        '<div><label class="text-xs font-label text-secondary uppercase tracking-widest mb-2 block">Логин</label>' +
        '<input name="username" type="text" required autocomplete="username" class="w-full bg-surface-container-low border-none rounded-2xl px-5 py-3.5 text-on-surface font-body focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-outline" placeholder="Ваш логин"/></div>' +
        '<div><label class="text-xs font-label text-secondary uppercase tracking-widest mb-2 block">Пароль</label>' +
        '<input name="password" type="password" required autocomplete="current-password" class="w-full bg-surface-container-low border-none rounded-2xl px-5 py-3.5 text-on-surface font-body focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-outline" placeholder="••••••••"/></div>' +
        (error ? '<div class="bg-red-50 text-error text-sm font-label px-4 py-3 rounded-2xl">⚠ ' + error + '</div>' : '') +
        '<button type="submit" class="w-full mt-2 py-4 bg-gradient-to-r from-primary to-primary-container text-white rounded-full font-headline font-bold text-sm tracking-tight shadow-xl shadow-primary/20 hover:opacity-90 active:scale-95 transition-all">Войти</button>' +
      '</form>' +
    '</div>' +
  '</div>' +
  '</body></html>';
}
function faqPage() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>FAQ & Решение проблем — CloudSpace</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>ℹ️</text></svg>">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&family=Manrope:wght@400;500;700;800&display=swap">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200">
  <style>
    :root {
      --bg: #12101a;
      --surf: #1b1b1f;
      --surf-cont: #1f1f23;
      --surf-hi: #2a292e;
      --on-surf: #e4e1e7;
      --on-surf-var: #c9c5cf;
      --outline: #84948b;
      --accent-color: #a078ff;
      --accent-light: #d2bbff;
      --accent-gradient: linear-gradient(135deg, #a078ff, #7c3aed);
      --font-display: "Plus Jakarta Sans", Manrope, sans-serif;
    }
    body {
      font-family: Manrope, sans-serif;
      background: var(--bg);
      color: var(--on-surf);
      margin: 0;
      padding: 0;
      line-height: 1.6;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      box-sizing: border-box;
    }
    .container {
      width: 100%;
      max-width: 760px;
      padding: 40px 24px;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 32px;
    }
    .header-icon {
      width: 52px;
      height: 52px;
      border-radius: 18px;
      background: var(--accent-gradient);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      box-shadow: 0 8px 24px rgba(160, 120, 255, 0.3);
    }
    .header-icon span {
      font-size: 28px;
    }
    h1 {
      font-family: var(--font-display);
      font-size: 28px;
      font-weight: 800;
      margin: 0;
      color: #fff;
      letter-spacing: -0.5px;
    }
    .header-sub {
      font-size: 14px;
      color: var(--on-surf-var);
      margin-top: 4px;
    }
    .card {
      background: var(--surf-cont);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 24px;
      padding: 28px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
      margin-bottom: 20px;
    }
    .faq-item {
      margin-bottom: 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      padding-bottom: 24px;
    }
    .faq-item:last-child {
      margin-bottom: 0;
      border-bottom: none;
      padding-bottom: 0;
    }
    .faq-question {
      font-family: var(--font-display);
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .faq-question span {
      color: var(--accent-light);
    }
    .faq-answer {
      font-size: 14px;
      color: var(--on-surf-var);
    }
    .faq-answer p {
      margin: 0 0 12px;
    }
    .faq-answer p:last-child {
      margin-bottom: 0;
    }
    .faq-answer ul, .faq-answer ol {
      margin: 8px 0;
      padding-left: 20px;
    }
    .faq-answer li {
      margin-bottom: 6px;
    }
    .badge {
      background: rgba(160, 120, 255, 0.15);
      border: 1px solid rgba(160, 120, 255, 0.3);
      color: var(--accent-light);
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    a {
      color: var(--accent-light);
      text-decoration: none;
      border-bottom: 1px dotted var(--accent-light);
      transition: color 0.2s, border-color 0.2s;
    }
    a:hover {
      color: #fff;
      border-bottom-color: #fff;
    }
    .btn-back {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--surf-hi);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--on-surf);
      font-size: 13px;
      font-weight: 700;
      padding: 10px 20px;
      border-radius: 9999px;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.2s, border-color 0.2s, transform 0.2s;
      margin-top: 10px;
    }
    .btn-back:hover {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
      transform: translateY(-1px);
    }
    .alert-box {
      background: rgba(255, 100, 80, 0.1);
      border: 1px solid rgba(255, 100, 80, 0.25);
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 20px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .alert-box span {
      color: #ff6454;
      font-size: 24px;
      flex-shrink: 0;
    }
    .alert-box-content {
      font-size: 13px;
      color: #ffdad6;
      line-height: 1.5;
    }
    .alert-box-content b {
      color: #fff;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-icon">
        <span class="material-symbols-outlined">help_center</span>
      </div>
      <div>
        <h1>FAQ и Решение проблем</h1>
        <div class="header-sub">Помощь по скачиванию видео и настройке YouTube Cookies</div>
      </div>
    </div>

    <div class="alert-box">
      <span class="material-symbols-outlined">warning</span>
      <div class="alert-box-content">
        <b>Не скачивается YouTube видео?</b> YouTube ввёл жесткие ограничения на скачивание со сторонних серверов (включая VPS). Без загруженного файла cookies.txt большинство видеороликов (особенно приватные, с ограничением по возрасту или новые видео) скачиваться не будут.
      </div>
    </div>

    <div class="card">
      <div class="faq-item">
        <div class="faq-question">
          <span class="material-symbols-outlined">cookie</span>
          Как настроить YouTube Cookies для загрузки?
        </div>
        <div class="faq-answer">
          <p>Чтобы скачивание работало стабильно, вам необходимо передать серверу файл авторизации cookies с вашего браузера:</p>
          <ol>
            <li>Установите расширение в браузер (например, <b>Get cookies.txt LOCALLY</b> для Chrome/Edge/Opera или <b>cookies.txt</b> для Firefox).</li>
            <li>Откройте сайт <a href="https://www.youtube.com" target="_blank">YouTube</a> в новой вкладке и убедитесь, что вы авторизованы (или просто находитесь на главной странице).</li>
            <li>Нажмите на иконку расширения и выберите <b>Export</b> (или скачайте cookies для домена youtube.com). Файл должен называться примерно <code>youtube.com_cookies.txt</code> или <code>cookies.txt</code>.</li>
            <li>Перейдите в CloudSpace → <b>Настройки</b> → раздел <b>🍪 YouTube Cookies</b>.</li>
            <li>Нажмите <b>Загрузить cookies.txt</b> и выберите скачанный файл.</li>
          </ol>
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-question">
          <span class="material-symbols-outlined">error</span>
          Что делать при ошибке "Requested format is not available"?
        </div>
        <div class="faq-answer">
          <p>Эта ошибка возникает, когда YouTube блокирует запросы к определенным потокам видео или требует подтверждения возраста/авторизации.</p>
          <ul>
            <li>Убедитесь, что вы загрузили свежий файл cookies.txt в настройках CloudSpace.</li>
            <li>Попробуйте сменить тип загрузки с <b>Видео</b> на <b>Лучшее качество</b> (или наоборот).</li>
            <li>Cookies имеют свойство устаревать. Если скачивание работало, но перестало — удалите старые куки в настройках и загрузите новые.</li>
          </ul>
        </div>
      </div>

      <div class="faq-item">
        <div class="faq-question">
          <span class="material-symbols-outlined">admin_panel_settings</span>
          Кто может управлять YouTube Cookies?
        </div>
        <div class="faq-answer">
          <p>Любой авторизованный пользователь CloudSpace может загружать и удалять собственные YouTube Cookies.</p>
          <p>Сервер автоматически использует ваши личные cookies при ваших скачиваниях. Если у вас они не загружены, сервер попытается использовать общие cookies, предоставленные администратором.</p>
        </div>
      </div>
    </div>

    <a href="/cloud" class="btn-back">
      <span class="material-symbols-outlined">arrow_back</span>
      Вернуться в CloudSpace
    </a>
  </div>
</body>
</html>`;
}

function cloudPage(username) { // v3 — multiselect + upload progress + disk fix
  const cloudUsers = loadUsers();
  const profile = cloudUsers[username] || {};
  const profileLabel = profile.label || username;
  const profileInitial = (profileLabel || username || '?').trim().charAt(0).toUpperCase() || '?';
  const profileRole = profile.isAdmin ? 'Admin' : 'User';
  const safeUsername = htmlEscape(username);
  const safeProfileLabel = htmlEscape(profileLabel);
  const safeProfileInitial = htmlEscape(profileInitial);
  const safeProfileRole = htmlEscape(profileRole);
  return '<!DOCTYPE html>' +
  '<html lang="ru">' +
  '<head>' +
  '<meta charset="UTF-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>CloudSpace - ' + safeUsername + '</title>' +
  '<script src="https://cdn.tailwindcss.com"></script>' +
  '<script>' +
  'function hexToRgb(h){var r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return[r,g,b];}' +
  'function darkenHex(h,f){var c=hexToRgb(h);return"#"+c.map(function(x){return Math.max(0,Math.round(x*f)).toString(16).padStart(2,"0");}).join("");}' +
  'function lightenHex(h,f){var c=hexToRgb(h);return"#"+c.map(function(x){return Math.min(255,Math.round(x+(255-x)*f)).toString(16).padStart(2,"0");}).join("");}' +
  'function rgbToHsl(r,g,b){r/=255;g/=255;b/=255;var max=Math.max(r,g,b),min=Math.min(r,g,b);var h=0,s=0,l=(max+min)/2;if(max!==min){var d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);switch(max){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break;}}return[Math.round(h*360),Math.round(s*100),Math.round(l*100)];}' +
  'function applyAccentColor(){' +
  '  var presets={"violet":"#a078ff","emerald":"#10b981","ruby":"#f43f5e","glacier":"#06b6d4"};' +
  '  var hex=localStorage.getItem("cloud-accent-hex")||presets[localStorage.getItem("cloud-accent")]||"#a078ff";' +
  '  var c=hexToRgb(hex);' +
  '  var hover=darkenHex(hex,0.78);' +
  '  var light=lightenHex(hex,0.6);' +
  '  var glow="rgba("+c[0]+","+c[1]+","+c[2]+",0.24)";' +
  '  var bg="rgba("+c[0]+","+c[1]+","+c[2]+",0.14)";' +
  '  var hsl=rgbToHsl(c[0],c[1],c[2]);' +
  '  var h=hsl[0];' +
  '  var isLight=localStorage.getItem("fm-theme")==="light";' +
  '  var bodyBg,surf,surfCont,surfHi;' +
  '  if(isLight){' +
  '    bodyBg="hsl("+h+",24%,96%)";' +
  '    surf="hsl("+h+",18%,100%)";' +
  '    surfCont="hsl("+h+",16%,94%)";' +
  '    surfHi="hsl("+h+",12%,87%)";' +
  '  } else {' +
  '    bodyBg="hsl("+h+",18%,7%)";' +
  '    surf="hsl("+h+",14%,11%)";' +
  '    surfCont="hsl("+h+",12%,14%)";' +
  '    surfHi="hsl("+h+",10%,18%)";' +
  '  }' +
  '  var root=document.documentElement;' +
  '  root.style.setProperty("--accent-color",hex);' +
  '  root.style.setProperty("--accent-glow",glow);' +
  '  root.style.setProperty("--accent-hover",hover);' +
  '  root.style.setProperty("--accent-bg",bg);' +
  '  root.style.setProperty("--accent-light",light);' +
  '  root.style.setProperty("--accent-gradient","linear-gradient(135deg,"+hex+","+hover+")");' +
  '  root.style.setProperty("--bg",bodyBg);' +
  '  root.style.setProperty("--surf",surf);' +
  '  root.style.setProperty("--surf-cont",surfCont);' +
  '  root.style.setProperty("--surf-hi",surfHi);' +
  '}' +
  'applyAccentColor();' +
  '</script>' +
  '<link rel="preconnect" href="https://fonts.googleapis.com">' +
  '<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&display=swap" rel="stylesheet">' +
  '<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">' +
  '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css">' +
  '<script src="https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.polyfilled.js"></script>' +
  '<script>window.addEventListener("load",function(){var s=document.createElement("span");s.className="material-symbols-outlined";s.textContent="settings";s.style.cssText="position:absolute;visibility:hidden;font-size:24px;max-width:none;width:auto";document.body.appendChild(s);if(s.offsetWidth>36)document.documentElement.classList.add("no-symbol-font");s.remove();});</script>' +
  '<style>' +
  ':root{--m3-spring:cubic-bezier(0.34,1.56,0.64,1);--m3-std:cubic-bezier(0.2,0,0,1);--surf:#1b1b1f;--surf-cont:#1f1f23;--surf-hi:#2a292e;--on-surf:#e4e1e7;--on-surf-var:#c9c5cf;--outline:#84948b;--outline-var:#3b4a43;--accent-color:#a078ff;--accent-glow:rgba(160,120,255,0.28);--accent-hover:#7c3aed;--accent-bg:rgba(160,120,255,0.16);--accent-light:#d2bbff;--accent-gradient:linear-gradient(135deg,#a078ff,#7c3aed);--plyr-color-main:var(--accent-color);--font-display:"Plus Jakarta Sans",Manrope,sans-serif}' +
  '*{box-sizing:border-box}' +
  'body{font-family:Manrope,sans-serif;background:var(--bg,#12101a);color:var(--on-surf);letter-spacing:0;transition:background .5s var(--m3-std),color .3s;}' +
  '.material-symbols-outlined{font-family:"Material Symbols Outlined";font-variation-settings:"FILL" 0,"wght" 500,"GRAD" 0,"opsz" 24;line-height:1;vertical-align:middle;display:inline-flex;align-items:center;justify-content:center;max-width:1.25em;overflow:hidden;white-space:nowrap;text-transform:none}' +
  '.no-symbol-font .material-symbols-outlined{font-size:0!important;width:1.25em;min-width:1.25em;color:transparent!important}' +
  'body.flex{display:flex}' +
  '.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}.items-center{align-items:center}.justify-center{justify-content:center}.justify-between{justify-content:space-between}.gap-2{gap:8px}.gap-3{gap:12px}.sticky{position:sticky}.top-0{top:0}.h-screen{height:100vh}.overflow-y-auto{overflow-y:auto}.px-4{padding-left:16px;padding-right:16px}.py-6{padding-top:24px;padding-bottom:24px}.mb-6{margin-bottom:24px}' +
  '::-webkit-scrollbar{width:5px;height:5px}' +
  '::-webkit-scrollbar-track{background:transparent}' +
  '::-webkit-scrollbar-thumb{background:var(--outline-var);border-radius:9999px}' +
  '::-webkit-scrollbar-thumb:hover{background:var(--outline)}' +
  '.mobile-topbar,.mobile-bottom-nav{display:none}' +
  '.sidebar{background:var(--surf);width:272px;min-height:100vh;flex-shrink:0;border-radius:0 28px 28px 0;box-shadow:6px 0 40px rgba(0,0,0,.38),inset -1px 0 0 rgba(255,255,255,.05),inset 0 1px 0 rgba(255,255,255,.04)}' +
  '.card{background:var(--surf-cont);border:none;border-radius:24px;box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 2px 16px rgba(0,0,0,.28)}' +
  '.btn-primary{background:var(--accent-color);color:#fff;border-radius:9999px;padding:10px 24px;font-weight:700;font-size:14px;border:none;cursor:pointer;transition:transform var(--m3-spring) .35s,box-shadow .25s,opacity .2s;min-height:44px;letter-spacing:.01em}' +
  '.btn-primary:hover{opacity:.92;transform:translateY(-2px) scale(1.04);box-shadow:0 8px 28px var(--accent-glow)}' +
  '.btn-primary:active{transform:scale(.97);transition-duration:100ms}' +
  '.btn-ghost{background:var(--surf-hi);border:none;color:var(--on-surf);border-radius:9999px;padding:8px 18px;font-weight:700;font-size:13px;cursor:pointer;transition:background .2s,transform var(--m3-spring) .32s,box-shadow .2s;min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:6px}' +
  '.btn-ghost:hover{background:color-mix(in srgb,var(--accent-color) 18%,var(--surf-hi));transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.2)}' +
  '.btn-ghost:active{transform:scale(.97);transition-duration:100ms}' +
  '.nav-item{display:flex;align-items:center;gap:12px;padding:10px 16px;border-radius:9999px;cursor:pointer;color:var(--on-surf-var);font-size:13px;font-weight:600;transition:background .2s,color .2s,transform var(--m3-spring) .3s;text-decoration:none;margin:1px 8px}' +
  '.nav-item:hover{background:color-mix(in srgb,var(--accent-color) 12%,var(--surf-hi));color:var(--on-surf);transform:translateX(2px)}' +
  '.nav-item.active{background:color-mix(in srgb,var(--accent-color) 22%,var(--surf-hi));color:var(--on-surf);font-weight:700;box-shadow:0 0 0 1px color-mix(in srgb,var(--accent-color) 35%,transparent)}' +
  '.nav-item.active .material-symbols-outlined{font-variation-settings:"FILL" 1,"wght" 700,"GRAD" 0,"opsz" 24;color:var(--accent-light)}' +
  '.breadcrumb-sep{color:#494454;margin:0 6px}' +
  '.file-row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:16px;cursor:pointer;transition:background .2s,transform var(--m3-spring) .32s;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 35%,transparent)}' +
  '.file-row:last-child{border-bottom:none}' +
  '.file-row:hover{background:var(--surf-hi);transform:translateX(3px)}' +
  '.file-row.selected{background:var(--accent-bg)}' +
  '.file-row.drag-over{background:var(--accent-bg)!important;outline:2px dashed var(--accent-color);outline-offset:-2px;border-radius:16px}' +
  '.file-row.dragging{opacity:.35}' +
  '.file-grid-item{background:var(--surf-cont);border:none;border-radius:28px;padding:20px 16px 16px;display:flex;flex-direction:column;align-items:center;gap:10px;cursor:pointer;transition:background .2s,transform var(--m3-spring) .32s,box-shadow .25s;text-align:center;animation:popIn .3s var(--m3-spring) both;box-shadow:0 1px 0 0 rgba(255,255,255,.06) inset,0 2px 12px rgba(0,0,0,.28)}' +
  '.file-grid-item:hover{background:var(--surf-hi);transform:translateY(-6px) scale(1.025);box-shadow:0 1px 0 0 rgba(255,255,255,.08) inset,0 20px 48px rgba(0,0,0,.38)}' +
  '.file-grid-item.selected{background:color-mix(in srgb,var(--accent-color) 14%,var(--surf-cont));box-shadow:0 0 0 2px var(--accent-color),0 12px 32px rgba(0,0,0,.32)}' +
  '.file-grid-item.drag-over{background:var(--accent-bg)!important;box-shadow:0 0 0 2px var(--accent-color)!important}' +
  '.file-grid-item.dragging{opacity:.35}' +
  '#drag-ghost-el{position:fixed;top:-600px;left:-600px;pointer-events:none;z-index:9999;overflow:visible}' +
  '.file-thumb{width:56px;height:56px;border-radius:18px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--accent-color) 20%,var(--surf-hi));color:var(--accent-light);font-size:30px;overflow:hidden;flex:0 0 auto}' +
  '.file-thumb .material-symbols-outlined{font-size:28px;color:var(--accent-light)}' +
  '.file-thumb img{width:100%;height:100%;object-fit:cover}' +
  '.file-actions{display:flex;gap:4px;margin-top:auto;flex-wrap:wrap;justify-content:center;max-width:100%}' +
  '.file-actions .btn-ghost{padding:3px 7px!important;min-width:30px}' +
  '.item-menu-btn{width:40px;height:40px;min-height:40px;border-radius:9999px;padding:0;display:flex;align-items:center;justify-content:center;flex:0 0 auto}' +
  '.item-menu-btn .material-symbols-outlined{font-size:22px}' +
  '.drop-target{outline:2px dashed var(--accent-color)!important;outline-offset:-3px;background:var(--accent-bg)!important;color:var(--accent-light)!important}' +
  '.transfer-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 35%,transparent)}' +
  '.transfer-row:last-child{border-bottom:none}' +
  '.transfer-card{display:flex;flex-direction:column;gap:8px;padding:12px 0;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 35%,transparent)}' +
  '.transfer-card:last-child{border-bottom:none}' +
  '.transfer-top{display:flex;align-items:center;gap:10px}' +
  '.transfer-name{flex:1;min-width:0;font-size:13px;font-weight:700;color:var(--on-surf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.transfer-status{font-size:11px;font-weight:800;text-transform:uppercase;color:var(--accent-light);background:var(--accent-bg);border-radius:9999px;padding:3px 8px}' +
  '.transfer-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px 12px;font-size:12px;color:var(--outline)}' +
  '.transfer-controls{display:flex;gap:8px;flex-wrap:wrap}' +
  '.transfer-controls .btn-ghost{min-height:32px;padding:4px 10px;font-size:12px}' +
  '.progress-track{background:var(--surf-hi);border:none;border-radius:9999px;height:8px;overflow:hidden;flex:1}' +
  '.progress-fill{height:100%;border-radius:9999px;background:linear-gradient(90deg,var(--accent-color),var(--accent-hover));transition:width .4s var(--m3-std)}' +
  '.progress-fill.done{background:#10B981;box-shadow:0 0 10px rgba(16,185,129,.45)}' +
  '@keyframes pf-slide{0%{transform:translateX(-100%)}100%{transform:translateX(500%)}}' +
  '.progress-fill.indeterminate{width:20%!important;animation:pf-slide 1.4s linear infinite;transition:none}' +
  '@keyframes pf-pulse{0%,100%{opacity:.55}50%{opacity:1}}' +
  '.progress-fill.processing{width:100%!important;animation:pf-pulse 1.1s ease-in-out infinite;transition:none}' +
  '.transfer-card.is-error{border-color:#93000a;background:rgba(147,0,10,.07);padding-left:12px;padding-right:12px;border-radius:16px}' +
  '.transfer-card.is-active{border-color:var(--accent-hover);background:var(--accent-bg);padding-left:12px;padding-right:12px;border-radius:16px}' +
  '.transfer-section-title{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;color:var(--outline);margin:4px 0}' +
  '#transfers-card{display:none;position:fixed;right:24px;bottom:24px;z-index:520;width:min(560px,calc(100vw - 48px));max-height:min(62vh,620px);overflow:auto;margin:0!important;padding:20px!important;box-shadow:0 20px 80px rgba(0,0,0,.55);border-radius:28px!important}' +
  '#transfers-card.minimized{display:none!important}' +
  '#transfers-chip{display:none;position:fixed;right:24px;bottom:24px;z-index:521;align-items:center;gap:10px;background:var(--surf-cont);border:1px solid var(--accent-color);border-radius:9999px;padding:10px 18px;color:var(--on-surf);box-shadow:0 14px 50px rgba(0,0,0,.45);cursor:pointer}' +
  '#transfers-chip.active{display:flex}' +
  '.new-badge{display:inline-flex;align-items:center;margin-left:8px;border:1px solid rgba(16,185,129,.42);background:rgba(16,185,129,.14);color:#86efac;border-radius:9999px;padding:2px 7px;font-size:10px;font-weight:900;text-transform:uppercase}' +
  '.file-row.is-new,.file-grid-item.is-new{outline:2px solid rgba(16,185,129,.65)!important;outline-offset:-2px}' +
  '.history-row{display:grid;grid-template-columns:1fr 120px 90px 150px;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 35%,transparent);background:var(--surf-cont)}' +
  '.history-row:first-child{border-radius:16px 16px 0 0}' +
  '.history-row:last-child{border-bottom:none;border-radius:0 0 16px 16px}' +
  '.history-name{min-width:0;font-size:13px;font-weight:800;color:var(--on-surf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.history-meta{font-size:12px;color:var(--outline);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.select-check{width:16px;height:16px;accent-color:var(--accent-color);cursor:pointer;flex:0 0 auto}' +
  '#selection-bar{display:none;align-items:center;gap:10px;padding:10px 24px;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 45%,transparent);background:var(--surf);flex-shrink:0}' +
  '#upload-panel{display:none;position:fixed;right:24px;bottom:24px;z-index:350;width:min(420px,calc(100vw - 48px));background:var(--surf-cont);border:none;border-radius:24px;padding:20px;box-shadow:0 20px 70px rgba(0,0,0,.55);animation:slideUp .32s var(--m3-spring) both}' +
  '#toast{display:none;flex-direction:column;position:fixed;right:24px;bottom:24px;z-index:650;width:min(360px,calc(100vw - 48px));background:#18181c;border:1px solid rgba(255,255,255,0.08);border-radius:24px;padding:20px;box-shadow:0 12px 40px rgba(0,0,0,0.5);animation:slideUp .28s var(--m3-spring) both;box-sizing:border-box} #toast .toast-circle{transition:transform .2s cubic-bezier(.4,0,.2,1)} #toast .toast-circle:hover{transform:scale(1.08);background:color-mix(in srgb,var(--accent-color) 18%,#1b1b1e)!important}' +
  '#connection-pill{display:none;position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:700;align-items:center;gap:8px;background:rgba(28,25,33,.94);border:1px solid var(--accent-color);border-radius:9999px;padding:8px 14px;color:var(--on-surf);font-size:12px;font-weight:800;box-shadow:0 10px 34px rgba(0,0,0,.42);backdrop-filter:blur(18px)}' +
  '.activity-row{background:var(--surf-cont);border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:16px;transition:all .22s cubic-bezier(0.4,0,0.2,1);position:relative;overflow:hidden}' +
  '.activity-row:hover{background:var(--surf-hi);border-color:color-mix(in srgb,var(--accent-color) 40%,rgba(255,255,255,0.12));transform:translateY(-1px);box-shadow:0 6px 20px rgba(0,0,0,0.15)}' +
  '.activity-user-badge{font-size:11px;font-weight:700;color:var(--accent-light);background:var(--accent-bg);border:1px solid color-mix(in srgb,var(--accent-color) 30%,transparent);padding:2px 8px;border-radius:6px;display:inline-block}' +
  'body.light .activity-row{background:#ffffff;border-color:#e4e1eb}' +
  'body.light .activity-row:hover{background:#f8f6fc;border-color:var(--accent-color)}' +
  '@media (max-width:768px){.activity-row{flex-direction:column;align-items:flex-start!important;gap:12px!important}.activity-row>div:last-child{align-items:flex-start!important;text-align:left!important;width:100%}}' +
  '#connection-pill.offline{display:flex;border-color:#93000a;color:#ffdad6}' +
  '#connection-pill.checking{display:flex;border-color:var(--accent-color);color:var(--accent-light)}' +
  '#connection-pill .dot{width:8px;height:8px;border-radius:9999px;background:var(--accent-color);box-shadow:0 0 12px var(--accent-glow)}' +
  '#connection-pill.offline .dot{background:#ff5449;box-shadow:0 0 12px rgba(255,84,73,.8)}' +
  '.speed-result{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}' +
  '.speed-metric{border:none;border-radius:16px;padding:12px;background:var(--surf);min-width:0}' +
  '.speed-metric b{display:block;color:var(--on-surf);font-size:18px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  '.speed-metric span{display:block;color:var(--outline);font-size:11px;margin-top:3px}' +
  '.preview-panel{display:none;width:380px;max-width:38vw;border-left:none;background:var(--surf-cont);flex-shrink:0;flex-direction:column;overflow:hidden;transform-origin:right center;position:relative!important;border-radius:24px 0 0 24px;box-shadow:-4px 0 32px rgba(0,0,0,.32),inset 1px 0 0 rgba(255,255,255,.05)}' +
  '.preview-resizer{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:col-resize;z-index:100;background:transparent;transition:background 0.2s}' +
  '.preview-resizer:hover,.preview-resizer.dragging{background:var(--accent-color)!important}' +
  '.preview-panel.open{display:flex;animation:panelIn .28s var(--m3-std) both}' +
  '.preview-head{display:flex;align-items:center;gap:4px;padding:18px 16px 14px;flex-shrink:0}' +
  '.preview-body{overflow:auto;max-height:48%;flex-shrink:0;padding:0}' +
  '.preview-body.media-preview{display:flex;align-items:center;justify-content:center;background:#0c0a12;max-height:48%;flex-shrink:0;padding:0}' +
  '.preview-media{max-width:100%;max-height:100%;object-fit:contain;display:block}' +
  '.preview-info-section{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-height:0}' +
  '.preview-meta-chip{background:var(--surf-hi);border-radius:12px;padding:10px 12px}' +
  '.preview-meta-label{font-size:10px;font-weight:600;color:var(--on-surf-var);text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px}' +
  '.preview-action-btn{width:100%;justify-content:center;gap:8px;display:flex;align-items:center;font-size:14px;font-weight:600}' +
  '.mv-stage .plyr,.preview-media-wrap .plyr{width:auto;max-width:100%;border-radius:14px;background:#000;box-shadow:0 24px 90px rgba(0,0,0,.38);overflow:hidden}' +
  '.mv-stage .plyr{max-height:100%;height:auto}' +
  '.mv-stage .plyr video,.preview-media-wrap .plyr video{width:100%;height:100%;max-width:100%;max-height:72vh;object-fit:contain}' +
  '.mv-stage .plyr__video-wrapper,.preview-media-wrap .plyr__video-wrapper{background:#000!important;aspect-ratio:auto!important;padding-bottom:0!important;height:100%!important;display:flex;align-items:center;justify-content:center}' +
  '.preview-media-wrap .plyr audio{width:100%}' +
  '.plyr--full-ui input[type=range]{color:var(--accent-color)}' +
  '.preview-media-wrap{width:100%;min-height:260px;display:flex;align-items:center;justify-content:center}' +
  '.preview-media-wrap:fullscreen{background:#050506;padding:24px}' +
  '.preview-media-wrap:fullscreen .preview-media{max-width:100vw;max-height:100vh}' +
  '.doc-preview{font-size:13px;line-height:1.55;color:var(--on-surf);background:var(--surf);border:none;border-radius:16px;padding:16px;overflow:auto}' +
  '.doc-preview h1,.doc-preview h2,.doc-preview h3{margin:0 0 10px;color:var(--on-surf);line-height:1.2}' +
  '.doc-preview table,.archive-table{width:100%;border-collapse:collapse;font-size:12px}' +
  '.doc-preview td,.doc-preview th,.archive-table td,.archive-table th{border-bottom:1px solid var(--outline-var);padding:8px;text-align:left;vertical-align:top}' +
  '.doc-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}' +
  '.doc-tab{border:none;background:var(--surf-hi);color:var(--on-surf);border-radius:9999px;padding:6px 14px;font-weight:700;font-size:12px;cursor:pointer;transition:background .2s,transform var(--m3-spring) .28s}' +
  '.doc-tab:hover{background:var(--accent-bg);transform:scale(1.05)}' +
  '.archive-path{max-width:210px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--on-surf)}' +
  '.archive-dir{color:var(--accent-light);font-weight:800}' +
  '.media-viewer{position:fixed;inset:0;z-index:900;background:rgba(5,4,10,.97);display:none;flex-direction:column;color:#fff}' +
  '.media-viewer.open{display:flex;animation:viewerIn .25s var(--m3-std) both}' +
  '.mv-top{height:64px;display:flex;align-items:center;gap:10px;padding:0 18px;border-bottom:1px solid rgba(255,255,255,.07);background:rgba(18,16,26,.78);backdrop-filter:blur(22px)}' +
  '.mv-title{flex:1;min-width:0;font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.mv-icon{width:42px;height:42px;border-radius:9999px;border:none;background:rgba(255,255,255,.09);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .2s,transform var(--m3-spring) .3s}' +
  '.mv-icon:hover{background:var(--accent-bg);transform:scale(1.1)}' +
  '.mv-stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px;overflow:hidden;position:relative;background:radial-gradient(circle at 50% 50%,var(--accent-bg),transparent 42%)}' +
  '.mv-stage img,.mv-stage video{max-width:100%;max-height:100%;object-fit:contain;border-radius:14px;box-shadow:0 24px 90px rgba(0,0,0,.55)}' +
  '.mv-stage audio{width:min(720px,92vw)}' +
  '.mv-bottom{min-height:72px;display:flex;align-items:center;gap:12px;padding:12px 18px;border-top:1px solid rgba(255,255,255,.07);background:rgba(18,16,26,.78);backdrop-filter:blur(22px)}' +
  '.mv-seek{flex:1;accent-color:var(--accent-color)}' +
  '.mv-time{font-size:12px;color:var(--on-surf-var);min-width:96px;text-align:center}' +
  '.mv-range{width:100px;accent-color:var(--accent-color)}' +
  '.mv-center-play{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(.94);width:86px;height:86px;border-radius:9999px;border:none;background:rgba(18,16,26,.68);backdrop-filter:blur(20px);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 18px 60px rgba(0,0,0,.42);transition:opacity .18s,transform var(--m3-spring) .35s}' +
  '.mv-center-play.hidden{opacity:0;pointer-events:none;transform:translate(-50%,-50%) scale(.78)}' +
  '.mv-center-play .material-symbols-outlined{font-size:48px}' +
  '.mv-select{height:38px;border-radius:9999px;border:none;background:rgba(255,255,255,.1);color:#fff;padding:0 14px;font:700 12px Manrope,sans-serif;outline:none}' +
  '.mv-select option{background:#18161f;color:#fff}' +
  '.mv-hint{position:absolute;left:50%;top:18px;transform:translateX(-50%);background:rgba(18,16,26,.86);border:1px solid rgba(255,255,255,.12);border-radius:9999px;padding:7px 14px;color:var(--on-surf-var);font-size:12px;opacity:0;pointer-events:none;transition:opacity .18s}' +
  '.mv-hint.show{opacity:1}' +
  '#preview-info{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-height:0;border-top:1px solid color-mix(in srgb,var(--outline-var) 30%,transparent);background:var(--surf-cont)}' +
  '.meta-row{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:1px solid color-mix(in srgb,var(--outline-var) 28%,transparent);font-size:12px}' +
  '.meta-row:last-child{border-bottom:none}' +
  '.meta-lbl{color:var(--outline);flex-shrink:0;padding-top:1px}' +
  '.meta-val{color:var(--on-surf-var);font-weight:500;text-align:right;word-break:break-all}' +
  '.dir-name{color:var(--accent-light)}' +
  '.file-name{color:var(--on-surf)}' +
  '.upload-file{font-size:12px;color:var(--on-surf-var);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:50;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)}' +
  '#modal-qr{z-index:120!important}' +
  '#modal-qr .modal{z-index:121}' +
  '.modal{background:var(--surf-cont);border:none;border-radius:28px;padding:28px;min-width:360px;max-width:90vw;animation:popIn .32s var(--m3-spring) both;box-shadow:0 1px 0 rgba(255,255,255,.06) inset,0 28px 80px rgba(0,0,0,.6)}' +
  '.modal h3,.modal h2{font-family:var(--font-display);font-weight:700;letter-spacing:-.01em}' +
  '.url-mode-card{border-radius:16px;padding:16px 14px;cursor:pointer;transition:background .18s var(--m3-std),border-color .18s var(--m3-std),box-shadow .18s var(--m3-std);background:var(--surf-hi);border:1.5px solid transparent;user-select:none}' +
  '.url-mode-card:hover{background:color-mix(in srgb,var(--on-surf) 6%,var(--surf-hi))}' +
  '.url-mode-card.selected{background:var(--accent-bg);border-color:var(--accent-color);box-shadow:0 0 0 1px color-mix(in srgb,var(--accent-color) 22%,transparent)}' +
  '.url-mode-card.selected:hover{background:color-mix(in srgb,var(--accent-color) 20%,var(--surf-hi))}' +
  '.url-dl-inp-wrap{position:relative;margin-bottom:20px}' +
  '.url-dl-inp-wrap .url-inp-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--on-surf-var);font-size:20px;pointer-events:none}' +
  '#url-dl-inp{width:100%;box-sizing:border-box;padding:13px 16px 13px 44px;border-radius:14px;background:var(--surf-hi);border:1.5px solid var(--outline-var);outline:none;font-size:14px;color:var(--on-surf);font-family:Manrope,sans-serif;transition:border-color .2s,box-shadow .2s}' +
  '#url-dl-inp:focus{border-color:var(--accent-color);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-color) 18%,transparent)}' +
  '#url-name-inp{width:100%;box-sizing:border-box;padding:11px 16px;border-radius:14px;background:var(--surf-hi);border:1.5px solid var(--outline-var);outline:none;font-size:13px;color:var(--on-surf);font-family:Manrope,sans-serif;transition:border-color .2s,box-shadow .2s;margin-bottom:6px}' +
  '#url-name-inp:focus{border-color:var(--accent-color);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent-color) 18%,transparent)}' +
  '.inp{background:color-mix(in srgb,var(--accent-color) 8%,var(--surf));border:none;border-bottom:2px solid var(--outline-var);border-radius:10px 10px 0 0;color:var(--on-surf);padding:10px 14px;font-size:14px;width:100%;outline:none;font-family:Manrope,sans-serif;transition:border-color .2s,background .2s}' +
  '.inp:focus{border-bottom-color:var(--accent-color);background:color-mix(in srgb,var(--accent-color) 12%,var(--surf));box-shadow:0 2px 0 var(--accent-color)}' +
  '.disk-bar{background:var(--surf-hi);border-radius:9999px;height:10px;overflow:hidden}' +
  '.disk-fill{height:100%;border-radius:9999px;background:linear-gradient(90deg,var(--accent-color),color-mix(in srgb,var(--accent-color) 60%,var(--accent-hover)));transition:width .6s var(--m3-std)}' +
  'body.light{background:var(--bg,#f3eff8);color:#1c1a23}' +
  'body.light .sidebar{background:#fff;box-shadow:6px 0 40px rgba(0,0,0,.08),inset -1px 0 0 rgba(0,0,0,.05)}' +
  'body.light .sidebar [style*="color:#e4e1e6"]{color:#17151c!important}' +
  'body.light .sidebar [style*="color:#958ea0"]{color:#7b6f93!important}' +
  'body.light .sidebar [style*="color:#494454"]{color:#4a3b6e!important}' +
  'body.light .nav-item{color:#4a3b6e}' +
  'body.light .nav-item:hover{background:var(--accent-bg);color:var(--accent-hover)}' +
  'body.light .nav-item.active{background:var(--accent-bg);color:var(--accent-hover)}' +
  'body.light #main-area{background:#f6f3ff!important}' +
  'body.light #main-area>div:first-child{background:#fff!important;border-bottom-color:#e2d9f3!important}' +
  'body.light #main-area>div:nth-child(2){background:#f1ecfb!important;border-bottom-color:#d8cdec!important}' +
  'body.light #selection-bar{background:var(--accent-bg);border-bottom-color:#e2d9f3;color:#1c1a23}' +
  'body.light #file-scroll{background:var(--bg,#f3eff8)}' +
  'body.light .card{background:#fff;border:none;color:#1c1a23;box-shadow:0 2px 12px rgba(80,60,120,.1)}' +
  'body.light .transfer-row{border-bottom-color:#e2d9f3}' +
  'body.light .transfer-card{border-bottom-color:#e2d9f3}' +
  'body.light .transfer-name{color:#1c1a23}' +
  'body.light .transfer-status{background:var(--accent-bg);color:var(--accent-hover)}' +
  'body.light .transfer-meta{color:#7b6f93}' +
  'body.light .progress-track{background:#e2d9f3}' +
  'body.light #transfers-card,body.light #transfers-chip{background:#fff;border-color:var(--accent-color);color:#17151c}' +
  'body.light .history-row{background:#fff;border-bottom-color:#e2d9f3}' +
  'body.light .history-name{color:#1c1a23}' +
  'body.light .history-meta{color:#7b6f93}' +
  'body.light .file-row{background:#fff!important;border-bottom-color:#ede5ff;color:#1c1a23}' +
  'body.light .file-row:hover{background:var(--accent-bg)!important}' +
  'body.light .file-row.selected{background:var(--accent-bg)}' +
  'body.light .file-thumb{background:var(--accent-bg)}' +
  'body.light .dir-name{color:var(--accent-hover)}' +
  'body.light .file-name{color:#1c1a23}' +
  'body.light .file-grid-item{background:#fff!important;color:#1c1a23!important;box-shadow:0 2px 8px rgba(80,60,120,.1)!important}' +
  'body.light .file-grid-item:hover{background:var(--accent-bg)!important}' +
  'body.light .file-grid-item.selected{background:var(--accent-bg)!important;box-shadow:0 0 0 2px var(--accent-color),0 6px 20px rgba(80,60,120,.15)!important}' +
  'body.light .file-grid-item [style*="color:#e4e1e6"],body.light .file-row [style*="color:#e4e1e6"]{color:#1c1a23!important}' +
  'body.light .file-grid-item [style*="color:#d0bcff"],body.light .file-row [style*="color:#d0bcff"]{color:var(--accent-hover)!important}' +
  'body.light .modal{background:#fff;color:#1c1a23;box-shadow:0 24px 80px rgba(80,60,120,.2)}' +
  'body.light #upload-panel{background:#fff}' +
  'body.light #toast{background:#f5f3f7;border-color:rgba(0,0,0,0.08);color:#1c1a23} body.light #toast .toast-circle{background:#fff;border-color:rgba(0,0,0,0.06)}' +
  'body.light #connection-pill{background:rgba(255,255,255,.94);color:#1c1a23}' +
  'body.light .speed-metric{background:#faf8ff}' +
  'body.light .speed-metric b{color:#1c1a23}' +
  'body.light .preview-panel{background:#fff;border-left-color:#e2d9f3}' +
  'body.light .preview-head{border-bottom-color:#e2d9f3}' +
  'body.light #preview-title{color:#1c1a23}' +
  'body.light #preview-info{background:#fff;border-top-color:#e2d9f3}' +
  'body.light .preview-panel{background:#fff;box-shadow:-4px 0 32px rgba(0,0,0,.08),inset 1px 0 0 rgba(0,0,0,.05)}' +
  'body.light .doc-preview{background:#fff;color:#1c1a23}' +
  'body.light .doc-preview h1,body.light .doc-preview h2,body.light .doc-preview h3{color:#1c1a23}' +
  'body.light .doc-preview td,body.light .doc-preview th,body.light .archive-table td,body.light .archive-table th{border-bottom-color:#e2d9f3}' +
  'body.light .doc-tab{background:#ede7f6;color:#1c1a23}' +
  'body.light .archive-path{color:#1c1a23}' +
  'body.light .meta-row{border-bottom-color:#e8e0f4}' +
  'body.light .meta-lbl{color:#9b91b4}' +
  'body.light .meta-val{color:#1c1a23}' +
  'body.light .preview-body{color:#1c1a23}' +
  'body.light .breadcrumb-sep{color:#c9bfe0}' +
  'body.light .disk-bar{background:#e2d9f3}' +
  'body.light #disk-label{color:#4a3b6e}' +
  'body.light .inp{background:#f0ebfa;color:#1c1a23;border-bottom-color:#c9bfe0}' +
  'body.light .inp:focus{border-bottom-color:var(--accent-color);background:#eae4f6;box-shadow:0 2px 0 var(--accent-color)}' +
  'body.light .btn-ghost{color:#4a3b6e;background:#ede7f6}' +
  'body.light .btn-ghost:hover{background:var(--accent-bg);color:var(--accent-hover)}' +
  'body.light .btn-primary{background:var(--accent-color)!important;color:#fff!important}' +
  'body.light .mobile-actions button{background:#ede7f6!important;border:none!important;color:#4a3b6e!important}' +
  'body.light .mobile-topbar,body.light .mobile-bottom-nav{background:rgba(255,255,255,.88)!important;border-color:#e2d9f3!important}' +
  'body.light .mobile-brand{color:#1c1a23!important;text-shadow:none!important}' +
  'body.light .mobile-avatar{background:var(--accent-bg)!important;color:var(--accent-hover)!important}' +
  'body.light #ctx-menu{background:#fff!important;border-color:#d8cdec!important;box-shadow:0 12px 40px rgba(50,34,80,.18)!important}' +
  'body.light .ctx-item{color:#2d2440!important}' +
  'body.light .ctx-item:hover{background:var(--accent-bg)!important;color:var(--accent-hover)!important}' +
  'body.light .ctx-sep{background:#e8e0f4!important}' +
  'body.light #file-area{color:#1c1a23}' +
  /* context menu */
  '#ctx-menu{position:fixed;z-index:500;background:var(--surf-cont);border:none;border-radius:18px;padding:6px;min-width:200px;box-shadow:0 16px 60px rgba(0,0,0,.65);display:none;transform-origin:top left}' +
  '#ctx-menu.open{animation:menuIn .2s var(--m3-spring) both}' +
  '.ctx-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;cursor:pointer;font-size:13px;font-weight:600;color:var(--on-surf);transition:background .15s,transform var(--m3-spring) .25s}' +
  '.ctx-item:hover{background:var(--accent-bg);color:var(--accent-light);transform:translateX(2px)}' +
  '.ctx-item.danger{color:#ffb4ab}' +
  '.ctx-item.danger:hover{background:rgba(255,180,171,.1);color:#ff8a80}' +
  '.ctx-sep{height:1px;background:var(--outline-var);margin:4px 8px;opacity:.4}' +
  /* drop zone overlay */
  '#drop-zone{position:fixed;inset:0;z-index:300;pointer-events:none;display:none;align-items:center;justify-content:center;flex-direction:column;gap:12px;background:rgba(109,59,215,.1);border:3px dashed var(--accent-color);border-radius:0}' +
  '#drop-zone.active{display:flex}' +
  /* Custom features classes */
  '.filter-pill{background:var(--surf-hi);border:none;color:var(--on-surf-var);border-radius:9999px;padding:7px 16px;font-size:12px;font-weight:700;cursor:pointer;transition:background .2s,color .2s,transform var(--m3-spring) .3s}' +
  '.filter-pill:hover{background:color-mix(in srgb,var(--accent-color) 16%,var(--surf-hi));color:var(--on-surf);transform:scale(1.04)}' +
  '.filter-pill.active{background:var(--accent-color);color:#fff;box-shadow:0 4px 14px var(--accent-glow);transform:scale(1.06)}' +
  'body.light .filter-pill{background:#ede7f6;color:#4a3b6e}' +
  'body.light .filter-pill:hover{background:var(--accent-bg);color:var(--accent-hover)}' +
  'body.light .filter-pill.active{background:var(--accent-color);color:#fff}' +
  '.settings-hero{position:relative;overflow:hidden;border:none;border-radius:28px;padding:28px;background:radial-gradient(circle at 14% -20%,var(--accent-bg),transparent 42%),linear-gradient(135deg,#231e30,#18151f 64%,#111019);box-shadow:0 24px 80px rgba(0,0,0,.32);margin-bottom:20px}' +
  '.settings-hero-icon{width:56px;height:56px;border-radius:20px;background:var(--accent-gradient);display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 14px 40px var(--accent-glow)}' +
  '.settings-card-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:900;margin-bottom:14px;color:var(--on-surf)}' +
  '.settings-card-title .material-symbols-outlined{color:var(--accent-light)}' +
  '.settings-subtle{font-size:12px;color:var(--outline);line-height:1.5}' +
  '.settings-grid{display:grid;grid-template-columns:1fr;gap:18px}' +
  '@media(min-width:1024px){.settings-grid{grid-template-columns:1fr 1fr!important}}' +
  '.cloud-switch{position:relative;display:inline-block;width:48px;height:26px;flex-shrink:0}' +
  '.cloud-switch input{opacity:0;width:0;height:0}' +
  '.cloud-switch-track{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:#403a52;border-radius:26px;transition:.25s}' +
  '.cloud-switch input:checked+.cloud-switch-track{background:var(--accent-color)}' +
  '.cloud-switch-track:before{content:"";position:absolute;height:20px;width:20px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.25s}' +
  '.cloud-switch input:checked+.cloud-switch-track:before{transform:translateX(22px)}' +
  '.settings-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06)}' +
  '.settings-toggle-row:last-child{border-bottom:none;padding-bottom:0}' +
  '.settings-toggle-row:first-child{padding-top:0}' +
  '.color-swatch{width:34px;height:34px;border-radius:50%;border:3px solid transparent;cursor:pointer;flex-shrink:0;transition:transform var(--m3-spring) .3s,border-color .15s,box-shadow .15s;box-shadow:0 2px 8px rgba(0,0,0,.3)}' +
  '.color-swatch:hover{transform:scale(1.22);box-shadow:0 6px 20px rgba(0,0,0,.5)}' +
  '.color-swatch.active{border-color:#fff!important;transform:scale(1.18);box-shadow:0 0 0 3px rgba(255,255,255,.28)}' +
  '#accent-color-input{width:46px;height:38px;border:none;border-radius:10px;cursor:pointer;padding:0;background:none;flex-shrink:0}' +
  '#accent-color-input::-webkit-color-swatch-wrapper{padding:0;border-radius:8px}' +
  '#accent-color-input::-webkit-color-swatch{border:none;border-radius:8px}' +
  '.theme-card{display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:18px;background:var(--surf);border:none;cursor:pointer;transition:background .2s,box-shadow .25s,transform var(--m3-spring) .32s}' +
  '.theme-card:hover{background:var(--surf-hi);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.22)}' +
  '.theme-card.active{background:var(--accent-bg);box-shadow:0 0 0 2px var(--accent-color),0 8px 28px rgba(0,0,0,.22)}' +
  'body.light .theme-card{background:#faf8ff}' +
  'body.light .theme-card:hover{background:var(--accent-bg)}' +
  'body.light .theme-card.active{background:var(--accent-bg);box-shadow:0 0 0 2px var(--accent-color)}' +
  '.theme-card-dot{width:22px;height:22px;border-radius:9999px;flex:0 0 auto}' +
  'body.light .settings-hero{background:radial-gradient(circle at 14% -20%,var(--accent-bg),transparent 42%),linear-gradient(135deg,#fff,#f7f2ff);box-shadow:0 22px 60px rgba(62,45,92,.12)}' +
  'body.light .settings-hero [style*="color:#fff"],body.light .theme-card [style*="color:#e4e1e6"]{color:#1c1a23!important}' +
  'body.light .settings-card-title{color:#1c1a23}' +
  'body.light .settings-subtle{color:#7b6f93}' +
  '.code-hl-kw{color:#ff79c6;font-weight:bold}' +
  '.code-hl-str{color:#f1fa8c}' +
  '.code-hl-cmt{color:#6272a4;font-style:italic}' +
  '.code-hl-num{color:#bd93f9}' +
  '.code-hl-fn{color:#50fa7b}' +
  '.code-hl-tag{color:#8be9fd}' +
  '.code-hl-attr{color:#ffb86c}' +
  '@keyframes popIn{from{opacity:0;transform:scale(.86) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}' +
  '@keyframes slideUp{from{opacity:0;transform:translateY(16px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}' +
  '@keyframes panelIn{from{opacity:0;transform:translateX(24px) scale(.97)}to{opacity:1;transform:translateX(0) scale(1)}}' +
  '@keyframes menuIn{from{opacity:0;transform:translateY(-8px) scale(.88)}to{opacity:1;transform:translateY(0) scale(1)}}' +
  '@keyframes viewerIn{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:scale(1)}}' +
  '@media (max-width:768px){' +
  'body{display:block!important;min-height:100dvh;overflow-x:hidden;padding:0 0 96px;background:var(--bg,#12101a)}' +
  '.mobile-topbar{display:flex;position:sticky;top:0;z-index:60;height:64px;align-items:center;justify-content:space-between;padding:0 20px;background:rgba(18,16,26,.9);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);border-bottom:1px solid rgba(60,55,70,.5)}' +
  '.mobile-brand{font-size:28px;line-height:34px;font-weight:800;color:#fff;letter-spacing:0;text-shadow:0 2px 12px rgba(0,0,0,.45)}' +
  '.mobile-avatar{width:36px;height:36px;border-radius:9999px;background:var(--surf-hi);border:none;display:flex;align-items:center;justify-content:center;color:var(--accent-light)}' +
  '.mobile-icon-btn{width:44px;height:44px;border:0;border-radius:9999px;background:transparent;color:var(--accent-color);display:flex;align-items:center;justify-content:center}' +
  '.mobile-icon-btn .material-symbols-outlined{font-size:32px}' +
  '.sidebar{display:none!important}' +
  '#main-area{min-height:calc(100dvh - 64px);display:block!important}' +
  '.desktop-toolbar{display:none!important}' +
  '.mobile-toolbar{display:flex!important;padding:44px 20px 14px!important;gap:14px!important;align-items:center!important;border-bottom:0!important;background:transparent!important;flex-wrap:wrap!important;height:auto!important}' +
  '.mobile-toolbar>button:not([data-action="upload-btn"]):not([data-action="go-back"]){display:none!important}' +
  '.mobile-toolbar>button[data-action="view-list"],.mobile-toolbar>button[data-action="view-grid"],.mobile-toolbar>button[data-action="toggle-theme"],.mobile-toolbar>button[data-action="go-back"]{display:flex!important}' +
  '.mobile-toolbar #breadcrumb{display:flex!important;width:100%!important;order:10!important;margin-top:4px!important;padding:8px 0!important;border-top:1px solid #1f1f22!important;overflow-x:auto!important;white-space:nowrap!important;scrollbar-width:none!important}' +
  '.mobile-toolbar #breadcrumb::-webkit-scrollbar{display:none}' +
  '.mobile-toolbar>div[style*="position:relative"]{display:block!important;flex:1;min-width:0}' +
  '#search-inp{width:100%!important;height:58px;border-radius:9999px!important;background:var(--surf-hi)!important;border:none!important;outline:none!important;color:var(--on-surf)!important;font-size:16px!important;padding-left:54px!important;font-family:Manrope,sans-serif!important}' +
  '#search-inp::placeholder{color:var(--on-surf-var)}' +
  '#search-inp::-webkit-search-decoration,#search-inp::-webkit-search-cancel-button,#search-inp::-webkit-search-results-button,#search-inp::-webkit-search-results-decoration{display:none;-webkit-appearance:none}' +
  '.mobile-toolbar>div[style*="position:relative"] span{left:20px!important;color:var(--on-surf-var)!important}' +
  '.mobile-toolbar [data-action="upload-btn"]{display:flex!important;width:64px!important;height:64px!important;padding:0!important;align-items:center;justify-content:center;box-shadow:0 18px 30px rgba(124,58,237,.28);font-size:0;flex:0 0 auto}' +
  '.mobile-toolbar [data-action="view-list"],.mobile-toolbar [data-action="view-grid"],.mobile-toolbar [data-action="toggle-theme"]{width:48px!important;height:48px!important;min-height:48px!important;padding:0!important;align-items:center;justify-content:center;flex:0 0 auto}' +
  '.mobile-toolbar [data-action="toggle-theme"]{font-size:0!important}' +
  '.mobile-toolbar [data-action="toggle-theme"]::before{content:"contrast";font-family:"Material Symbols Outlined";font-size:26px}' +
  '.mobile-toolbar [data-action="upload-btn"]::before{content:"upload";font-family:"Material Symbols Outlined";font-size:34px;font-variation-settings:"FILL" 1,"wght" 700,"GRAD" 0,"opsz" 32}' +
  '.mobile-toolbar [data-action="upload-btn"] span{display:none!important}' +
  '.mobile-actions{display:flex!important;padding:0 20px 28px!important;gap:10px!important;overflow-x:auto;border-bottom:0!important;background:transparent!important}' +
  '.mobile-actions button{white-space:nowrap;min-height:44px;background:var(--surf-hi);border:none;color:var(--on-surf)}' +
  '#mobile-storage{display:block!important;margin:0 20px 34px!important;padding:20px 28px!important}' +
  '#mobile-storage .disk-bar{height:8px;background:var(--surf-hi)}' +
  '#selection-bar{position:sticky;top:64px;z-index:45;margin:0 20px 14px;padding:12px!important;flex-wrap:wrap;border:none;border-radius:20px;background:var(--surf-cont);box-shadow:0 4px 16px rgba(0,0,0,.25)}' +
  '#file-scroll{padding:0 20px 20px!important;overflow:visible!important}' +
  '#file-area{display:block}' +
  '#file-area>div[style*="background:#1b1b1e"]{background:transparent!important;border:0!important;border-radius:0!important;overflow:visible!important;display:flex!important;flex-direction:column!important;gap:14px!important}' +
  '.file-row:first-child{display:none!important}' +
  '.file-row{min-height:80px;gap:14px!important;padding:16px 22px!important;background:var(--surf-cont)!important;border:none!important;border-radius:22px!important;box-shadow:0 2px 8px rgba(0,0,0,.2);transform:none!important}' +
  '.file-row.selected{box-shadow:0 0 0 2px var(--accent-color),0 4px 16px rgba(0,0,0,.25)!important;background:var(--accent-bg)!important}' +
  '.file-row>div:nth-child(4),.file-row>div:nth-child(5){display:none!important}' +
  '.file-row>div:nth-child(3){min-width:0;font-size:18px!important;line-height:24px!important;font-weight:700!important;color:var(--on-surf)!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.file-row>div:nth-child(3)::after{content:attr(data-meta);display:block;font-size:14px;line-height:20px;color:var(--on-surf-var);font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  '.file-row>div:last-child{width:auto!important;flex-shrink:0}' +
  '.file-actions{gap:6px!important;justify-content:flex-end!important}' +
  '.file-actions .btn-ghost{width:34px;height:34px;min-height:34px;padding:0!important;font-size:0!important;border:0!important;background:transparent!important;color:var(--on-surf-var)!important}' +
  '#file-area>div[style*="grid-template-columns"]{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:22px!important}' +
  '.file-grid-item{min-height:144px;padding:18px 14px!important;align-items:flex-start!important;text-align:left!important;background:var(--surf-cont)!important;border-radius:22px!important}' +
  '.card{margin:0 20px 24px!important;padding:22px!important;border-radius:22px!important}' +
  '.mobile-bottom-nav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:55;height:88px;align-items:center;justify-content:space-around;padding:8px 18px calc(8px + env(safe-area-inset-bottom));background:rgba(18,16,26,.92);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-top:1px solid rgba(60,55,70,.5)}' +
  '.bottom-nav-item{min-width:68px;height:64px;border:0;background:transparent;color:var(--on-surf-var);border-radius:22px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:12px;font-weight:800;transition:background .2s,color .2s,transform var(--m3-spring) .3s}' +
  '.bottom-nav-item.active{background:var(--accent-bg);color:var(--accent-light);transform:scale(1.08)}' +
  '.bottom-nav-item .material-symbols-outlined{font-size:30px}' +
  '#upload-panel{left:20px!important;right:20px!important;bottom:104px!important;width:auto!important;border-radius:18px!important}' +
  '#toast{left:20px!important;right:20px!important;bottom:24px!important;top:auto!important;width:auto!important}' +
  '#transfers-card{left:20px!important;right:20px!important;bottom:104px!important;width:auto!important;max-height:50vh}' +
  '#transfers-chip{right:20px!important;bottom:104px!important}' +
  '.preview-panel{position:fixed!important;left:0;right:0;bottom:0;z-index:70;width:100%!important;max-width:none!important;max-height:72dvh;border-left:0;border-top:1px solid var(--outline-var);border-radius:28px 28px 0 0;background:var(--surf-cont)}' +
  '.media-viewer{z-index:950}' +
  '.mv-top{height:58px;padding:0 12px}' +
  '.mv-bottom{flex-wrap:wrap;gap:8px;padding:10px 12px}' +
  '.mv-seek{flex-basis:100%;order:-1}' +
  '.mv-stage{padding:10px}' +
  '#file-scroll{min-height:0!important}' +
  '#file-area section{display:grid!important;grid-template-columns:1fr!important;gap:14px!important;margin-top:14px!important}' +
  '#file-area section:first-child{margin-top:0!important}' +
  '#file-area section>div{min-width:0!important}' +
  '#file-area h1{font-size:26px!important;line-height:1.12!important}' +
  '#file-area [style*="grid-template-columns:minmax(0,1fr) 170px"],#file-area [style*="grid-template-columns:minmax(0,1fr) auto auto"],#file-area [style*="grid-template-columns:repeat(4"],#file-area [style*="grid-template-columns:minmax(0,1fr) minmax(320px"],#file-area [style*="grid-template-columns:repeat(auto-fit"]{grid-template-columns:1fr!important}' +
  '#file-area [style*="grid-template-columns:1fr 1fr 1fr"]{grid-template-columns:1fr!important}' +
  '#file-area .btn-primary,#file-area .btn-ghost{min-height:46px}' +
  '#file-area [data-action="dashboard-url-download"],#file-area [data-action="upload-btn"]{width:100%;justify-content:center}' +
  '.history-row{display:grid!important;grid-template-columns:1fr!important;gap:8px!important;padding:14px!important;border-radius:16px!important;margin-bottom:10px!important;border:1px solid rgba(74,68,85,.55)!important}' +
  '.history-row>div:last-child{justify-content:flex-start!important}' +
  '#selection-bar{top:64px!important;max-height:38dvh;overflow:auto!important}' +
  '.speed-result{grid-template-columns:1fr!important}' +
  '#selection-bar .btn-ghost{min-height:38px;padding:7px 10px!important;font-size:12px!important}' +
  '#selection-count{flex-basis:100%!important}' +
  '.mobile-bottom-nav{height:78px!important;padding:6px 8px calc(6px + env(safe-area-inset-bottom))!important;gap:4px!important}' +
  '.bottom-nav-item{min-width:0!important;flex:1 1 0!important;height:58px!important;border-radius:18px!important;font-size:10px!important;line-height:12px!important}' +
  '.bottom-nav-item .material-symbols-outlined{font-size:25px!important}' +
  '.mobile-toolbar{padding:18px 14px 10px!important;gap:10px!important}' +
  '.mobile-toolbar>div[style*="position:relative"]{order:-1!important;flex-basis:100%!important}' +
  '#search-inp{height:50px!important;font-size:15px!important}' +
  '.mobile-toolbar [data-action="upload-btn"]{width:54px!important;height:54px!important}' +
  '.mobile-toolbar [data-action="view-list"],.mobile-toolbar [data-action="view-grid"],.mobile-toolbar [data-action="toggle-theme"],.mobile-toolbar [data-action="go-back"]{width:44px!important;height:44px!important;min-height:44px!important}' +
  '.mobile-actions{padding:0 14px 18px!important;gap:8px!important;scroll-snap-type:x proximity}' +
  '.mobile-actions button{scroll-snap-align:start;min-height:42px!important;padding:8px 12px!important;font-size:12px!important}' +
  '#mobile-storage{margin:0 14px 18px!important;padding:16px!important}' +
  '#file-scroll{padding:0 14px 18px!important}' +
  '#file-area>div[style*="grid-template-columns"]{gap:12px!important}' +
  '.file-grid-item{min-height:132px!important;padding:14px 12px!important}' +
  '.file-grid-item .file-thumb{width:44px!important;height:44px!important}' +
  '.file-row{min-height:72px!important;padding:14px!important;border-radius:16px!important}' +
  '.file-row>div:nth-child(3){font-size:15px!important;line-height:20px!important}' +
  '.file-row>div:nth-child(3)::after{font-size:12px!important;line-height:17px!important}' +
  '.item-menu-btn{width:38px!important;height:38px!important;min-height:38px!important}' +
  '.preview-panel{max-height:82dvh!important}' +
  '.preview-body{padding:12px!important;max-height:48dvh!important}' +
  '#preview-info{max-height:30dvh!important}' +
  '.preview-media-wrap{min-height:180px!important}' +
  '.preview-media-wrap .plyr video{max-height:44dvh!important}' +
  '.mv-top{min-height:48px!important;height:48px!important;gap:4px!important;padding:0 8px!important}' +
  '.mv-title{font-size:12px!important;margin-right:4px!important}' +
  '.mv-icon{width:32px!important;height:32px!important;background:transparent!important;border:none!important}' +
  '.mv-icon span{font-size:20px!important}' +
  '.plyr__controls{padding:6px!important}' +
  '.plyr__controls .plyr__control{padding:6px!important}' +
  '.plyr__time{font-size:11px!important}' +
  '.pl-carousel::-webkit-scrollbar{display:none!important}' +
  '.pl-carousel{scrollbar-width:none!important}' +
  '.mv-stage{padding:8px!important}' +
  '.mv-stage .plyr video{max-height:calc(100dvh - 132px)!important}' +
  '.modal-backdrop{align-items:flex-end!important;padding:10px!important;z-index:800!important}' +
  '.modal{width:100%!important;max-width:none!important;max-height:86dvh!important;overflow:auto!important;padding:22px!important;border-radius:28px 28px 16px 16px!important}' +
  '.modal .inp{font-size:16px!important;min-height:46px!important}' +
  '.modal [style*="grid-template-columns"]{grid-template-columns:1fr!important}' +
  '.modal [style*="justify-content:flex-end"]{justify-content:stretch!important}' +
  '.modal [style*="justify-content:flex-end"] .btn-primary,.modal [style*="justify-content:flex-end"] .btn-ghost{flex:1 1 0!important;justify-content:center}' +
  '#modal-share-manager .modal{max-height:92dvh!important}' +
  '#sm-list [style*="grid-template-columns:1fr 1fr"]{grid-template-columns:1fr!important}' +
  '#upload-panel{left:10px!important;right:10px!important;bottom:88px!important;max-height:70dvh!important;overflow:auto!important}' +
  '#toast{left:10px!important;right:10px!important;bottom:88px!important;width:auto!important}' +
  '#transfers-card{left:10px!important;right:10px!important;bottom:88px!important;max-height:62dvh!important}' +
  '#transfers-chip{right:10px!important;bottom:88px!important}' +
  '@media (max-width:420px){#file-area>div[style*="grid-template-columns"]{grid-template-columns:1fr!important}.mobile-brand{font-size:22px!important}.bottom-nav-item span:last-child{display:none!important}.bottom-nav-item{height:52px!important}.mobile-bottom-nav{height:70px!important}.preview-panel{max-height:86dvh!important}}' +
  '.modal-backdrop{align-items:flex-end!important;padding:10px!important}' +
  '.modal{min-width:0!important;width:100%!important;padding:22px!important;border-radius:28px 28px 16px 16px!important}' +
  '}' +
  '#sidebar-player{display:none;margin:12px 8px;padding:14px;border-radius:20px;background:var(--surf-hi);border:1px solid color-mix(in srgb,var(--accent-color) 15%,rgba(255,255,255,.05));box-shadow:0 8px 32px rgba(0,0,0,.24);flex-direction:column;gap:10px;animation:slideUpFade 0.4s var(--m3-spring) both}' +
  '@keyframes slideUpFade{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}' +
  '.player-cover-art{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,var(--accent-color),color-mix(in srgb,var(--accent-color) 40%,#000));display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0;box-shadow:0 4px 14px var(--accent-glow)}' +
  '.player-ctrl-btn{width:34px!important;height:34px!important;min-height:34px!important;padding:0!important;border-radius:50%!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;transition:transform 0.2s,background 0.2s!important}' +
  '.player-ctrl-btn:hover{transform:scale(1.1);background:rgba(255,255,255,0.08)!important}' +
  '.player-play-btn{width:40px;height:40px;border-radius:50%;background:var(--accent-color);color:#fff;border:none;outline:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px var(--accent-glow);transition:transform 0.25s var(--m3-spring),box-shadow 0.2s}' +
  '.player-play-btn:hover{transform:scale(1.12);box-shadow:0 8px 24px var(--accent-glow)}' +
  '.player-play-btn:active{transform:scale(0.95)}' +
  '#player-progress{-webkit-appearance:none;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,0.12);outline:none;cursor:pointer;accent-color:var(--accent-color);transition:height 0.15s}' +
  '#player-progress:hover{height:6px}' +
  '#player-progress::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;border-radius:50%;background:var(--accent-color);cursor:pointer;box-shadow:0 0 8px var(--accent-glow);transition:transform 0.15s}' +
  '#player-progress:hover::-webkit-slider-thumb{transform:scale(1.3)}' +
  '.playlist-track-row:hover{background:rgba(255,255,255,0.05)!important}' +
  '</style>' +
  '</head>' +
  '<body class="flex">' +
  '<header class="mobile-topbar">' +
  '<div class="mobile-avatar"><span class="material-symbols-outlined">person</span></div>' +
  '<div class="mobile-brand">CloudSpace</div>' +
  '<div id="mobile-header-player" style="display:none;align-items:center;width:100%;height:100%;gap:10px">' +
  '  <div class="player-cover-art" style="width:36px;height:36px;border-radius:8px;font-size:18px;box-shadow:none">' +
  '    <span class="material-symbols-outlined" style="font-size:20px">music_note</span>' +
  '  </div>' +
  '  <div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center">' +
  '    <div id="m-player-title" style="font-size:12px;font-weight:800;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2">—</div>' +
  '    <div id="m-player-artist" style="font-size:10px;color:#958ea0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2;margin-top:1px">—</div>' +
  '  </div>' +
  '  <div style="display:flex;align-items:center;gap:4px">' +
  '    <button class="btn-ghost" id="m-player-btn-play" title="Воспроизведение" style="width:36px!important;height:36px!important;min-height:36px!important;padding:0!important;border-radius:50%!important;display:flex!important;align-items:center;justify-content:center">' +
  '      <span class="material-symbols-outlined" id="m-player-play-icon" style="font-size:22px">play_arrow</span>' +
  '    </button>' +
  '    <button class="btn-ghost" id="m-player-btn-next" title="Следующий трек" style="width:36px!important;height:36px!important;min-height:36px!important;padding:0!important;border-radius:50%!important;display:flex!important;align-items:center;justify-content:center">' +
  '      <span class="material-symbols-outlined" style="font-size:22px">skip_next</span>' +
  '    </button>' +
  '    <button class="btn-ghost" id="m-player-btn-close" title="Закрыть плеер" style="width:36px!important;height:36px!important;min-height:36px!important;padding:0!important;border-radius:50%!important;display:flex!important;align-items:center;justify-content:center;color:#958ea0">' +
  '      <span class="material-symbols-outlined" style="font-size:20px">close</span>' +
  '    </button>' +
  '  </div>' +
  '</div>' +
  '</header>' +
  /* ── SIDEBAR ── */
  '<aside class="sidebar flex flex-col py-6 px-4 gap-2 sticky top-0 h-screen overflow-y-auto">' +
  '<div class="flex items-center gap-3 px-2 mb-6">' +
  '<div style="background:var(--accent-gradient);border-radius:14px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 12px 28px var(--accent-glow);flex-shrink:0"><span class="material-symbols-outlined">cloud</span></div>' +
  '<div><div style="font-weight:800;font-size:17px;color:var(--on-surf);font-family:var(--font-display);letter-spacing:-.01em">CloudSpace</div>' +
  '<div style="font-size:11px;color:var(--outline)">' + safeUsername + '</div></div>' +
  '</div>' +
  '<a href="/" class="nav-item"><span class="material-symbols-outlined">arrow_back</span><span>Главная</span></a>' +
  '<div style="font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--outline-var);text-transform:uppercase;padding:10px 4px 4px 20px">Навигация</div>' +
  '<div class="nav-item active" data-action="nav-dashboard"><span class="material-symbols-outlined">dashboard</span><span>Главная</span></div>' +
  '<div class="nav-item" data-action="nav-files"><span class="material-symbols-outlined">folder</span><span>Мои файлы</span></div>' +
  '<div class="nav-item" data-action="nav-activity"><span class="material-symbols-outlined">list_alt</span><span>Активность</span></div>' +
  '<div class="nav-item" data-action="nav-settings"><span class="material-symbols-outlined">settings</span><span>Настройки</span></div>' +
  '<div style="flex:1"></div>' +
  '<audio id="global-audio" style="display:none"></audio>' +
  '<div id="sidebar-player" class="card">' +
  '  <div style="display:flex;align-items:center;gap:12px;position:relative">' +
  '    <div class="player-cover-art">' +
  '      <span class="material-symbols-outlined" style="font-size:24px">music_note</span>' +
  '    </div>' +
  '    <div id="player-text-wrap" style="min-width:0;flex:1;cursor:pointer;margin-right:48px" title="Нажмите, чтобы поменять местами Название и Исполнителя">' +
  '      <div id="player-title" style="font-size:13px;font-weight:800;color:var(--on-surf);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2">—</div>' +
  '      <div id="player-artist" style="font-size:11px;color:#958ea0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.2;margin-top:2px">—</div>' +
  '    </div>' +
  '    <div style="position:absolute;right:-4px;top:-4px;display:flex;align-items:center;gap:2px">' +
  '      <button class="btn-ghost player-ctrl-btn" id="player-btn-details" title="Открыть детали файла" style="width:24px!important;height:24px!important;min-height:24px!important">' +
  '        <span class="material-symbols-outlined" style="font-size:15px">info</span>' +
  '      </button>' +
  '      <button class="btn-ghost player-ctrl-btn" id="player-btn-close" title="Скрыть плеер" style="width:24px!important;height:24px!important;min-height:24px!important">' +
  '        <span class="material-symbols-outlined" style="font-size:15px">close</span>' +
  '      </button>' +
  '    </div>' +
  '  </div>' +
  '  <div style="display:flex;flex-direction:column;gap:4px;margin-top:2px">' +
  '    <input type="range" id="player-progress" min="0" max="100" value="0">' +
  '    <div style="display:flex;justify-content:space-between;font-size:10px;color:#958ea0;font-weight:700">' +
  '      <span id="player-time-cur">0:00</span>' +
  '      <span id="player-time-dur">0:00</span>' +
  '    </div>' +
  '  </div>' +
  '  <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-top:2px">' +
  '    <button class="btn-ghost player-ctrl-btn" id="player-btn-repeat" title="Повтор" style="color:var(--outline)">' +
  '      <span class="material-symbols-outlined" style="font-size:20px">repeat</span>' +
  '    </button>' +
  '    <button class="btn-ghost player-ctrl-btn" id="player-btn-prev" title="Предыдущий трек">' +
  '      <span class="material-symbols-outlined" style="font-size:22px">skip_previous</span>' +
  '    </button>' +
  '    <button class="player-play-btn" id="player-btn-play" title="Воспроизведение">' +
  '      <span class="material-symbols-outlined" id="player-play-icon" style="font-size:24px">play_arrow</span>' +
  '    </button>' +
  '    <button class="btn-ghost player-ctrl-btn" id="player-btn-next" title="Следующий трек">' +
  '      <span class="material-symbols-outlined" style="font-size:22px">skip_next</span>' +
  '    </button>' +
  '    <button class="btn-ghost player-ctrl-btn" id="player-btn-playlist" title="Очередь воспроизведения">' +
  '      <span class="material-symbols-outlined" style="font-size:20px">playlist_play</span>' +
  '    </button>' +
  '  </div>' +
  '</div>' +
  '<div class="profile-card card" style="margin:0;padding:14px;background:linear-gradient(180deg,var(--accent-bg),rgba(27,27,29,.92));border-color:var(--accent-color)">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
  '<div id="profile-avatar-sidebar" style="width:38px;height:38px;border-radius:14px;background:var(--accent-gradient);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:16px;flex:0 0 auto">' + safeProfileInitial + '</div>' +
  '<div style="min-width:0;flex:1"><div id="profile-label-sidebar" style="font-size:14px;font-weight:900;color:#e4e1e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + safeProfileLabel + '</div><div id="profile-meta-sidebar" style="font-size:11px;color:#958ea0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">@' + safeUsername + ' &middot; ' + safeProfileRole + '</div></div>' +
  '<button class="btn-ghost" data-action="nav-settings" title="Профиль" style="width:34px;height:34px;min-height:34px;padding:0;display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">manage_accounts</span></button>' +
  '</div>' +
  '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;padding:7px 9px;border:1px solid color-mix(in srgb,var(--accent-color) 34%,transparent);border-radius:10px;background:var(--accent-bg)"><span style="font-size:10px;color:#958ea0;text-transform:uppercase;letter-spacing:.08em;font-weight:900">Версия сайта</span><span style="font-size:11px;color:var(--accent-light);font-weight:900">v' + SITE_VERSION + '</span></div>' +
  '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px"><span style="font-size:11px;color:#958ea0">Диск</span><span style="font-size:11px;color:#cbc3d7" id="disk-label">Загрузка...</span></div>' +
  '<div class="disk-bar"><div class="disk-fill" id="disk-fill" style="width:0%"></div></div>' +
  '</div>' +
  '</aside>' +
  /* ── MAIN ── */
  '<main id="main-area" class="flex-1 flex flex-col" style="min-width:0">' +
  '<div class="desktop-toolbar mobile-toolbar" style="background:rgba(19,19,23,.82);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-bottom:1px solid rgba(255,255,255,.06);padding:10px 24px;display:flex;align-items:center;gap:12px;flex-shrink:0">' +
  '<button id="go-back-btn" class="btn-ghost" data-action="go-back" data-drop-path="" title="Назад" style="padding:6px 10px;flex-shrink:0"><span class="material-symbols-outlined">arrow_back</span></button>' +
  '<div id="breadcrumb" style="flex:1;min-width:0;display:flex;align-items:center;flex-wrap:wrap;font-size:14px;color:var(--on-surf-var)"></div>' +
  '<div id="toolbar-search-wrap" style="display:none;position:relative;flex-shrink:0">' +
  '<input id="search-inp" type="text" role="searchbox" placeholder="Search files, folders..." style="width:260px;padding:10px 16px 10px 44px;border-radius:9999px;background:var(--surf-hi);border:none;outline:none;font-size:14px;height:42px;color:var(--on-surf);font-family:Manrope,sans-serif" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-form-type="other" data-lpignore="true" data-1p-ignore tabindex="0">' +
  '<span class="material-symbols-outlined" style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--accent-light);font-size:20px;pointer-events:none">search</span>' +
  '</div>' +
  '<button id="toolbar-view-list" class="btn-ghost" data-action="view-list" title="Список" style="width:40px;height:40px;padding:0;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">view_list</span></button>' +
  '<button id="toolbar-view-grid" class="btn-ghost" data-action="view-grid" title="Сетка" style="width:40px;height:40px;padding:0;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">grid_view</span></button>' +
  '<button id="toolbar-theme" class="btn-ghost" data-action="toggle-theme" title="Тема" style="width:40px;height:40px;padding:0;flex-shrink:0;display:inline-flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">contrast</span></button>' +
  '<button id="toolbar-upload" class="btn-primary" data-action="upload-btn" style="flex-shrink:0;gap:6px;display:flex;align-items:center"><span class="material-symbols-outlined" style="font-size:18px;font-variation-settings:\'FILL\' 1,\'wght\' 700,\'GRAD\' 0,\'opsz\' 20">upload</span>Загрузить</button>' +
  '</div>' +
  '<section id="mobile-storage" class="card" style="display:none">' +
  '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-bottom:18px">' +
  '<h2 style="font-size:24px;line-height:30px;font-weight:800;color:#fff;margin:0">Storage</h2>' +
  '<div style="font-size:16px;color:#ccc3d8;font-weight:700" id="mobile-disk-label">Загрузка...</div>' +
  '</div>' +
  '<div class="disk-bar"><div class="disk-fill" id="mobile-disk-fill" style="width:0%"></div></div>' +
  '</section>' +
  '<div class="mobile-actions" style="padding:12px 24px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #1f1f22;flex-shrink:0">' +
  '<input type="file" id="upload-input" multiple style="display:none">' +
  '<button class="btn-ghost" data-action="open-url-modal"><span class="material-symbols-outlined">link</span> URL</button>' +
  '<button class="btn-ghost" data-action="mkdir"><span class="material-symbols-outlined">create_new_folder</span> Новая папка</button>' +
  '</div>' +
  '<div id="selection-bar">' +
  '<div id="selection-count" style="font-size:13px;font-weight:600;color:#d0bcff;flex:1">0 selected</div>' +
  '<button class="btn-ghost" data-action="download-selected">Скачать всё</button>' +
  '<button class="btn-ghost" data-action="zip-selected">Скачать архивом</button>' +
  '<button class="btn-ghost" data-action="share-selected">Публичная ссылка</button>' +
  '<button class="btn-ghost" data-action="clear-selection">Сбросить</button>' +
  '<button class="btn-ghost" data-action="delete-selected" style="color:#ffb4ab;border-color:#93000a">Удалить</button>' +
  '</div>' +
  '<div id="file-scroll" style="flex:1;overflow-y:auto;padding:16px 24px">' +
  '<div id="file-area"><div style="color:#958ea0;padding:40px;text-align:center">Загрузка...</div></div>' +
  '</div>' +
  '<div id="transfers-card" class="card">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><div style="font-size:13px;font-weight:700;color:#cbc3d7;flex:1">Активные загрузки</div><button class="btn-ghost" data-action="minimize-transfers" style="padding:4px 8px" title="Свернуть"><span class="material-symbols-outlined">remove</span></button></div>' +
  '<div id="transfers-list"><div style="color:#494454;font-size:13px">Нет активных загрузок</div></div>' +
  '</div>' +
  '<div id="transfers-chip" data-action="restore-transfers"><span class="material-symbols-outlined">downloading</span><span id="transfers-chip-text">Загрузка...</span></div>' +
  '</main>' +
  '<nav class="mobile-bottom-nav">' +
  '<button class="bottom-nav-item active" data-action="nav-dashboard"><span class="material-symbols-outlined">home</span><span>Главная</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-files"><span class="material-symbols-outlined">folder</span><span>Файлы</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-activity"><span class="material-symbols-outlined">list_alt</span><span>Активность</span></button>' +
  '<button class="bottom-nav-item" data-action="nav-settings"><span class="material-symbols-outlined">settings</span><span>Настройки</span></button>' +
  '<button class="bottom-nav-item" data-action="upload-btn"><span class="material-symbols-outlined">upload</span><span>Загрузить</span></button>' +
  '</nav>' +
  '<aside id="preview-panel" class="preview-panel">' +
  '<div id="preview-resizer" class="preview-resizer"></div>' +
  '<div class="preview-head">' +
  '<div id="preview-title" style="font-weight:700;font-size:17px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-display);color:var(--on-surf)">Детали</div>' +
  '<button id="preview-btn-prev" class="btn-ghost" data-action="preview-prev" style="padding:5px 9px;display:none" title="Предыдущий"><span class="material-symbols-outlined">navigate_before</span></button>' +
  '<button id="preview-btn-next" class="btn-ghost" data-action="preview-next" style="padding:5px 9px;display:none" title="Следующий"><span class="material-symbols-outlined">navigate_next</span></button>' +
  '<button class="btn-ghost" data-action="fullscreen-preview" style="padding:5px 9px" title="На весь экран"><span class="material-symbols-outlined">open_in_full</span></button>' +
  '<button class="btn-ghost" data-action="close-preview" style="padding:5px 9px" title="Закрыть"><span class="material-symbols-outlined">close</span></button>' +
  '</div>' +
  '<div id="preview-body" class="preview-body"></div>' +
  '<div id="preview-info"></div>' +
  '</aside>' +
  /* ── CONTEXT MENU ── */
  '<div id="media-viewer" class="media-viewer">' +
  '<div class="mv-top"><div id="mv-title" class="mv-title">Media</div><button class="mv-icon" data-action="playlist-prev" title="Предыдущий"><span class="material-symbols-outlined">navigate_before</span></button><button class="mv-icon" data-action="playlist-next" title="Следующий"><span class="material-symbols-outlined">navigate_next</span></button><button class="mv-icon" id="mv-btn-screenshot" data-action="mv-screenshot" title="Сделать скриншот" style="display:none"><span class="material-symbols-outlined">photo_camera</span></button><button class="mv-icon" data-action="mv-download" title="Скачать"><span class="material-symbols-outlined">download</span></button><button class="mv-icon" data-action="mv-share" title="Публичная ссылка"><span class="material-symbols-outlined">link</span></button><button class="mv-icon" data-action="mv-close" title="Закрыть"><span class="material-symbols-outlined">close</span></button></div>' +
  '<div id="mv-stage" class="mv-stage"></div>' +
  '<div id="mv-bottom" class="mv-bottom"></div>' +
  '</div>' +
  '<div id="modal-text-editor" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:min(700px,96vw);max-height:90vh;display:flex;flex-direction:column">' +
  '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-shrink:0">' +
  '<div><div style="font-weight:700;font-size:17px" id="te-title">Редактор</div><div style="font-size:12px;color:var(--on-surf-var);margin-top:2px" id="te-path-label"></div></div>' +
  '<button class="btn-ghost" data-action="close-text-editor" style="padding:6px 10px"><span class="material-symbols-outlined">close</span></button>' +
  '</div>' +
  '<div id="te-status" style="font-size:12px;min-height:18px;margin-bottom:8px;color:var(--on-surf-var);flex-shrink:0"></div>' +
  '<textarea id="te-textarea" spellcheck="false" style="flex:1;min-height:340px;max-height:60vh;width:100%;background:var(--surf-hi);color:var(--on-surf);border:1.5px solid var(--outline-var);border-radius:14px;padding:14px 16px;font-size:13px;font-family:\'JetBrains Mono\',\'Fira Mono\',\'Cascadia Code\',Consolas,monospace;line-height:1.6;resize:vertical;outline:none;box-sizing:border-box;transition:border-color .2s" onfocus="this.style.borderColor=\'var(--accent-color)\'" onblur="this.style.borderColor=\'var(--outline-var)\'"></textarea>' +
  '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;flex-shrink:0">' +
  '<div style="font-size:11px;color:var(--outline)">Ctrl+S — сохранить</div>' +
  '<div style="display:flex;gap:10px">' +
  '<button class="btn-ghost" data-action="close-text-editor">Отмена</button>' +
  '<button class="btn-primary" data-action="save-text-editor"><span class="material-symbols-outlined" style="font-size:17px">save</span> Сохранить</button>' +
  '</div></div>' +
  '</div></div>' +
  '<div id="ctx-menu"></div>' +
'<div id="toast" style="display:none;flex-direction:column;gap:14px;box-sizing:border-box">' +
  '  <div style="display:flex;justify-content:space-between;align-items:center;width:100%">' +
  '    <div id="toast-title" style="font-weight:800;font-size:16px;font-family:var(--font-display);color:#fff">Поделиться ссылкой</div>' +
  '    <button class="btn-ghost" data-action="hide-toast" style="padding:4px;min-height:auto;min-width:auto;border-color:transparent;border-radius:50%;color:#958ea0;display:flex;align-items:center;justify-content:center;background:transparent" title="Закрыть"><span class="material-symbols-outlined" style="font-size:18px">close</span></button>' +
  '  </div>' +
  '  <div id="toast-body" style="font-size:12px;color:#958ea0;word-break:break-all;line-height:1.4"></div>' +
  '  <div id="toast-share-actions" style="display:flex;justify-content:space-around;align-items:center;margin-top:4px;width:100%">' +
  '    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer" data-action="copy-toast">' +
  '      <div class="toast-circle" style="width:54px;height:54px;border-radius:50%;background:color-mix(in srgb,var(--accent-color) 12%,#1b1b1e);border:1px solid color-mix(in srgb,var(--accent-color) 20%,transparent);display:flex;align-items:center;justify-content:center;transition:transform .2s cubic-bezier(.4,0,.2,1)">' +
  '        <span class="material-symbols-outlined" style="color:var(--accent-light);font-size:22px">content_copy</span>' +
  '      </div>' +
  '      <span style="font-size:11px;font-weight:600;color:#958ea0">Копировать</span>' +
  '    </div>' +
  '    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer" data-action="open-toast-qr">' +
  '      <div class="toast-circle" style="width:54px;height:54px;border-radius:50%;background:color-mix(in srgb,var(--accent-color) 12%,#1b1b1e);border:1px solid color-mix(in srgb,var(--accent-color) 20%,transparent);display:flex;align-items:center;justify-content:center;transition:transform .2s cubic-bezier(.4,0,.2,1)">' +
  '        <span class="material-symbols-outlined" style="color:var(--accent-light);font-size:22px">qr_code_2</span>' +
  '      </div>' +
  '      <span style="font-size:11px;font-weight:600;color:#958ea0">QR-код</span>' +
  '    </div>' +
  '    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer" data-action="open-toast-link">' +
  '      <div class="toast-circle" style="width:54px;height:54px;border-radius:50%;background:color-mix(in srgb,var(--accent-color) 12%,#1b1b1e);border:1px solid color-mix(in srgb,var(--accent-color) 20%,transparent);display:flex;align-items:center;justify-content:center;transition:transform .2s cubic-bezier(.4,0,.2,1)">' +
  '        <span class="material-symbols-outlined" style="color:var(--accent-light);font-size:22px">open_in_new</span>' +
  '      </div>' +
  '      <span style="font-size:11px;font-weight:600;color:#958ea0">Перейти</span>' +
  '    </div>' +
  '  </div>' +
  '</div>' +
  '<div id="connection-pill"><span class="dot"></span><span id="connection-text">Проверяю соединение...</span></div>' +
  /* ── DROP ZONE ── */
  '<div id="drop-zone">' +
  '<div style="font-size:48px">\u{1F4E5}</div>' +
  '<div style="font-size:20px;font-weight:700;color:#d0bcff">Перетащите файлы для загрузки</div>' +
  '<div style="font-size:13px;color:#958ea0">Отпустите, чтобы загрузить в текущую папку</div>' +
  '</div>' +
  /* ── MKDIR MODAL ── */
  '<div id="upload-panel">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">' +
  '<div id="upload-title" style="font-size:13px;font-weight:700;color:#e4e1e6;flex:1">Upload</div>' +
  '<button class="btn-ghost" data-action="hide-upload-panel" style="padding:3px 8px;font-size:12px">x</button>' +
  '</div>' +
  '<div id="upload-files" style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px"></div>' +
  '<div class="progress-track" style="height:8px;margin-bottom:8px"><div id="upload-fill" class="progress-fill" style="width:0%"></div></div>' +
  '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px">' +
  '<div id="upload-status" style="font-size:13px;font-weight:700;color:var(--accent-light);min-width:36px">0%</div>' +
  '<div id="upload-speed" style="font-size:12px;color:#8ff0a4"></div>' +
  '</div>' +
  '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
  '<div id="upload-bytes" style="font-size:11px;color:#958ea0"></div>' +
  '<div style="font-size:11px;color:#958ea0">ETA: <span id="upload-eta">-</span></div>' +
  '</div>' +
  '</div>' +
  '<div id="modal-mkdir" class="modal-backdrop" style="display:none">' +
  '<div class="modal">' +
  '<div style="font-weight:700;font-size:18px;margin-bottom:16px">Новая папка</div>' +
  '<input id="mkdir-name" class="inp" placeholder="Название папки" style="margin-bottom:16px">' +
  '<div style="display:flex;gap:10px;justify-content:flex-end">' +
  '<button class="btn-ghost" data-action="close-mkdir">Отмена</button>' +
  '<button class="btn-primary" data-action="confirm-mkdir">Создать</button>' +
  '</div></div></div>' +
  /* ── RENAME MODAL ── */
  '<div id="modal-rename" class="modal-backdrop" style="display:none">' +
  '<div class="modal">' +
  '<div style="font-weight:700;font-size:18px;margin-bottom:16px">Переименовать</div>' +
  '<div style="display:flex;align-items:center;margin-bottom:16px">' +
  '<input id="rename-inp" class="inp" style="flex:1;min-width:0;border-top-right-radius:0;border-bottom-right-radius:0">' +
  '<div id="rename-ext" class="inp" style="display:none;width:auto;flex:0 0 auto;border-left:0;border-top-left-radius:0;border-bottom-left-radius:0;color:#958ea0;background:#121216"></div>' +
  '</div>' +
  '<div style="display:flex;gap:10px;justify-content:flex-end">' +
  '<button class="btn-ghost" data-action="close-rename">Отмена</button>' +
  '<button class="btn-primary" data-action="confirm-rename">Сохранить</button>' +
  '</div></div></div>' +
  /* ── CONFLICT MODAL ── */
  '<div id="modal-conflict" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:460px">' +
  '<div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">' +
  '<div style="width:40px;height:40px;border-radius:12px;background:rgba(255,180,0,.12);display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
  '<span class="material-symbols-outlined" style="color:#ffb400;font-size:22px">warning</span></div>' +
  '<div style="font-weight:700;font-size:17px">Файл уже существует</div>' +
  '</div>' +
  '<div id="conflict-desc" style="color:var(--on-surface-variant,#958ea0);font-size:13px;margin-bottom:18px;line-height:1.5"></div>' +
  '<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">' +
  /* radio: replace */
  '<label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;cursor:pointer;border:1.5px solid transparent" id="copt-replace-lbl">' +
  '<input type="radio" name="conflict-opt" value="replace" style="accent-color:var(--primary,#a78bfa);width:16px;height:16px">' +
  '<div><div style="font-size:14px;font-weight:600">Заменить</div><div style="font-size:12px;color:var(--on-surface-variant,#958ea0)">Существующий файл будет перезаписан</div></div>' +
  '</label>' +
  /* radio: skip */
  '<label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;cursor:pointer;border:1.5px solid transparent" id="copt-skip-lbl">' +
  '<input type="radio" name="conflict-opt" value="skip" style="accent-color:var(--primary,#a78bfa);width:16px;height:16px">' +
  '<div><div style="font-size:14px;font-weight:600">Пропустить</div><div style="font-size:12px;color:var(--on-surface-variant,#958ea0)">Конфликтующие файлы не будут загружены</div></div>' +
  '</label>' +
  /* radio: rename */
  '<label style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;cursor:pointer;border:1.5px solid transparent" id="copt-rename-lbl">' +
  '<input type="radio" name="conflict-opt" value="rename" style="accent-color:var(--primary,#a78bfa);width:16px;height:16px">' +
  '<div><div style="font-size:14px;font-weight:600">Сохранить оба</div><div id="conflict-freename-hint" style="font-size:12px;color:var(--on-surface-variant,#958ea0)">Загрузить с новым именем</div></div>' +
  '</label>' +
  '</div>' +
  '<div style="display:flex;gap:10px;justify-content:flex-end">' +
  '<button class="btn-ghost" data-action="close-conflict">Отмена</button>' +
  '<button class="btn-primary" id="conflict-confirm-btn" data-action="confirm-conflict">Продолжить</button>' +
  '</div></div></div>' +
  '<div id="modal-url" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:520px">' +
  /* header */
  '<div style="display:flex;align-items:center;gap:14px;margin-bottom:22px">' +
  '<div style="width:48px;height:48px;border-radius:16px;background:var(--accent-bg);display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
  '<span class="material-symbols-outlined" style="color:var(--accent-color);font-size:26px;font-variation-settings:\'FILL\' 1">download</span>' +
  '</div>' +
  '<div><div style="font-weight:700;font-size:20px;font-family:var(--font-display);color:var(--on-surf)">Загрузить по URL</div>' +
  '<div style="font-size:13px;color:var(--on-surf-var);margin-top:3px">Файл попадёт в текущую папку CloudSpace</div>' +
  '</div></div>' +
  /* batch toggle */
  '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
  '  <div style="font-size:11px;font-weight:600;color:var(--on-surf-var);text-transform:uppercase;letter-spacing:.8px">Ссылка для загрузки</div>' +
  '  <button class="btn-ghost" id="url-toggle-batch" onclick="toggleUrlBatchMode()" style="padding:4px 8px;font-size:11px;border-radius:8px;min-height:24px;color:var(--accent-light)">Несколько ссылок</button>' +
  '</div>' +
  /* url input */
  '<div class="url-dl-inp-wrap" style="margin-bottom:14px">' +
  '<span class="material-symbols-outlined url-inp-icon">link</span>' +
  '<input id="url-dl-inp" type="text" placeholder="https://example.com/file.zip или ссылка YouTube..." autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore>' +
  '<textarea id="url-dl-inp-batch" style="display:none;width:100%;height:100px;border-radius:14px;border:1.5px solid var(--outline-var);padding:10px 14px;background:var(--surf-hi);color:var(--on-surf);font-size:13px;font-family:monospace;resize:none;outline:none;box-sizing:border-box;transition:border-color .2s,box-shadow .2s;margin-top:2px" placeholder="Вставьте одну или несколько ссылок, каждую с новой строки..." onfocus="this.style.borderColor=\'var(--accent-color)\';this.style.boxShadow=\'0 0 0 3px color-mix(in srgb,var(--accent-color) 18%,transparent)\'" onblur="this.style.borderColor=\'var(--outline-var)\';this.style.boxShadow=\'none\'"></textarea>' +
  '</div>' +
  /* mode label */
  '<div style="font-size:11px;font-weight:600;color:var(--on-surf-var);text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">Тип загрузки</div>' +
  /* hidden select used by addUrlDownload */
  '<select id="url-mode-inp" style="display:none"><option value="file">file</option><option value="video">video</option><option value="audio">audio</option><option value="best">best</option></select>' +
  /* cards 2×2 */
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px">' +
  '<div id="url-card-file" class="url-mode-card selected" onclick="selectUrlMode(\'file\')">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
  '<div style="width:36px;height:36px;border-radius:10px;background:color-mix(in srgb,var(--accent-color) 16%,transparent);display:flex;align-items:center;justify-content:center">' +
  '<span class="material-symbols-outlined" style="font-size:20px;color:var(--accent-color);font-variation-settings:\'FILL\' 1">insert_drive_file</span>' +
  '</div>' +
  '<div style="font-size:14px;font-weight:700;color:var(--on-surf)">Файл</div>' +
  '</div>' +
  '<div style="font-size:12px;color:var(--on-surf-var);line-height:1.45">Прямая ссылка на любой файл</div>' +
  '</div>' +
  '<div id="url-card-video" class="url-mode-card" onclick="selectUrlMode(\'video\')">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
  '<div style="width:36px;height:36px;border-radius:10px;background:rgba(255,100,80,.13);display:flex;align-items:center;justify-content:center">' +
  '<span class="material-symbols-outlined" style="font-size:20px;color:#ff6454;font-variation-settings:\'FILL\' 1">movie</span>' +
  '</div>' +
  '<div style="font-size:14px;font-weight:700;color:var(--on-surf)">Видео</div>' +
  '</div>' +
  '<div style="font-size:12px;color:var(--on-surf-var);line-height:1.45">YouTube, Vimeo и другие площадки</div>' +
  '</div>' +
  '<div id="url-card-audio" class="url-mode-card" onclick="selectUrlMode(\'audio\')">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
  '<div style="width:36px;height:36px;border-radius:10px;background:rgba(80,180,255,.13);display:flex;align-items:center;justify-content:center">' +
  '<span class="material-symbols-outlined" style="font-size:20px;color:#50b4ff;font-variation-settings:\'FILL\' 1">music_note</span>' +
  '</div>' +
  '<div style="font-size:14px;font-weight:700;color:var(--on-surf)">MP3 аудио</div>' +
  '</div>' +
  '<div style="font-size:12px;color:var(--on-surf-var);line-height:1.45">Извлечь аудиодорожку в MP3</div>' +
  '</div>' +
  '<div id="url-card-best" class="url-mode-card" onclick="selectUrlMode(\'best\')">' +
  '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
  '<div style="width:36px;height:36px;border-radius:10px;background:rgba(180,120,255,.13);display:flex;align-items:center;justify-content:center">' +
  '<span class="material-symbols-outlined" style="font-size:20px;color:#b478ff;font-variation-settings:\'FILL\' 1">hd</span>' +
  '</div>' +
  '<div style="font-size:14px;font-weight:700;color:var(--on-surf)">Лучшее качество</div>' +
  '</div>' +
  '<div style="font-size:12px;color:var(--on-surf-var);line-height:1.45">Наилучший доступный медиаформат</div>' +
  '</div>' +
  '</div>' + /* end grid */
  /* quality + audio selector — shown only for video/best modes */
  '<div id="url-media-opts" style="display:none;margin-bottom:16px">' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
  '<div>' +
  '<div style="font-size:11px;font-weight:600;color:var(--on-surf-var);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Разрешение</div>' +
  '<select id="url-quality-inp" style="width:100%;background:var(--surf-hi);color:var(--on-surf);border:1.5px solid var(--outline-var);border-radius:10px;padding:9px 12px;font-size:13px;font-family:Manrope,sans-serif;outline:none;cursor:pointer">' +
  '<option value="">Лучшее доступное</option>' +
  '<option value="2160">4K (2160p)</option>' +
  '<option value="1440">2K (1440p)</option>' +
  '<option value="1080">1080p Full HD</option>' +
  '<option value="720">720p HD</option>' +
  '<option value="480">480p</option>' +
  '<option value="360">360p</option>' +
  '</select>' +
  '</div>' +
  '<div>' +
  '<div style="font-size:11px;font-weight:600;color:var(--on-surf-var);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Контейнер</div>' +
  '<select id="url-container-inp" style="width:100%;background:var(--surf-hi);color:var(--on-surf);border:1.5px solid var(--outline-var);border-radius:10px;padding:9px 12px;font-size:13px;font-family:Manrope,sans-serif;outline:none;cursor:pointer">' +
  '<option value="mp4">MP4 (совместимый)</option>' +
  '<option value="mkv">MKV (лучшее качество)</option>' +
  '</select>' +
  '</div>' +
  '</div>' +
  '</div>' +
  /* optional filename */
  '<input id="url-name-inp" type="text" placeholder="Имя без расширения (необязательно)" autocomplete="off" data-form-type="other" data-lpignore="true" data-1p-ignore>' +
  '<div id="url-name-hint" style="font-size:11px;color:var(--on-surf-var);margin-bottom:14px">Для медиа расширение добавится автоматически: .mp4 / .mkv или .mp3</div>' +
  /* status */
  '<div id="url-status" style="font-size:12px;color:var(--on-surf-var);min-height:18px;margin-bottom:14px"></div>' +
  /* inline media progress — hidden until download starts */
  '<div id="url-modal-progress" style="display:none;margin-bottom:16px">' +
  '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
  '<span id="url-prog-phase" style="font-size:13px;font-weight:600;color:var(--on-surf)">Подготовка...</span>' +
  '<span id="url-prog-right" style="font-size:12px;color:var(--on-surf-var)"></span>' +
  '</div>' +
  '<div style="height:6px;background:var(--surf-hi);border-radius:3px;overflow:hidden">' +
  '<div id="url-prog-bar" class="progress-fill indeterminate" style="height:100%;background:var(--accent-color);border-radius:3px;transform-origin:left;width:0%"></div>' +
  '</div>' +
  '</div>' +
  '<div style="font-size:11px;color:#958ea0;margin-bottom:14px;display:flex;align-items:center;gap:6px" id="url-faq-hint"><span class="material-symbols-outlined" style="font-size:14px;color:var(--accent-light)">info</span>Не загружается YouTube? <a href="/faq.html" target="_blank" style="color:var(--accent-light);text-decoration:none;border-bottom:1px dotted var(--accent-light)">Решения проблем в FAQ</a></div>' +
  /* buttons */
  '<div style="display:flex;gap:10px;justify-content:flex-end" id="url-modal-btns">' +
  '<button class="btn-ghost" data-action="close-url-modal">Отмена</button>' +
  '<button class="btn-primary" id="url-submit-btn" data-action="confirm-url-download" style="display:inline-flex;align-items:center;gap:8px">' +
  '<span class="material-symbols-outlined" style="font-size:18px;font-variation-settings:\'FILL\' 1">download</span>Загрузить' +
  '</button>' +
  '</div></div></div>' +
  '<div id="modal-share" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:460px">' +
  '<div style="font-weight:700;font-size:18px;margin-bottom:6px">Публичная ссылка</div>' +
  '<div id="share-target-label" style="font-size:12px;color:#958ea0;margin-bottom:14px">Настройки доступа</div>' +
  '<label style="display:block;font-size:12px;color:#958ea0;margin-bottom:6px">Срок действия</label>' +
  '<select id="share-expire-inp" class="inp" style="margin-bottom:12px">' +
  '<option value="0">Без ограничения</option><option value="1">1 час</option><option value="24">1 день</option><option value="72">3 дня</option><option value="168">7 дней</option><option value="720">30 дней</option>' +
  '</select>' +
  '<label style="display:block;font-size:12px;color:#958ea0;margin-bottom:6px">Количество скачиваний</label>' +
  '<input id="share-max-inp" class="inp" type="number" min="0" step="1" placeholder="0 = без ограничения" style="margin-bottom:12px">' +
  '<label style="display:block;font-size:12px;color:#958ea0;margin-bottom:6px">Пароль для защиты ссылки (опционально)</label>' +
  '<input id="share-password-inp" class="inp" type="password" placeholder="Оставьте пустым, если пароль не нужен" style="margin-bottom:12px">' +
  '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#958ea0;margin-bottom:12px;cursor:pointer">' +
  '<input type="checkbox" id="share-preview-chk" checked style="cursor:pointer"> Создать страницу предпросмотра (вместо авто-скачивания)' +
  '</label>' +
  '<div id="share-status" style="font-size:12px;color:#958ea0;min-height:16px;margin-bottom:12px"></div>' +
  '<div style="display:flex;gap:10px;justify-content:flex-end">' +
  '<button class="btn-ghost" data-action="close-share-modal">Отмена</button>' +
  '<button class="btn-primary" data-action="confirm-share">Создать ссылку</button>' +
  '</div></div></div>' +
  '<div id="modal-qr" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:380px;text-align:center">' +
  '<div style="font-weight:700;font-size:18px;margin-bottom:6px">QR-код ссылки</div>' +
  '<div id="qr-link-text" style="font-size:12px;color:#958ea0;word-break:break-all;margin-bottom:14px"></div>' +
  '<div style="background:#fff;border-radius:14px;padding:14px;display:inline-flex;margin-bottom:14px"><img id="qr-img" alt="QR code" style="width:260px;height:260px;display:block"></div>' +
  '<div style="display:flex;gap:10px;justify-content:center">' +
  '<a id="qr-open-link" class="btn-ghost" target="_blank" rel="noopener" style="text-decoration:none">Открыть</a>' +
  '<button class="btn-ghost" data-action="copy-toast">Копировать</button>' +
  '<button class="btn-primary" data-action="close-qr">Готово</button>' +
  '</div></div></div>' +
  '<div id="modal-playlist" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:min(500px,94vw);max-height:80vh;display:flex;flex-direction:column;padding:20px;border-radius:24px;background:var(--surf-hi);border:1px solid rgba(255,255,255,.05)">' +
  '  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px">' +
  '    <span class="material-symbols-outlined" style="color:var(--accent-color);font-size:26px">queue_music</span>' +
  '    <div style="font-weight:800;font-size:18px;color:var(--on-surf);flex:1">Очередь воспроизведения</div>' +
  '    <button class="btn-ghost" id="playlist-modal-close" style="padding:4px 8px;font-size:14px;border-radius:50%;width:32px;height:32px;display:flex;align-items:center;justify-content:center"><span class="material-symbols-outlined" style="font-size:20px">close</span></button>' +
  '  </div>' +
  '  <div id="playlist-modal-tracks" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:12px;max-height:50vh"></div>' +
  '</div></div>' +
  '<div id="modal-share-manager" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:min(760px,94vw);max-height:86vh;overflow:auto">' +
  '<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">' +
  '<div style="flex:1"><div style="font-weight:800;font-size:18px;margin-bottom:4px">Публичные ссылки</div><div id="sm-file-label" style="font-size:12px;color:#958ea0;word-break:break-all"></div></div>' +
  '<button class="btn-ghost" data-action="close-share-manager" style="padding:6px 10px"><span class="material-symbols-outlined">close</span></button>' +
  '</div>' +
  '<div id="sm-status" style="font-size:12px;color:#958ea0;min-height:16px;margin-bottom:10px"></div>' +
  '<div id="sm-list"></div>' +
  '<div style="border-top:1px solid #353437;margin-top:14px;padding-top:14px">' +
  '<div style="font-weight:700;font-size:14px;margin-bottom:10px">Создать новую ссылку</div>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">' +
  '<select id="sm-new-expire" class="inp"><option value="0">Без ограничения</option><option value="1">1 час</option><option value="24">1 день</option><option value="72">3 дня</option><option value="168">7 дней</option><option value="720">30 дней</option></select>' +
  '<input id="sm-new-max" class="inp" type="number" min="0" step="1" placeholder="Скачиваний: 0 = без лимита">' +
  '</div>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">' +
  '<input id="sm-new-password" class="inp" type="password" placeholder="Пароль (опционально)">' +
  '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#958ea0;cursor:pointer"><input type="checkbox" id="sm-new-preview" checked> Страница предпросмотра</label>' +
  '</div>' +
  '<div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn-primary" data-action="sm-create"><span class="material-symbols-outlined">add_link</span> Создать ссылку</button></div>' +
  '</div>' +
  '</div></div>' +
  '<div id="modal-changelog" class="modal-backdrop" style="display:none">' +
  '<div class="modal" style="width:min(500px,94vw);max-height:80vh;display:flex;flex-direction:column;padding:24px;border-radius:24px;background:var(--surf-cont);border:1px solid rgba(255,255,255,.05)">' +
  '  <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">' +
  '    <span class="material-symbols-outlined" style="color:var(--accent-color);font-size:28px">campaign</span>' +
  '    <div style="font-weight:800;font-size:18px;color:var(--on-surf);flex:1">Что нового в версии <span id="changelog-ver"></span></div>' +
  '  </div>' +
  '  <div id="changelog-body" style="flex:1;overflow-y:auto;font-size:13px;line-height:1.6;color:#cbc3d7;margin-bottom:18px;max-height:50vh;padding-right:4px"></div>' +
  '  <div style="display:flex;justify-content:flex-end"><button class="btn-primary" data-action="close-changelog" style="min-width:100px">Отлично</button></div>' +
  '</div></div>' +
  '<script>' +
  'var userIsAdmin = ' + (profile.isAdmin ? 'true' : 'false') + ';' +
  'var activeFilter = "all";' +
  'var currentPath="__dashboard__",currentView=localStorage.getItem("fm-view")||"list";' +
  'if(currentView!=="grid")currentView="list";' +
  'function encPath(p){return (p||"").split("/").filter(Boolean).map(encodeURIComponent).join("/");}' +
  'function decPath(p){return (p||"").split("/").filter(Boolean).map(function(x){try{return decodeURIComponent(x);}catch(e){return x;}}).join("/");}' +
  'function hashForPath(p){if(p==="__dashboard__")return "dashboard";if(p==="__recent__")return "recent";if(p==="__activity__")return "activity";if(p==="__settings__")return "settings";return p?"files/"+encPath(p):"files";}' +
  'function parseHash(){var h=(window.location.hash||"").replace(/^#/,"");if(!h)return null;if(h==="dashboard"||h==="__dashboard__")return {type:"dashboard"};if(h==="recent"||h==="__recent__")return {type:"recent"};if(h==="activity"||h==="__activity__")return {type:"activity"};if(h==="settings"||h==="__settings__")return {type:"settings"};if(h==="files")return {type:"files",path:""};if(h.indexOf("files/")===0)return {type:"files",path:decPath(h.slice(6))};return {type:"files",path:decPath(h)};}' +
  'function savePath(p){try{localStorage.setItem("fm-path",p);if(!window._ignoreHash){var next="#"+hashForPath(p);if(window.location.hash!==next)window.location.hash=next;}}catch(e){}}' +
  'function handleHash(){' +
  '  var h=parseHash();if(!h)h={type:"dashboard"};' +
  '  var target=h.type==="dashboard"?"__dashboard__":h.type==="recent"?"__recent__":h.type==="activity"?"__activity__":h.type==="settings"?"__settings__":(h.path||"");' +
  '  if(target===currentPath)return;' +
  '  window._ignoreHash=true;' +
  '  if(h.type==="dashboard")loadDashboard();' +
  '  else if(h.type==="recent")loadRecent();' +
  '  else if(h.type==="activity")loadActivityLog();' +
  '  else if(h.type==="settings")loadCloudSettings();' +
  '  else navigateTo(h.path||"");' +
  '  window._ignoreHash=false;' +
  '}' +
  'window.addEventListener("hashchange",handleHash);' +
  'var renameFp="",renameIsDir=false,renameExt="";' +
  'var ctxFp="",ctxName="",ctxIsDir=false;' +
  'var dragFp=null,dragName=null,dragIsDir=false,dragEl=null,dragItems=null,dragGhostEl=null;' +
  'var selectedItems={},lastEntries=[],lastBase="";' +
  'var previewFp="",previewName="",previewKind="",previewSrc="",mvZoom=1;' +
  'var activeAudioFp="",activeAudioName="",currentAudioQueue=[],sidebarPlayerInitialized=false;' +
  'var urlBatchMode=false,dashUrlBatchMode=false;' +
  'var toastUrl="";' +
  'var pendingShare=null;' +
  'var shareManagerFp="",shareManagerName="";' +
  'var transfersMinimized=localStorage.getItem("transfers-minimized")==="1";' +
  'var knownMediaStatuses={};' +
  'var pendingUrlJobs={};try{pendingUrlJobs=JSON.parse(localStorage.getItem("pending-url-jobs")||"{}")||{};}catch(e){pendingUrlJobs={};}' +
  'var recentNewFiles={};' +
  'var uploadBusy=false;' +
  /* ── UTILS ── */
  'function H(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
  'function highlightCode(code,ext){' +
  '  var escaped=H(code);' +
  '  var store=[];' +
  '  function mask(str,cls){' +
  '    var placeholder="___MASKED_"+store.length+"___";' +
  '    store.push({value:str,cls:cls});' +
  '    return placeholder;' +
  '  }' +
  '  var temp=escaped;' +
  '  temp=temp.replace(/(&quot;|&#39;|\\\'|\'|`)(?:\\\\.|[^\\\\])*?\\\\1/g,function(m){' +
  '    return mask(m,"code-hl-str");' +
  '  });' +
  '  if(["html","xml"].includes(ext)){' +
  '    temp=temp.replace(/&lt;!--[\\\\s\\\\S]*?--&gt;/g,function(m){' +
  '      return mask(m,"code-hl-cmt");' +
  '    });' +
  '  }else{' +
  '    temp=temp.replace(/\\/\\*[\\\\s\\\\S]*?\\*\\//g,function(m){' +
  '      return mask(m,"code-hl-cmt");' +
  '    });' +
  '    temp=temp.replace(/\\/\\/.*$/gm,function(m){' +
  '      return mask(m,"code-hl-cmt");' +
  '    });' +
  '    temp=temp.replace(/#.*$/gm,function(m){' +
  '      return mask(m,"code-hl-cmt");' +
  '    });' +
  '  }' +
  '  if(["html","xml","svg"].includes(ext)){' +
  '    temp=temp.replace(/(&lt;\\/?)([\\\\w:-]+)(.*?)(\\/?&gt;)/g,function(match,open,tag,attrs,close){' +
  '      var highlightedAttrs=attrs.replace(/(\\b[\\\\w:-]+)(=)/g,\'<span class="code-hl-attr">$1</span>$2\');' +
  '      return open+\'<span class="code-hl-tag">\'+tag+\'</span>\'+highlightedAttrs+close;' +
  '    });' +
  '  }else{' +
  '    var keywords=/\\b(break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|function|if|import|in|instanceof|new|return|super|switch|this|throw|try|typeof|var|void|while|with|yield|def|elif|lambda|import|from|as|global|nonlocal|pass|raise|try|except|finally|with|and|or|not|is|in)\\b/g;' +
  '    var builtins=/\\b(console|document|window|Object|Array|String|Number|Boolean|Function|Promise|JSON|Map|Set|dict|list|tuple|set|int|str|float|print|len|range|self)\\b/g;' +
  '    temp=temp.replace(keywords,\'<span class="code-hl-kw">$1</span>\');' +
  '    temp=temp.replace(builtins,\'<span class="code-hl-fn">$1</span>\');' +
  '    temp=temp.replace(/\\b(\\d+(?:\\.\\d+)?)\\b/g,\'<span class="code-hl-num">$1</span>\');' +
  '  }' +
  '  for(var i=store.length-1;i>=0;i--){' +
  '    var placeholder="___MASKED_"+i+"___";' +
  '    var item=store[i];' +
  '    temp=temp.replace(placeholder,\'<span class="\'+item.cls+\'">\'+item.value+\'</span>\');' +
  '  }' +
  '  return temp;' +
  '}' +
  'function fmtSize(b){if(!b)return "0 B";var u=["B","KB","MB","GB"],i=0;while(b>=1024&&i<3){b/=1024;i++;}return b.toFixed(i?1:0)+" "+u[i];}' +
  'function fmtSpeed(b){return fmtSize(b||0)+"/s";}' +
  'function fmtDate(ts){if(!ts)return "";return new Date(ts).toLocaleDateString("ru-RU",{day:"2-digit",month:"short",year:"numeric"});}' +
  'function fmtDateTime(ts){if(!ts)return "";return new Date(ts).toLocaleString("ru-RU",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});}' +
  'function activePath(){return (currentPath==="__dashboard__"||currentPath==="__recent__"||currentPath==="__activity__"||currentPath==="__url_history__"||currentPath==="__settings__")?"":currentPath;}' +
  'function setNavActive(action){document.querySelectorAll(".nav-item,.bottom-nav-item").forEach(function(x){x.classList.toggle("active",x.dataset.action===action);});}' +
  'function parentPath(p){var parts=(p||"").split("/").filter(Boolean);parts.pop();return parts.join("/");}' +
  'function splitExt(name,isDir){if(isDir)return {base:name,ext:""};var dot=name.lastIndexOf(".");if(dot<=0)return {base:name,ext:""};return {base:name.slice(0,dot),ext:name.slice(dot)};}' +
  'function setView(v){currentView=v==="grid"?"grid":"list";localStorage.setItem("fm-view",currentView);if(currentPath!=="__recent__"&&currentPath!=="__url_history__")loadDir();}' +
  'function selectedList(){return Object.keys(selectedItems).map(function(k){return selectedItems[k];});}' +
  'function updateSelectionBar(){var n=selectedList().length;document.getElementById("selection-count").textContent="Выбрано: "+n;document.getElementById("selection-bar").style.display=n?"flex":"none";}' +
  'function clearSelection(refresh){selectedItems={};updateSelectionBar();if(refresh)renderContent(lastEntries,lastBase);}' +
  'function toggleSelect(fp,name,isDir,checked){if(checked)selectedItems[fp]={fp:fp,name:name,isDir:isDir};else delete selectedItems[fp];updateSelectionBar();renderContent(lastEntries,lastBase);}' +
  'function selectAllVisible(checked){selectedItems={};if(checked){for(var i=0;i<lastEntries.length;i++){var f=lastEntries[i];var fp=lastBase?(lastBase+"/"+f.name):f.name;selectedItems[fp]={fp:fp,name:f.name,isDir:!!f.isDir};}}updateSelectionBar();renderContent(lastEntries,lastBase);}' +
  'function refreshCurrent(){if(currentPath==="__dashboard__")loadDashboard();else if(currentPath==="__recent__")loadRecent();else if(currentPath==="__activity__")loadActivityLog();else if(currentPath==="__settings__")loadCloudSettings();else loadDir();}' +
  'function goBackPath(){var p=activePath();if(!p)return;navigateTo(parentPath(p));}' +
  'function allVisibleSelected(files,base){if(!files.length)return false;for(var i=0;i<files.length;i++){var fp=base?(base+"/"+files[i].name):files[i].name;if(!selectedItems[fp])return false;}return true;}' +
  'function selectedPayload(){return selectedList().map(function(x){return {path:x.fp,isDir:x.isDir};});}' +
  'function itemParent(fp){var parts=(fp||"").split("/").filter(Boolean);parts.pop();return parts.join("/");}' +
  'function setSmartVisible(el,on,display){if(el)el.style.display=on?display:"none";}' +
  'function updateSmartToolbar(kind){' +
  '  var isFiles=kind==="files",isDashboard=kind==="dashboard";' +
  '  var toolbar=document.querySelector(".desktop-toolbar"),back=document.getElementById("go-back-btn"),bc=document.getElementById("breadcrumb"),search=document.getElementById("toolbar-search-wrap"),viewList=document.getElementById("toolbar-view-list"),viewGrid=document.getElementById("toolbar-view-grid"),theme=document.getElementById("toolbar-theme"),upload=document.getElementById("toolbar-upload");' +
  '  var hasParent=isFiles&&!!(currentPath||"");' +
  '  setSmartVisible(back,hasParent,"flex");' +
  '  setSmartVisible(bc,!isDashboard,"flex");' +
  '  setSmartVisible(search,false,"block");' +
  '  setSmartVisible(viewList,isFiles,"flex");' +
  '  setSmartVisible(viewGrid,isFiles,"flex");' +
  '  setSmartVisible(upload,isFiles,"inline-flex");' +
  '  setSmartVisible(theme,true,"inline-flex");' +
  '  if(toolbar)toolbar.style.justifyContent=isDashboard?"flex-end":"flex-start";' +
  '}' +
  'function setSectionChrome(kind){var a=document.querySelector(".mobile-actions");if(a)a.style.display=kind==="files"?"flex":"none";updateSmartToolbar(kind);if(kind!=="files"){try{clearTimeout(searchTimer);var s=document.getElementById("search-inp");if(s)s.value="";}catch(e){}}}' +
  'function moveItemTo(from,name,dest){dest=dest||"";if(!from||dest===from||dest.indexOf(from+"/")===0)return;var to=dest?(dest+"/"+name):name;if(to===from)return;fetch("/api/fm/move",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:from,to:to})}).then(function(r){return r.json();}).then(function(d){if(d.ok)navigateTo(activePath());else alert(d.error||"Ошибка перемещения");});}' +
  'function moveMultiTo(items,dest){dest=dest||"";var valid=items.filter(function(item){if(!item.fp||item.fp===dest)return false;if(dest&&dest.indexOf(item.fp+"/")===0)return false;return true;});if(!valid.length)return;var promises=valid.map(function(item){var to=dest?(dest+"/"+item.name):item.name;if(to===item.fp)return Promise.resolve({ok:true});return fetch("/api/fm/move",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({from:item.fp,to:to})}).then(function(r){return r.json();});});Promise.all(promises).then(function(results){var errs=results.filter(function(d){return!d.ok;});clearSelection();navigateTo(activePath());if(errs.length)alert(errs.length+" файл(ов) не удалось переместить");});}' +
  'function fileEmojiDrag(name,isDir){if(isDir)return"📁";var e=(name||"").split(".").pop().toLowerCase();return{mp4:"🎬",mkv:"🎬",avi:"🎬",mov:"🎬",webm:"🎬",mp3:"🎵",flac:"🎵",wav:"🎵",zip:"📦",rar:"📦","7z":"📦",tar:"📦",gz:"📦",exe:"💿",msi:"💿",iso:"💿",pdf:"📄",jpg:"🖼",jpeg:"🖼",png:"🖼",gif:"🖼",webp:"🖼"}[e]||"📄";}' +
  'function createDragGhost(e,items){removeDragGhost();var count=items.length;var first=items[0];var cs=getComputedStyle(document.documentElement);var surfCont=cs.getPropertyValue("--surf-cont").trim()||"#1b1b1f";var onSurf=cs.getPropertyValue("--on-surf").trim()||"#e4e1e7";var accentRaw=cs.getPropertyValue("--accent-color").trim()||"120 80 255";var accent="rgb("+accentRaw+")";var numBg=Math.min(count-1,2);var w=180,cardH=48;var ghost=document.createElement("div");ghost.style.cssText="position:fixed;top:-600px;left:-600px;pointer-events:none;z-index:9999;width:"+(w+numBg*8)+"px;height:"+(cardH+numBg*8)+"px;overflow:visible";for(var i=numBg;i>0;i--){var bg=document.createElement("div");var off=(numBg-i+1)*6;var rot=(numBg-i+1)*2.5;bg.style.cssText="position:absolute;left:"+off+"px;top:"+off+"px;width:"+w+"px;height:"+cardH+"px;background:"+surfCont+";border-radius:13px;transform:rotate("+rot+"deg);box-shadow:0 4px 16px rgba(0,0,0,.45);border:1.5px solid rgba(255,255,255,.07);opacity:.62";ghost.appendChild(bg);}var front=document.createElement("div");front.style.cssText="position:absolute;left:0;top:0;width:"+w+"px;height:"+cardH+"px;background:"+surfCont+";border-radius:13px;display:flex;align-items:center;gap:8px;padding:0 12px;box-shadow:0 8px 30px rgba(0,0,0,.55);border:1.5px solid rgba(255,255,255,.13);overflow:hidden";var ico=document.createElement("span");ico.style.cssText="font-size:20px;flex-shrink:0;line-height:1";ico.textContent=fileEmojiDrag(first.name,first.isDir);var nm=document.createElement("span");nm.style.cssText="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:12px;font-weight:700;color:"+onSurf+";font-family:Manrope,system-ui,sans-serif";nm.textContent=first.name.length>22?first.name.slice(0,20)+"…":first.name;front.appendChild(ico);front.appendChild(nm);if(count>1){var badge=document.createElement("div");badge.style.cssText="position:absolute;top:-8px;right:-8px;background:"+accent+";color:#fff;border-radius:9999px;font-size:11px;font-weight:800;min-width:20px;height:20px;display:flex;align-items:center;justify-content:center;padding:0 4px;box-shadow:0 2px 8px rgba(0,0,0,.5);font-family:Manrope,system-ui,sans-serif";badge.textContent=count;front.appendChild(badge);}ghost.appendChild(front);document.body.appendChild(ghost);dragGhostEl=ghost;e.dataTransfer.setDragImage(ghost,24,cardH/2);}' +
  'function removeDragGhost(){if(dragGhostEl){try{document.body.removeChild(dragGhostEl);}catch(ex){}dragGhostEl=null;}}' +
  'function showToast(title,body,url){title=title||"";body=body||"";toastUrl=url||"";if(!title&&!body&&!url)return hideToast();document.getElementById("toast-title").textContent=title;document.getElementById("toast-body").textContent=body||url||"";var actions=document.getElementById("toast-share-actions");if(actions){actions.style.display=url?"flex":"none";}document.getElementById("toast").style.display="flex";if(url&&navigator.clipboard)navigator.clipboard.writeText(url).catch(function(){});}' +
  'function hideToast(){document.getElementById("toast").style.display="none";}' +
  'function copyToast(){if(toastUrl&&navigator.clipboard)navigator.clipboard.writeText(toastUrl).then(function(){showToast("Скопировано",toastUrl,toastUrl);});}' +
  'function qrImageUrl(url){return "/api/qr?data="+encodeURIComponent(url);}' +
  'function openQrModal(url){var full=url||toastUrl;if(!full)return;toastUrl=full;document.getElementById("qr-link-text").textContent=full;document.getElementById("qr-img").src=qrImageUrl(full);document.getElementById("qr-open-link").href=full;document.getElementById("modal-qr").style.display="flex";}' +
  'function closeQrModal(){document.getElementById("modal-qr").style.display="none";document.getElementById("qr-img").removeAttribute("src");}' +
  'function closeChangelogModal(){document.getElementById("modal-changelog").style.display="none";}' +
  'function showChangelogModal(){var m=document.getElementById("modal-changelog");if(!m)return;document.getElementById("changelog-ver").textContent="' + SITE_VERSION + '";var b=document.getElementById("changelog-body");var h="<ul style=\'margin:0;padding-left:20px;display:flex;flex-direction:column;gap:10px\'>";h+="<li><b>⚡ Мгновенные обновления:</b> Прогресс загрузок теперь приходит в реальном времени через SSE — без опроса сервера каждые 2 секунды.</li>";h+="<li><b>🔔 Push-уведомления:</b> Включите Push в настройках — уведомление о завершении загрузки придёт даже если вкладка закрыта.</li>";h+="<li><b>📁 Конфликты файлов:</b> При загрузке файла с существующим именем — выбор: заменить, пропустить или сохранить оба.</li>";h+="<li><b>🛠 Исправления:</b> Кириллические имена файлов в проверке конфликтов, корректная обработка пропуска всех файлов.</li>";h+="</ul>";b.innerHTML=h;m.style.display="flex";localStorage.setItem("last_seen_changelog_version","' + SITE_VERSION + '");}' +
  'function checkChangelog(){var last=localStorage.getItem("last_seen_changelog_version");if(last!=="' + SITE_VERSION + '"){showChangelogModal();}}' +
  'function copyOrShowLink(url){var full=window.location.origin+url;showToast("Публичная ссылка готова",full,full);}' +
  'function playDoneSound(){try{var ac=new (window.AudioContext||window.webkitAudioContext)();var o=ac.createOscillator(),g=ac.createGain();o.type="sine";o.frequency.setValueAtTime(660,ac.currentTime);o.frequency.setValueAtTime(880,ac.currentTime+.12);g.gain.setValueAtTime(.0001,ac.currentTime);g.gain.exponentialRampToValueAtTime(.08,ac.currentTime+.02);g.gain.exponentialRampToValueAtTime(.0001,ac.currentTime+.34);o.connect(g);g.connect(ac.destination);o.start();o.stop(ac.currentTime+.36);}catch(e){}}' +
  'function notifyDone(name){playDoneSound();showToast("Загрузка завершена",name||"Файл готов","");if("Notification" in window){if(Notification.permission==="granted")new Notification("CloudSpace: загрузка завершена",{body:name||"Файл готов"});else if(Notification.permission==="default")Notification.requestPermission().then(function(p){if(p==="granted")new Notification("CloudSpace: загрузка завершена",{body:name||"Файл готов"});});}}' +
  'function notifyFail(name,error){showToast("Загрузка не удалась",(name||"Media download")+(error?": "+error:""),"");if("Notification" in window){if(Notification.permission==="granted")new Notification("CloudSpace: загрузка не удалась",{body:(name||"Media download")+(error?": "+error:"")});else if(Notification.permission==="default")Notification.requestPermission().then(function(p){if(p==="granted")new Notification("CloudSpace: загрузка не удалась",{body:(name||"Media download")+(error?": "+error:"")});});}}' +
  'var connectionOnline=true,connectionHadDrop=false,connectionTimer=null;' +
  'function setConnectionState(ok,checking){var pill=document.getElementById("connection-pill"),txt=document.getElementById("connection-text");if(!pill||!txt)return;clearTimeout(connectionTimer);pill.classList.remove("offline","checking");if(ok){connectionOnline=true;if(connectionHadDrop){showToast("\\u0421\\u043e\\u0435\\u0434\\u0438\\u043d\\u0435\\u043d\\u0438\\u0435 \\u0432\\u043e\\u0441\\u0441\\u0442\\u0430\\u043d\\u043e\\u0432\\u043b\\u0435\\u043d\\u043e","CloudSpace \\u0441\\u043d\\u043e\\u0432\\u0430 \\u043d\\u0430 \\u0441\\u0432\\u044f\\u0437\\u0438","");connectionHadDrop=false;}pill.style.display="none";return;}connectionOnline=false;connectionHadDrop=true;txt.textContent=checking?"\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0441\\u043e\\u0435\\u0434\\u0438\\u043d\\u0435\\u043d\\u0438\\u0435...":"\\u041d\\u0435\\u0442 \\u0441\\u0432\\u044f\\u0437\\u0438 \\u0441 VPS";pill.classList.add(checking?"checking":"offline");pill.style.display="flex";}' +
  'async function checkConnection(silent){if(!navigator.onLine){setConnectionState(false,false);return;}try{if(!silent)setConnectionState(false,true);var c=new AbortController();var tm=setTimeout(function(){c.abort();},4500);var r=await fetch("/api/speedtest/ping?health=1&x="+Date.now(),{cache:"no-store",signal:c.signal});clearTimeout(tm);setConnectionState(!!r.ok,false);}catch(e){setConnectionState(false,false);}}' +
  'window.addEventListener("offline",function(){setConnectionState(false,false);});' +
  'window.addEventListener("online",function(){checkConnection(false);});' +
  'function rememberNewFile(job){if(!job||!job.file)return;var ts=new Date(job.updatedAt||job.createdAt||Date.now()).getTime();if(Date.now()-ts>30*60*1000)return;var fp=(job.folder?job.folder+"/":"")+job.file;recentNewFiles[fp]=ts+30*60*1000;}' +
  'function savePendingUrlJobs(){try{localStorage.setItem("pending-url-jobs",JSON.stringify(pendingUrlJobs));}catch(e){}}' +
  'function markPendingUrlJob(gid,folder){if(!gid)return;pendingUrlJobs[gid]={folder:folder||"",at:Date.now(),seen:false};savePendingUrlJobs();}' +
  'function clearPendingUrlJob(gid){if(!gid||!pendingUrlJobs[gid])return;delete pendingUrlJobs[gid];savePendingUrlJobs();}' +
  'function isNewFile(fp){var until=recentNewFiles[fp]||0;if(until<Date.now()){delete recentNewFiles[fp];return false;}return true;}' +
  'function setTransfersUi(count){var card=document.getElementById("transfers-card"),chip=document.getElementById("transfers-chip"),txt=document.getElementById("transfers-chip-text");if(!card||!chip)return;if(count>0){txt.textContent=count+" активн.";if(transfersMinimized){card.style.display="none";chip.classList.add("active");}else{card.style.display="block";chip.classList.remove("active");}}else{card.style.display="none";chip.classList.remove("active");}}' +
  'function applyTheme(){var light=localStorage.getItem("fm-theme")==="light";document.body.classList.toggle("light",light);applyAccentColor();}' +
  'function toggleTheme(){localStorage.setItem("fm-theme",document.body.classList.contains("light")?"dark":"light");applyTheme();}' +
  'function fileKind(name){var ext=(name.split(".").pop()||"").toLowerCase();if(["png","jpg","jpeg","gif","webp","svg","bmp"].includes(ext))return"image";if(["mp4","webm","ogg","mov","mkv"].includes(ext))return"video";if(["mp3","wav","m4a","flac","aac","oga"].includes(ext))return"audio";if(ext==="pdf")return"pdf";if(["docx","xlsx","xls","ods","csv"].includes(ext))return"office";if(["zip","rar","7z","tar","gz"].includes(ext))return"archive";if(["exe","msi","apk","deb"].includes(ext))return"app";if(["txt","log","md","json","js","css","html","xml","yml","yaml","ini","conf"].includes(ext))return"text";return"file";}' +
  'function fileThumb(name,fp,isDir){if(isDir)return \'<div class="file-thumb"><span class="material-symbols-outlined">folder</span></div>\';var k=fileKind(name);var ext=(name.split(".").pop()||"").toLowerCase();if(k==="image"||ext==="exe"||k==="video"){var fb=ext==="exe"?"deployed_code":k==="video"?"movie":"image";return \'<div class="file-thumb"><img src="/api/fm/preview?path=\'+encodeURIComponent(fp)+\'&thumb=1" onerror="this.outerHTML=\'+String.fromCharCode(39)+\'<span class=material-symbols-outlined>\'+fb+\'</span>\'+String.fromCharCode(39)+\'"></div>\';}var icons={video:"movie",audio:"audio_file",pdf:"picture_as_pdf",office:"table_view",archive:"folder_zip",app:"deployed_code",text:"article",file:"draft"};return \'<div class="file-thumb"><span class="material-symbols-outlined">\'+(icons[k]||"draft")+\'</span></div>\';}' +
  'function makeZip(items,name,startDownload){return fetch("/api/fm/zip",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items:items,name:name||"cloudspace.zip"})}).then(function(r){return r.json();}).then(function(d){if(!d.ok)throw new Error(d.error||"Ошибка архива");if(startDownload)window.location.href=d.url;return d;});}' +
  'function downloadSelected(){var items=selectedList();if(!items.length)return;if(items.some(function(x){return x.isDir;})||items.length>5){zipSelected();return;}items.forEach(function(it,i){setTimeout(function(){var a=document.createElement("a");a.href="/api/fm/download?path="+encodeURIComponent(it.fp);a.download=it.name;document.body.appendChild(a);a.click();a.remove();},i*350);});}' +
  'function zipSelected(){var items=selectedPayload();if(!items.length)return;makeZip(items,"cloudspace.zip",true).catch(function(e){alert(e.message);});}' +
  'function openShareModal(payload,label){pendingShare=payload;document.getElementById("share-target-label").textContent=label||"Настройки доступа";document.getElementById("share-expire-inp").value="0";document.getElementById("share-max-inp").value="";document.getElementById("share-password-inp").value="";document.getElementById("share-preview-chk").checked=true;document.getElementById("share-status").textContent="";document.getElementById("modal-share").style.display="flex";}' +
  'function closeShareModal(){document.getElementById("modal-share").style.display="none";pendingShare=null;}' +
  'function confirmShare(){if(!pendingShare)return;var body=Object.assign({},pendingShare);body.expiresIn=parseInt(document.getElementById("share-expire-inp").value||"0",10);body.maxDownloads=parseInt(document.getElementById("share-max-inp").value||"0",10);body.password=document.getElementById("share-password-inp").value.trim();body.preview=document.getElementById("share-preview-chk").checked;var st=document.getElementById("share-status");st.textContent="Создаю ссылку...";fetch("/api/fm/share",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){if(d.ok){closeShareModal();copyOrShowLink(d.url);if(previewFp)renderPreviewInfo(previewFp,previewName);}else st.textContent=d.error||"Ошибка ссылки";}).catch(function(){st.textContent="Ошибка ссылки";});}' +
  'function shareSelected(){var items=selectedPayload();if(!items.length)return;openShareModal({items:items},"Выбрано объектов: "+items.length);}' +
  'function shareOne(fp){openShareModal({path:fp},"Объект: "+fp);}' +
  'function shareExpireOptions(selected){var opts=[[0,"Без ограничения"],[1,"1 час"],[24,"1 день"],[72,"3 дня"],[168,"7 дней"],[720,"30 дней"]];return opts.map(function(o){return "<option value=\\""+o[0]+"\\""+(String(selected)===String(o[0])?" selected":"")+">"+o[1]+"</option>";}).join("");}' +
  'function shareDateText(v){return v?fmtDateTime(v):"Без ограничения";}' +
  'function shareMaxText(v){return v?String(v):"Без лимита";}' +
  'function openShareManager(fp,name){shareManagerFp=fp;shareManagerName=name||fp;document.getElementById("sm-file-label").textContent=shareManagerName+" · "+shareManagerFp;document.getElementById("sm-status").textContent="";document.getElementById("sm-new-password").value="";document.getElementById("modal-share-manager").style.display="flex";loadShareManager();}' +
  'function closeShareManager(){document.getElementById("modal-share-manager").style.display="none";shareManagerFp="";shareManagerName="";}' +
  'function renderShareManager(items){var box=document.getElementById("sm-list");if(!items.length){box.innerHTML=\'<div class="card" style="padding:14px;margin:0;color:#958ea0">У этого файла пока нет публичных ссылок.</div>\';return;}var h="";items.forEach(function(x){var full=window.location.origin+x.url;var lockIcon=x.hasPassword?"\u{1F512}":"\u{1F513}";h+=\'<div class="card" style="padding:14px;margin:0 0 10px 0"><div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:10px"><div style="flex:1;min-width:0"><div style="font-size:12px;color:#958ea0;margin-bottom:4px">Создана: \'+H(fmtDateTime(x.created))+\'; действует до: \'+H(shareDateText(x.expiresAt))+\' &middot; \'+lockIcon+\'</div><div style="font-size:12px;color:#d2bbff;word-break:break-all">\'+H(full)+\'</div><div style="font-size:12px;color:#958ea0;margin-top:4px">Скачиваний: \'+H(String(x.downloads||0))+\' / \'+H(shareMaxText(x.maxDownloads))+\'</div></div><button class="btn-ghost" data-action="sm-qr" data-url="\'+H(full)+\'" style="padding:6px 9px"><span class="material-symbols-outlined">qr_code_2</span></button><button class="btn-ghost" data-action="sm-copy" data-url="\'+H(full)+\'" style="padding:6px 9px"><span class="material-symbols-outlined">content_copy</span></button></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px"><select id="sm-expire-\'+H(x.token)+\'" class="inp">\'+shareExpireOptions(0)+\'</select><input id="sm-max-\'+H(x.token)+\'" class="inp" type="number" min="0" step="1" value="\'+H(x.maxDownloads||"")+\'" placeholder="0 = без лимита"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px"><input id="sm-password-\'+H(x.token)+\'" class="inp" type="password" placeholder="Новый пароль"><label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#958ea0;cursor:pointer"><input type="checkbox" id="sm-clear-password-\'+H(x.token)+\'"> Сбросить пароль</label></div><label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#958ea0;margin-bottom:10px"><input type="checkbox" id="sm-preview-\'+H(x.token)+\'" \'+(x.preview!==false?"checked":"")+\' > Страница предпросмотра</label><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-ghost" data-action="sm-save" data-token="\'+H(x.token)+\'">Сохранить</button><button class="btn-ghost" data-action="sm-revoke" data-token="\'+H(x.token)+\'" style="color:#ffb4ab;border-color:#93000a">Отозвать</button></div></div>\';});box.innerHTML=h;}' +
  'function loadShareManager(){if(!shareManagerFp)return;document.getElementById("sm-status").textContent="Загружаю ссылки...";fetch("/api/fm/shares?path="+encodeURIComponent(shareManagerFp)).then(function(r){return r.json();}).then(function(d){if(!d.ok){document.getElementById("sm-status").textContent=d.error||"Ошибка";return;}document.getElementById("sm-status").textContent="";renderShareManager(d.shares||[]);}).catch(function(){document.getElementById("sm-status").textContent="Ошибка загрузки ссылок";});}' +
  'function createManagedShare(){if(!shareManagerFp)return;var body={path:shareManagerFp,expiresIn:parseInt(document.getElementById("sm-new-expire").value||"0",10),maxDownloads:parseInt(document.getElementById("sm-new-max").value||"0",10),password:document.getElementById("sm-new-password").value.trim(),preview:document.getElementById("sm-new-preview").checked};document.getElementById("sm-status").textContent="Создаю ссылку...";fetch("/api/fm/share",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){if(d.ok){document.getElementById("sm-new-expire").value="0";document.getElementById("sm-new-max").value="";document.getElementById("sm-new-password").value="";document.getElementById("sm-new-preview").checked=true;copyOrShowLink(d.url);loadShareManager();if(previewFp===shareManagerFp)renderPreviewInfo(previewFp,previewName);}else document.getElementById("sm-status").textContent=d.error||"Ошибка ссылки";}).catch(function(){document.getElementById("sm-status").textContent="Ошибка ссылки";});}' +
  'function saveManagedShare(token){var clearChecked=!!(document.getElementById("sm-clear-password-"+token)||{}).checked;var passVal=(document.getElementById("sm-password-"+token)||{}).value||"";var body={expiresIn:parseInt((document.getElementById("sm-expire-"+token)||{}).value||"0",10),maxDownloads:parseInt((document.getElementById("sm-max-"+token)||{}).value||"0",10),preview:!!(document.getElementById("sm-preview-"+token)||{}).checked};if(clearChecked)body.password="";else if(passVal.trim())body.password=passVal.trim();document.getElementById("sm-status").textContent="Сохраняю...";fetch("/api/fm/share/"+encodeURIComponent(token),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){document.getElementById("sm-status").textContent=d.ok?"Сохранено":(d.error||"Ошибка");loadShareManager();if(previewFp===shareManagerFp)renderPreviewInfo(previewFp,previewName);}).catch(function(){document.getElementById("sm-status").textContent="Ошибка сохранения";});}' +
  'function revokeManagedShare(token){if(!confirm("Отозвать эту публичную ссылку?"))return;fetch("/api/share/"+encodeURIComponent(token),{method:"DELETE"}).then(function(r){return r.json();}).then(function(d){if(!d.ok)throw new Error(d.error||"Ошибка");loadShareManager();if(previewFp===shareManagerFp)renderPreviewInfo(previewFp,previewName);}).catch(function(e){document.getElementById("sm-status").textContent=e.message;});}' +
  'function copyPlain(url){if(navigator.clipboard)navigator.clipboard.writeText(url).then(function(){showToast("Скопировано",url,url);});}' +
  /* ── BREADCRUMB ── */
  'function renderBreadcrumb(p){' +
  '  var el=document.getElementById("breadcrumb");' +
  '  var parts=p?p.split("/").filter(Boolean):[];' +
  '  var back=document.getElementById("go-back-btn");if(back)back.dataset.dropPath=parentPath(p);' +
  '  var html=\'<span data-action="navigate" data-drop-path="" data-fp="" style="color:var(--accent-color);cursor:pointer;font-weight:600">Мои файлы</span>\';' +
  '  var built="";' +
  '  for(var i=0;i<parts.length;i++){' +
  '    built=built?(built+"/"+parts[i]):parts[i];' +
  '    html+=\'<span class="breadcrumb-sep">/</span>\';' +
  '    html+=\'<span data-action="navigate" data-drop-path="\'+H(built)+\'" data-fp="\'+H(built)+\'" style="cursor:pointer;color:#cbc3d7">\'+H(parts[i])+"</span>";' +
  '  }' +
  '  el.innerHTML=html;' +
  '}' +
  /* ── NAVIGATE & LOAD ── */
  'function navigateTo(p){' +
  '  p=p||"";' +
  '  var s=document.getElementById("search-inp");if(s)s.value="";' +
  '  activeFilter="all";' +
  '  if(p!==currentPath){clearSelection(false);closeConflictModal();}' +
  '  currentPath=p;' +
  '  savePath(p);' +
  '  loadDir();' +
  '}' +
  'function loadDir(){' +
  '  setSectionChrome("files");' +
  '  setNavActive("nav-files");' +
  '  renderBreadcrumb(currentPath);' +
  '  document.getElementById("file-area").innerHTML=\'<div style="color:#958ea0;padding:40px;text-align:center">Загрузка...</div>\';' +
  '  fetch("/api/fm/list?path="+encodeURIComponent(currentPath))' +
  '  .then(function(r){return r.json();})' +
  '  .then(function(d){' +
  '    if(d.error){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\'+H(d.error)+"</div>";return;}' +
  '    renderContent(d.entries||[]);' +
  '  })' +
  '  .catch(function(){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">Ошибка загрузки</div>\';});' +
  '}' +
  "function loadDashboard(){" +
  "  currentPath=\"__dashboard__\";savePath(\"__dashboard__\");clearSelection(false);setSectionChrome(\"dashboard\");setNavActive(\"nav-dashboard\");" +
  "  var bc=document.getElementById(\"breadcrumb\");if(bc)bc.innerHTML='<span style=\"color:var(--accent-color);font-weight:800\">CloudSpace</span><span class=\"breadcrumb-sep\">/</span><span>Главная</span>';" +
  "  var h='';" +
  "  h+='<section style=\"display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,.85fr);gap:18px;align-items:stretch\">';" +
  "  h+='<div style=\"position:relative;overflow:hidden;border:1px solid color-mix(in srgb,var(--accent-color) 46%,transparent);border-radius:24px;padding:28px;background:radial-gradient(circle at 12% 0%,var(--accent-bg),transparent 34%),linear-gradient(135deg,#211934 0%,#141416 58%,#101114 100%);min-height:290px;box-shadow:0 24px 80px rgba(0,0,0,.32)\">';" +
  "  h+='<div style=\"display:flex;align-items:center;gap:10px;margin-bottom:20px;color:#d7c7ff;font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.08em\"><span class=\"material-symbols-outlined\">bolt</span> Быстрая отправка на VPS</div>';" +
  "  h+='<h1 style=\"font-size:34px;line-height:1.08;margin:0 0 10px;color:#fff;font-weight:900;max-width:760px\">Скачай файл на сервер и забери с любого устройства</h1>';" +
  "  h+='<div style=\"color:#bfb5d6;font-size:14px;line-height:1.55;max-width:780px;margin-bottom:22px\">Вставь ссылку, выбери режим или закинь файл с компьютера. Всё попадёт в CloudSpace, без прыжков между вкладками.</div>';" +
"  h+='<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\">';" +
  "  h+='  <div style=\"font-size:11px;font-weight:600;color:var(--on-surf-var);text-transform:uppercase;letter-spacing:.8px\">Ссылка для загрузки</div>';" +
  "  h+='  <button class=\"btn-ghost\" id=\"dash-url-toggle-batch\" onclick=\"toggleDashUrlBatchMode()\" style=\"padding:4px 8px;font-size:11px;border-radius:8px;min-height:24px;color:var(--accent-light);border-color:transparent\">Несколько ссылок</button>';" +
  "  h+='</div>';" +
  "  h+='<div style=\"display:grid;grid-template-columns:minmax(0,1fr) 170px;gap:10px;margin-bottom:10px\">';" +
  "  h+='<div style=\"position:relative;width:100%\">';" +
  "  h+='<input id=\"dash-url-inp\" class=\"inp\" placeholder=\"https://example.com/file.zip или ссылка на видео\" style=\"width:100%;box-sizing:border-box;margin:0\">';" +
  "  h+='<textarea id=\"dash-url-inp-batch\" style=\"display:none;width:100%;height:100px;border-radius:14px;border:1.5px solid var(--outline-var);padding:10px 14px;background:var(--surf-hi);color:var(--on-surf);font-size:13px;font-family:monospace;resize:none;outline:none;box-sizing:border-box;transition:border-color .2s,box-shadow .2s;margin:0\" placeholder=\"Вставьте одну или несколько ссылок, каждую с новой строки...\" onfocus=\"this.style.borderColor=\\'var(--accent-color)\\';this.style.boxShadow=\\'0 0 0 3px color-mix(in srgb,var(--accent-color) 18%,transparent)\\'\" onblur=\"this.style.borderColor=\\'var(--outline-var)\\';this.style.boxShadow=\\'none\\'\"></textarea>';" +
  "  h+='</div>';" +
  "  h+='<select id=\"dash-mode-inp\" class=\"inp\"><option value=\"file\">Обычный файл</option><option value=\"video\">Видео</option><option value=\"audio\">MP3 audio</option><option value=\"best\">Лучший файл</option></select></div>';" +
  "  h+='<div id=\"dash-buttons-row\" style=\"display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center\"><input id=\"dash-name-inp\" class=\"inp\" placeholder=\"Имя без расширения, если нужно\" style=\"margin:0\"><button class=\"btn-primary\" data-action=\"dashboard-url-download\"><span class=\"material-symbols-outlined\">download</span> Загрузить</button><button id=\"dash-upload-btn\" class=\"btn-ghost\" data-action=\"upload-btn\"><span class=\"material-symbols-outlined\">upload_file</span> С ПК</button></div>';" +
  "  h+='<div id=\"dash-url-status\" style=\"font-size:12px;color:#8ff0a4;min-height:18px;margin-top:12px\"></div>';" +
  "  h+='<div style=\"font-size:11px;color:#958ea0;margin-top:10px;display:flex;align-items:center;gap:6px\"><span class=\"material-symbols-outlined\" style=\"font-size:14px;color:var(--accent-light)\">info</span>Не загружается YouTube? <a href=\"/faq.html\" target=\"_blank\" style=\"color:var(--accent-light);text-decoration:none;border-bottom:1px dotted var(--accent-light)\">Попробуйте cookies.txt или откройте FAQ</a></div>';" +
  "  h+='</div>';" +
  "  h+='<div style=\"display:grid;grid-template-rows:auto 1fr;gap:18px\">';" +
  "  h+='<div class=\"card\" data-action=\"nav-files\" style=\"margin:0;padding:24px;cursor:pointer;border-radius:28px;background:linear-gradient(145deg,color-mix(in srgb,var(--accent-color) 12%,var(--surf-cont)),var(--surf-cont));min-height:160px;transition:transform .3s var(--m3-spring),box-shadow .3s\"><div style=\"display:flex;align-items:center;justify-content:space-between;gap:12px\"><div style=\"width:48px;height:48px;border-radius:16px;background:color-mix(in srgb,var(--accent-color) 22%,var(--surf-hi));display:flex;align-items:center;justify-content:center\"><span class=\"material-symbols-outlined\" style=\"font-size:28px;color:var(--accent-light);font-variation-settings:chr(39)FILL chr(39) 1,chr(39)wght chr(39) 600,chr(39)GRAD chr(39) 0,chr(39)opsz chr(39) 28\">folder_open</span></div><span class=\"material-symbols-outlined\" style=\"color:var(--outline)\">arrow_forward_ios</span></div><div style=\"font-size:24px;font-weight:800;color:var(--on-surf);margin-top:20px;font-family:var(--font-display);letter-spacing:-.01em\">Мои файлы</div><div id=\"dash-files-meta\" style=\"font-size:13px;color:var(--on-surf-var);margin-top:6px\">Считаю хранилище...</div></div>';" +
  "  h+='<div class=\"card\" style=\"margin:0;padding:24px;border-radius:28px;background:linear-gradient(145deg,color-mix(in srgb,var(--accent-color) 8%,var(--surf-cont)),var(--surf-cont))\"><div style=\"font-size:11px;color:var(--accent-light);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px\">Хранилище</div><div style=\"display:flex;align-items:flex-end;justify-content:space-between;gap:12px\"><div id=\"dash-disk-big\" style=\"font-size:32px;font-weight:800;color:var(--on-surf);font-family:var(--font-display);letter-spacing:-.02em\">...</div><div id=\"dash-disk-small\" style=\"font-size:12px;color:var(--on-surf-var);text-align:right\">Загрузка</div></div><div class=\"disk-bar\" style=\"margin-top:16px\"><div class=\"disk-fill\" id=\"dash-disk-fill\" style=\"width:0%\"></div></div></div>';" +
  "  h+='</div>';" +
  "  h+='</section>';" +
  "  h+='<section style=\"display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:18px\">';" +
  "  h+=dashActionCard(\"list_alt\",\"Активность\",\"Лог действий с файлами\",\"nav-activity\",\"#ffd166\");" +
  "  h+=dashActionCard(\"settings\",\"Настройки\",\"Пароль, токен, аккаунты\",\"nav-settings\",\"#8ff0a4\");" +
  "  h+=dashActionCard(\"create_new_folder\",\"Новая папка\",\"Сразу перейти в файлы\",\"nav-files\",\"#9ddcff\");" +
  "  h+='</section>';" +
  "  h+='<section style=\"display:grid;grid-template-columns:minmax(0,1fr);gap:18px;margin-top:18px\">';" +
  "  h+='<div class=\"card\" style=\"margin:0;padding:24px;border-radius:28px\"><div style=\"font-size:20px;font-weight:800;color:var(--on-surf);margin-bottom:16px;font-family:var(--font-display);letter-spacing:-.01em\">Сейчас</div><div style=\"display:grid;gap:10px\"><div style=\"display:flex;justify-content:space-between;gap:12px;color:#cbc3d7\"><span>Активные загрузки</span><b id=\"dash-active-count\">0</b></div><div style=\"display:flex;justify-content:space-between;gap:12px;color:#cbc3d7\"><span>Текущий режим</span><b>Cloud</b></div><div style=\"display:flex;justify-content:space-between;gap:12px;color:#cbc3d7\"><span>Версия сайта</span><b style=\"color:var(--accent-light)\">v" + SITE_VERSION + "</b></div></div></div>';" +
  "  h+='</section>';" +
  "  document.getElementById(\"file-area\").innerHTML=h;" +
  "  fetch(\"/api/fm/list?path=\").then(function(r){return r.json();}).then(function(d){" +
  "    var used=d.diskUsed||0,total=d.diskTotal||0,pct=total?Math.min(100,Math.round(used/total*100)):0;" +
  "    var files=(d.entries||[]).filter(function(x){return !x.isDir;}).slice(0,5);" +
  "    var meta=document.getElementById(\"dash-files-meta\");if(meta)meta.textContent=((d.entries||[]).length)+\" объектов · \"+fmtSize(used)+\" / \"+fmtSize(total);" +
  "    var big=document.getElementById(\"dash-disk-big\");if(big)big.textContent=pct+\"%\";" +
  "    var small=document.getElementById(\"dash-disk-small\");if(small)small.textContent=fmtSize(used)+\" занято из \"+fmtSize(total);" +
  "    var fill=document.getElementById(\"dash-disk-fill\");if(fill)fill.style.width=pct+\"%\";" +
  "    var list=document.getElementById(\"dash-recent-list\");if(list)list.innerHTML=files.length?files.map(function(f){var fp=f.name;return '<div data-action=\"preview\" data-fp=\"'+H(fp)+'\" data-name=\"'+H(f.name)+'\" style=\"display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #2d2936;border-radius:14px;cursor:pointer;background:#161619\">'+fileThumb(f.name,fp,false)+'<div style=\"min-width:0;flex:1\"><div style=\"font-size:13px;font-weight:800;color:#e4e1e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">'+H(f.name)+'</div><div style=\"font-size:11px;color:#958ea0\">'+fmtSize(f.size)+' · '+fmtDate(f.mtime)+'</div></div></div>';}).join(\"\"):'<div style=\"color:#494454;font-size:13px\">Пока нет файлов</div>';" +
  "  }).catch(function(){});" +
  "  fetch(\"/api/downloads\").then(function(r){return r.json();}).then(function(items){var el=document.getElementById(\"dash-active-count\");if(el)el.textContent=Array.isArray(items)?items.length:0;}).catch(function(){});" +
  "}" +
  "function dashActionCard(icon,title,body,action,color){return '<button class=\"card\" data-action=\"'+action+'\" style=\"margin:0;padding:18px;border-radius:20px;text-align:left;cursor:pointer;background:#18181b;color:#e4e1e6;min-height:132px\"><span class=\"material-symbols-outlined\" style=\"font-size:30px;color:'+color+'\">'+icon+'</span><div style=\"font-size:16px;font-weight:900;margin-top:18px\">'+title+'</div><div style=\"font-size:12px;color:#958ea0;margin-top:5px;line-height:1.4\">'+body+'</div></button>';}" +
'function toggleDashUrlBatchMode(){' +
  '  dashUrlBatchMode=!dashUrlBatchMode;' +
  '  var single=document.getElementById("dash-url-inp");' +
  '  var batch=document.getElementById("dash-url-inp-batch");' +
  '  var btn=document.getElementById("dash-url-toggle-batch");' +
  '  var nameInp=document.getElementById("dash-name-inp");' +
  '  var uploadBtn=document.getElementById("dash-upload-btn");' +
  '  var row=document.getElementById("dash-buttons-row");' +
  '  if(dashUrlBatchMode){' +
  '    single.style.display="none";' +
  '    batch.style.display="block";' +
  '    btn.textContent="Одна ссылка";' +
  '    btn.style.color="var(--accent-color)";' +
  '    if(nameInp)nameInp.style.display="none";' +
  '    if(uploadBtn)uploadBtn.style.display="none";' +
  '    if(row)row.style.gridTemplateColumns="1fr auto";' +
  '    setTimeout(function(){batch.focus();},50);' +
  '  }else{' +
  '    single.style.display="block";' +
  '    batch.style.display="none";' +
  '    btn.textContent="Несколько ссылок";' +
  '    btn.style.color="var(--accent-light)";' +
  '    if(nameInp)nameInp.style.display="block";' +
  '    if(uploadBtn)uploadBtn.style.display="block";' +
  '    if(row)row.style.gridTemplateColumns="minmax(0,1fr) auto auto";' +
  '    setTimeout(function(){single.focus();},50);' +
  '  }' +
  '}' +
  'function addDashboardUrlDownload(){' +
  '  var mode=document.getElementById("dash-mode-inp").value;' +
  '  var st=document.getElementById("dash-url-status");' +
  '  var media=mode!=="file";' +
  '  if(window.dashUrlBatchMode){' +
  '    var text=document.getElementById("dash-url-inp-batch").value.trim();' +
  '    if(!text){st.textContent="Вставьте ссылки";return;}' +
  '    var urls=text.split("\\n").map(function(x){return x.trim();}).filter(Boolean);' +
  '    if(!urls.length){st.textContent="Вставьте ссылки";return;}' +
  '    st.textContent="Запускаю " + urls.length + " загрузок...";' +
  '    var promises=urls.map(function(url){' +
  '      return fetch(media?"/api/fm/media":"/api/fm/add-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url,filename:"",path:"",mode:mode})})' +
  '        .then(function(r){return r.json();})' +
  '        .then(function(d){' +
  '          if(d.ok){' +
  '            var gid=d.gid||(d.job&&d.job.id);' +
  '            if(gid){knownMediaStatuses[gid]="active";markPendingUrlJob(gid,"");}' +
  '          }' +
  '        });' +
  '    });' +
  '    Promise.all(promises).then(function(){' +
  '      st.textContent="Все загрузки запущены!";' +
  '      document.getElementById("dash-url-inp-batch").value="";' +
  '      loadTransfers();' +
  '      setTimeout(function(){st.textContent="";if(window.dashUrlBatchMode){toggleDashUrlBatchMode();}},1500);' +
  '    }).catch(function(){' +
  '      st.textContent="Ошибка при пакетной отправке";' +
  '    });' +
  '  }else{' +
  '    var url=document.getElementById("dash-url-inp").value.trim();' +
  '    var name=document.getElementById("dash-name-inp").value.trim();' +
  '    if(!url){st.textContent="Вставь URL";return;}' +
  '    if(media)name=stripInputMediaExt(name);' +
  '    st.textContent=media?"Запускаю медиа-загрузку...":"Добавляю загрузку...";' +
  '    fetch(media?"/api/fm/media":"/api/fm/add-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url,filename:name,path:"",mode:mode})})' +
  '    .then(function(r){return r.json();}).then(function(d){' +
  '      if(d.ok){' +
  '        var gid=d.gid||(d.job&&d.job.id);' +
  '        if(gid){knownMediaStatuses[gid]="active";markPendingUrlJob(gid,"");}' +
  '        document.getElementById("dash-url-inp").value="";' +
  '        document.getElementById("dash-name-inp").value="";' +
  '        st.textContent="Загрузка запущена";' +
  '        loadTransfers();' +
  '      }else st.textContent=d.error||"Ошибка";' +
  '    }).catch(function(){st.textContent="Ошибка";});' +
  '  }' +
  '}' +
  'function settingsCard(title,body){return \'<div class="card" style="margin:0;padding:18px">\'+\'<div style="font-size:15px;font-weight:800;margin-bottom:12px;color:#e4e1e6">\'+title+\'</div>\'+body+"</div>";}' +
  'function setCloudStatus(id,msg,ok){var el=document.getElementById(id);if(!el)return;el.textContent=msg||"";el.style.color=ok?"#8ff0a4":"#ffb4ab";}' +
  'function fmtMbps(bytes,ms){if(!ms)return "\\u2014";return ((bytes*8)/(ms/1000)/1000000).toFixed(2)+" Mbps";}' +
  'function setSpeedStatus(msg,ok){var el=document.getElementById("speed-status");if(!el)return;el.textContent=msg||"";el.style.color=ok?"#8ff0a4":"#958ea0";}' +
  'async function runSpeedTest(){var st=document.getElementById("speed-status"),p=document.getElementById("speed-ping"),d=document.getElementById("speed-down"),u=document.getElementById("speed-up");if(!st||!p||!d||!u)return;p.textContent=d.textContent=u.textContent="...";setSpeedStatus("\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0437\\u0430\\u0434\\u0435\\u0440\\u0436\\u043a\\u0443...",false);try{var pingTimes=[];for(var i=0;i<4;i++){var t0=performance.now();await fetch("/api/speedtest/ping?x="+Date.now()+"-"+i,{cache:"no-store"});pingTimes.push(performance.now()-t0);}var ping=Math.round(pingTimes.reduce(function(a,b){return a+b;},0)/pingTimes.length);p.textContent=ping+" ms";setSpeedStatus("\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0441\\u043a\\u0430\\u0447\\u0438\\u0432\\u0430\\u043d\\u0438\\u0435...",false);var size=10*1024*1024,t1=performance.now();var r=await fetch("/api/speedtest/download?size="+size+"&x="+Date.now(),{cache:"no-store"});var buf=await r.arrayBuffer();var downMs=performance.now()-t1;d.textContent=fmtMbps(buf.byteLength,downMs);setSpeedStatus("\\u041f\\u0440\\u043e\\u0432\\u0435\\u0440\\u044f\\u044e \\u0432\\u044b\\u0433\\u0440\\u0443\\u0437\\u043a\\u0443...",false);var upSize=4*1024*1024,payload=new Uint8Array(upSize);for(var j=0;j<upSize;j+=4096)payload[j]=j%251;var t2=performance.now();await fetch("/api/speedtest/upload?x="+Date.now(),{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:payload,cache:"no-store"});var upMs=performance.now()-t2;u.textContent=fmtMbps(upSize,upMs);setSpeedStatus("\\u0413\\u043e\\u0442\\u043e\\u0432\\u043e",true);}catch(e){setSpeedStatus("\\u041d\\u0435 \\u0443\\u0434\\u0430\\u043b\\u043e\\u0441\\u044c \\u0432\\u044b\\u043f\\u043e\\u043b\\u043d\\u0438\\u0442\\u044c \\u0442\\u0435\\u0441\\u0442",false);if(p.textContent==="...")p.textContent="\\u2014";if(d.textContent==="...")d.textContent="\\u2014";if(u.textContent==="...")u.textContent="\\u2014";}}' +
  'function loadCloudSettings(){currentPath="__settings__";savePath("__settings__");clearSelection(false);setSectionChrome("settings");setNavActive("nav-settings");var bc=document.getElementById("breadcrumb");if(bc)bc.innerHTML=\'<span style="color:var(--accent-color);font-weight:800">Настройки</span>\';var html=\'<div class="settings-grid">\';html+=settingsCard(\'Внешний вид\',\'<div class="settings-subtle" style="margin-bottom:14px">Цвет акцента применяется ко всем элементам интерфейса.</div><div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px" id="color-swatches"><button class="color-swatch" data-action="set-accent-hex" data-hex="#a078ff" title="Violet" style="background:#a078ff"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#10b981" title="Emerald" style="background:#10b981"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#f43f5e" title="Ruby" style="background:#f43f5e"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#06b6d4" title="Glacier" style="background:#06b6d4"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#f59e0b" title="Amber" style="background:#f59e0b"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#ec4899" title="Pink" style="background:#ec4899"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#22c55e" title="Green" style="background:#22c55e"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#6366f1" title="Indigo" style="background:#6366f1"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#ef4444" title="Red" style="background:#ef4444"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#14b8a6" title="Teal" style="background:#14b8a6"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#f97316" title="Orange" style="background:#f97316"></button><button class="color-swatch" data-action="set-accent-hex" data-hex="#a855f7" title="Purple" style="background:#a855f7"></button></div><div style="display:flex;align-items:center;gap:12px;margin-bottom:14px"><span class="settings-subtle" style="white-space:nowrap">Свой цвет</span><input type="color" id="accent-color-input" value="#a078ff" title="Выберите цвет"><span id="accent-hex-label" style="font-size:12px;color:var(--accent-light);font-family:monospace;font-weight:700">#a078ff</span></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-ghost" data-action="toggle-theme"><span class="material-symbols-outlined">contrast</span> Светлая / тёмная</button></div>\');html+=settingsCard(\'Профиль\',\'<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px"><div id="settings-profile-avatar" style="width:48px;height:48px;border-radius:16px;background:var(--accent-gradient);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:18px;flex:0 0 auto">?</div><div style="min-width:0;flex:1"><div id="settings-profile-login" class="settings-subtle" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">@...</div><div id="settings-profile-role" style="font-size:12px;color:var(--accent-light);margin-top:2px;font-weight:800"></div></div></div><div class="settings-subtle" style="margin-bottom:8px">Имя в профиле</div><input id="cloud-profile-label" class="inp" maxlength="40" placeholder="CloudSpace" style="margin-bottom:10px"><button class="btn-primary" data-action="settings-save-profile">Сохранить</button><div id="cloud-profile-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard(\'Хранение файлов\',\'<div class="settings-subtle" style="margin-bottom:10px">Автоудаление старых файлов</div><select id="cloud-retention" class="inp" style="margin-bottom:10px"><option value="1">1 день</option><option value="3">3 дня</option><option value="7">7 дней</option><option value="30">30 дней</option><option value="0">Никогда</option></select><button class="btn-primary" data-action="settings-save-retention">Сохранить</button><div id="cloud-retention-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard(\'Уведомления\',\'<div id="cloud-notif-status" class="settings-subtle" style="margin-bottom:10px">Проверяю...</div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-ghost" data-action="settings-notif"><span class="material-symbols-outlined">notifications</span> Уведомления вкладки</button><button class="btn-ghost" id="push-toggle-btn" onclick="togglePushSubscription()">🔕 Включить Push</button></div><div class="settings-subtle" style="margin-top:8px;font-size:11px">Push-уведомления работают даже когда вкладка закрыта</div>\');html+=settingsCard(\'📥 Авто-скачивание\',\'<div class="settings-toggle-row"><div><div style="font-size:14px;font-weight:700;margin-bottom:2px">Авто-скачать на ПК</div><div class="settings-subtle">Когда файл готов на VPS — сразу загружать в браузер</div></div><label class="cloud-switch"><input type="checkbox" id="cloud-auto-dl"><span class="cloud-switch-track"></span></label></div><div class="settings-toggle-row"><div><div style="font-size:14px;font-weight:700;margin-bottom:2px">Уведомления браузера</div><div class="settings-subtle">Пуш при завершении загрузки на VPS</div></div><label class="cloud-switch"><input type="checkbox" id="cloud-notif-toggle"><span class="cloud-switch-track"></span></label></div><div style="margin-top:12px;font-size:11px;color:var(--outline);padding:8px 10px;background:rgba(255,255,255,.04);border-radius:8px">ℹ️ Требуется расширение Chrome. Настройки применяются в этом браузере.</div>\');html+=settingsCard(\'Speed test\',\'<div class="settings-subtle" style="margin-bottom:10px">Проверка скорости между браузером и VPS</div><button class="btn-primary" data-action="settings-speedtest"><span class="material-symbols-outlined">speed</span> Запустить тест</button><div id="speed-status" class="settings-subtle" style="margin-top:10px;min-height:16px"></div><div id="speed-result" class="speed-result"><div class="speed-metric"><b id="speed-ping">—</b><span>Ping</span></div><div class="speed-metric"><b id="speed-down">—</b><span>Download</span></div><div class="speed-metric"><b id="speed-up">—</b><span>Upload</span></div></div>\');html+=settingsCard(\'Токен расширения\',\'<div id="cloud-token-display" style="font-size:12px;color:var(--accent-light);word-break:break-all;margin-bottom:10px">Скрыт</div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn-ghost" data-action="settings-load-token">Показать</button><button class="btn-ghost" data-action="settings-copy-token">Копировать</button><button class="btn-ghost" data-action="settings-reset-token" style="color:#ffb4ab;border-color:#93000a">Сбросить</button></div><div id="cloud-token-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard(\'Telegram\',\'<div id="tg-linked" style="display:none"><div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;padding:10px 12px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);border-radius:10px"><span style="font-size:22px;flex-shrink:0">✅</span><div><div style="font-size:13px;font-weight:700;color:#4ade80">Telegram подключён</div><div id="tg-linked-info" class="settings-subtle" style="margin-top:2px"></div></div></div><button class="btn-ghost" data-action="settings-tg-unlink" style="color:#ffb4ab;border-color:#93000a">Отключить</button></div><div id="tg-unlinked"><div class="settings-subtle" style="margin-bottom:12px">Отправляйте файлы в Telegram — они сохранятся прямо в ваше хранилище на VPS. Поддерживаются документы, фото, видео, аудио.</div><button class="btn-primary" data-action="settings-tg-connect" style="background:linear-gradient(135deg,#0ea5e9,#2563eb)">🤖 Подключить Telegram</button><div class="settings-subtle" style="margin-top:8px">Откроется @SiplyiFolderUpload_bot</div></div><div id="tg-status" style="font-size:12px;margin-top:8px;min-height:16px"></div><hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:14px 0"><div style="font-size:12px;color:#958ea0;margin-bottom:8px">Лимит размера файла через Telegram</div><select id="cloud-tg-limit" class="inp" style="margin-bottom:10px"><option value="5">5 МБ</option><option value="10">10 МБ</option><option value="20">20 МБ</option><option value="50">50 МБ</option><option value="100">100 МБ</option><option value="200">200 МБ</option><option value="500">500 МБ</option><option value="1000">1 ГБ</option><option value="2000">2 ГБ (Максимум)</option></select><button class="btn-primary" data-action="settings-save-tg-limit">Сохранить лимит</button><div id="cloud-tg-limit-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard(\'Пароль\',\'<input id="cloud-pass-current" class="inp" type="password" placeholder="Текущий пароль" style="margin-bottom:10px"><input id="cloud-pass-new" class="inp" type="password" placeholder="Новый пароль" style="margin-bottom:10px"><button class="btn-primary" data-action="settings-change-password">Сменить пароль</button><div id="cloud-pass-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=settingsCard(\'🍪 YouTube Cookies\',\'<div class="settings-subtle" style="margin-bottom:10px">Для скачивания возрастных и приватных видео YouTube нужен файл cookies. Установите расширение <a href="https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc" target="_blank" style="color:var(--accent-light);text-decoration:none">Get cookies.txt LOCALLY</a>, перейдите на YouTube, нажмите на расширение → экспортируйте и загрузите файл сюда.</div><div id="cookies-status-info" style="font-size:12px;color:#958ea0;margin-bottom:12px">Проверяю...</div><div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><label class="btn-primary" style="cursor:pointer;display:inline-flex;align-items:center;gap:6px"><span class="material-symbols-outlined" style="font-size:16px">upload_file</span> Загрузить cookies.txt<input type="file" id="cookies-file-inp" accept=".txt" style="display:none" data-action="cookies-file-change"></label><button class="btn-ghost" data-action="settings-delete-cookies" style="color:#ffb4ab;border-color:#93000a">Удалить</button></div><div id="cookies-upload-status" style="font-size:12px;margin-top:8px;min-height:16px"></div>\');html+=\'<div id="cloud-users-section" class="card" style="margin:0;padding:18px;display:none"><div class="settings-card-title"><span class="material-symbols-outlined">group</span> Аккаунты</div><div id="cloud-users-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px"></div><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px"><input id="cloud-new-username" class="inp" placeholder="Логин"><input id="cloud-new-password" class="inp" placeholder="Пароль"><input id="cloud-new-label" class="inp" placeholder="Имя"></div><button class="btn-primary" data-action="settings-add-user">Добавить аккаунт</button><div id="cloud-users-status" style="font-size:12px;margin-top:8px;min-height:16px"></div></div>\';html+="</div>";document.getElementById("file-area").innerHTML=html;applyAccentColor();initColorPicker();loadCloudProfile();loadCloudRetention();loadCloudAutoDl();updateCloudNotifStatus();loadCloudUsers();loadTelegramStatus();loadCookiesStatus();}' +
  'function loadCloudRetention(){fetch("/api/settings").then(function(r){return r.json();}).then(function(d){var el=document.getElementById("cloud-retention");if(el&&d.retention!==undefined)el.value=String(d.retention);var elTg=document.getElementById("cloud-tg-limit");if(elTg&&d.tgLimit!==undefined)elTg.value=String(d.tgLimit);if(d.accentHex&&/^#[0-9a-fA-F]{6}$/.test(d.accentHex)){localStorage.setItem("cloud-accent-hex",d.accentHex);applyAccentColor();var inp=document.getElementById("accent-color-input");var lbl=document.getElementById("accent-hex-label");if(inp)inp.value=d.accentHex;if(lbl)lbl.textContent=d.accentHex;if(typeof updateColorSwatches==="function")updateColorSwatches(d.accentHex);}else{var presets={"violet":"#a078ff","emerald":"#10b981","ruby":"#f43f5e","glacier":"#06b6d4"};var cur=localStorage.getItem("cloud-accent-hex")||presets[localStorage.getItem("cloud-accent")]||null;if(cur&&/^#[0-9a-fA-F]{6}$/.test(cur))saveAccentServer(cur);}}).catch(function(){});}' +
  'function saveCloudRetention(){var v=document.getElementById("cloud-retention").value;fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({retention:parseInt(v,10)})}).then(function(r){return r.json();}).then(function(d){setCloudStatus("cloud-retention-status",d.ok?"Сохранено":(d.error||"Ошибка"),!!d.ok);}).catch(function(){setCloudStatus("cloud-retention-status","Ошибка",false);});}' +
  'function saveCloudTgLimit(){var v=document.getElementById("cloud-tg-limit").value;fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tgLimit:parseInt(v,10)})}).then(function(r){return r.json();}).then(function(d){setCloudStatus("cloud-tg-limit-status",d.ok?"Сохранено":(d.error||"Ошибка"),!!d.ok);}).catch(function(){setCloudStatus("cloud-tg-limit-status","Ошибка",false);});}' +
  'function loadCookiesStatus(){fetch("/api/settings/cookies").then(function(r){return r.json();}).then(function(d){var el=document.getElementById("cookies-status-info");if(!el)return;if(d.exists){el.textContent="✅ cookies.txt загружен: "+new Date(d.mtime).toLocaleString("ru-RU");el.style.color="#4ade80";}else{el.textContent="Файл не загружен — yt-dlp не может скачивать возрастные видео";el.style.color="#958ea0";}var inp=document.getElementById("cookies-file-inp");if(inp&&!inp._bound){inp._bound=true;inp.addEventListener("change",function(e){var f=e.target.files&&e.target.files[0];if(!f)return;var fd=new FormData();fd.append("cookies",f);setCloudStatus("cookies-upload-status","Загружаю...",true);fetch("/api/settings/cookies",{method:"POST",body:fd}).then(function(r){return r.json();}).then(function(d){setCloudStatus("cookies-upload-status",d.ok?"✅ Загружено! Теперь yt-dlp будет использовать cookies":(d.error||"Ошибка"),!!d.ok);if(d.ok)loadCookiesStatus();}).catch(function(){setCloudStatus("cookies-upload-status","Ошибка загрузки",false);});});}}).catch(function(){});}' +
  'function deleteCookies(){if(!confirm("Удалить cookies.txt с сервера?"))return;fetch("/api/settings/cookies",{method:"DELETE"}).then(function(r){return r.json();}).then(function(d){setCloudStatus("cookies-upload-status",d.ok?"Удалено":(d.error||"Ошибка"),!!d.ok);if(d.ok)loadCookiesStatus();}).catch(function(){setCloudStatus("cookies-upload-status","Ошибка",false);});}' +
  'function loadCloudAutoDl(){' +
  '  var autoDl=document.getElementById("cloud-auto-dl");' +
  '  var notifToggle=document.getElementById("cloud-notif-toggle");' +
  '  if(autoDl)autoDl.checked=localStorage.getItem("cloud-auto-dl")!=="false";' +
  '  if(notifToggle)notifToggle.checked=localStorage.getItem("cloud-notif")!=="false";' +
  '  if(autoDl)autoDl.addEventListener("change",function(){localStorage.setItem("cloud-auto-dl",autoDl.checked?"true":"false");});' +
  '  if(notifToggle)notifToggle.addEventListener("change",function(){localStorage.setItem("cloud-notif",notifToggle.checked?"true":"false");});' +
  '}' +
  'function updateCloudNotifStatus(){var el=document.getElementById("cloud-notif-status");if(!el)return;if(!("Notification" in window)){el.textContent="Браузерные уведомления недоступны";return;}el.textContent=Notification.permission==="granted"?"Уведомления включены":Notification.permission==="denied"?"Уведомления запрещены в браузере":"Уведомления еще не разрешены";}' +
  'function requestCloudNotif(){if(!("Notification" in window))return;Notification.requestPermission().then(updateCloudNotifStatus);}' +
  'function loadCloudToken(){fetch("/api/mytoken").then(function(r){return r.json();}).then(function(d){document.getElementById("cloud-token-display").textContent=d.token||"";setCloudStatus("cloud-token-status","Токен загружен",true);}).catch(function(){setCloudStatus("cloud-token-status","Ошибка токена",false);});}' +
  'function loadTelegramStatus(){fetch("/api/tg/status").then(function(r){return r.json();}).then(function(d){var linked=document.getElementById("tg-linked"),unlinked=document.getElementById("tg-unlinked"),info=document.getElementById("tg-linked-info");if(!linked)return;if(d.linked){linked.style.display="";unlinked.style.display="none";if(info)info.textContent=(d.firstName?"@"+d.firstName+" · ":"")+"Подключён "+new Date(d.connectedAt).toLocaleDateString("ru");}else{linked.style.display="none";unlinked.style.display="";}}).catch(function(){});}' +
  'function connectTelegram(){var st=document.getElementById("tg-status");if(st)st.textContent="Открываю бота...";fetch("/api/tg/connect-link").then(function(r){return r.json();}).then(function(d){if(d.url){window.open(d.url,"_blank");if(st)st.textContent="Бот открыт в Telegram. После подтверждения нажмите кнопку ниже.";var btn=document.createElement("button");btn.className="btn-ghost";btn.style.marginTop="8px";btn.textContent="Проверить подключение";btn.onclick=function(){loadTelegramStatus();if(st)st.textContent="";};var stParent=st&&st.parentNode;if(stParent)stParent.insertBefore(btn,st.nextSibling);}else{if(st)st.textContent=d.error||"Ошибка";}}).catch(function(){if(st)st.textContent="Ошибка";});}' +
  'function unlinkTelegram(){if(!confirm("Отключить Telegram?"))return;fetch("/api/tg/unlink",{method:"POST"}).then(function(r){return r.json();}).then(function(){loadTelegramStatus();}).catch(function(){});}' +
  'function saveAccentServer(hex){' +
  '  fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({accentHex:hex})}).catch(function(){});' +
  '}' +
  'var _accentSaveTimer=null;' +
  'function saveAccentServerDebounced(hex){clearTimeout(_accentSaveTimer);_accentSaveTimer=setTimeout(function(){saveAccentServer(hex);},600);}' +
  'function loadAccentFromServer(){' +
  '  fetch("/api/settings").then(function(r){return r.json();}).then(function(d){' +
  '    if(d.accentHex&&/^#[0-9a-fA-F]{6}$/.test(d.accentHex)){' +
  '      localStorage.setItem("cloud-accent-hex",d.accentHex);' +
  '      applyAccentColor();' +
  '      var inp=document.getElementById("accent-color-input");' +
  '      var lbl=document.getElementById("accent-hex-label");' +
  '      if(inp)inp.value=d.accentHex;if(lbl)lbl.textContent=d.accentHex;' +
  '      if(typeof updateColorSwatches==="function")updateColorSwatches(d.accentHex);' +
  '    } else {' +
  '      var presets={"violet":"#a078ff","emerald":"#10b981","ruby":"#f43f5e","glacier":"#06b6d4"};' +
  '      var cur=localStorage.getItem("cloud-accent-hex")||presets[localStorage.getItem("cloud-accent")]||null;' +
  '      if(cur&&/^#[0-9a-fA-F]{6}$/.test(cur))saveAccentServer(cur);' +
  '    }' +
  '  }).catch(function(){});' +
  '}' +
  'function initColorPicker(){' +
  '  var inp=document.getElementById("accent-color-input");' +
  '  var lbl=document.getElementById("accent-hex-label");' +
  '  if(!inp)return;' +
  '  var cur=localStorage.getItem("cloud-accent-hex")||"#a078ff";' +
  '  inp.value=cur;if(lbl)lbl.textContent=cur;' +
  '  updateColorSwatches(cur);' +
  '  inp.addEventListener("input",function(){' +
  '    var h=inp.value;localStorage.setItem("cloud-accent-hex",h);' +
  '    if(lbl)lbl.textContent=h;' +
  '    applyAccentColor();updateColorSwatches(h);saveAccentServerDebounced(h);' +
  '  });' +
  '}' +
  'function updateColorSwatches(hex){' +
  '  var btns=document.querySelectorAll(".color-swatch");' +
  '  btns.forEach(function(b){b.classList.toggle("active",b.dataset.hex&&b.dataset.hex.toLowerCase()===hex.toLowerCase());});' +
  '}' +
  'function copyCloudToken(){var t=(document.getElementById("cloud-token-display")||{}).textContent||"";if(!t||t==="Скрыт"){loadCloudToken();return;}navigator.clipboard&&navigator.clipboard.writeText(t).then(function(){setCloudStatus("cloud-token-status","Скопировано",true);});}' +
  'function resetCloudToken(){if(!confirm("Сбросить токен расширения? Старый перестанет работать."))return;fetch("/api/mytoken/reset",{method:"POST"}).then(function(r){return r.json();}).then(function(d){document.getElementById("cloud-token-display").textContent=d.token||"";setCloudStatus("cloud-token-status","Новый токен готов",true);}).catch(function(){setCloudStatus("cloud-token-status","Ошибка сброса",false);});}' +
  'function updateSidebarProfile(d){var label=d.label||d.username||"",user=d.username||"",role=d.isAdmin?"Admin":"User";var ls=document.getElementById("profile-label-sidebar"),av=document.getElementById("profile-avatar-sidebar"),ms=document.getElementById("profile-meta-sidebar"),sl=document.getElementById("settings-profile-login"),sr=document.getElementById("settings-profile-role"),sa=document.getElementById("settings-profile-avatar");if(ls)ls.textContent=label;if(av)av.textContent=(label||user||"?").trim().charAt(0).toUpperCase()||"?";if(sa)sa.textContent=(label||user||"?").trim().charAt(0).toUpperCase()||"?";if(ms)ms.textContent="@"+user+" \u00b7 "+role;if(sl)sl.textContent="@"+user;if(sr)sr.textContent=role;}\n' +
  'function loadCloudProfile(){fetch("/api/me").then(function(r){return r.json();}).then(function(d){updateSidebarProfile(d);var inp=document.getElementById("cloud-profile-label");if(inp)inp.value=d.label||d.username||"";}).catch(function(){setCloudStatus("cloud-profile-status","\u041e\u0448\u0438\u0431\u043a\u0430 \u043f\u0440\u043e\u0444\u0438\u043b\u044f",false);});}\n' +
  'function saveCloudProfile(){var inp=document.getElementById("cloud-profile-label"),label=(inp&&inp.value||"").trim();fetch("/api/me",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:label})}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-profile-status",d._ok?"\u0421\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u043e":(d.error||"\u041e\u0448\u0438\u0431\u043a\u0430"),d._ok);if(d._ok)updateSidebarProfile(d);}).catch(function(){setCloudStatus("cloud-profile-status","\u041e\u0448\u0438\u0431\u043a\u0430",false);});}\n' +
  'function changeCloudPassword(){var currentPassword=document.getElementById("cloud-pass-current").value,newPassword=document.getElementById("cloud-pass-new").value;fetch("/api/change-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({currentPassword:currentPassword,newPassword:newPassword})}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-pass-status",d._ok?"Пароль изменён":(d.error||"Ошибка"),d._ok);if(d._ok){document.getElementById("cloud-pass-current").value="";document.getElementById("cloud-pass-new").value="";}}).catch(function(){setCloudStatus("cloud-pass-status","Ошибка",false);});}' +
  'function loadCloudUsers(){fetch("/api/users").then(function(r){if(!r.ok)throw new Error("not admin");return r.json();}).then(function(users){var sec=document.getElementById("cloud-users-section"),box=document.getElementById("cloud-users-list");if(!sec||!box)return;sec.style.display="block";box.innerHTML=users.map(function(u){var quotaLabel=u.quotaGb!=null?(u.quotaGb+" ГБ"):"без лимита";return \'<div style="border:1px solid #353437;border-radius:14px;padding:10px 12px;margin-bottom:2px"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><div style="flex:1"><b>\'+H(u.username)+\'</b><div style="font-size:12px;color:#958ea0">\'+H(u.label||"")+\' \'+(u.isAdmin?"· admin":"")+\'</div></div><button class="btn-ghost" data-action="settings-delete-user" data-user="\'+H(u.username)+\'" style="color:#ffb4ab;border-color:#93000a;padding:4px 10px;font-size:12px">Удалить</button></div><div style="display:flex;align-items:center;gap:6px"><span style="font-size:12px;color:#958ea0;white-space:nowrap">Квота:</span><input id="quota-inp-\'+H(u.username)+\'" type="number" min="1" step="1" placeholder="∞ без лимита" value="\'+H(u.quotaGb!=null?String(u.quotaGb):"")+\'" style="width:100px;background:var(--surf-hi);color:var(--on-surf);border:1px solid var(--outline-var);border-radius:8px;padding:4px 8px;font-size:12px;outline:none"><span style="font-size:12px;color:#958ea0">ГБ</span><button class="btn-ghost" onclick="saveUserQuota(\\\'\'+H(u.username)+\'\\\')" style="padding:4px 10px;font-size:12px">Сохранить</button><span id="quota-status-\'+H(u.username)+\'" style="font-size:12px;color:var(--accent-light);min-width:60px">\'+quotaLabel+\'</span></div></div>\';}).join("");}).catch(function(){var sec=document.getElementById("cloud-users-section");if(sec)sec.style.display="none";});}' +
  'function saveUserQuota(username){var inp=document.getElementById("quota-inp-"+username);var st=document.getElementById("quota-status-"+username);if(!inp)return;var raw=inp.value.trim();var v=raw===""?null:parseFloat(raw);fetch("/api/users/"+encodeURIComponent(username),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({quotaGb:v})}).then(function(r){return r.json();}).then(function(d){if(st)st.textContent=d.ok?(v!=null?v+" ГБ":"без лимита"):(d.error||"Ошибка");}).catch(function(){if(st)st.textContent="Ошибка";});}' +
  'function addCloudUser(){var username=document.getElementById("cloud-new-username").value.trim(),password=document.getElementById("cloud-new-password").value,label=document.getElementById("cloud-new-label").value.trim();fetch("/api/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:username,password:password,label:label})}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-users-status",d._ok?"Аккаунт добавлен":(d.error||"Ошибка"),d._ok);if(d._ok){document.getElementById("cloud-new-username").value="";document.getElementById("cloud-new-password").value="";document.getElementById("cloud-new-label").value="";loadCloudUsers();}}).catch(function(){setCloudStatus("cloud-users-status","Ошибка",false);});}' +
  'function deleteCloudUser(username){if(!confirm("Удалить аккаунт "+username+"?"))return;fetch("/api/users/"+encodeURIComponent(username),{method:"DELETE"}).then(function(r){return r.json().then(function(d){d._ok=r.ok;return d;});}).then(function(d){setCloudStatus("cloud-users-status",d._ok?"Аккаунт удалён":(d.error||"Ошибка"),d._ok);loadCloudUsers();}).catch(function(){setCloudStatus("cloud-users-status","Ошибка",false);});}' +
  'function getFilteredEntries(entries){' +
  '  if(activeFilter==="all")return entries;' +
  '  var map={' +
  '    images:["jpg","jpeg","png","gif","webp","svg","bmp","ico"],' +
  '    videos:["mp4","webm","ogg","mov","mkv"],' +
  '    music:["mp3","wav","m4a","flac","aac","oga"],' +
  '    docs:["pdf","doc","docx","xls","xlsx","ppt","pptx","txt","rtf","odt","ods","odp","csv","md","html","css","js","json","py","sh","yml","yaml"],' +
  '    archives:["zip","rar","tar","gz","7z","bz2","xz"]' +
  '  };' +
  '  var exts=map[activeFilter]||[];' +
  '  return entries.filter(function(e){' +
  '    if(e.isDir)return true;' +
  '    var ext=(e.name.split(".").pop()||"").toLowerCase();' +
  '    return exts.includes(ext);' +
  '  });' +
  '}' +
  'function renderContent(entries,base){' +
  '  lastEntries=entries||[];lastBase=(base!==undefined)?base:currentPath;' +
  '  var filtered=getFilteredEntries(lastEntries);' +
  '  var isFiles=(currentPath!=="__dashboard__"&&currentPath!=="__recent__"&&currentPath!=="__settings__"&&currentPath!=="__activity__");' +
  '  var filterHtml="";' +
  '  if(isFiles){' +
  '    filterHtml=\'<div class="filter-bar" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center;">\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="all"?" active":"")+\'" data-action="filter-category" data-filter="all">Все</button>\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="images"?" active":"")+\'" data-action="filter-category" data-filter="images">Изображения</button>\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="videos"?" active":"")+\'" data-action="filter-category" data-filter="videos">Видео</button>\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="music"?" active":"")+\'" data-action="filter-category" data-filter="music">Музыка</button>\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="docs"?" active":"")+\'" data-action="filter-category" data-filter="docs">Документы</button>\' +' +
  '      \'<button class="filter-pill\'+(activeFilter==="archives"?" active":"")+\'" data-action="filter-category" data-filter="archives">Архивы</button>\' +' +
  '    \'</div>\';' +
  '  }' +
  '  document.getElementById("file-area").innerHTML=filterHtml+' +
  '    (currentView==="grid"?fileGridHtml(filtered,lastBase):fileListHtml(filtered,lastBase));' +
  '}' +
  'function fileListHtml(files,base){' +
  '  if(!files.length)return \'<div style="color:#494454;padding:40px;text-align:center">\\u041f\\u0430\\u043f\\u043a\\u0430 \\u043f\\u0443\\u0441\\u0442\\u0430</div>\';' +
  '  var h=\'<div style="background:#1b1b1e;border:1px solid #494454;border-radius:12px;overflow:hidden">\';' +
  '  h+=\'<div class="file-row" style="font-size:12px;font-weight:600;color:#494454;text-transform:uppercase;letter-spacing:.05em;cursor:default;background:#131316"><div style="width:20px"><input class="select-check" type="checkbox" data-action="select-all" \'+(allVisibleSelected(files,base)?"checked":"")+\'></div><div style="width:28px"></div><div style="flex:1">\\u041d\\u0430\\u0437\\u0432\\u0430\\u043d\\u0438\\u0435</div><div style="width:100px;text-align:right">\\u0420\\u0430\\u0437\\u043c\\u0435\\u0440</div><div style="width:130px;text-align:right">\\u0418\\u0437\\u043c\\u0435\\u043d\\u0435\\u043d</div><div style="width:54px"></div></div>\';' +
  '  for(var i=0;i<files.length;i++){var f=files[i],fp=base?(base+"/"+f.name):f.name,checked=!!selectedItems[fp],isNew=isNewFile(fp),badge=isNew?\'<span class="new-badge">New</span>\':"";h+=\'<div class="file-row \'+(checked?"selected ":"")+(isNew?"is-new":"")+\'" draggable="true" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'">\';h+=\'<input class="select-check" type="checkbox" data-action="select-item" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'"\'+(checked?" checked":"")+">";h+=fileThumb(f.name,fp,f.isDir);if(f.isDir)h+=\'<div data-meta="\'+(f.fileCount!=null?H(f.fileCount+" объектов"):"Папка")+\'" style="flex:1;font-weight:500;color:#d0bcff;cursor:pointer;pointer-events:none">\'+H(f.name)+badge+"</div>";else h+=\'<div data-meta="\'+H(fmtSize(f.size)+" · "+fmtDate(f.mtime))+\'" style="flex:1;color:#e4e1e6;pointer-events:none">\'+H(f.name)+badge+"</div>";h+=\'<div style="width:100px;text-align:right;font-size:13px;color:#958ea0;pointer-events:none">\'+(f.isDir?"—":fmtSize(f.size))+"</div>";h+=\'<div style="width:130px;text-align:right;font-size:12px;color:#494454;pointer-events:none">\'+fmtDate(f.mtime)+"</div>";h+=\'<button class="btn-ghost item-menu-btn" data-action="item-menu" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" title="Actions"><span class="material-symbols-outlined">more_vert</span></button></div>\';}' +
  '  return h+"</div>";' +
  '}' +
  'function fileGridHtml(files,base){' +
  '  if(!files.length)return \'<div style="color:#494454;padding:40px;text-align:center">\\u041f\\u0430\\u043f\\u043a\\u0430 \\u043f\\u0443\\u0441\\u0442\\u0430</div>\';' +
  '  var h=\'<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px">\';' +
  '  for(var i=0;i<files.length;i++){var f=files[i],fp=base?(base+"/"+f.name):f.name,checked=!!selectedItems[fp],isNew=isNewFile(fp),badge=isNew?\'<span class="new-badge">New</span>\':"";h+=\'<div class="file-grid-item \'+(checked?"selected ":"")+(isNew?"is-new":"")+\'" draggable="true" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" style="position:relative">\';h+=\'<input class="select-check" type="checkbox" data-action="select-item" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" style="position:absolute;top:10px;left:10px"\'+(checked?" checked":"")+">";h+=fileThumb(f.name,fp,f.isDir);h+=\'<div style="font-size:13px;font-weight:700;color:\'+(f.isDir?"#d0bcff":"#e4e1e6")+\';word-break:break-word;max-width:150px;text-align:left;pointer-events:none">\'+H(f.name)+badge+"</div>";h+=\'<div style="font-size:11px;color:#958ea0;pointer-events:none">\'+(f.isDir?((f.fileCount||0)+" объектов"):fmtSize(f.size))+"</div>";h+=\'<button class="btn-ghost item-menu-btn" data-action="item-menu" data-fp="\'+H(fp)+\'" data-name="\'+H(f.name)+\'" data-dir="\'+f.isDir+\'" title="Actions" style="position:absolute;right:10px;top:10px"><span class="material-symbols-outlined">more_vert</span></button></div>\';}' +
  '  return h+"</div>";' +
  '}' +
  'function loadRecent(){' +
  '  clearSelection(false);setSectionChrome("recent");currentPath="__recent__";savePath("__recent__");setNavActive("nav-recent");document.getElementById("file-area").innerHTML=\'<div style="color:#958ea0;padding:40px;text-align:center">\\u0417\\u0430\\u0433\\u0440\\u0443\\u0437\\u043a\\u0430...</div>\';renderBreadcrumb("");' +
  '  fetch("/api/fm/recent").then(function(r){return r.json();})' +
  '  .then(function(d){if(d.error){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\'+H(d.error)+"</div>";return;}var entries=(d.entries||[]).map(function(e){return{name:e.relPath,size:e.size,mtime:e.mtime,isDir:false};});lastEntries=entries;lastBase="";document.getElementById("file-area").innerHTML=\'<div style="font-size:13px;color:#958ea0;margin-bottom:12px">\\u041d\\u0435\\u0434\\u0430\\u0432\\u043d\\u0438\\u0435 \\u0444\\u0430\\u0439\\u043b\\u044b</div>\'+fileListHtml(entries,"");})' +
  '  .catch(function(){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\\u041e\\u0448\\u0438\\u0431\\u043a\\u0430</div>\';});' +
  '}' +
  'function getActivityActionStyle(action){' +
  '  var icon="info",color="#958ea0";' +
  '  if(action==="Создание папки"){icon="create_new_folder";color="#10b981";}' +
  '  else if(action==="Переименование"){icon="edit";color="#ffd166";}' +
  '  else if(action==="Удаление"){icon="delete";color="#ffb4ab";}' +
  '  else if(action==="Перемещение"){icon="drive_file_move";color="#a078ff";}' +
  '  else if(action==="Скачивание"){icon="download";color="#06b6d4";}' +
  '  else if(action==="Загрузка с ПК"){icon="upload_file";color="#9ddcff";}' +
  '  else if(action==="Архивация"){icon="folder_zip";color="#f59e0b";}' +
  '  else if(action==="Доступ"){icon="link";color="#38bdf8";}' +
  '  else if(action==="Загрузка по ссылке"){icon="cloud_download";color="#d2bbff";}' +
  '  return {icon:icon,color:color};' +
  '}' +
  'function loadActivityLog(){' +
  '  clearSelection(false);setSectionChrome("activity");currentPath="__activity__";savePath("__activity__");setNavActive("nav-activity");renderBreadcrumb("");' +
  '  document.getElementById("file-area").innerHTML=\'<div style="color:#958ea0;padding:40px;text-align:center">Загрузка истории активности...</div>\';' +
  '  fetch("/api/activity").then(function(r){return r.json();})' +
  '  .then(function(items){' +
  '    items=Array.isArray(items)?items:[];' +
  '    if(!items.length){' +
  '      document.getElementById("file-area").innerHTML=\'<div style="color:#494454;padding:40px;text-align:center">История активности пустая</div>\';' +
  '      return;' +
  '    }' +
  '    var h=\'<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px"><div style="text-align:left;"><div style="font-size:20px;font-weight:900;color:#e4e1e6">История активности</div><div style="font-size:13px;color:#958ea0;margin-top:2px">Лог последних действий с файлами и папками</div></div><button class="btn-ghost" data-action="nav-home"><span class="material-symbols-outlined">folder</span> Мои файлы</button></div>\';' +
  '    h+=\'<div style="display:flex;flex-direction:column;gap:10px">\';' +
  '    for(var i=0;i<items.length;i++){' +
  '      var x=items[i],style=getActivityActionStyle(x.action);' +
  '      h+=\'<div class="activity-row">\' +' +
  '        \'<div style="display:flex;align-items:center;gap:14px;min-width:0;flex:1">\' +' +
  '          \'<div style="width:42px;height:42px;border-radius:12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:\' + style.color + \'"><span class="material-symbols-outlined" style="font-size:22px">\' + style.icon + \'</span></div>\' +' +
  '          \'<div style="min-width:0;text-align:left;">\' +' +
  '            \'<div style="font-size:14px;font-weight:800;color:var(--on-surf)">\' + H(x.action) + \'</div>\' +' +
  '            \'<div style="font-size:12px;color:var(--outline);margin-top:4px;word-break:break-all">\' + H(x.details||"") + \'</div>\' +' +
  '          \'</div>\' +' +
  '        \'</div>\' +' +
  '        \'<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;text-align:right">\' +' +
  '          \'<span class="activity-user-badge">@\' + H(x.username) + \'</span>\' +' +
  '          \'<span style="font-size:11px;color:var(--outline);margin-top:2px">\' + fmtDateTime(x.timestamp) + \'</span>\' +' +
  '        \'</div>\' +' +
  '      \'</div>\';' +
  '    }' +
  '    h+=\'</div>\';' +
  '    document.getElementById("file-area").innerHTML=h;' +
  '  })' +
  '  .catch(function(){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">Ошибка загрузки активности</div>\';});' +
  '}' +
  'function doSearch(q){' +
  '  if(currentPath==="__dashboard__"||currentPath==="__recent__"||currentPath==="__activity__"||currentPath==="__settings__")return;' +
  '  if(!q.trim())return navigateTo(activePath());' +
  '  clearSelection(false);' +
  '  document.getElementById("file-area").innerHTML=\'<div style="color:#958ea0;padding:40px;text-align:center">Поиск...</div>\';' +
  '  fetch("/api/fm/search?q="+encodeURIComponent(q)).then(function(r){return r.json();})' +
  '  .then(function(d){' +
  '    if(d.error){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">\'+H(d.error)+"</div>";return;}' +
  '    var entries=(d.entries||[]).map(function(e){return{name:e.relPath,size:e.size,mtime:e.mtime,isDir:e.isDir};});lastEntries=entries;lastBase="";' +
  '    if(!entries.length){document.getElementById("file-area").innerHTML=\'<div style="color:#494454;padding:40px;text-align:center">Ничего не найдено</div>\';return;}' +
  '    document.getElementById("file-area").innerHTML=fileListHtml(entries,"");' +
  '  })' +
  '  .catch(function(){document.getElementById("file-area").innerHTML=\'<div style="color:#ffb4ab;padding:24px">Ошибка</div>\';});' +
  '}' +
  /* ── MKDIR ── */
  'function openMkdirModal(){document.getElementById("modal-mkdir").style.display="flex";document.getElementById("mkdir-name").value="";document.getElementById("mkdir-name").focus();}' +
  'function closeMkdirModal(){document.getElementById("modal-mkdir").style.display="none";}' +
  'function createFolder(){' +
  '  var name=document.getElementById("mkdir-name").value.trim();' +
  '  if(!name)return;' +
  '  var p=activePath();' +
  '  fetch("/api/fm/mkdir",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p,name:name})})' +
  '  .then(function(r){return r.json();}).then(function(d){closeMkdirModal();if(d.ok)navigateTo(p);else alert(d.error||"Ошибка");});' +
  '}' +
  /* ── RENAME ── */
  'function openRenameModal(fp,name,isDir){' +
  '  renameFp=fp;renameIsDir=isDir;' +
  '  var parts=splitExt(name,isDir);renameExt=parts.ext;' +
  '  document.getElementById("rename-inp").value=parts.base;' +
  '  var extEl=document.getElementById("rename-ext");' +
  '  extEl.textContent=renameExt;' +
  '  extEl.style.display=renameExt?"block":"none";' +
  '  document.getElementById("modal-rename").style.display="flex";' +
  '  document.getElementById("rename-inp").focus();' +
  '  document.getElementById("rename-inp").select();' +
  '}' +
  'function closeRenameModal(){document.getElementById("modal-rename").style.display="none";}' +
  'function doRename(){' +
  '  var newName=document.getElementById("rename-inp").value.trim();' +
  '  if(!newName)return;' +
  '  if(renameExt&&newName.toLowerCase().endsWith(renameExt.toLowerCase()))newName=newName.slice(0,-renameExt.length);' +
  '  newName=newName+renameExt;' +
  '  fetch("/api/fm/rename",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({oldPath:renameFp,newName:newName})})' +
  '  .then(function(r){return r.json();}).then(function(d){closeRenameModal();if(d.ok)navigateTo(activePath());else alert(d.error||"Ошибка");});' +
  '}' +
  /* ── DELETE ── */
  'function selectUrlMode(mode){' +
  '  document.getElementById("url-mode-inp").value=mode;' +
  '  var modes=["file","video","audio","best"];' +
  '  for(var i=0;i<modes.length;i++){' +
  '    var card=document.getElementById("url-card-"+modes[i]);' +
  '    if(!card)continue;' +
  '    if(modes[i]===mode){card.classList.add("selected");}else{card.classList.remove("selected");}' +
  '  }' +
  '  var opts=document.getElementById("url-media-opts");' +
  '  if(opts)opts.style.display=(mode==="video"||mode==="best")?"block":"none";' +
  '  var contInp=document.getElementById("url-container-inp");' +
  '  if(contInp&&mode==="best"&&!document.getElementById("url-quality-inp").value){contInp.value="mkv";}' +
  '  else if(contInp&&mode==="video"){contInp.value="mp4";}' +
  '}' +
  'function openUrlModal(prefill){document.getElementById("modal-url").style.display="flex";document.getElementById("url-dl-inp").value=prefill||"";document.getElementById("url-dl-inp-batch").value="";document.getElementById("url-name-inp").value="";var qi=document.getElementById("url-quality-inp");if(qi)qi.value="";selectUrlMode("file");document.getElementById("url-status").textContent="";if(window.urlBatchMode){toggleUrlBatchMode();}setTimeout(function(){document.getElementById("url-dl-inp").focus();},20);}' +
  'var _urlProgTimer=null;' +
  'function closeUrlModal(){' +
  '  clearTimeout(_urlProgTimer);_urlProgTimer=null;' +
  '  document.getElementById("modal-url").style.display="none";' +
  '  document.getElementById("url-dl-inp").value="";' +
  '  document.getElementById("url-dl-inp-batch").value="";' +
  '  document.getElementById("url-name-inp").value="";' +
  '  document.getElementById("url-status").textContent="";' +
  '  var prog=document.getElementById("url-modal-progress");if(prog)prog.style.display="none";' +
  '  var bar=document.getElementById("url-prog-bar");if(bar){bar.className="progress-fill indeterminate";bar.style.width="0%";}' +
  '  var submitBtn=document.getElementById("url-submit-btn");if(submitBtn){submitBtn.disabled=false;submitBtn.style.opacity="";}' +
  '  var faqHint=document.getElementById("url-faq-hint");if(faqHint)faqHint.style.display="";' +
  '  if(window.urlBatchMode){toggleUrlBatchMode();}' +
  '}' +
  'function stripInputMediaExt(name){return String(name||"").replace(/\\.(mp4|webm|mkv|mov|m4v|mp3|m4a|opus|ogg|wav|flac|aac)$/i,"");}' +
  'function toggleUrlBatchMode(){' +
  '  urlBatchMode=!urlBatchMode;' +
  '  var single=document.getElementById("url-dl-inp");' +
  '  var batch=document.getElementById("url-dl-inp-batch");' +
  '  var btn=document.getElementById("url-toggle-batch");' +
  '  var nameInp=document.getElementById("url-name-inp");' +
  '  var nameHint=document.getElementById("url-name-hint");' +
  '  var wrap=single.closest(".url-dl-inp-wrap");' +
  '  var icon=wrap?wrap.querySelector(".url-inp-icon"):null;' +
  '  if(urlBatchMode){' +
  '    single.style.display="none";' +
  '    batch.style.display="block";' +
  '    btn.textContent="Одна ссылка";' +
  '    btn.style.color="var(--accent-color)";' +
  '    if(nameInp)nameInp.style.display="none";' +
  '    if(nameHint)nameHint.style.display="none";' +
  '    if(icon)icon.style.display="none";' +
  '    if(wrap){' +
  '      wrap.style.background="transparent";' +
  '      wrap.style.border="none";' +
  '      wrap.style.boxShadow="none";' +
  '      wrap.style.padding="0";' +
  '    }' +
  '    setTimeout(function(){batch.focus();},50);' +
  '  }else{' +
  '    single.style.display="block";' +
  '    batch.style.display="none";' +
  '    btn.textContent="Несколько ссылок";' +
  '    btn.style.color="var(--accent-light)";' +
  '    if(nameInp)nameInp.style.display="block";' +
  '    if(nameHint)nameHint.style.display="block";' +
  '    if(icon)icon.style.display="block";' +
  '    if(wrap){' +
  '      wrap.removeAttribute("style");' +
  '    }' +
  '    setTimeout(function(){single.focus();},50);' +
  '  }' +
  '}' +
  'function addUrlDownload(){' +
  '  var mode=document.getElementById("url-mode-inp").value;' +
  '  var st=document.getElementById("url-status");' +
  '  var folder=activePath();' +
  '  var media=mode!=="file";' +
  '  if(window.urlBatchMode){' +
  '    var text=document.getElementById("url-dl-inp-batch").value.trim();' +
  '    if(!text){st.textContent="Вставьте ссылки";return;}' +
  '    var urls=text.split("\\n").map(function(x){return x.trim();}).filter(Boolean);' +
  '    if(!urls.length){st.textContent="Вставьте ссылки";return;}' +
  '    st.textContent="Запускаю " + urls.length + " загрузок...";' +
  '    var quality=document.getElementById("url-quality-inp")?document.getElementById("url-quality-inp").value:"";' +
  '    var promises=urls.map(function(url){' +
  '      return fetch(media?"/api/fm/media":"/api/fm/add-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url,filename:"",path:folder,mode:mode,quality:quality})})' +
  '        .then(function(r){return r.json();})' +
  '        .then(function(d){' +
  '          if(d.ok){' +
  '            var gid=d.gid||(d.job&&d.job.id);' +
  '            if(gid){knownMediaStatuses[gid]="active";markPendingUrlJob(gid,folder);}' +
  '          }' +
  '        });' +
  '    });' +
  '    Promise.all(promises).then(function(){' +
  '      st.textContent="Все загрузки добавлены!";' +
  '      setTimeout(function(){closeUrlModal();loadTransfers();},800);' +
  '    }).catch(function(){' +
  '      st.textContent="Ошибка при пакетной отправке";' +
  '    });' +
  '  }else{' +
  '    var url=document.getElementById("url-dl-inp").value.trim();' +
  '    var name=document.getElementById("url-name-inp").value.trim();' +
  '    var quality=(document.getElementById("url-quality-inp")||{}).value||"";' +
  '    if(!url){st.textContent="Вставь URL";return;}' +
  '    if(media)name=stripInputMediaExt(name);' +
  '    st.textContent=media?"Запускаю медиа-загрузку...":"Добавляю загрузку...";' +
  '    fetch(media?"/api/fm/media":"/api/fm/add-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url,filename:name,path:folder,mode:mode,quality:quality})})' +
  '      .then(function(r){return r.json();})' +
  '      .then(function(d){' +
  '        if(d.ok){' +
  '          var gid=d.gid||(d.job&&d.job.id);' +
  '          if(gid){knownMediaStatuses[gid]="active";markPendingUrlJob(gid,folder);}' +
  '          if(media&&gid){' +
  '            st.textContent="";' +
  '            var submitBtn=document.getElementById("url-submit-btn");' +
  '            if(submitBtn){submitBtn.disabled=true;submitBtn.style.opacity="0.45";}' +
  '            var faqHint=document.getElementById("url-faq-hint");if(faqHint)faqHint.style.display="none";' +
  '            document.getElementById("url-modal-progress").style.display="block";' +
  '            startUrlModalProgress(gid,folder);' +
  '          }else{' +
  '            st.textContent=media?"Медиа-загрузка запущена":"Загрузка добавлена";' +
  '            closeUrlModal();loadTransfers();' +
  '          }' +
  '        }else st.textContent=d.error||"Ошибка";' +
  '      }).catch(function(){st.textContent="Ошибка";});' +
  '  }' +
  '}' +
  'function startUrlModalProgress(jobId,folder){' +
  '  clearTimeout(_urlProgTimer);' +
  '  function tick(){' +
  '    fetch("/api/fm/media-jobs").then(function(r){return r.json();}).then(function(jobs){' +
  '      var job=jobs.find(function(j){return j.id===jobId;});' +
  '      var bar=document.getElementById("url-prog-bar");' +
  '      var phase=document.getElementById("url-prog-phase");' +
  '      var right=document.getElementById("url-prog-right");' +
  '      if(!bar||!phase)return;' +
  '      if(!job){' +
  '        phase.textContent="Загружено!";' +
  '        bar.className="progress-fill done";bar.style.width="100%";' +
  '        setTimeout(function(){closeUrlModal();loadTransfers();},1000);' +
  '        return;' +
  '      }' +
  '      var mp=job.progress||0;' +
  '      var isPrep=(job.status==="starting"||(job.status==="active"&&mp===0));' +
  '      var isProc=(job.status==="processing");' +
  '      if(isProc){bar.className="progress-fill processing";bar.style.width="100%";}' +
  '      else if(isPrep){bar.className="progress-fill indeterminate";}' +
  '      else{bar.className="progress-fill"+(mp>=100?" done":"");bar.style.width=mp+"%";}' +
  '      var label=job.streamLabel||"";' +
  '      if(job.status==="complete"){phase.textContent="Загружено!";right.textContent="";}' +
  '      else if(job.status==="error"){phase.textContent="Ошибка";right.textContent="";}' +
  '      else if(isProc){phase.textContent="Слияние файлов...";right.textContent="";}' +
  '      else if(isPrep){phase.textContent=label||"Подготовка...";right.textContent="";}' +
  '      else{phase.textContent=label||(mp+"%");right.textContent=(job.speed&&job.eta)?job.speed+" · "+job.eta:(job.speed||"");}' +
  '      if(job.status==="complete"){' +
  '        bar.className="progress-fill done";bar.style.width="100%";' +
  '        setTimeout(function(){closeUrlModal();loadTransfers();},1000);return;' +
  '      }' +
  '      if(job.status==="error"){' +
  '        var st=document.getElementById("url-status");' +
  '        if(st)st.textContent=job.error||"Ошибка загрузки";' +
  '        setTimeout(function(){closeUrlModal();loadTransfers();},2500);return;' +
  '      }' +
  '      if(job.status==="cancelled"){setTimeout(function(){closeUrlModal();},800);return;}' +
  '      _urlProgTimer=setTimeout(tick,1500);' +
  '    }).catch(function(){_urlProgTimer=setTimeout(tick,2000);});' +
  '  }' +
  '  tick();' +
  '}' +
  'function updatePreviewNavButtons(){' +
  '  var prevBtn=document.getElementById("preview-btn-prev");' +
  '  var nextBtn=document.getElementById("preview-btn-next");' +
  '  var isMedia=["image","video","audio"].includes(previewKind);' +
  '  if(prevBtn)prevBtn.style.display=isMedia?"inline-flex":"none";' +
  '  if(nextBtn)nextBtn.style.display=isMedia?"inline-flex":"none";' +
  '}' +
  'function closePreview(){if(window.previewPlyrInstance){window.previewPlyrInstance.destroy();window.previewPlyrInstance=null;}document.getElementById("preview-panel").classList.remove("open");document.getElementById("preview-body").classList.remove("media-preview");document.getElementById("preview-body").innerHTML="";document.getElementById("preview-info").innerHTML="";previewKind="";previewSrc="";updatePreviewNavButtons();}' +
  'function metaRow(label,value){return \'<div class="meta-row"><div class="meta-lbl">\'+H(label)+\'</div><div class="meta-val">\'+(value||"—")+\'</div></div>\';}' +
  'function renderPreviewInfo(fp,name){' +
  '  var info=document.getElementById("preview-info");' +
  '  info.innerHTML=\'<div style="padding:20px;text-align:center;font-size:12px;color:var(--on-surf-var)">Загрузка информации...</div>\';' +
  '  fetch("/api/fm/meta?path="+encodeURIComponent(fp)).then(function(r){return r.json();}).then(function(m){' +
  '    if(m.error){info.innerHTML=\'<div style="padding:16px;color:#ffb4ab;font-size:13px">\'+H(m.error)+\'</div>\';return;}' +
  '    var links=m.publicLinks||[];var isDir=!!m.isDir;' +
  '    var ext=m.ext?m.ext.slice(1).toUpperCase():(isDir?"Папка":"Файл");' +
  '    var h="";' +
  /* name */
  '    h+=\'<div style="padding:18px 16px 0">\';' +
  '    h+=\'<div class="preview-meta-label">Название</div>\';' +
  '    h+=\'<div style="font-size:15px;font-weight:700;color:var(--on-surf);word-break:break-all;line-height:1.45;font-family:var(--font-display)">\'+H(m.name||name)+\'</div>\';' +
  '    h+=\'</div>\';' +
  /* size + type chips */
  '    if(!isDir){' +
  '      h+=\'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:14px 16px 0">\';' +
  '      h+=\'<div class="preview-meta-chip"><div class="preview-meta-label">Размер</div><div style="font-size:14px;font-weight:700;color:var(--on-surf)">\'+fmtSize(m.size)+\'</div></div>\';' +
  '      h+=\'<div class="preview-meta-chip"><div class="preview-meta-label">Тип</div><div style="font-size:14px;font-weight:700;color:var(--on-surf)">\'+H(ext)+\'</div></div>\';' +
  '      h+=\'</div>\';' +
  '    }' +
  /* date */
  '    h+=\'<div style="padding:14px 16px 0">\';' +
  '    h+=\'<div class="preview-meta-label">Загружен</div>\';' +
  '    h+=\'<div style="font-size:13px;color:var(--on-surf)">\'+fmtDateTime(m.created)+\'</div>\';' +
  '    h+=\'</div>\';' +
  /* path chip */
  '    h+=\'<div style="padding:14px 16px 0">\';' +
  '    h+=\'<div class="preview-meta-label">Путь</div>\';' +
  '    h+=\'<div style="background:var(--surf-hi);border-radius:10px;padding:8px 12px;font-size:12px;color:var(--accent-light);word-break:break-all;line-height:1.5">\'+H(m.path||fp)+\'</div>\';' +
  '    h+=\'</div>\';' +
  /* public links */
  '    if(links.length){' +
  '      var lh=links.map(function(x){var full=window.location.origin+x.url;return \'<div style="display:flex;align-items:center;gap:6px;margin-top:5px"><a href="\'+H(x.url)+\'" target="_blank" style="color:var(--accent-light);font-size:12px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">\'+H(full)+\'</a><button class="btn-ghost" data-action="qr-link" data-url="\'+H(full)+\'" style="padding:2px 7px;min-height:24px;font-size:11px">QR</button></div>\';}).join("");' +
  '      h+=\'<div style="padding:14px 16px 0"><div class="preview-meta-label">Публичная ссылка</div>\'+lh+\'</div>\';' +
  '    }' +
  /* push buttons to bottom */
  '    h+=\'<div style="flex:1;min-height:16px"></div>\';' +
  /* action buttons */
  '    h+=\'<div style="padding:16px;display:flex;flex-direction:column;gap:8px">\';' +
  '    h+=\'<button class="btn-primary preview-action-btn" data-action="download-preview"><span class="material-symbols-outlined" style="font-size:18px">download</span>Скачать</button>\';' +
  '    h+=\'<button class="btn-ghost preview-action-btn" data-action="share-preview"><span class="material-symbols-outlined" style="font-size:18px">share</span>Поделиться</button>\';' +
  '    if(!isDir)h+=\'<button class="btn-ghost preview-action-btn" data-action="delete-preview" style="color:#ffb4ab;border-color:rgba(147,0,10,.45)"><span class="material-symbols-outlined" style="font-size:18px">delete</span>Удалить</button>\';' +
  '    h+=\'</div>\';' +
  '    info.innerHTML=h;' +
  '  }).catch(function(){info.innerHTML=\'<div style="padding:16px;color:#ffb4ab;font-size:13px">Ошибка загрузки метаданных</div>\';});' +
  '}' +
  'function fitPlyrToVideo(media,player){if(!media||!player)return;var container=player.elements&&player.elements.container;if(!container)return;function fit(){var vw=media.videoWidth||0,vh=media.videoHeight||0;if(!vw||!vh)return;var host=media.closest(".preview-media-wrap")||media.closest(".mv-stage")||container.parentElement;if(!host)return;var maxW=host.clientWidth||window.innerWidth,maxH=host.clientHeight||Math.round(window.innerHeight*.72);if(host.classList&&host.classList.contains("mv-stage"))maxH=Math.max(220,maxH-4);else maxH=Math.min(maxH||Math.round(window.innerHeight*.72),Math.round(window.innerHeight*.72));var ratio=vw/vh,w=maxW,h=w/ratio;if(h>maxH){h=maxH;w=h*ratio;}container.style.width=Math.max(180,Math.floor(w))+"px";container.style.maxWidth="100%";container.style.aspectRatio=vw+" / "+vh;var wrap=container.querySelector(".plyr__video-wrapper");if(wrap){wrap.style.aspectRatio=vw+" / "+vh;wrap.style.height=Math.floor(h)+"px";}media.style.objectFit="contain";}media.addEventListener("loadedmetadata",fit,{once:false});window.addEventListener("resize",fit);setTimeout(fit,80);setTimeout(fit,400);}\n' +
  'function getPlayableMediaFiles(kind){' +
  '  var exts=[];' +
  '  if(kind==="image")exts=["png","jpg","jpeg","gif","webp","svg","bmp"];' +
  '  else if(kind==="video")exts=["mp4","webm","ogg","mov","mkv"];' +
  '  else if(kind==="audio")exts=["mp3","wav","m4a","flac","aac","oga"];' +
  '  else return [];' +
  '  return lastEntries.filter(function(e){' +
  '    if(e.isDir)return false;' +
  '    var ext=(e.name.split(".").pop()||"").toLowerCase();' +
  '    return exts.includes(ext);' +
  '  });' +
  '}' +
  'function playSibling(direction,autoPlay){' +
  '  if(!previewFp||!previewKind)return;' +
  '  var list=getPlayableMediaFiles(previewKind);' +
  '  if(!list.length)return;' +
  '  var idx=-1;' +
  '  for(var i=0;i<list.length;i++){' +
  '    var entryPath=lastBase?(lastBase+"/"+list[i].name):list[i].name;' +
  '    if(entryPath===previewFp){idx=i;break;}' +
  '  }' +
  '  if(idx===-1)return;' +
  '  var nextIdx=idx;' +
  '  if(direction==="next"){nextIdx=(idx+1)%list.length;}' +
  '  else{nextIdx=(idx-1+list.length)%list.length;}' +
  '  var nextEntry=list[nextIdx];' +
  '  var nextFp=lastBase?(lastBase+"/"+nextEntry.name):nextEntry.name;' +
  '  var mv=document.getElementById("media-viewer");' +
  '  var isMvOpen=mv&&mv.classList.contains("open");' +
  '  if(isMvOpen){' +
  '    if(window.plyrInstance){try{window.plyrInstance.destroy();}catch(e){}window.plyrInstance=null;}' +
  '    document.getElementById("mv-stage").innerHTML="";' +
  '    document.getElementById("mv-bottom").innerHTML="";' +
  '    openPreview(nextFp,nextEntry.name,false,0,autoPlay);' +
  '    setTimeout(function(){openMediaViewer();},100);' +
  '  }else{' +
  '    openPreview(nextFp,nextEntry.name,false,0,autoPlay);' +
  '  }' +
  '}' +
  'function initPlyr(selector,isVideo,key,startTime,autoPlay){if(typeof Plyr==="undefined")return null;var isMobile=window.innerWidth<=768;var opts={controls:isVideo?(isMobile?["play-large","play","progress","current-time","settings","fullscreen"]:["play-large","play","progress","current-time","duration","mute","volume","captions","settings","pip","airplay","fullscreen"]):(isMobile?["play","progress","current-time"]:["play","progress","current-time","duration","mute","volume"]),settings:["captions","quality","speed","loop"],keyboard:{focused:true,global:false},tooltips:{controls:!isMobile,seek:!isMobile}};var p=new Plyr(selector,opts);if(isVideo)fitPlyrToVideo(document.querySelector(selector),p);p.on("ready",function(e){var savedTime=localStorage.getItem(key);var useTime=(startTime!==undefined&&startTime!==null)?startTime:(savedTime?parseFloat(savedTime):0);e.detail.plyr.currentTime=useTime;if(autoPlay){setTimeout(function(){try{e.detail.plyr.play();}catch(err){}},50);}});p.on("timeupdate",function(e){localStorage.setItem(key,e.detail.plyr.currentTime);});p.on("ended",function(e){playSibling("next",true);});return p;}\n' +
  'function playGlobalAudio(fp,name,forcePlay){' +
  '  var audio=document.getElementById("global-audio");' +
  '  if(!audio)return;' +
  '  activeAudioFp=fp;activeAudioName=name;' +
  '  if(!window.sidebarPlayerInitialized){initSidebarPlayer();}' +
  '  var isMobile=window.innerWidth<=768;' +
  '  if(isMobile){' +
  '    var mPlayer=document.getElementById("mobile-header-player");' +
  '    if(mPlayer)mPlayer.style.display="flex";' +
  '    var avatar=document.querySelector(".mobile-avatar");' +
  '    var brand=document.querySelector(".mobile-brand");' +
  '    if(avatar)avatar.style.display="none";' +
  '    if(brand)brand.style.display="none";' +
  '  }else{' +
  '    var playerCard=document.getElementById("sidebar-player");' +
  '    if(playerCard)playerCard.style.display="flex";' +
  '  }' +
  '  updatePlayerTrackInfo();' +
  '  var src="/api/fm/preview?path="+encodeURIComponent(fp);' +
  '  if(audio.src!==window.location.origin+src&&audio.getAttribute("src")!==src){audio.src=src;}' +
  '  buildAudioQueue();' +
  '  if(forcePlay){' +
  '    audio.play().catch(function(e){console.error("Audio play error:",e);});' +
  '    updatePlayButtonState(true);' +
  '  }else{' +
  '    audio.pause();updatePlayButtonState(false);' +
  '  }' +
  '}' +
  'function updatePlayerTrackInfo(){' +
  '  var name=activeAudioName;' +
  '  if(!name)return;' +
  '  var titleEl=document.getElementById("player-title");' +
  '  var artistEl=document.getElementById("player-artist");' +
  '  var mTitleEl=document.getElementById("m-player-title");' +
  '  var mArtistEl=document.getElementById("m-player-artist");' +
  '  var baseName=name.replace(/\\.[^/.]+$/,"");' +
  '  var parts=baseName.split(" - ");' +
  '  var title=baseName;' +
  '  var artist="CloudSpace";' +
  '  var swap=localStorage.getItem("player-swap-fields")==="true";' +
  '  if(parts.length>1){' +
  '    var p0=parts[0].trim();' +
  '    var p1=parts.slice(1).join(" - ").trim();' +
  '    if(swap){' +
  '      title=p0;artist=p1;' +
  '    }else{' +
  '      title=p1;artist=p0;' +
  '    }' +
  '  }' +
  '  if(titleEl)titleEl.textContent=title;' +
  '  if(artistEl)artistEl.textContent=artist;' +
  '  if(mTitleEl)mTitleEl.textContent=title;' +
  '  if(mArtistEl)mArtistEl.textContent=artist;' +
  '}' +
  'function buildAudioQueue(){' +
  '  currentAudioQueue=[];' +
  '  var exts=["mp3","wav","m4a","flac","aac","oga"];' +
  '  for(var i=0;i<lastEntries.length;i++){' +
  '    var entry=lastEntries[i];' +
  '    if(entry.isDir)continue;' +
  '    var ext=(entry.name.split(".").pop()||"").toLowerCase();' +
  '    if(exts.includes(ext)){' +
  '      var entryPath=lastBase?(lastBase+"/"+entry.name):entry.name;' +
  '      currentAudioQueue.push({fp:entryPath,name:entry.name});' +
  '    }' +
  '  }' +
  '}' +
  'function prevGlobalTrack(){' +
  '  if(!currentAudioQueue.length)return;' +
  '  var idx=-1;' +
  '  for(var i=0;i<currentAudioQueue.length;i++){if(currentAudioQueue[i].fp===activeAudioFp){idx=i;break;}}' +
  '  if(idx===-1)return;' +
  '  var prevIdx=idx-1;' +
  '  if(prevIdx<0){' +
  '    prevIdx=currentAudioQueue.length-1;' +
  '  }' +
  '  var track=currentAudioQueue[prevIdx];' +
  '  playGlobalAudio(track.fp,track.name,true);' +
  '}' +
  'function nextGlobalTrack(isAuto){' +
  '  if(!currentAudioQueue.length)return;' +
  '  var idx=-1;' +
  '  for(var i=0;i<currentAudioQueue.length;i++){if(currentAudioQueue[i].fp===activeAudioFp){idx=i;break;}}' +
  '  if(idx===-1)return;' +
  '  var repeat=localStorage.getItem("player-repeat-mode")||"off";' +
  '  if(isAuto&&repeat==="one"){' +
  '    playGlobalAudio(activeAudioFp,activeAudioName,true);' +
  '    return;' +
  '  }' +
  '  var nextIdx=idx+1;' +
  '  if(nextIdx>=currentAudioQueue.length){' +
  '    if(isAuto&&repeat==="off"){' +
  '      updatePlayButtonState(false);' +
  '      return;' +
  '    }' +
  '    nextIdx=0;' +
  '  }' +
  '  var track=currentAudioQueue[nextIdx];' +
  '  playGlobalAudio(track.fp,track.name,true);' +
  '}' +
  'function toggleGlobalPlay(){' +
  '  var audio=document.getElementById("global-audio");' +
  '  if(!audio)return;' +
  '  if(audio.paused){' +
  '    audio.play().then(function(){updatePlayButtonState(true);}).catch(function(e){console.error(e);});' +
  '  }else{' +
  '    audio.pause();updatePlayButtonState(false);' +
  '  }' +
  '}' +
  'function updatePlayButtonState(isPlaying){' +
  '  var icon=document.getElementById("player-play-icon");' +
  '  if(icon)icon.textContent=isPlaying?"pause":"play_arrow";' +
  '  var btn=document.getElementById("player-btn-play");' +
  '  if(btn)btn.title=isPlaying?"Пауза":"Воспроизведение";' +
  '  var mIcon=document.getElementById("m-player-play-icon");' +
  '  if(mIcon)mIcon.textContent=isPlaying?"pause":"play_arrow";' +
  '  var mBtn=document.getElementById("m-player-btn-play");' +
  '  if(mBtn)mBtn.title=isPlaying?"Пауза":"Воспроизведение";' +
  '}' +
  'function toggleRepeatMode(){' +
  '  var repeat=localStorage.getItem("player-repeat-mode")||"off";' +
  '  var nextRepeat="off";' +
  '  if(repeat==="off")nextRepeat="all";' +
  '  else if(repeat==="all")nextRepeat="one";' +
  '  localStorage.setItem("player-repeat-mode",nextRepeat);' +
  '  updateRepeatButtonUI();' +
  '}' +
  'function updateRepeatButtonUI(){' +
  '  var btn=document.getElementById("player-btn-repeat");' +
  '  if(!btn)return;' +
  '  var icon=btn.querySelector(".material-symbols-outlined");' +
  '  var repeat=localStorage.getItem("player-repeat-mode")||"off";' +
  '  if(repeat==="off"){' +
  '    btn.style.color="var(--outline)";' +
  '    btn.title="Повтор: выкл";' +
  '    if(icon)icon.textContent="repeat";' +
  '  }else if(repeat==="all"){' +
  '    btn.style.color="var(--accent-color)";' +
  '    btn.title="Повтор: все";' +
  '    if(icon)icon.textContent="repeat";' +
  '  }else if(repeat==="one"){' +
  '    btn.style.color="var(--accent-color)";' +
  '    btn.title="Повтор: один";' +
  '    if(icon)icon.textContent="repeat_one";' +
  '  }' +
  '}' +
  'function closeSidebarPlayer(){' +
  '  var audio=document.getElementById("global-audio");' +
  '  if(audio)audio.pause();' +
  '  var card=document.getElementById("sidebar-player");' +
  '  if(card)card.style.display="none";' +
  '  var mPlayer=document.getElementById("mobile-header-player");' +
  '  if(mPlayer)mPlayer.style.display="none";' +
  '  var avatar=document.querySelector(".mobile-avatar");' +
  '  var brand=document.querySelector(".mobile-brand");' +
  '  if(avatar)avatar.style.display="flex";' +
  '  if(brand)brand.style.display="block";' +
  '  activeAudioFp="";activeAudioName="";' +
  '}' +
  'function renderPlaylistModalTracks(){' +
  '  var container=document.getElementById("playlist-modal-tracks");' +
  '  if(!container)return;' +
  '  if(!currentAudioQueue.length){' +
  '    container.innerHTML=\'<div style="color:var(--outline);text-align:center;padding:24px">Очередь пуста</div>\';' +
  '    return;' +
  '  }' +
  '  var html="";' +
  '  for(var i=0;i<currentAudioQueue.length;i++){' +
  '    var track=currentAudioQueue[i];' +
  '    var isActive=track.fp===activeAudioFp;' +
  '    var bg=isActive?"color-mix(in srgb,var(--accent-color) 12%,var(--surf-hi))":"transparent";' +
  '    var border=isActive?"1px solid color-mix(in srgb,var(--accent-color) 30%,transparent)":"1px solid transparent";' +
  '    var textColor=isActive?"var(--accent-light)":"var(--on-surf)";' +
  '    var icon=isActive?"volume_up":"music_note";' +
  '    var titleParts=track.name.replace(/\\.[^/.]+$/,"").split(" - ");' +
  '    var title=track.name;' +
  '    var artist="CloudSpace";' +
  '    if(titleParts.length>1){' +
  '      var swap=localStorage.getItem("player-swap-fields")==="true";' +
  '      if(swap){' +
  '        title=titleParts[0].trim();artist=titleParts.slice(1).join(" - ").trim();' +
  '      }else{' +
  '        title=titleParts[1].trim();artist=titleParts[0].trim();' +
  '      }' +
  '    }' +
  '    html+=\'<div class="playlist-track-row" style="display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:12px;background:\'+bg+\';border:\'+border+\';cursor:pointer;transition:background 0.2s" data-fp="\'+H(track.fp)+\'" data-name="\'+H(track.name)+\'">\';' +
  '    html+=\'  <span class="material-symbols-outlined" style="font-size:20px;color:\'+(isActive?\'var(--accent-color)\':\'var(--outline)\')+\'">\'+icon+\'</span>\';' +
  '    html+=\'  <div style="min-width:0;flex:1" class="playlist-track-click">\';' +
  '    html+=\'    <div style="font-size:13px;font-weight:700;color:\'+textColor+\';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\'+H(title)+\'</div>\';' +
  '    html+=\'    <div style="font-size:11px;color:var(--outline);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">\'+H(artist)+\'</div>\';' +
  '    html+=\'  </div>\';' +
  '    html+=\'  <button class="btn-ghost playlist-track-menu" style="width:28px;height:28px;padding:0;min-height:28px;border-radius:50%" data-fp="\'+H(track.fp)+\'" data-name="\'+H(track.name)+\'">\';' +
  '    html+=\'    <span class="material-symbols-outlined" style="font-size:18px">more_vert</span>\';' +
  '    html+=\'  </button>\';' +
  '    html+=\'</div>\';' +
  '  }' +
  '  container.innerHTML=html;' +
  '  container.querySelectorAll(".playlist-track-click").forEach(function(el){' +
  '    el.addEventListener("click",function(){' +
  '      var parent=el.closest(".playlist-track-row");' +
  '      if(parent){' +
  '        playGlobalAudio(parent.dataset.fp,parent.dataset.name,true);' +
  '        renderPlaylistModalTracks();' +
  '      }' +
  '    });' +
  '  });' +
  '  container.querySelectorAll(".playlist-track-menu").forEach(function(btn){' +
  '    btn.addEventListener("click",function(e){' +
  '      e.stopPropagation();' +
  '      var rect=btn.getBoundingClientRect();' +
  '      showCtxMenu(rect.left,rect.bottom+window.scrollY,btn.dataset.fp,btn.dataset.name,false);' +
  '    });' +
  '  });' +
  '}' +
  'function initSidebarPlayer(){' +
  '  if(window.sidebarPlayerInitialized)return;' +
  '  var audio=document.getElementById("global-audio");' +
  '  if(!audio)return;' +
  '  var prog=document.getElementById("player-progress");' +
  '  var curTime=document.getElementById("player-time-cur");' +
  '  var durTime=document.getElementById("player-time-dur");' +
  '  audio.addEventListener("timeupdate",function(){' +
  '    if(!audio.duration)return;' +
  '    var pct=(audio.currentTime/audio.duration)*100;' +
  '    prog.value=pct;' +
  '    curTime.textContent=fmtDuration(audio.currentTime);' +
  '  });' +
  '  audio.addEventListener("durationchange",function(){' +
  '    if(!audio.duration)return;' +
  '    durTime.textContent=fmtDuration(audio.duration);' +
  '  });' +
  '  audio.addEventListener("ended",function(){nextGlobalTrack(true);});' +
  '  audio.addEventListener("play",function(){updatePlayButtonState(true);});' +
  '  audio.addEventListener("pause",function(){updatePlayButtonState(false);});' +
  '  prog.addEventListener("input",function(){' +
  '    if(!audio.duration)return;' +
  '    var time=(prog.value/100)*audio.duration;' +
  '    audio.currentTime=time;' +
  '  });' +
  '  document.getElementById("player-btn-prev").addEventListener("click",prevGlobalTrack);' +
  '  document.getElementById("player-btn-play").addEventListener("click",toggleGlobalPlay);' +
  '  document.getElementById("player-btn-next").addEventListener("click",function(){nextGlobalTrack(false);});' +
  '  document.getElementById("player-btn-close").addEventListener("click",closeSidebarPlayer);' +
  '  document.getElementById("player-btn-repeat").addEventListener("click",toggleRepeatMode);' +
  '  document.getElementById("player-btn-playlist").addEventListener("click",function(){' +
  '    document.getElementById("modal-playlist").style.display="flex";' +
  '    renderPlaylistModalTracks();' +
  '  });' +
  '  document.getElementById("playlist-modal-close").addEventListener("click",function(){' +
  '    document.getElementById("modal-playlist").style.display="none";' +
  '  });' +
  '  document.getElementById("player-btn-details").addEventListener("click",function(){' +
  '    if(activeAudioFp&&activeAudioName){' +
  '      openPreview(activeAudioFp,activeAudioName,false);' +
  '    }' +
  '  });' +
  '  var textWrap=document.getElementById("player-text-wrap");' +
  '  if(textWrap){' +
  '    textWrap.addEventListener("click",function(){' +
  '      var swap=localStorage.getItem("player-swap-fields")==="true";' +
  '      localStorage.setItem("player-swap-fields",swap?"false":"true");' +
  '      updatePlayerTrackInfo();' +
  '    });' +
  '  }' +
  '  updateRepeatButtonUI();' +
  '  var mPlayBtn=document.getElementById("m-player-btn-play");' +
  '  if(mPlayBtn)mPlayBtn.addEventListener("click",toggleGlobalPlay);' +
  '  var mNextBtn=document.getElementById("m-player-btn-next");' +
  '  if(mNextBtn)mNextBtn.addEventListener("click",function(){nextGlobalTrack(false);});' +
  '  var mCloseBtn=document.getElementById("m-player-btn-close");' +
  '  if(mCloseBtn)mCloseBtn.addEventListener("click",closeSidebarPlayer);' +
  '  window.sidebarPlayerInitialized=true;' +
  '}' +
  'function fmtDuration(secs){' +
  '  if(isNaN(secs))return "0:00";' +
  '  var m=Math.floor(secs/60);' +
  '  var s=Math.floor(secs%60);' +
  '  return m+":"+(s<10?"0":"")+s;' +
  '}' +
  'function openPreview(fp,name,isDir,startTime,autoPlay){if(isDir){navigateTo(fp);return;}if(window.previewPlyrInstance){try{window.previewPlyrInstance.destroy();}catch(e){}window.previewPlyrInstance=null;}var body=document.getElementById("preview-body");body.innerHTML="";previewFp=fp;previewName=name;previewKind="";previewSrc="";var ext=(name.split(".").pop()||"").toLowerCase();if(["png","jpg","jpeg","gif","webp","svg","bmp"].includes(ext))previewKind="image";else if(["mp4","webm","ogg","mov","mkv"].includes(ext))previewKind="video";else if(["mp3","wav","m4a","flac","aac","oga"].includes(ext))previewKind="audio";updatePreviewNavButtons();var panel=document.getElementById("preview-panel");document.getElementById("preview-title").textContent=name;panel.classList.add("open");body.classList.remove("media-preview");renderPreviewInfo(fp,name);var src="/api/fm/preview?path="+encodeURIComponent(fp);if(previewKind==="image"){previewSrc=src;body.classList.add("media-preview");body.innerHTML=`<div id="preview-media-wrap" class="preview-media-wrap"><img class="preview-media" src="${src}" alt="${H(name)}"></div>`;return;}if(previewKind==="video"){previewSrc=src;body.classList.add("media-preview");body.innerHTML=`<div id="preview-media-wrap" class="preview-media-wrap"><video id="preview-plyr" crossorigin="anonymous" playsinline controls><source src="${src}" type="video/mp4" size="1080"><source src="${src}&quality=720" type="video/mp4" size="720"><source src="${src}&quality=480" type="video/mp4" size="480"><source src="${src}&quality=360" type="video/mp4" size="360"></video></div>`;setTimeout(function(){try{if(window.previewPlyrInstance){window.previewPlyrInstance.destroy();window.previewPlyrInstance=null;}window.previewPlyrInstance=initPlyr("#preview-plyr",true,"plyr_time_"+src,startTime,autoPlay);}catch(e){console.error(e);}},50);return;}if(previewKind==="audio"){previewSrc=src;playGlobalAudio(fp,name,false);body.classList.add("media-preview");body.innerHTML=\'<div style="padding:24px;text-align:center;color:var(--outline)"><span class="material-symbols-outlined" style="font-size:48px;color:var(--accent-color);margin-bottom:10px">music_note</span><div style="font-size:14px;font-weight:700;color:var(--on-surf);margin-bottom:4px">Воспроизведение...</div><div style="font-size:12px;color:var(--outline)">Трек загружен в плеер сайдбара</div></div>\';return;}if(ext==="pdf"){body.innerHTML=`<iframe src="${src}" style="width:100%;height:70vh;border:0;border-radius:10px"></iframe>`;return;}if(["txt","log","md","json","csv","js","css","html","xml","yml","yaml","ini","conf","py","sh"].includes(ext)){body.textContent="Загрузка предпросмотра...";fetch(src).then(function(r){return r.text();}).then(function(t){if(t.length<150000&&["js","css","html","xml","json","py","sh","yml","yaml","md"].includes(ext)){var highlighted=highlightCode(t,ext);body.innerHTML=`<pre style="white-space:pre-wrap;font-size:12px;line-height:1.55;margin:0;font-family:\'Fira Code\',Consolas,monospace;background:#18181f;padding:12px;border-radius:10px;color:#f8f8f2">${highlighted}</pre>`;}else{body.innerHTML=`<pre style="white-space:pre-wrap;font-size:12px;line-height:1.55;margin:0">${H(t)}</pre>`;}}).catch(function(){body.textContent="Не удалось загрузить предпросмотр";});return;}if(ext==="torrent"){body.innerHTML=`<div style="padding:32px;text-align:center;color:#958ea0"><span class="material-symbols-outlined" style="font-size:48px;color:var(--accent-color);display:block;margin-bottom:12px">cloud_download</span>Торрент-файл<br><br><button class="btn-primary" onclick="startTorrentDownload(previewFp,previewName)" style="display:inline-flex;align-items:center;gap:8px"><span class="material-symbols-outlined" style="font-size:18px">download_for_offline</span>Скачать торрент на VPS</button><br><br><a class="btn-ghost" href="/api/fm/download?path=${encodeURIComponent(fp)}" download style="display:inline-block;text-decoration:none;font-size:13px">↓ Скачать .torrent файл</a></div>`;return;}body.innerHTML=`<div style="padding:32px;text-align:center;color:#958ea0">Предпросмотр недоступен<br><br><a class="btn-primary" href="/api/fm/download?path=${encodeURIComponent(fp)}" download style="display:inline-block;text-decoration:none">Скачать файл</a></div>`;}' +
  'function openPreviewShell(fp,name){if(window.previewPlyrInstance){try{window.previewPlyrInstance.destroy();}catch(e){}window.previewPlyrInstance=null;}var body=document.getElementById("preview-body");body.innerHTML="";previewFp=fp;previewName=name;previewKind="";previewSrc="";updatePreviewNavButtons();var panel=document.getElementById("preview-panel");document.getElementById("preview-title").textContent=name;panel.classList.add("open");body.classList.remove("media-preview");renderPreviewInfo(fp,name);return body;}' +
  'function renderDocPreview(fp,name){var body=openPreviewShell(fp,name);body.innerHTML=\'<div style="color:#958ea0;padding:20px">Загрузка документа...</div>\';fetch("/api/fm/doc-preview?path="+encodeURIComponent(fp)).then(function(r){return r.json();}).then(function(d){if(!d.ok){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">\'+H(d.error||"Не удалось открыть документ")+\'</div>\';return;}if(d.type==="sheet"){var sheets=d.sheets||[];if(!sheets.length){body.innerHTML=\'<div style="padding:24px;color:#958ea0">В таблице нет листов</div>\';return;}var h=\'<div class="doc-tabs">\';for(var i=0;i<sheets.length;i++)h+=\'<button class="doc-tab" data-sheet="\'+i+\'">\'+H(sheets[i].name)+\'</button>\';h+=\'</div><div id="sheet-preview" class="doc-preview">\'+(sheets[0].html||"")+\'</div>\';body.innerHTML=h;body.querySelectorAll("[data-sheet]").forEach(function(btn){btn.addEventListener("click",function(){var idx=parseInt(btn.dataset.sheet,10)||0;document.getElementById("sheet-preview").innerHTML=sheets[idx].html||"";});});return;}body.innerHTML=\'<div class="doc-preview">\'+(d.html||"")+\'</div>\';}).catch(function(){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">Ошибка предпросмотра</div>\';});}' +
  'function renderArchivePreview(fp,name){var body=openPreviewShell(fp,name);body.innerHTML=\'<div style="color:#958ea0;padding:20px">Читаю архив...</div>\';fetch("/api/fm/archive/list?path="+encodeURIComponent(fp)).then(function(r){return r.json();}).then(function(d){if(!d.ok){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">\'+H(d.error||"Не удалось открыть архив")+\'<div style="margin-top:8px;color:#958ea0;font-size:12px">\'+H(d.details||"")+\'</div></div>\';return;}var items=d.entries||[];if(!items.length){body.innerHTML=\'<div style="padding:24px;color:#958ea0">Архив пуст</div>\';return;}var h=\'<div style="display:flex;justify-content:space-between;gap:10px;margin-bottom:10px;color:#958ea0;font-size:12px"><span>\'+items.length+\' items</span><a class="btn-ghost" href="/api/fm/download?path=\'+encodeURIComponent(fp)+\'" download style="text-decoration:none;padding:4px 10px;min-height:28px">Скачать архив</a></div><table class="archive-table"><tbody>\';items.forEach(function(x){var icon=x.isDir?"folder":"draft";var cls=x.isDir?"archive-path archive-dir":"archive-path";h+=\'<tr><td style="width:28px"><span class="material-symbols-outlined" style="font-size:18px">\'+icon+\'</span></td><td><div class="\'+cls+\'" title="\'+H(x.path)+\'">\'+H(x.path)+\'</div></td><td style="width:76px;color:#958ea0;white-space:nowrap">\'+(x.isDir?"":fmtSize(x.size||0))+\'</td><td style="width:42px;text-align:right">\'+(x.isDir?"":\'<a class="btn-ghost" href="/api/fm/archive/download?path=\'+encodeURIComponent(fp)+\'&entry=\'+encodeURIComponent(x.path)+\'" download style="padding:3px 8px;min-height:24px;text-decoration:none">↓</a>\')+\'</td></tr>\';});h+=\'</tbody></table>\';body.innerHTML=h;}).catch(function(){body.innerHTML=\'<div style="padding:24px;color:#ffb4ab">Ошибка чтения архива</div>\';});}' +
  'var cloudBasicOpenPreview=openPreview;openPreview=function(fp,name,isDir,startTime,autoPlay){if(isDir){navigateTo(fp);return;}var ext=(name.split(".").pop()||"").toLowerCase();if(["docx","xlsx","csv"].includes(ext))return renderDocPreview(fp,name);if(["zip","rar","7z","tar","gz","bz2","xz"].includes(ext))return renderArchivePreview(fp,name);return cloudBasicOpenPreview(fp,name,isDir,startTime,autoPlay);};' +
  'window.plyrInstance = null;' +
  'window.previewPlyrInstance = null;' +
  'function closeMediaViewer(){' +
  '  var v=document.getElementById("media-viewer");' +
  '  var startPreviewPlayback=false,lastTime=0;' +
  '  var media=document.getElementById("mv-media");' +
  '  if(media){' +
  '    lastTime=media.currentTime||0;' +
  '    startPreviewPlayback=!media.paused;' +
  '    try{media.pause();}catch(e){}' +
  '  }' +
  '  if(window.plyrInstance){' +
  '    if(lastTime===0) lastTime=window.plyrInstance.currentTime||0;' +
  '    if(!startPreviewPlayback) startPreviewPlayback=window.plyrInstance.playing||false;' +
  '    try{window.plyrInstance.destroy();}catch(e){}window.plyrInstance=null;' +
  '  }' +
  '  v.classList.remove("open");' +
  '  document.getElementById("mv-stage").innerHTML="";' +
  '  document.getElementById("mv-bottom").innerHTML="";' +
  '  if(previewFp && (previewKind==="video" || previewKind === "audio")) {' +
  '    openPreview(previewFp, previewName, false, lastTime, startPreviewPlayback);' +
  '  } else if (previewFp && previewKind === "image") {' +
  '    openPreview(previewFp, previewName, false);' +
  '  }' +
  '}' +
'function openMediaViewer(){' +
  '  if(!previewSrc||!previewKind)return;' +
  '  mvZoom=1; window.mvTranslateX=0; window.mvTranslateY=0;' +
  '  document.getElementById("mv-title").textContent=previewName||"Media";' +
  '  var v=document.getElementById("media-viewer"),stage=document.getElementById("mv-stage"),bottom=document.getElementById("mv-bottom");' +
  '  var startPlayback=false,startTime=0;' +
  '  var smallMedia=document.getElementById("preview-plyr");' +
  '  if(smallMedia){' +
  '    startTime=smallMedia.currentTime||0;' +
  '    startPlayback=!smallMedia.paused;' +
  '    try{smallMedia.pause();}catch(e){}' +
  '  }' +
  '  if(window.previewPlyrInstance){' +
  '    if(startTime===0) startTime=window.previewPlyrInstance.currentTime||0;' +
  '    if(!startPlayback) startPlayback=window.previewPlyrInstance.playing||false;' +
  '    try{window.previewPlyrInstance.destroy();}catch(e){}window.previewPlyrInstance=null;' +
  '  }' +
  '  var previewBody=document.getElementById("preview-body");' +
  '  if(previewBody) previewBody.innerHTML="";' +
  '  var shotBtn=document.getElementById("mv-btn-screenshot");' +
  '  if(shotBtn){shotBtn.style.display=(previewKind==="video")?"block":"none";}' +
  '  if(previewKind==="image"){' +
  '    stage.innerHTML=\'<img id="mv-media" src="\' + previewSrc + \'" alt="\' + H(previewName) + \'" style="max-height:100%;max-width:100%;object-fit:contain;transition:transform 0.1s ease-out;cursor:grab;transform-origin:center center">\';' +
  '    bottom.innerHTML=\'<button class="mv-icon" data-action="mv-zoom-out"><span class="material-symbols-outlined">zoom_out</span></button><button class="mv-icon" data-action="mv-fit"><span class="material-symbols-outlined">fit_screen</span></button><button class="mv-icon" data-action="mv-zoom-in"><span class="material-symbols-outlined">zoom_in</span></button><div style="flex:1"></div><div class="mv-time">Изображение</div>\';' +
  '    setTimeout(function(){' +
  '      var m=document.getElementById("mv-media");' +
  '      if(!m)return;' +
  '      var isDragging = false;' +
  '      var startX, startY;' +
  '      function updateTransform() {' +
  '        m.style.transform = "scale(" + mvZoom + ") translate(" + window.mvTranslateX + "px, " + window.mvTranslateY + "px)";' +
  '      }' +
  '      m.addEventListener("wheel", function(e) {' +
  '        e.preventDefault();' +
  '        var delta = e.deltaY < 0 ? 0.15 : -0.15;' +
  '        mvZoom = Math.min(6, Math.max(0.25, mvZoom + delta));' +
  '        m.style.transition = "transform 0.05s ease-out";' +
  '        updateTransform();' +
  '      });' +
  '      m.addEventListener("mousedown", function(e) {' +
  '        if (mvZoom <= 1) return;' +
  '        isDragging = true;' +
  '        startX = e.clientX - window.mvTranslateX * mvZoom;' +
  '        startY = e.clientY - window.mvTranslateY * mvZoom;' +
  '        m.style.cursor = "grabbing";' +
  '        m.style.transition = "none";' +
  '        e.preventDefault();' +
  '      });' +
  '      document.addEventListener("mousemove", function(e) {' +
  '        if (!isDragging) return;' +
  '        window.mvTranslateX = (e.clientX - startX) / mvZoom;' +
  '        window.mvTranslateY = (e.clientY - startY) / mvZoom;' +
  '        updateTransform();' +
  '      });' +
  '      document.addEventListener("mouseup", function() {' +
  '        if (isDragging) {' +
  '          isDragging = false;' +
  '          m.style.cursor = "grab";' +
  '        }' +
  '      });' +
  '      var touchStartX = 0;' +
  '      var touchStartY = 0;' +
  '      m.addEventListener("touchstart", function(e) {' +
  '        if (e.touches.length === 1) {' +
  '          touchStartX = e.touches[0].clientX;' +
  '          touchStartY = e.touches[0].clientY;' +
  '        }' +
  '      }, {passive: true});' +
  '      m.addEventListener("touchend", function(e) {' +
  '        if (mvZoom > 1) return;' +
  '        if (e.changedTouches.length === 1) {' +
  '          var touchEndX = e.changedTouches[0].clientX;' +
  '          var touchEndY = e.changedTouches[0].clientY;' +
  '          var diffX = touchEndX - touchStartX;' +
  '          var diffY = touchEndY - touchStartY;' +
  '          if (Math.abs(diffX) > 60 && Math.abs(diffY) < 40) {' +
  '            if (diffX < 0) { playSibling("next", true); }' +
  '            else { playSibling("prev", true); }' +
  '          }' +
  '        }' +
  '      }, {passive: true});' +
  '    }, 50);' +
  '  } else {' +
  '    var autoplayAttr=startPlayback?"autoplay":"";' +
  '    if(previewKind==="video"){' +
  '      stage.innerHTML=\'<video id="mv-media" crossorigin="anonymous" playsinline controls style="max-height:100%" \' + autoplayAttr + \'><source src="\' + previewSrc + \'" type="video/mp4" size="1080"><source src="\' + previewSrc + \'&quality=720" type="video/mp4" size="720"><source src="\' + previewSrc + \'&quality=480" type="video/mp4" size="480"><source src="\' + previewSrc + \'&quality=360" type="video/mp4" size="360"></video>\';' +
  '    }else{' +
  '      stage.innerHTML=\'<audio id="mv-media" src="\' + previewSrc + \'" crossorigin="anonymous" playsinline controls style="max-height:100%" \' + autoplayAttr + \'></audio>\';' +
  '    }' +
  '    var mediaFiles=getPlayableMediaFiles(previewKind);' +
  '    var plHtml=\'<div class="plyr-playlist" style="width:100%;padding:10px 16px;background:rgba(20,20,24,0.72);border-top:1px solid rgba(255,255,255,0.06);box-sizing:border-box">\';' +
  '    plHtml+=\'<div style="font-size:12px;font-weight:700;color:var(--accent-light);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px">Плейлист папки</div>\';' +
  '    plHtml+=\'<div class="pl-carousel" style="display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scrollbar-width:thin">\';' +
  '    for(var idx=0;idx<mediaFiles.length;idx++){' +
  '      var item=mediaFiles[idx];' +
  '      var entryPath=lastBase?(lastBase+"/"+item.name):item.name;' +
  '      var isActive=entryPath===previewFp;' +
  '      var cardStyle=\'flex:0 0 auto;width:160px;padding:8px 12px;border-radius:10px;background:\' + (isActive?\'color-mix(in srgb,var(--accent-color) 12%,#1b1b1e)\':\'#1b1b1e\') + \';border:1px solid \' + (isActive?\'var(--accent-color)\':\'rgba(255,255,255,0.08)\') + \';cursor:pointer;transition:transform .2s,border-color .2s\';' +
  "      plHtml+='<div class=\"pl-card\" style=\"' + cardStyle + '\" onclick=\"playSiblingDirect(\\\'\' + entryPath.split(String.fromCharCode(39)).join('\\\\\\\'') + \'\\\',\\\'\' + item.name.split(String.fromCharCode(39)).join('\\\\\\\'') + \'\\\')\">';" +
  '      plHtml+=\'<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><span class="material-symbols-outlined" style="font-size:16px;color:\' + (isActive?\'var(--accent-color)\':\'#958ea0\') + \'">\' + (previewKind===\'video\'?\'movie\':\'music_note\') + \'</span>\';' +
  '      plHtml+=\'<span style="font-size:10px;color:#958ea0">\' + fmtSize(item.size) + \'</span></div>\';' +
  '      plHtml+=\'<div style="font-size:11px;font-weight:700;color:\' + (isActive?\'#fff\':\'#e4e1e6\') + \';overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\' + H(item.name) + \'">\' + H(item.name) + \'</div>\';' +
  '      plHtml+=\'</div>\';' +
  '    }' +
  '    plHtml+=\'</div></div>\';' +
  '    bottom.innerHTML=plHtml;' +
  '    setTimeout(function() {' +
  '      if(typeof Plyr === "undefined") { console.error("Plyr is not loaded!"); return; }' +
  '      var isVideo = previewKind === "video";' +
  '      var isMobile = window.innerWidth <= 768;' +
  '      var opts = { ' +
  '        controls: isVideo ? (isMobile ? ["play-large", "play", "progress", "current-time", "settings", "fullscreen"] : ["play-large", "play", "progress", "current-time", "duration", "mute", "volume", "captions", "settings", "pip", "airplay", "fullscreen"]) : (isMobile ? ["play", "progress", "current-time"] : ["play", "progress", "current-time", "duration", "mute", "volume"]),' +
  '        settings: ["captions", "quality", "speed", "loop"],' +
  '        keyboard: { focused: true, global: true },' +
  '        tooltips: { controls: !isMobile, seek: !isMobile }' +
  '      };' +
  '      try {' +
  '        if(window.plyrInstance) { window.plyrInstance.destroy(); }' +
  '        window.plyrInstance = new Plyr("#mv-media", opts);' +
  '        window.plyrInstance.on("ready", function(e){ ' +
  '           console.log("Plyr Ready event");' +
  '           var savedTime = localStorage.getItem("plyr_time_" + previewSrc);' +
  '           var useTime = startTime > 0 ? startTime : (savedTime ? parseFloat(savedTime) : 0);' +
  '           e.detail.plyr.currentTime = useTime;' +
  '           if (startPlayback) {' +
  '             setTimeout(function() { try { e.detail.plyr.play(); } catch(err) {} }, 50);' +
  '           }' +
  '        });' +
  '        window.plyrInstance.on("timeupdate", function(e){ ' +
  '           localStorage.setItem("plyr_time_" + previewSrc, e.detail.plyr.currentTime);' +
  '        });' +
  '        window.plyrInstance.on("ended", function(e){ ' +
  '           playSibling("next", true);' +
  '        });' +
  '      } catch(err) { console.error("Plyr failed to init:", err); }' +
  '    }, 150);' +
  '  }' +
  '  v.classList.add("open");' +
  '}' +
  'function playSiblingDirect(fp,name){' +
  '  if(window.plyrInstance){try{window.plyrInstance.destroy();}catch(e){}window.plyrInstance=null;}' +
  '  document.getElementById("mv-stage").innerHTML="";' +
  '  document.getElementById("mv-bottom").innerHTML="";' +
  '  openPreview(fp,name,false,0,true);' +
  '  setTimeout(function(){openMediaViewer();},100);' +
  '}' +
  'function bindMediaControls(){}' +
'function mediaViewerAction(action){' +
  '  var m=document.getElementById("mv-media"),viewer=document.getElementById("media-viewer");' +
  '  if(action==="mv-close")return closeMediaViewer();' +
  '  if(action==="mv-download"&&previewFp)window.location.href="/api/fm/download?path="+encodeURIComponent(previewFp);' +
  '  if(action==="mv-share"&&previewFp)shareOne(previewFp);' +
  '  if(action==="mv-zoom-in"&&m){' +
  '    mvZoom=Math.min(6,mvZoom+.25);' +
  '    m.style.transform="scale("+mvZoom+") translate("+(window.mvTranslateX||0)+"px, "+(window.mvTranslateY||0)+"px)";' +
  '  }' +
  '  if(action==="mv-zoom-out"&&m){' +
  '    mvZoom=Math.max(.25,mvZoom-.25);' +
  '    m.style.transform="scale("+mvZoom+") translate("+(window.mvTranslateX||0)+"px, "+(window.mvTranslateY||0)+"px)";' +
  '  }' +
  '  if(action==="mv-fit"&&m){' +
  '    mvZoom=1; window.mvTranslateX=0; window.mvTranslateY=0;' +
  '    m.style.transform="scale(1) translate(0px, 0px)";' +
  '  }' +
  '  if(action==="mv-screenshot"){' +
  '    var v=document.getElementById("mv-media");' +
  '    if(!v || previewKind!=="video")return;' +
  '    try{' +
  '      var canvas=document.createElement("canvas");' +
  '      canvas.width=v.videoWidth||v.clientWidth;' +
  '      canvas.height=v.videoHeight||v.clientHeight;' +
  '      var ctx=canvas.getContext("2d");' +
  '      ctx.drawImage(v,0,0,canvas.width,canvas.height);' +
  '      var imgData=canvas.toDataURL("image/png");' +
  '      var statusEl=document.getElementById("mv-title");' +
  '      var oldTitle=statusEl.textContent;' +
  '      statusEl.textContent="📸 Сохраняю скриншот...";' +
  '      fetch("/api/fm/video-screenshot",{' +
  '        method:"POST",' +
  '        headers:{"Content-Type":"application/json"},' +
  '        body:JSON.stringify({path:previewFp,folder:activePath(),img:imgData})' +
  '      }).then(function(r){return r.json();}).then(function(d){' +
  '        if(d.ok){' +
  '          statusEl.textContent="📸 Кадр сохранён!";' +
  '          refreshCurrent();' +
  '          setTimeout(function(){statusEl.textContent=oldTitle;},2000);' +
  '        }else{' +
  '          statusEl.textContent="❌ Ошибка сохранения";' +
  '          setTimeout(function(){statusEl.textContent=oldTitle;},2000);' +
  '        }' +
  '      }).catch(function(){' +
  '        statusEl.textContent="❌ Ошибка сети";' +
  '        setTimeout(function(){statusEl.textContent=oldTitle;},2000);' +
  '      });' +
  '    }catch(err){' +
  '      alert("Не удалось сделать скриншот: "+err.message);' +
  '    }' +
  '  }' +
  '}' +
  'function deleteItem(fp,name,isDir){' +
  '  if(!confirm("Удалить " + name + "?"))return;' +
  '  fetch("/api/fm/delete",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fp,isDir:isDir})})' +
  '  .then(function(r){return r.json();}).then(function(d){if(d.ok)navigateTo(activePath());else alert(d.error||"Ошибка");});' +
  '}' +
  /* ── UPLOAD ── */
  'function deleteSelected(){' +
  '  var items=selectedList();' +
  '  if(!items.length)return;' +
  '  if(!confirm("Удалить выбранные: " + items.length + "?"))return;' +
  '  Promise.all(items.map(function(it){return fetch("/api/fm/delete",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:it.fp,isDir:it.isDir})}).then(function(r){return r.json();});}))' +
  '  .then(function(results){var failed=results.filter(function(x){return !x.ok;});clearSelection(false);refreshCurrent();if(failed.length)alert("Не удалось удалить: "+failed.length);})' +
  '  .catch(function(){alert("Ошибка удаления");});' +
  '}' +
  /* ── CONFLICT MODAL LOGIC ── */
  'var _conflictPendingFiles=null,_conflictPendingFolder=null;' +
  'function openConflictModal(files,folderPath,conflicts){' +
  '  _conflictPendingFiles=files;_conflictPendingFolder=folderPath;' +
  '  var desc=document.getElementById("conflict-desc");' +
  '  var hint=document.getElementById("conflict-freename-hint");' +
  '  var n=conflicts.length;' +
  '  if(n===1){' +
  '    desc.innerHTML=\'Файл <b>\'+H(conflicts[0].name)+\'</b> уже есть в этой папке. Что сделать?\';' +
  '    hint.textContent=\'Сохранить как "\'+conflicts[0].freeName+\'"\';' +
  '  }else{' +
  '    desc.innerHTML=\'<b>\'+n+\' файла(ов)</b> уже существуют в этой папке. Что сделать с конфликтующими файлами?\';' +
  '    hint.textContent="Загрузить с новыми именами (добавить номер)";' +
  '  }' +
  '  var radios=document.querySelectorAll(\'input[name="conflict-opt"]\');' +
  '  radios.forEach(function(r){r.checked=false;});' +
  '  radios[0].checked=true;' +
  '  updateConflictHighlight();' +
  '  document.getElementById("modal-conflict").style.display="flex";' +
  '}' +
  'function closeConflictModal(){document.getElementById("modal-conflict").style.display="none";}' +
  'function updateConflictHighlight(){' +
  '  var val=getConflictChoice();' +
  '  ["replace","skip","rename"].forEach(function(v){' +
  '    var lbl=document.getElementById("copt-"+v+"-lbl");' +
  '    if(lbl)lbl.style.borderColor=val===v?"var(--primary,#a78bfa)":"transparent";' +
  '  });' +
  '}' +
  'function getConflictChoice(){' +
  '  var radios=document.querySelectorAll(\'input[name="conflict-opt"]\');' +
  '  for(var i=0;i<radios.length;i++){if(radios[i].checked)return radios[i].value;}' +
  '  return "replace";' +
  '}' +
  'document.addEventListener("change",function(e){if(e.target&&e.target.name==="conflict-opt")updateConflictHighlight();});' +
  'function confirmConflict(){' +
  '  var mode=getConflictChoice();' +
  '  closeConflictModal();' +
  '  doUploadFiles(_conflictPendingFiles,_conflictPendingFolder,mode);' +
  '}' +
  /* ── UPLOAD ── */
  'function uploadFiles(files,folderPath){' +
  '  if(!files||!files.length)return;' +
  '  var arr=Array.from(files);' + // FileList — живой объект, копируем до async
  '  if(!arr.length)return;' +
  '  var names=arr.map(function(f){return f.name;});' +
  '  fetch("/api/fm/check-conflicts?path="+encodeURIComponent(folderPath||""),{' +
  '    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filenames:names})' +
  '  }).then(function(r){return r.json();}).then(function(d){' +
  '    if(d.conflicts&&d.conflicts.length){' +
  '      openConflictModal(arr,folderPath,d.conflicts);' +
  '    }else{' +
  '      doUploadFiles(arr,folderPath,"replace");' +
  '    }' +
  '  }).catch(function(){doUploadFiles(arr,folderPath,"replace");});' +
  '}' +
  'function doUploadFiles(files,folderPath,conflictMode){' +
  '  if(!files||!files.length)return;' +
  '  var panel=document.getElementById("upload-panel");' +
  '  var fill=document.getElementById("upload-fill");' +
  '  var status=document.getElementById("upload-status");' +
  '  var title=document.getElementById("upload-title");' +
  '  var list=document.getElementById("upload-files");' +
  '  var speedEl=document.getElementById("upload-speed");' +
  '  var etaEl=document.getElementById("upload-eta");' +
  '  var bytesEl=document.getElementById("upload-bytes");' +
  '  panel.style.display="block";fill.classList.remove("done");fill.style.width="0%";' +
  '  status.textContent="0%";title.textContent="Загрузка файлов";' +
  '  if(speedEl)speedEl.textContent="";if(etaEl)etaEl.textContent="";if(bytesEl)bytesEl.textContent="";' +
  '  var dispNames=[];for(var n=0;n<Math.min(files.length,4);n++)dispNames.push(\'<div class="upload-file">\'+H(files[n].name)+\'</div>\');' +
  '  if(files.length>4)dispNames.push(\'<div class="upload-file">+ \'+(files.length-4)+\' more</div>\');' +
  '  list.innerHTML=dispNames.join("");' +
  '  var fd=new FormData();' +
  '  var totalBytes=0;for(var i=0;i<files.length;i++){fd.append("files",files[i]);totalBytes+=files[i].size;}' +
  '  var xhr=new XMLHttpRequest();' +
  '  var startTime=Date.now();var lastLoaded=0;var lastTime=Date.now();' +
  '  uploadBusy=true;' +
  '  xhr.open("POST","/api/fm/upload?path="+encodeURIComponent(folderPath||"")+"&conflictMode="+encodeURIComponent(conflictMode||"replace"));' +
  '  xhr.upload.onprogress=function(e){' +
  '    if(!e.lengthComputable)return;' +
  '    var pct=Math.round(e.loaded/e.total*100);' +
  '    fill.style.width=pct+"%";status.textContent=pct+"%";' +
  '    var now=Date.now();var dt=(now-lastTime)/1000;' +
  '    if(dt>0.3){var bps=(e.loaded-lastLoaded)/dt;lastLoaded=e.loaded;lastTime=now;' +
  '      if(speedEl)speedEl.textContent=fmtSize(Math.max(0,bps))+"/с";' +
  '      if(bytesEl)bytesEl.textContent=fmtSize(e.loaded)+" / "+fmtSize(e.total);' +
  '      if(etaEl&&bps>0){var rem=Math.max(0,e.total-e.loaded);var secs=Math.ceil(rem/bps);' +
  '        etaEl.textContent=secs>3600?(Math.ceil(secs/3600)+" ч"):secs>60?(Math.ceil(secs/60)+" мин"):(secs+" с");' +
  '      }' +
  '    }' +
  '  };' +
  '  xhr.onload=function(){' +
  '    uploadBusy=false;' +
  '    if(xhr.status>=200&&xhr.status<300){' +
  '      fill.style.width="100%";fill.classList.add("done");' +
  '      status.textContent="Готово";title.textContent="Файлы загружены";' +
  '      var elapsed=(Date.now()-startTime)/1000;var avgSpd=elapsed>0?totalBytes/elapsed:0;' +
  '      if(speedEl)speedEl.textContent="Avg: "+fmtSize(avgSpd)+"/с";' +
  '      if(bytesEl)bytesEl.textContent=fmtSize(totalBytes);' +
  '      if(etaEl)etaEl.textContent="";' +
  '      refreshCurrent();loadDisk();' +
  '      setTimeout(function(){panel.style.display="none";},3000);' +
  '    }else{status.textContent="Ошибка "+xhr.status;}' +
  '  };' +
  '  xhr.onerror=function(){uploadBusy=false;status.textContent="Ошибка соединения";};' +
  '  xhr.onabort=function(){uploadBusy=false;status.textContent="Загрузка отменена";};' +
  '  xhr.send(fd);' +
  '}' +
  /* ── CONTEXT MENU ── */
  'function showCtxMenu(x,y,fp,name,isDir){' +
  '  ctxFp=fp;ctxName=name;ctxIsDir=isDir;' +
  '  var m=document.getElementById("ctx-menu");' +
  '  var h="";' +
  '  if(isDir){' +
  '    h+=\'<div class="ctx-item" data-ctx="open">\u{1F4C2} Открыть</div>\';' +
  '    h+=\'<div class="ctx-item" data-ctx="download">📦 Скачать ZIP</div>\';' +
  '  }else{' +
  '    h+=\'<div class="ctx-item" data-ctx="download">↓ Скачать</div>\';' +
  '  }' +
  '  if(!isDir)h+=\'<div class="ctx-item" data-ctx="preview">👁 Предпросмотр</div>\';' +
  '  var _txtExts=new Set([".txt",".log",".md",".json",".csv",".js",".ts",".jsx",".tsx",".css",".xml",".yml",".yaml",".ini",".conf",".cfg",".sh",".py",".toml",".env",".htaccess",".sql"]);' +
  '  var _nameExt=(name.lastIndexOf(".")>0?name.slice(name.lastIndexOf(".")):"")+"";\n' +
  '  if(!isDir&&_txtExts.has(_nameExt.toLowerCase()))h+=\'<div class="ctx-item" data-ctx="edit-text"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px">edit_note</span> Редактировать</div>\';' +
  '  if(!isDir&&_nameExt.toLowerCase()===".torrent")h+=\'<div class="ctx-item" data-ctx="torrent-start"><span class="material-symbols-outlined" style="font-size:16px;vertical-align:-3px;color:var(--accent-light)">download_for_offline</span> Скачать торрент</div>\';' +
  '  h+=\'<div class="ctx-sep"></div>\';' +
  '  h+=\'<div class="ctx-item" data-ctx="share">🔗 Публичная ссылка</div>\';' +
  '  if(!isDir)h+=\'<div class="ctx-item" data-ctx="share-manage"><span class="material-symbols-outlined" style="font-size:18px;vertical-align:-4px">admin_panel_settings</span> Управление ссылками</div>\';' +
  '  h+=\'<div class="ctx-item" data-ctx="rename">✏️ Переименовать</div>\';' +
  '  h+=\'<div class="ctx-item" data-ctx="copypath">\u{1F4CB} Копировать путь</div>\';' +
  '  h+=\'<div class="ctx-sep"></div>\';' +
  '  h+=\'<div class="ctx-item danger" data-ctx="delete">\u{1F5D1}️ Удалить</div>\';' +
  '  m.innerHTML=h;' +
  '  m.style.display="block";m.classList.remove("open");void m.offsetWidth;m.classList.add("open");' +
  '  var mw=200,mh=m.scrollHeight||160;' +
  '  var ww=window.innerWidth,wh=window.innerHeight;' +
  '  m.style.left=Math.max(8,(x+mw>ww?ww-mw-8:x))+"px";' +
  '  m.style.top=Math.max(8,(y+mh>wh?wh-mh-8:y))+"px";' +
  '}' +
  'function hideCtxMenu(){var m=document.getElementById("ctx-menu");m.style.display="none";m.classList.remove("open");}' +
  'function startTorrentDownload(fp,name){' +
  '  showToast("Торрент","Запускаю скачивание...","");' +
  '  fetch("/api/fm/torrent-start",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:fp})})' +
  '  .then(function(r){return r.json();})' +
  '  .then(function(d){' +
  '    if(d.ok){showToast("Торрент добавлен",(name||"")+" — содержимое скачивается на VPS","");loadTransfers();}' +
  '    else alert(d.error||"Ошибка запуска торрента");' +
  '  })' +
  '  .catch(function(){alert("Ошибка соединения");});' +
  '}' +
  'var _teFp="";' +
  'function openTextEditor(fp,name){' +
  '  _teFp=fp;' +
  '  document.getElementById("te-title").textContent=name||fp;' +
  '  document.getElementById("te-path-label").textContent=fp;' +
  '  document.getElementById("te-status").textContent="Загрузка...";' +
  '  document.getElementById("te-textarea").value="";' +
  '  document.getElementById("modal-text-editor").style.display="flex";' +
  '  fetch("/api/fm/read-text?path="+encodeURIComponent(fp))' +
  '    .then(function(r){return r.json();})' +
  '    .then(function(d){' +
  '      if(d.error){document.getElementById("te-status").textContent=d.error;return;}' +
  '      document.getElementById("te-textarea").value=d.text;' +
  '      document.getElementById("te-status").textContent="";' +
  '      document.getElementById("te-textarea").focus();' +
  '    }).catch(function(){document.getElementById("te-status").textContent="Ошибка загрузки";});' +
  '}' +
  'function saveTextFile(){' +
  '  if(!_teFp)return;' +
  '  var text=document.getElementById("te-textarea").value;' +
  '  var st=document.getElementById("te-status");' +
  '  st.textContent="Сохранение...";' +
  '  fetch("/api/fm/write-text",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:_teFp,text:text})})' +
  '    .then(function(r){return r.json();})' +
  '    .then(function(d){' +
  '      if(d.ok){st.textContent="Сохранено";setTimeout(function(){st.textContent="";},2000);}' +
  '      else{st.textContent=d.error||"Ошибка";}' +
  '    }).catch(function(){st.textContent="Ошибка сохранения";});' +
  '}' +
  /* ── DRAG & DROP ── */
  'function clearDragOver(){document.querySelectorAll(".drag-over,.drop-target").forEach(function(el){el.classList.remove("drag-over");el.classList.remove("drop-target");});}' +
  /* TRANSFERS */
  'function loadTransfers(){' +
  '  Promise.all([fetch("/api/downloads").then(function(r){return r.json();}).catch(function(){return[];}),fetch("/api/fm/media-jobs?scope=active").then(function(r){return r.json();}).catch(function(){return[];}),fetch("/api/fm/media-jobs?scope=history").then(function(r){return r.json();}).catch(function(){return[];})])' +
  '  .then(function(all){' +
  '    var items=(Array.isArray(all[0])?all[0]:[]).filter(function(x){return ["active","waiting","paused"].includes(x.status);});var media=Array.isArray(all[1])?all[1]:[];var history=Array.isArray(all[2])?all[2]:[];' +
  '    history.forEach(function(j){if(j.status==="complete"){rememberNewFile(j);}var prev=knownMediaStatuses[j.id];var pending=pendingUrlJobs[j.id];var shouldSignal=(prev&&prev!==j.status)||!!pending;if(pending&&["active","waiting","paused","starting","processing"].includes(j.status)){pending.seen=true;savePendingUrlJobs();}if(shouldSignal){if(j.status==="complete"){notifyDone(j.name||j.file||"Download");rememberNewFile(j);clearPendingUrlJob(j.id);loadDisk();if(currentPath==="__dashboard__"||currentPath==="__recent__"||currentPath==="__url_history__"||currentPath===(j.folder||""))refreshCurrent();}else if(j.status==="error"||j.status==="cancelled"){notifyFail(j.name||j.file||"Download",j.error||"unknown error");clearPendingUrlJob(j.id);loadDisk();if(currentPath==="__dashboard__"||currentPath==="__url_history__"||currentPath===(j.folder||""))refreshCurrent();}}knownMediaStatuses[j.id]=j.status;});' +
  '    var count=items.length+media.length;setTransfersUi(count);if(!count){document.getElementById("transfers-list").innerHTML="";return;}' +
  '    var h=\'<div class="transfer-section-title">\\u0421\\u0435\\u0439\\u0447\\u0430\\u0441 \\u0437\\u0430\\u0433\\u0440\\u0443\\u0436\\u0430\\u0435\\u0442\\u0441\\u044f</div>\';' +
  '    for(var i=0;i<items.length;i++){' +
  '      var t=items[i],pct=t.progress||0,name=t.name||t.gid||"Download",left=Math.max(0,(t.size||0)-(t.downloaded||0));var eta=(t.speed>0&&left>0)?Math.ceil(left/t.speed):0;' +
  '      h+=\'<div class="transfer-card is-active"><div class="transfer-top"><div class="transfer-name">\'+H(name)+\'</div><div class="transfer-status">\'+H(t.status||"unknown")+\'</div><div style="font-size:12px;color:#958ea0;width:42px;text-align:right">\'+pct+\'%</div></div>\';' +
  '      h+=\'<div class="progress-track"><div class="progress-fill\'+(pct>=100?" done":"")+\'" style="width:\'+pct+\'%"></div></div>\';' +
  '      h+=\'<div class="transfer-meta"><div>\\u0421\\u043a\\u0430\\u0447\\u0430\\u043d\\u043e: \'+fmtSize(t.downloaded)+\' / \'+fmtSize(t.size)+\'</div><div>\\u0421\\u043a\\u043e\\u0440\\u043e\\u0441\\u0442\\u044c: \'+fmtSpeed(t.speed)+\'</div><div>\\u041e\\u0441\\u0442\\u0430\\u043b\\u043e\\u0441\\u044c: \'+(eta?Math.ceil(eta/60)+" \\u043c\\u0438\\u043d":"-")+\'</div><div>\\u0421\\u043e\\u0435\\u0434\\u0438\\u043d\\u0435\\u043d\\u0438\\u044f: \'+(t.connections||0)+\'</div></div>\';' +
  '      if(t.errorMessage)h+=\'<div style="font-size:12px;color:#ffb4ab">\'+H(t.errorMessage)+\'</div>\';h+=\'<div class="transfer-controls">\';' +
  '      if(t.status==="active")h+=\'<button class="btn-ghost" data-action="transfer-pause" data-gid="\'+H(t.gid)+\'"><span class="material-symbols-outlined">pause</span> \\u041f\\u0430\\u0443\\u0437\\u0430</button>\';' +
  '      if(t.status==="paused"||t.status==="waiting")h+=\'<button class="btn-ghost" data-action="transfer-resume" data-gid="\'+H(t.gid)+\'"><span class="material-symbols-outlined">play_arrow</span> \\u041f\\u0440\\u043e\\u0434\\u043e\\u043b\\u0436\\u0438\\u0442\\u044c</button>\';' +
  '      h+=\'<button class="btn-ghost" data-action="transfer-remove" data-gid="\'+H(t.gid)+\'" style="color:#ffb4ab;border-color:#93000a"><span class="material-symbols-outlined">close</span> \\u0423\\u0431\\u0440\\u0430\\u0442\\u044c</button></div></div>\';' +
  '    }' +
  '    for(var j=0;j<media.length;j++){' +
  '      var mt=media[j],mp=Math.round(mt.progress||0);' +
  '      var modeLabel=mt.mode==="audio"?"MP3":"Видео";if(mt.quality)modeLabel+=" "+mt.quality+"p";' +
  '      var statusLabel=mt.streamLabel||(mt.status==="starting"?"Подготовка...":mt.status==="active"?"Загрузка...":mt.status==="processing"?"Обработка...":mt.status==="complete"?"Готово":mt.status||"");' +
  '      var _elapsed=mt.createdAt?Math.floor((Date.now()-new Date(mt.createdAt).getTime())/1000):0;' +
  '      var _elStr=_elapsed>=3600?Math.floor(_elapsed/3600)+"ч "+Math.floor((_elapsed%3600)/60)+"м":_elapsed>=60?Math.floor(_elapsed/60)+"м "+(_elapsed%60)+"с":_elapsed+"с";' +
  '      var _isPrep=(mt.status==="starting"||(mt.status==="active"&&mp===0));' +
  '      var _isProc=mt.status==="processing";' +
  '      var _pfCls="progress-fill"+(_isProc?" processing":(_isPrep?" indeterminate":(mp>=100?" done":"")));' +
  '      var _pctStr=_isPrep?_elStr:mp+"%";' +
  '      h+=\'<div class="transfer-card is-active"><div class="transfer-top"><div class="transfer-name">\'+H(mt.name||mt.file||"Media download")+\'</div><div class="transfer-status">\'+H(modeLabel+" / "+statusLabel)+\'</div><div style="font-size:12px;color:#958ea0;min-width:38px;text-align:right">\'+_pctStr+\'</div></div>\';' +
  '      h+=\'<div class="progress-track"><div class="\'+_pfCls+\'" style="width:\'+mp+\'%"></div></div>\';' +
  '      h+=\'<div class="transfer-meta">\';' +
  '      if(mt.speed)h+=\'<div>Скорость: \'+H(mt.speed)+\'</div>\';' +
  '      if(mt.eta)h+=\'<div>ETA: \'+H(mt.eta)+\'</div>\';' +
  '      h+=\'<div>Время: \'+_elStr+\'</div>\';' +
  '      h+=\'<div>Папка: \'+H(mt.folder||"Мои файлы")+\'</div></div>\';' +
  '      if(mt.error){h+=\'<div style="font-size:12px;color:#ffb4ab">\'+H(mt.error)+\'</div>\';if(mt.error.toLowerCase().indexOf("youtube")!==-1||mt.error.toLowerCase().indexOf("format")!==-1){h+=\'<div style="font-size:11px;color:#cbbcff;margin-top:4px"><a href="/faq.html" target="_blank" style="color:var(--accent-light);text-decoration:none;border-bottom:1px dotted var(--accent-light)">Решение проблем в FAQ (cookies.txt)</a></div>\';}}' +
  '      h+=\'<div class="transfer-controls"><button class="btn-ghost" data-action="media-cancel" data-job="\'+H(mt.id)+\'" style="color:#ffb4ab;border-color:#93000a"><span class="material-symbols-outlined">close</span> Отмена</button></div></div>\';' +
  '    }document.getElementById("transfers-list").innerHTML=h;' +
  '  }).catch(function(){});' +
  '}' +
  'function loadDisk(){' +
  '  Promise.all([fetch("/api/fm/list?path=").then(function(r){return r.json();}).catch(function(){return{};}),fetch("/api/me").then(function(r){return r.json();}).catch(function(){return{};})])' +
  '  .then(function(all){' +
  '    var d=all[0],me=all[1];' +
  '    var diskUsed,diskTotal,pct;' +
  '    if(me.quotaGb!=null&&me.diskUsedBytes!=null){' +
  '      diskUsed=me.diskUsedBytes;diskTotal=me.quotaGb*1024*1024*1024;' +
  '    }else if(d.diskUsed!=null&&d.diskTotal!=null){' +
  '      diskUsed=d.diskUsed;diskTotal=d.diskTotal;' +
  '    }else{return;}' +
  '    pct=Math.min(100,Math.round(diskUsed/diskTotal*100));' +
  '    document.getElementById("disk-fill").style.width=pct+"%";' +
  '    document.getElementById("disk-label").textContent=fmtSize(diskUsed)+" / "+fmtSize(diskTotal)+(me.quotaGb!=null?" (квота)":"");' +
  '    var mf=document.getElementById("mobile-disk-fill"),ml=document.getElementById("mobile-disk-label");' +
  '    if(mf)mf.style.width=pct+"%";' +
  '    if(ml)ml.textContent=fmtSize(diskUsed)+" / "+fmtSize(diskTotal)+(me.quotaGb!=null?" (квота)":"");' +
  '  }).catch(function(){});' +
  '}' +
  /* ── CLICK DELEGATION ── */
  'document.addEventListener("click",function(e){' +
  '  /* context menu item */\n' +
  '  var ctx=e.target.closest("[data-ctx]");' +
  '  if(ctx){' +
  '    var ca=ctx.dataset.ctx;' +
  '    hideCtxMenu();' +
  '    if(ca==="open")navigateTo(ctxFp);' +
  '    else if(ca==="download")window.location.href="/api/fm/download?path="+encodeURIComponent(ctxFp);' +
  '    else if(ca==="preview")openPreview(ctxFp,ctxName,ctxIsDir);' +
  '    else if(ca==="share")shareOne(ctxFp);' +
  '    else if(ca==="share-manage")openShareManager(ctxFp,ctxName);' +
  '    else if(ca==="rename")openRenameModal(ctxFp,ctxName,ctxIsDir);' +
  '    else if(ca==="delete")deleteItem(ctxFp,ctxName,ctxIsDir);' +
  '    else if(ca==="edit-text")openTextEditor(ctxFp,ctxName);' +
  '    else if(ca==="torrent-start")startTorrentDownload(ctxFp,ctxName);' +
  '    else if(ca==="copypath"){navigator.clipboard&&navigator.clipboard.writeText(ctxFp).catch(function(){});}' +
  '    return;' +
  '  }' +
  '  if(!e.target.closest("#ctx-menu"))hideCtxMenu();' +
  '  /* action buttons */\n' +
  '  var el=e.target.closest("[data-action]");' +
  '  if(!el)return;' +
  '  var action=el.dataset.action;' +
  '  if(action.indexOf("mv-")===0){mediaViewerAction(action);return;}' +
  '  if(action==="focus-search"){var si=document.getElementById("search-inp");if(si){si.focus();si.scrollIntoView({block:"center",behavior:"smooth"});}return;}' +
  '  if(action==="item-menu"){e.preventDefault();e.stopPropagation();var r=el.getBoundingClientRect();showCtxMenu(r.right-190,r.bottom+6,el.dataset.fp,el.dataset.name,el.dataset.dir==="true");return;}' +
  '  if(el.classList&&el.classList.contains("bottom-nav-item")){document.querySelectorAll(".bottom-nav-item").forEach(function(x){x.classList.remove("active");});el.classList.add("active");}' +
  '  if(action==="navigate")navigateTo(el.dataset.fp||"");' +
  '  else if(action==="go-back")goBackPath();' +
  '  else if(action==="select-item"){toggleSelect(el.dataset.fp,el.dataset.name,el.dataset.dir==="true",el.checked);}' +
  '  else if(action==="select-all"){selectAllVisible(el.checked);}' +
  '  else if(action==="clear-selection"){clearSelection(true);}' +
  '  else if(action==="download-selected"){downloadSelected();}' +
  '  else if(action==="zip-selected"){zipSelected();}' +
  '  else if(action==="share-selected"){shareSelected();}' +
  '  else if(action==="delete-selected"){deleteSelected();}' +
  '  else if(action==="hide-upload-panel"){document.getElementById("upload-panel").style.display="none";}' +
  '  else if(action==="hide-toast"){hideToast();}' +
  '  else if(action==="copy-toast"){copyToast();}' +
  '  else if(action==="open-toast-qr"){openQrModal(toastUrl);}' +
  '  else if(action==="open-toast-link"){if(toastUrl)window.open(toastUrl,"_blank");}' +
  '  else if(action==="qr-link"){openQrModal(el.dataset.url);}' +
  '  else if(action==="close-qr"){closeQrModal();}' +
  '  else if(action==="close-changelog"){closeChangelogModal();}' +
  '  else if(action==="close-share-manager"){closeShareManager();}' +
  '  else if(action==="sm-create"){createManagedShare();}' +
  '  else if(action==="sm-save"){saveManagedShare(el.dataset.token);}' +
  '  else if(action==="sm-revoke"){revokeManagedShare(el.dataset.token);}' +
  '  else if(action==="sm-copy"){copyPlain(el.dataset.url);}' +
  '  else if(action==="sm-qr"){openQrModal(el.dataset.url);}' +
  '  else if(action==="minimize-transfers"){transfersMinimized=true;localStorage.setItem("transfers-minimized","1");setTransfersUi(1);}' +
  '  else if(action==="restore-transfers"){transfersMinimized=false;localStorage.setItem("transfers-minimized","0");loadTransfers();}' +
  '  else if(action==="toggle-theme"){toggleTheme();}' +
  '  else if(action==="share-one"){shareOne(el.dataset.fp);}' +
  '  else if(action==="preview"){openPreview(el.dataset.fp,el.dataset.name,el.dataset.dir==="true");}' +
  '  else if(action==="open-url-modal"){openUrlModal();}' +
  '  else if(action==="dashboard-url-download"){addDashboardUrlDownload();}' +
  '  else if(action==="close-text-editor"){document.getElementById("modal-text-editor").style.display="none";}' +
  '  else if(action==="save-text-editor"){saveTextFile();}' +
  '  else if(action==="close-url-modal"){closeUrlModal();}' +
  '  else if(action==="confirm-url-download"){addUrlDownload();}' +
  '  else if(action==="close-share-modal"){closeShareModal();}' +
  '  else if(action==="confirm-share"){confirmShare();}' +
  '  else if(action==="close-preview"){closePreview();}' +
  '  else if(action==="fullscreen-preview"){openMediaViewer();}' +
  '  else if(action==="preview-prev"||action==="playlist-prev"){playSibling("prev",true);}' +
  '  else if(action==="preview-next"||action==="playlist-next"){playSibling("next",true);}' +
  '  else if(action==="filter-category"){activeFilter=el.dataset.filter;renderContent(lastEntries,lastBase);}' +
  '  else if(action==="set-accent"){var themeName=el.dataset.theme;localStorage.setItem("cloud-accent",themeName);var presets={"violet":"#a078ff","emerald":"#10b981","ruby":"#f43f5e","glacier":"#06b6d4"};var resolvedHex=presets[themeName]||"#a078ff";localStorage.setItem("cloud-accent-hex",resolvedHex);applyAccentColor();saveAccentServer(resolvedHex);document.querySelectorAll(".theme-card").forEach(function(x){var on=x.dataset.theme===themeName;x.classList.toggle("active",on);var i=x.querySelector(".material-symbols-outlined:last-child");if(i)i.textContent=on?"check_circle":"radio_button_unchecked";});}' +
  '  else if(action==="download-preview"){if(previewFp)window.location.href="/api/fm/download?path="+encodeURIComponent(previewFp);}' +
  '  else if(action==="share-preview"){if(previewFp)shareOne(previewFp);}' +
  '  else if(action==="delete-preview"){if(previewFp&&confirm("Удалить файл?"))fetch("/api/fm/delete",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:previewFp,isDir:false})}).then(function(r){return r.json();}).then(function(d){if(d.ok){closePreview();refreshCurrent();}else alert(d.error||"Ошибка удаления");}).catch(function(){alert("Ошибка удаления");});}' +
  '  else if(action==="transfer-pause"){fetch("/api/downloads/"+encodeURIComponent(el.dataset.gid)+"/pause",{method:"POST"}).then(loadTransfers);}' +
  '  else if(action==="transfer-resume"){fetch("/api/downloads/"+encodeURIComponent(el.dataset.gid)+"/resume",{method:"POST"}).then(loadTransfers);}' +
  '  else if(action==="transfer-remove"){if(confirm("Убрать загрузку?"))fetch("/api/downloads/"+encodeURIComponent(el.dataset.gid),{method:"DELETE"}).then(loadTransfers);}' +
  '  else if(action==="media-cancel"){if(confirm("Отменить медиа-загрузку?"))fetch("/api/fm/media-jobs/"+encodeURIComponent(el.dataset.job),{method:"DELETE"}).then(loadTransfers);}' +
  '  else if(action==="nav-home"||action==="nav-dashboard"){loadDashboard();}' +
  '  else if(action==="nav-files"){navigateTo("");}' +
  '  else if(action==="nav-recent"){loadRecent();}' +
  '  else if(action==="nav-activity"){loadActivityLog();}' +
  '  else if(action==="nav-settings"){loadCloudSettings();}' +
  '  else if(action==="settings-save-retention"){saveCloudRetention();}' +
  '  else if(action==="settings-save-tg-limit"){saveCloudTgLimit();}' +
  '  else if(action==="settings-save-profile"){saveCloudProfile();}' +
  '  else if(action==="settings-speedtest"){runSpeedTest();}' +
  '  else if(action==="settings-notif"){requestCloudNotif();}' +
  '  else if(action==="settings-load-token"){loadCloudToken();}' +
  '  else if(action==="settings-copy-token"){copyCloudToken();}' +
  '  else if(action==="settings-reset-token"){resetCloudToken();}' +
  '  else if(action==="set-accent-hex"){var h=el.dataset.hex;if(h){localStorage.setItem("cloud-accent-hex",h);applyAccentColor();saveAccentServer(h);var inp=document.getElementById("accent-color-input");var lbl=document.getElementById("accent-hex-label");if(inp)inp.value=h;if(lbl)lbl.textContent=h;updateColorSwatches(h);}}' +
  '  else if(action==="settings-delete-cookies"){deleteCookies();}' +
  '  else if(action==="settings-tg-connect"){connectTelegram();}' +
  '  else if(action==="settings-tg-unlink"){unlinkTelegram();}' +
  '  else if(action==="settings-change-password"){changeCloudPassword();}' +
  '  else if(action==="settings-add-user"){addCloudUser();}' +
  '  else if(action==="settings-delete-user"){deleteCloudUser(el.dataset.user);}' +
  '  else if(action==="retry-url"){var u=el.dataset.url;if(u){openUrlModal(u);}}' +
  '  else if(action==="show-history-error"){alert(el.dataset.error||"Ошибка загрузки");}' +
  '  else if(action==="view-list"){setView("list");}' +
  '  else if(action==="view-grid"){setView("grid");}' +
  '  else if(action==="mkdir")openMkdirModal();' +
  '  else if(action==="close-mkdir")closeMkdirModal();' +
  '  else if(action==="confirm-mkdir")createFolder();' +
  '  else if(action==="rename")openRenameModal(el.dataset.fp,el.dataset.name,el.dataset.dir==="true");' +
  '  else if(action==="close-rename")closeRenameModal();' +
  '  else if(action==="confirm-rename")doRename();' +
  '  else if(action==="close-conflict")closeConflictModal();' +
  '  else if(action==="confirm-conflict")confirmConflict();' +
  '  else if(action==="delete")deleteItem(el.dataset.fp,el.dataset.name,el.dataset.dir==="true");' +
  '  else if(action==="upload-btn")document.getElementById("upload-input").click();' +
  '});' +
  /* ── CLICK on file row to open folder ── */
  'document.addEventListener("click",function(e){' +
  '  if(e.target.closest("[data-action]")||e.target.closest("[data-ctx]"))return;' +
  '  var row=e.target.closest("[data-fp][data-dir]");' +
  '  if(!row)return;' +
  '  if(row.dataset.dir==="true")navigateTo(row.dataset.fp);else openPreview(row.dataset.fp,row.dataset.name,false);' +
  '});' +
  /* ── CONTEXT MENU trigger ── */
  'document.addEventListener("contextmenu",function(e){' +
  '  var row=e.target.closest("[data-fp][data-name]");' +
  '  if(!row){hideCtxMenu();return;}' +
  '  e.preventDefault();' +
  '  showCtxMenu(e.clientX,e.clientY,row.dataset.fp,row.dataset.name,row.dataset.dir==="true");' +
  '});' +
  'document.addEventListener("scroll",hideCtxMenu,true);' +
  /* ── DRAG START ── */
  'document.addEventListener("dragstart",function(e){' +
  '  var row=e.target.closest("[data-fp][data-name]");' +
  '  if(!row)return;' +
  '  dragFp=row.dataset.fp;dragName=row.dataset.name;dragIsDir=row.dataset.dir==="true";dragEl=row;' +
  '  e.dataTransfer.effectAllowed="move";' +
  '  e.dataTransfer.setData("text/plain",dragFp);' +
  '  var sel=selectedList();' +
  '  var isMulti=sel.length>1&&!!selectedItems[dragFp];' +
  '  dragItems=isMulti?sel:null;' +
  '  if(isMulti){' +
  '    createDragGhost(e,sel);' +
  '    document.querySelectorAll("[data-fp]").forEach(function(el){if(selectedItems[el.dataset.fp])el.classList.add("dragging");});' +
  '  }else{' +
  '    setTimeout(function(){if(dragEl)dragEl.classList.add("dragging");},0);' +
  '  }' +
  '});' +
  /* ── DRAG END ── */
  'document.addEventListener("dragend",function(){' +
  '  document.querySelectorAll(".dragging").forEach(function(el){el.classList.remove("dragging");});' +
  '  dragEl=null;dragFp=null;dragItems=null;' +
  '  removeDragGhost();clearDragOver();' +
  '  document.getElementById("drop-zone").classList.remove("active");' +
  '});' +
  /* ── DRAG OVER ── */
  'document.addEventListener("dragover",function(e){' +
  '  /* internal move: drag over a folder */\n' +
  '  if(dragFp){' +
  '    var dropTarget=e.target.closest("[data-drop-path]");' +
  '    if(dropTarget){' +
  '      e.preventDefault();e.dataTransfer.dropEffect="move";' +
  '      clearDragOver();dropTarget.classList.add("drop-target");' +
  '      return;' +
  '    }' +
  '    var target=e.target.closest("[data-dir=\'true\'][data-fp]");' +
  '    if(target&&target.dataset.fp!==dragFp){' +
  '      e.preventDefault();e.dataTransfer.dropEffect="move";' +
  '      clearDragOver();target.classList.add("drag-over");' +
  '      return;' +
  '    }' +
  '    clearDragOver();' +
  '    return;' +
  '  }' +
  '  /* external files */\n' +
  '  if(e.dataTransfer.types&&Array.from(e.dataTransfer.types).includes("Files")){' +
  '    e.preventDefault();e.dataTransfer.dropEffect="copy";' +
  '    document.getElementById("drop-zone").classList.add("active");' +
  '  }' +
  '});' +
  /* ── DRAG LEAVE ── */
  'document.addEventListener("dragleave",function(e){' +
  '  if(!e.relatedTarget){' +
  '    clearDragOver();' +
  '    document.getElementById("drop-zone").classList.remove("active");' +
  '  }' +
  '});' +
  /* ── DROP ── */
  'document.addEventListener("drop",function(e){' +
  '  clearDragOver();' +
  '  document.getElementById("drop-zone").classList.remove("active");' +
  '  /* external file drop */\n' +
  '  if(!dragFp&&e.dataTransfer.files&&e.dataTransfer.files.length){' +
  '    e.preventDefault();' +
  '    uploadFiles(e.dataTransfer.files,activePath());' +
  '    return;' +
  '  }' +
  '  /* internal move */\n' +
  '  if(!dragFp)return;' +
  '  var destFp=null;' +
  '  var dropTarget=e.target.closest("[data-drop-path]");' +
  '  if(dropTarget){' +
  '    e.preventDefault();' +
  '    destFp=dropTarget.dataset.dropPath||"";' +
  '  }else{' +
  '    var target=e.target.closest("[data-dir=\'true\'][data-fp]");' +
  '    if(!target||target.dataset.fp===dragFp){dragFp=null;dragItems=null;return;}' +
  '    e.preventDefault();' +
  '    destFp=target.dataset.fp;' +
  '  }' +
  '  if(dragItems&&dragItems.length>1){' +
  '    var multiItems=dragItems;' +
  '    dragFp=null;dragItems=null;' +
  '    moveMultiTo(multiItems,destFp);' +
  '  }else{' +
  '    var moveFp=dragFp,moveName=dragName;' +
  '    dragFp=null;dragItems=null;' +
  '    moveItemTo(moveFp,moveName,destFp);' +
  '  }' +
  '});' +
  /* ── KEYBOARD ── */
  'document.addEventListener("keydown",function(e){' +
  '  if(e.key==="Escape"){hideCtxMenu();closeMkdirModal();closeRenameModal();closeConflictModal();closeUrlModal();closeShareModal();closeShareManager();closeQrModal();closeMediaViewer();closePreview();document.getElementById("modal-text-editor").style.display="none";}  var mv=document.getElementById("media-viewer");  var isMvOpen=mv&&mv.classList.contains("open");  if(isMvOpen && previewKind==="image"){    if(e.key==="ArrowRight"){playSibling("next",true);}    else if(e.key==="ArrowLeft"){playSibling("prev",true);}  }' +
  '  if(e.ctrlKey&&e.key==="s"&&document.getElementById("modal-text-editor").style.display!=="none"){e.preventDefault();saveTextFile();}' +
  '  if(e.key==="Enter"){' +
  '    if(document.getElementById("modal-mkdir").style.display!=="none")createFolder();' +
  '    else if(document.getElementById("modal-rename").style.display!=="none")doRename();' +
  '    else if(document.getElementById("modal-conflict").style.display!=="none")confirmConflict();' +
  '    else if(document.getElementById("modal-url").style.display!=="none")addUrlDownload();' +
  '    else if(document.getElementById("modal-share").style.display!=="none")confirmShare();' +
  '  }' +
  '});' +
  /* ── CLIPBOARD PASTE ── */
  'document.addEventListener("paste",function(e){' +
  '  var target=e.target;' +
  '  if(target.tagName==="INPUT"||target.tagName==="TEXTAREA"||target.isContentEditable)return;' +
  '  var items=(e.clipboardData||(e.originalEvent||{}).clipboardData||{}).items||[];' +
  '  var files=[];' +
  '  for(var i=0;i<items.length;i++){' +
  '    if(items[i].kind==="file"){' +
  '      var blob=items[i].getAsFile();' +
  '      if(blob){' +
  '        var name=blob.name;' +
  '        if(!name||name==="image.png"){' +
  '          var d=new Date();' +
  '          var ts=d.getFullYear()+""+String(d.getMonth()+1).padStart(2,"0")+""+String(d.getDate()).padStart(2,"0")+"_"+String(d.getHours()).padStart(2,"0")+""+String(d.getMinutes()).padStart(2,"0")+""+String(d.getSeconds()).padStart(2,"0");' +
  '          name="Screenshot_"+ts+".png";' +
  '        }' +
  '        try{' +
  '          var f=new File([blob],name,{type:blob.type});' +
  '          files.push(f);' +
  '        }catch(err){' +
  '          blob.name=name;files.push(blob);' +
  '        }' +
  '      }' +
  '    }' +
  '  }' +
  '  if(files.length){' +
  '    e.preventDefault();' +
  '    uploadFiles(files,activePath());' +
  '  }' +
  '});' +
  /* ── UPLOAD input ── */
  'document.getElementById("upload-input").addEventListener("change",function(){' +
  '  uploadFiles(this.files,activePath());this.value="";' +
  '});' +
  /* ── SEARCH ── */
  'var searchTimer;' +
  'document.getElementById("search-inp").addEventListener("input",function(){' +
  '  clearTimeout(searchTimer);var q=this.value;' +
  '  searchTimer=setTimeout(function(){doSearch(q);},400);' +
  '});' +
  'document.addEventListener("keydown",function(e){if(e.key==="Enter"&&document.activeElement&&["dash-url-inp","dash-name-inp","dash-url-inp-batch"].includes(document.activeElement.id)){if(document.activeElement.id==="dash-url-inp-batch"&&!e.ctrlKey)return;addDashboardUrlDownload();}});' +
  'window.addEventListener("beforeunload",function(e){if(uploadBusy){e.preventDefault();e.returnValue="";return "";}});' +
  '(function(){' +
  '  var resizer=document.getElementById("preview-resizer");' +
  '  var panel=document.getElementById("preview-panel");' +
  '  if(!resizer||!panel)return;' +
  '  var isDragging=false;' +
  '  resizer.addEventListener("mousedown",function(e){' +
  '    if(window.innerWidth<=768)return;' +
  '    isDragging=true;' +
  '    resizer.classList.add("dragging");' +
  '    document.body.style.cursor="col-resize";' +
  '    document.body.style.userSelect="none";' +
  '    e.preventDefault();' +
  '  });' +
  '  window.addEventListener("mousemove",function(e){' +
  '    if(!isDragging)return;' +
  '    var width=window.innerWidth-e.clientX;' +
  '    if(width<240)width=240;' +
  '    if(width>window.innerWidth*0.8)width=window.innerWidth*0.8;' +
  '    panel.style.width=width+"px";' +
  '    panel.style.maxWidth="none";' +
  '    window.dispatchEvent(new Event("resize"));' +
  '  });' +
  '  window.addEventListener("mouseup",function(){' +
  '    if(!isDragging)return;' +
  '    isDragging=false;' +
  '    resizer.classList.remove("dragging");' +
  '    document.body.style.cursor="";' +
  '    document.body.style.userSelect="";' +
  '    window.dispatchEvent(new Event("resize"));' +
  '  });' +
  '  resizer.addEventListener("dblclick",function(e){' +
  '    if(window.innerWidth<=768)return;' +
  '    panel.style.width="";' +
  '    panel.style.maxWidth="";' +
  '    window.dispatchEvent(new Event("resize"));' +
  '  });' +
  '})();' +
  'applyTheme();loadAccentFromServer();checkChangelog();' +
  '(function(){var h=parseHash();if(h){if(h.type==="dashboard")loadDashboard();else if(h.type==="recent")loadRecent();else if(h.type==="activity")loadActivityLog();else if(h.type==="settings")loadCloudSettings();else navigateTo(h.path||"");return;}var saved=localStorage.getItem("fm-path");if(saved===null)loadDashboard();else if(saved==="__dashboard__")loadDashboard();else if(saved==="__recent__")loadRecent();else if(saved==="__activity__")loadActivityLog();else if(saved==="__settings__")loadCloudSettings();else navigateTo(saved||"");})();initSidebarPlayer();' +
  'loadDisk();' +
  'loadTransfers();' +
  'checkConnection(true);' +
  /* ── SSE: заменяем polling раз в 2 сек на push-события ── */
  'var _sseConn=null,_sseRetry=0;' +
  'function connectSSE(){' +
  '  if(_sseConn){try{_sseConn.close();}catch{}}' +
  '  _sseConn=new EventSource("/api/events");' +
  '  _sseConn.addEventListener("jobs",function(){loadTransfers();_sseRetry=0;});' +
  '  _sseConn.onerror=function(){' +
  '    _sseRetry++;' +
  '    var delay=Math.min(30000,2000*Math.pow(1.5,_sseRetry));' +
  '    setTimeout(connectSSE,delay);' +
  '  };' +
  '}' +
  'connectSSE();' +
  'setInterval(loadDisk,60000);' +
  'setInterval(function(){checkConnection(true);},15000);' +
  /* ── Service Worker + Web Push ── */
  '(function(){' +
  '  if(!("serviceWorker" in navigator))return;' +
  '  navigator.serviceWorker.register("/sw.js").then(function(reg){' +
  '    window._swReg=reg;' +
  '    return fetch("/api/push/vapid-key").then(function(r){return r.json();});' +
  '  }).then(function(d){' +
  '    if(!d.enabled)return;' +
  '    window._vapidKey=d.publicKey;' +
  '    updatePushButtonState();' +
  '  }).catch(function(){});' +
  '})();' +
  'function urlBase64ToUint8(b64){var pad="=".repeat((4-b64.length%4)%4);var s=(b64+pad).replace(/-/g,"+").replace(/_/g,"/");var raw=atob(s);var out=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;}' +
  'function updatePushButtonState(){' +
  '  var btn=document.getElementById("push-toggle-btn");' +
  '  if(!btn||!window._swReg)return;' +
  '  window._swReg.pushManager.getSubscription().then(function(sub){' +
  '    btn.textContent=sub?"🔔 Push включён":"🔕 Включить Push";' +
  '    btn.dataset.subbed=sub?"1":"0";' +
  '  });' +
  '}' +
  'function togglePushSubscription(){' +
  '  if(!window._swReg||!window._vapidKey)return;' +
  '  var btn=document.getElementById("push-toggle-btn");' +
  '  if(btn&&btn.dataset.subbed==="1"){' +
  '    window._swReg.pushManager.getSubscription().then(function(sub){' +
  '      if(!sub)return;' +
  '      return fetch("/api/push/subscribe",{method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({endpoint:sub.endpoint})})' +
  '        .then(function(){return sub.unsubscribe();});' +
  '    }).then(updatePushButtonState).catch(function(){});' +
  '  }else{' +
  '    Notification.requestPermission().then(function(perm){' +
  '      if(perm!=="granted")return;' +
  '      return window._swReg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8(window._vapidKey)});' +
  '    }).then(function(sub){' +
  '      if(!sub)return;' +
  '      return fetch("/api/push/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({subscription:sub.toJSON()})});' +
  '    }).then(updatePushButtonState).catch(function(){});' +
  '  }' +
  '}' +
  '</script>' +
  '</body></html>';
}

module.exports = {
  sharePasswordPage,
  shareNotFoundPage,
  sharePreviewPage,
  landingPage,
  privacyPage,
  loginPage,
  faqPage,
  cloudPage,
};
