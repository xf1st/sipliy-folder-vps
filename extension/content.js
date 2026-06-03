// Sipliy Folder VPS — YouTube content script v1.0
(function () {
  'use strict';

  const ID = 'sipliy-vps';
  const BTN_ID = ID + '-btn';
  const MENU_ID = ID + '-menu';
  const STYLE_ID = ID + '-style';

  /* ── CSS ─────────────────────────────────────────────── */
  const CSS = `
    #${BTN_ID} {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 0 14px 0 10px;
      height: 36px;
      border-radius: 18px;
      border: none;
      background: var(--yt-spec-button-chip-background-fill, rgba(255,255,255,0.1));
      color: var(--yt-spec-text-primary, #fff);
      font-family: Roboto, Arial, sans-serif;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      margin-left: 8px;
      position: relative;
      transition: background 0.1s;
    }
    #${BTN_ID}:hover {
      background: var(--yt-spec-button-chip-background-hover, rgba(255,255,255,0.18));
    }
    #${BTN_ID} .${ID}-logo {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--sipliy-p, #a078ff), #7c3aed);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 11px;
      color: #fff;
      flex-shrink: 0;
      font-family: 'Plus Jakarta Sans', Manrope, Arial, sans-serif;
      letter-spacing: -0.5px;
    }
    #${MENU_ID} {
      position: absolute;
      top: calc(100% + 10px);
      left: 0;
      background: var(--yt-spec-base-background, #0f0f0f);
      border: 1px solid var(--yt-spec-10-percent-layer, rgba(255,255,255,0.12));
      border-radius: 14px;
      padding: 8px;
      min-width: 220px;
      z-index: 99999;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      display: none;
    }
    #${MENU_ID}.open { display: block; }
    .${ID}-header {
      padding: 6px 12px 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .06em;
      opacity: .5;
      color: var(--yt-spec-text-primary, #fff);
      font-family: Roboto, Arial, sans-serif;
    }
    .${ID}-opt {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 12px;
      border-radius: 8px;
      cursor: pointer;
      font-family: Roboto, Arial, sans-serif;
      font-size: 13px;
      color: var(--yt-spec-text-primary, #fff);
      background: none;
      border: none;
      width: 100%;
      text-align: left;
      transition: background 0.12s;
    }
    .${ID}-opt:hover {
      background: var(--yt-spec-10-percent-layer, rgba(255,255,255,0.1));
    }
    .${ID}-opt-icon { font-size: 17px; width: 22px; text-align: center; }
    .${ID}-opt-text { flex: 1; }
    .${ID}-opt-title { font-weight: 500; }
    .${ID}-opt-sub { font-size: 11px; opacity: .55; margin-top: 1px; }
    .${ID}-sep {
      height: 1px;
      background: var(--yt-spec-10-percent-layer, rgba(255,255,255,0.08));
      margin: 6px 8px;
    }
    #${ID}-toast {
      padding: 10px 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #4ade80;
      font-size: 13px;
      font-family: Roboto, Arial, sans-serif;
      font-weight: 500;
    }
    #${ID}-toast svg { flex-shrink: 0; }
    .${ID}-progress-wrap {
      padding: 10px 14px 12px;
      min-width: 220px;
    }
    .${ID}-progress-phase {
      font-size: 13px;
      font-weight: 600;
      font-family: Roboto, Arial, sans-serif;
      color: var(--yt-spec-text-primary, #fff);
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .${ID}-progress-right {
      font-size: 11px;
      opacity: .65;
      font-weight: 400;
    }
    .${ID}-progress-track {
      height: 4px;
      background: rgba(255,255,255,0.12);
      border-radius: 2px;
      overflow: hidden;
    }
    .${ID}-progress-bar {
      height: 100%;
      background: var(--sipliy-p, #a078ff);
      border-radius: 2px;
      width: 0%;
      transition: width 0.35s ease;
      transform-origin: left;
    }
    .${ID}-progress-bar.indeterminate {
      width: 22% !important;
      animation: ${ID}-slide 1.4s linear infinite;
      transition: none;
    }
    .${ID}-progress-bar.processing {
      width: 100% !important;
      animation: ${ID}-pulse 1.1s ease-in-out infinite;
      transition: none;
    }
    @keyframes ${ID}-slide {
      0% { transform: translateX(-200%); }
      100% { transform: translateX(600%); }
    }
    @keyframes ${ID}-pulse {
      0%, 100% { opacity: .45; }
      50% { opacity: 1; }
    }
  `;

  /* ── helpers ─────────────────────────────────────────── */
  function injectCSS() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function getAccentColor() {
    // Read synced accent from storage
    try {
      chrome.storage.local.get('sipliyAccent', d => {
        if (d && d.sipliyAccent) {
          document.documentElement.style.setProperty('--sipliy-p', d.sipliyAccent);
        }
      });
    } catch (_) {}
  }

  /* ── button + dropdown ───────────────────────────────── */
  let menuOpen = false;
  let _progTimer = null;

  function showYtProgress(menu, jobId) {
    clearTimeout(_progTimer);

    function renderBar(phase, pct, cls, rightText, color) {
      menu.innerHTML = `
        <div class="${ID}-progress-wrap">
          <div class="${ID}-progress-phase">
            <span style="color:${color || 'var(--yt-spec-text-primary,#fff)'}">${phase}</span>
            <span class="${ID}-progress-right">${rightText || ''}</span>
          </div>
          <div class="${ID}-progress-track">
            <div class="${ID}-progress-bar ${cls}" style="width:${pct}%"></div>
          </div>
        </div>`;
    }

    function poll() {
      chrome.runtime.sendMessage({ type: 'get-media-job', jobId }, resp => {
        if (!resp || !resp.ok) {
          _progTimer = setTimeout(poll, 2000);
          return;
        }
        const job = resp.job;
        if (!job) {
          renderBar('Загружено! ✓', 100, '', '', '#4ade80');
          setTimeout(() => { menu.classList.remove('open'); menuOpen = false; }, 1200);
          return;
        }
        const mp = job.progress || 0;
        const isPrep = job.status === 'starting' || (job.status === 'active' && mp === 0);
        const isProc = job.status === 'processing';
        const isDone = job.status === 'complete';
        const isErr  = job.status === 'error';

        let phase = job.streamLabel || '';
        let barCls = '';
        let barPct = mp;
        let color = '';
        let right = '';

        if (isProc)      { phase = 'Слияние файлов...'; barCls = 'processing'; barPct = 100; }
        else if (isPrep) { phase = phase || 'Подготовка...'; barCls = 'indeterminate'; }
        else if (isDone) { phase = 'Загружено! ✓'; barPct = 100; color = '#4ade80'; }
        else if (isErr)  { phase = 'Ошибка'; barPct = 0; color = '#ff6b6b'; }
        else             { phase = phase || mp + '%'; right = [job.speed, job.eta].filter(Boolean).join(' · '); }

        renderBar(phase, barPct, barCls, right, color);

        if (isDone) {
          setTimeout(() => { menu.classList.remove('open'); menuOpen = false; }, 1200);
        } else if (isErr || job.status === 'cancelled') {
          setTimeout(() => { menu.classList.remove('open'); menuOpen = false; }, 2200);
        } else {
          _progTimer = setTimeout(poll, 1500);
        }
      });
    }

    renderBar('Подготовка...', 0, 'indeterminate', '', '');
    poll();
  }

  function removeButton() {
    const w = document.getElementById(BTN_ID + '-wrap');
    if (w) w.remove();
  }

  function createButton() {
    if (document.getElementById(BTN_ID)) return;

    // Find YouTube's action bar — try multiple selectors for robustness
    const actionBar =
      document.querySelector('#actions #top-level-buttons-computed') ||
      document.querySelector('#actions-inner #top-level-buttons-computed') ||
      document.querySelector('ytd-video-primary-info-renderer #top-level-buttons-computed');

    if (!actionBar) return;

    /* wrapper (keeps button+menu together for positioning) */
    const wrap = document.createElement('div');
    wrap.id = BTN_ID + '-wrap';
    wrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;';

    /* main button */
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.title = 'Скачать на VPS (Sipliy Folder)';
    btn.innerHTML = `
      <span class="${ID}-logo">S</span>
      <span>VPS</span>
    `;

    /* dropdown */
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.innerHTML = `
      <div class="${ID}-header">Sipliy Folder VPS</div>
      <button class="${ID}-opt" data-mode="video" data-quality="1080">
        <span class="${ID}-opt-icon">🎬</span>
        <div class="${ID}-opt-text">
          <div class="${ID}-opt-title">Видео 1080p</div>
          <div class="${ID}-opt-sub">Full HD · MP4</div>
        </div>
      </button>
      <button class="${ID}-opt" data-mode="video" data-quality="720">
        <span class="${ID}-opt-icon">📺</span>
        <div class="${ID}-opt-text">
          <div class="${ID}-opt-title">Видео 720p</div>
          <div class="${ID}-opt-sub">HD · MP4</div>
        </div>
      </button>
      <button class="${ID}-opt" data-mode="best" data-quality="">
        <span class="${ID}-opt-icon">✨</span>
        <div class="${ID}-opt-text">
          <div class="${ID}-opt-title">Максимальное качество</div>
          <div class="${ID}-opt-sub">Лучший формат без ограничений</div>
        </div>
      </button>
      <div class="${ID}-sep"></div>
      <button class="${ID}-opt" data-mode="audio" data-quality="">
        <span class="${ID}-opt-icon">🎵</span>
        <div class="${ID}-opt-text">
          <div class="${ID}-opt-title">Только аудио</div>
          <div class="${ID}-opt-sub">MP3 · лучшее качество</div>
        </div>
      </button>
    `;

    /* button click — open/close dropdown */
    btn.addEventListener('click', e => {
      e.stopPropagation();
      menuOpen = !menuOpen;
      menu.classList.toggle('open', menuOpen);
    });

    /* option clicks */
    menu.querySelectorAll('.' + ID + '-opt').forEach(opt => {
      opt.addEventListener('click', e => {
        e.stopPropagation();
        const url = location.href;
        const mode = opt.dataset.mode;
        const quality = opt.dataset.quality || '';

        // Show sending state immediately
        menu.innerHTML = `
          <div id="${ID}-toast" style="color:var(--yt-spec-text-primary,#fff)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--sipliy-p,#a078ff)" style="flex-shrink:0;animation:${ID}-pulse 1s ease-in-out infinite"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
            Запуск...
          </div>`;

        chrome.runtime.sendMessage({ type: 'yt-download', url, mode, quality }, resp => {
          if (resp && resp.ok && resp.job && resp.job.id) {
            showYtProgress(menu, resp.job.id);
          } else {
            menu.innerHTML = resp && resp.ok
              ? `<div id="${ID}-toast"><svg width="16" height="16" viewBox="0 0 24 24" fill="#4ade80"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>Отправлено на VPS!</div>`
              : `<div id="${ID}-toast" style="color:#ff6b6b">✕ ${(resp && resp.error) || 'Ошибка'}</div>`;
            setTimeout(() => { menu.classList.remove('open'); menuOpen = false; }, 1600);
          }
        });
      });
    });

    /* close on outside click */
    document.addEventListener('click', () => {
      if (menuOpen) { menu.classList.remove('open'); menuOpen = false; }
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    actionBar.appendChild(wrap);

    getAccentColor();
  }

  /* ── injection loop ──────────────────────────────────── */
  function tryInject() {
    if (!location.pathname.startsWith('/watch')) { removeButton(); return; }
    injectCSS();
    createButton();
  }

  // MutationObserver — YouTube SPA constantly rewrites DOM
  const obs = new MutationObserver(tryInject);

  function start() {
    tryInject();
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // YouTube SPA fires this on every page navigation
  document.addEventListener('yt-navigate-finish', () => {
    removeButton();
    menuOpen = false;
    setTimeout(tryInject, 600);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
