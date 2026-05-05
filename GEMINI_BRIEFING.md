# Sipliy Folder VPS — Project Briefing for Gemini

## Что это за проект

**VPS Downloader** — веб-приложение + Chrome-расширение для скачивания файлов прямо на VPS-сервер (канал 1 Гбит/с), после чего файлы доступны через веб-интерфейс.

Публичный адрес: **https://sipliyfolder.ru** (VPS IP: `77.73.135.98`)

---

## Стек

| Компонент | Технология |
|---|---|
| Бэкенд | Node.js (CommonJS) + Express 5, aria2 daemon |
| Рендеринг HTML | Строковая конкатенация внутри функций `mainPage()` / `cloudPage()` (без шаблонизаторов) |
| Стили на сервере | Tailwind CDN (mainPage) + inline CSS (cloudPage) |
| Шрифты | Material Symbols Outlined (иконки), Segoe UI (mainPage), Manrope (cloudPage) |
| Файловые менеджеры | `/api/fm/*` — REST API для менеджера файлов |
| Загрузки с URL | aria2 через JSON-RPC (localhost:6800) |
| Расширение | Chrome MV3 (Manifest V3), service worker |
| Деплой | SSH2 (локальный Node.js скрипт `deploy.js`), SCP + `pm2 restart` |

---

## Структура файлов (локально — Windows, D:\sites\VPS_downloader)

```
D:\sites\VPS_downloader\
├── app\
│   └── server.js          ← ЕДИНСТВЕННЫЙ серверный файл (~3728 строк)
├── extension\
│   ├── manifest.json      ← MV3, версия 2.4.1
│   ├── background.js      ← Service Worker (~574 строк)
│   ├── popup.html         ← UI попапа (~410 строк)
│   ├── popup.js           ← Логика попапа (~893 строк)
│   ├── welcome.html       ← Страница после установки
│   └── icons\
├── package.json
└── deploy.js              ← Деплой через SSH2 на VPS
```

**На VPS (Ubuntu):**
```
/opt/vps-downloader/          ← данные приложения
  ├── users.json              ← пользователи {username: {password, label, isAdmin}}
  ├── tokens.json             ← API-токены расширения
  ├── settings.json           ← настройки (retention)
  ├── shares.json             ← публичные ссылки
  └── public/                 ← статика (сервируется на /static)

/var/downloads/               ← файлы пользователей
  └── {username}/             ← папка каждого юзера

/opt/vps-downloader/app/server.js   ← запущенный сервер
```

Приложение запущено через **pm2** (`pm2 restart vps-downloader`).

---

## server.js — ключевые части

### Основные маршруты

```
GET  /               → mainPage(username)         — Material Design 3, светлая тема
GET  /cloud          → cloudPage(username)        — Manrope, тёмная тема (#131315)
GET  /login          → форма входа
POST /login          → аутентификация
POST /logout
```

### API для веб-UI
```
GET  /api/disk                   → статистика диска
GET  /api/files                  → файлы пользователя (legacy)
GET  /api/downloads              → aria2: active + waiting + stopped
POST /api/add                    → добавить URL в aria2
DEL  /api/downloads/:gid         → удалить загрузку
POST /api/downloads/:gid/pause
POST /api/downloads/:gid/resume
GET  /api/vt/:file               → VirusTotal скан
GET  /download/:file             → скачать файл
POST /api/share                  → создать публичную ссылку
DEL  /api/share/:token
GET  /api/shares
POST /api/upload                 → загрузить файл с ПК → VPS (multer)
DEL  /api/files/:file
GET  /api/mytoken                → получить API-токен расширения
POST /api/mytoken/reset          → сбросить токен
GET  /api/qr                     → QR-код публичной ссылки
```

### Файловый менеджер (cloudPage)
```
GET  /api/fm/list               → список файлов/папок
POST /api/fm/mkdir
POST /api/fm/rename
DEL  /api/fm/delete
POST /api/fm/move
GET  /api/fm/recent             → недавние файлы
GET  /api/fm/search
GET  /api/fm/download           → скачать файл
GET  /api/fm/preview            → превью (изображения, текст, PDF, видео)
GET  /api/fm/meta               → метаданные (размер папки, тип файла)
POST /api/fm/add-url            → добавить URL (aria2 для http/magnet, yt-dlp для медиа)
POST /api/fm/zip                → создать ZIP
POST /api/fm/share              → публичная ссылка на файл
GET  /api/fm/shares
POST /api/fm/upload             → загрузка файла в конкретную папку FM
POST /api/fm/media              → запустить yt-dlp/ffmpeg конвертацию
GET  /api/fm/media-jobs         → прогресс media-задач
DEL  /api/fm/media-jobs/:id
```

### API для расширения (требует Bearer-токена)
```
POST /api/add-ext               → добавить URL с расширения
POST /api/upload-ext            → загрузить файл с расширения
POST /api/purge-errors-ext      → удалить ошибки из aria2 stopped
GET  /api/downloads-ext         → список активных загрузок
GET  /api/files-ext             → готовые файлы
GET  /api/ext/shares            → публичные ссылки
POST /api/ext/share             → создать публичную ссылку
GET  /api/ext/version           → текущая версия расширения
GET  /ext/update                → страница OTA-обновления
GET  /ext/extension.zip         → скачать zip расширения
```

### Вспомогательные функции
```js
function mainPage(username)      // строки 1657–2609 — светлая тема (MD3)
function cloudPage(username)     // строки 2610–3728 — тёмная тема
function auth(req,res,next)      // middleware сессии
function authToken(req,res,next) // middleware Bearer-токена (расширение)
function extCors(req,res,next)   // CORS для ext-API
function userDir(username)       // → /var/downloads/{username}
function fmResolve(username, relPath)  // → абсолютный путь в папке юзера
function aria2(method, params)   // JSON-RPC обёртка
function fmtBytes(b)             // байты → "1.5 GB"
```

---

## mainPage — структура (MD3, светлая, строки 1657–2609)

- **Три вкладки**: Загрузки (`showTab('downloads')`), Готовые файлы (`showTab('files')`), Публичные ссылки (`showTab('shares')`)
- Sidebar слева на десктопе, slide-in на мобиле
- Кнопка перехода на `/cloud` в сайдбаре
- Загрузки: опрос `/api/downloads` каждые 2с, карточки с прогрессбаром
- Загрузка файлов: `uploadFiles(files)` — один XHR на файл, показывает только `%`
- Стили: Tailwind + `HEAD` константа (Material Symbols + Segoe UI + переменные MD3)

---

## cloudPage — структура (Manrope, тёмная, строки 2610–3728)

- **Пять разделов**: Dashboard, Files (FM), Recent, URL History, Settings
- Навигация через `data-action` event delegation:
  ```js
  nav-dashboard → loadDashboard()
  nav-files     → navigateTo("")
  nav-recent    → loadRecent()
  nav-url-history → loadUrlHistory()
  nav-settings  → loadCloudSettings()
  ```
- Текущий путь хранится в `localStorage("fm-path")`, сохраняется через `savePath(p)`
- `setNavActive(action)` обновляет активный пункт меню
- Начальное состояние: `var currentPath = localStorage.getItem("fm-path") || "__dashboard__"`
- Загрузка файлов через `POST /api/fm/upload` (multer), drag-and-drop поддерживается

---

## Chrome-расширение (extension/)

### manifest.json (MV3 v2.4.1)
Permissions: `contextMenus, storage, notifications, downloads, cookies, alarms`
Host: `<all_urls>`

### background.js (~574 строк) — Service Worker
- Контекстное меню: «Скачать ссылку на VPS», «Скачать изображение», «Скачать видео», «Скачать страницу», «Скачать выделенный URL»
- `sendDownload(url, options)` — POST на `/api/add-ext`
- Перехват загрузок браузера: `chrome.downloads.onCreated` → `sendDownload`
- Режимы перехвата:
  - `direct` — aria2 скачивает напрямую с VPS
  - `relay` — браузер скачивает файл, extension отправляет байты через `/api/upload-ext`
- Состояние перехвата хранится в `chrome.storage.local.captureNext` (SW-agnostic)
- OTA-обновление: `chrome.alarms` → проверка `/api/ext/version`

### popup.js (~893 строк)
- `getConfig()` — читает `chrome.storage.local` (serverUrl, token, accountId)
- `refreshCaptureStatus()` — читает `captureNext` из `chrome.storage.local` напрямую (не через SW)
- `startCaptureNextDownload(mode)` — пишет в storage если SW не отвечает (SW может спать)
- `renderDownloads()` — GET `/api/downloads-ext`, рендерит карточки, скрывает nameless errors
- `$('purge-errors-btn')` → POST `/api/purge-errors-ext`
- Кнопки: «Перехватить следующую» (direct), «Через браузер» (relay), «Отмена»

---

## Деплой (deploy.js)

1. Локально: SSH2 → SCP копирует `app/server.js` на VPS
2. `pm2 restart vps-downloader` — перезапуск
3. При деплое расширения: запаковывает `extension/` → ZIP → SCP → доступен на `/ext/extension.zip`

**Как задеплоить:**
```bash
node deploy.js          # деплой server.js
node deploy.js ext      # деплой расширения + zip
```

---

## Аутентификация

- **Веб-UI**: сессии через `express-session` + `session-file-store` (cookie `connect.sid`)
- **Расширение**: Bearer-токен в заголовке `Authorization: Bearer <token>`, хранится в `/opt/vps-downloader/tokens.json`
- Единственный admin-пользователь: `xf1st`

---

## Важные детали разработки

### Как устроен HTML-рендеринг
Весь HTML — строковая конкатенация в `server.js`. Никаких файлов шаблонов. Пример:
```js
return '<div class="card">' + someVar + '</div>';
```
Это значит: менять HTML = менять строки в `server.js`.

### aria2 JSON-RPC
```js
async function aria2(method, params) {
  // POST http://localhost:6800/jsonrpc
  // { jsonrpc:'2.0', method, params:['token:mySecretToken123', ...params] }
}
```
Статусы: `active`, `waiting`, `paused`, `complete`, `error`, `removed`

### CORS для расширения
Все `/api/*-ext` и `/api/ext/*` маршруты имеют `EXT_CORS` заголовки и отдельный `OPTIONS` preflight.

### MV3 Service Worker lifecycle
SW может «уснуть» — `chrome.runtime.sendMessage` вернёт `undefined`. 
**Решение**: `chrome.storage.local` как источник истины для состояния UI (popup читает storage напрямую, не через SW).

---

## Что сейчас в работе (pending задачи)

1. **Extension popup**: сделать ссылку на сайт кликабельной
2. **Server**: `GET /` → redirect на `/cloud` (сделать /cloud главной страницей)
3. **cloudPage hash-роутинг**: `/cloud#files`, `/cloud#dashboard` и т.д., чтобы F5 не сбрасывал вкладку
4. **cloudPage dashboard**: переоформить под стиль sipliyfolder.ru (hero, stats, quick actions)
5. **Upload progress**: показывать MB/GB + скорость (не только %)
6. **beforeunload warning**: предупреждение при уходе со страницы когда идёт загрузка файла

---

## Переменные окружения / конфиги

| Параметр | Значение |
|---|---|
| PORT | 3000 |
| ARIA2_URL | http://localhost:6800/jsonrpc |
| ARIA2_TOKEN | mySecretToken123 |
| DOWNLOADS_ROOT | /var/downloads |
| USERS_FILE | /opt/vps-downloader/users.json |
| TOKENS_FILE | /opt/vps-downloader/tokens.json |
| SETTINGS_FILE | /opt/vps-downloader/settings.json |
| SHARES_FILE | /opt/vps-downloader/shares.json |
| VT_API_KEY | 93c0c934... (VirusTotal) |

---

## Соглашения по коду

- **Без комментариев** (если только не очень неочевидная логика)
- **Без TypeScript** — чистый CommonJS Node.js
- **Без фреймворков на фронтенде** — ванильный JS, DOM-манипуляции
- **Tailwind через CDN** в mainPage, **inline CSS** в cloudPage
- Все страницы — SSR-строки (нет SPA-фреймворков)
- `pm2` управляет процессом на VPS
