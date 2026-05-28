# Инструкция для продолжения работы в новой сессии Claude

## Контекст проекта

**Sipliy Folder VPS** — файловое хранилище на VPS с веб-интерфейсом и Chrome-расширением.

- **Сайт**: https://sipliyfolder.ru (VPS IP: 77.73.135.98)
- **Главный файл**: `D:\sites\VPS_downloader\app\server.js` (~3800 строк)
- **Деплой**: `node deploy.js` (из папки D:\sites\VPS_downloader)
- **На VPS**: pm2 process `vps-downloader`, файл `/opt/vps-downloader/server.js`

## Что УЖЕ сделано (не трогать)

### Telegram-бот интеграция (добавлена сегодня)
Бот: @SiplyiFolderUpload_bot (токен в TG_TOKEN в server.js)

**Как работает:**
1. Пользователь идёт в Настройки CloudSpace → карточка "Telegram"
2. Нажимает "Подключить Telegram" → открывается `https://t.me/SiplyiFolderUpload_bot?start=TOKEN`
3. Бот получает `/start TOKEN` → проверяет токен → линкует аккаунт
4. Пользователь отправляет файлы боту → они сохраняются в `/var/downloads/{username}/`

**Файлы на VPS:** `/opt/vps-downloader/tg-users.json` — маппинг telegram_id → username

**Ключевые функции в server.js:**
- `tgPoll()` — long-polling Telegram API (запускается на старте сервера)
- `handleTgUpdate(update)` — обработка входящего сообщения
- `tgSend(chatId, text)` — отправка ответа
- `GET /api/tg/status` — статус привязки для веб-UI
- `GET /api/tg/connect-link` — генерирует deep-link для бота
- `POST /api/tg/unlink` — отвязать Telegram

**В cloudPage settings:** карточка "Telegram" с состояниями connected/disconnected
**JS функции в cloudPage:** `loadTelegramStatus()`, `connectTelegram()`, `unlinkTelegram()`

---

## Что НУЖНО сделать (pending задачи)

### 1. Extension popup — кликабельная ссылка
**Файл:** `D:\sites\VPS_downloader\extension\popup.html` и `popup.js`
Где-то в UI попапа показывается URL сервера — нужно сделать его `<a href="...">` кликабельным.
После изменения нужно задеплоить расширение: `node deploy.js ext`

### 2. Редирект / → /cloud
**Файл:** `server.js` строка ~449:
```js
app.get('/', auth, (req, res) => res.send(mainPage(req.session.user)));
```
Заменить на:
```js
app.get('/', auth, (req, res) => res.redirect('/cloud'));
```

### 3. Hash-роутинг в cloudPage
При F5 на `/cloud` пользователь теряет вкладку (например был на Files, после обновления попадает на Dashboard).

**Что нужно:** добавить hash-роутинг `#dashboard`, `#files`, `#recent`, `#activity`, `#settings`

Навигация в cloudPage (строки ~4580-4590 в server.js):
```
nav-dashboard → loadDashboard()  → hash: #dashboard
nav-files     → navigateTo("")   → hash: #files
nav-recent    → loadRecent()     → hash: #recent
nav-activity  → loadActivityLog() → hash: #activity
nav-settings  → loadCloudSettings() → hash: #settings
```

Уже есть функция `parseHash()` и listener `hashchange` (строка ~4802).
Нужно добавить `location.hash = '#dashboard'` и т.д. при каждом nav-переходе.

### 4. Улучшение upload progress
**Файл:** `server.js`, функция `uploadFiles(files)` в cloudPage (~строка 2124 в оригинале, сейчас сместилась)

Сейчас показывает только `%`. Нужно добавить:
- Текущий размер: `1.2 МБ из 5.0 МБ`
- Скорость: `3.4 МБ/с`
- Предупреждение `beforeunload` пока идёт загрузка

### 5. Dashboard cloudPage redesign
Текущий dashboard (`loadDashboard()`) — базовый.
Нужно переоформить под стиль sipliyfolder.ru: hero-секция, статистика (файлов, размер диска), быстрые действия.

---

## Структура server.js — навигация по файлу

| Строки | Что там |
|--------|---------|
| 1–130 | Константы, хелперы, middleware |
| ~55 | TG_TOKEN, TG_BOT_NAME, TG_USERS_FILE, tgPoll() setup |
| 449 | `GET /` → mainPage |
| 449–1240 | Все Express маршруты (API, FM, ext) |
| ~1221 | app.listen |
| ~1222–1285 | tgPoll + handleTgUpdate (telegram polling) |
| ~1290 | File Manager helpers (fmResolve, etc.) |
| 1484 | `GET /cloud` → cloudPage |
| 1657–2609 | `function mainPage(username)` — MD3 светлая тема |
| 2610–конец | `function cloudPage(username)` — Manrope тёмная тема |
| ~3578 | Sidebar cloudPage |
| ~4055–4057 | `loadCloudSettings()` — настройки (две функции, вторая актуальная) |
| ~4062+ | `loadCloudToken()`, `loadTelegramStatus()`, `connectTelegram()` и т.д. |
| ~4580–4600 | Диспетчер action'ов cloudPage |
| ~4802 | Инициализация cloudPage (parseHash, localStorage restore) |

---

## Как редактировать HTML в server.js

Весь HTML — строковая конкатенация. Пример:
```js
'<div class="card">' + someVar + '</div>'
```

В cloudPage функции весь JS встроен как строки:
```js
'function foo(){...}' +
'function bar(){...}' +
```

При редактировании через Edit tool: находите уникальную подстроку и заменяете.

---

## Как деплоить

```bash
cd D:\sites\VPS_downloader

# Задеплоить server.js:
node deploy.js

# Задеплоить расширение (создаёт zip + деплоит):
node deploy.js ext
```

Деплой делает SCP → pm2 restart на VPS 77.73.135.98.

---

## Telegram бот — тестирование

1. Зайти на https://sipliyfolder.ru/cloud
2. Настройки → Telegram → Подключить Telegram
3. Откроется @SiplyiFolderUpload_bot → нажать Start
4. Отправить файл боту → проверить что файл появился в Мои файлы

Команды бота:
- `/start TOKEN` — привязка
- `/status` — статус привязки
- `/disconnect` — отвязать

---

## Важно для понимания кода

- **Нет TypeScript, нет шаблонизаторов** — всё строки в Node.js
- **Tailwind CDN** в mainPage, **inline CSS** в cloudPage
- **aria2 JSON-RPC** на localhost:6800 для загрузок
- **Service Worker может спать** → `chrome.storage.local` как источник истины в расширении
- **Одна сессия на пользователя**, аутентификация через express-session
- Пользователи: `xf1st` (admin, пароль в `/opt/vps-downloader/users.json`)
