# Sipliy Folder VPS

Личный менеджер загрузок на базе VPS. Закидываешь ссылку — сервер качает на скорости 1 Гбит/с, потом забираешь файл себе на ПК прямо из браузера. Дополнительно есть браузерное расширение для Chrome и Edge — правый клик по ссылке и файл уже качается.

![Node.js](https://img.shields.io/badge/Node.js-Express-green)
![aria2](https://img.shields.io/badge/aria2c-download_engine-blue)
![Manifest V3](https://img.shields.io/badge/Extension-Manifest_V3-orange)

---

## Возможности

- **Веб-интерфейс** — добавление загрузок по ссылке (HTTP/HTTPS/magnet), прогресс в реальном времени, пауза/возобновление
- **Файловый менеджер** — просмотр, поиск, переименование, удаление, загрузка файлов на сервер (drag & drop)
- **Публичные ссылки** — генерация временных ссылок для отдачи файлов без авторизации
- **Браузерное расширение** — правый клик по ссылке/картинке/видео → скачать на VPS, авто-скачивание на ПК по готовности
- **VirusTotal проверка** — хэш-проверка и загрузка файлов до 32 МБ
- **Push-уведомления** — браузерный push когда файл докачался
- **Тёмная тема** — переключатель в интерфейсе, запоминает выбор
- **Мультипользователь** — отдельные папки для каждого пользователя
- **Авто-удаление** — настраиваемое (1/3/7/30 дней или никогда)
- **HTTPS** — Let's Encrypt с авто-продлением

---

## Стек

| Компонент | Технология |
|-----------|-----------|
| Сервер | Node.js + Express |
| Движок загрузок | aria2c (JSON-RPC) |
| Авторизация | express-session + session-file-store |
| Загрузка файлов | multer |
| Веб-сервер/прокси | nginx + Let's Encrypt |
| Стили | Tailwind CSS CDN + CSS custom properties |
| Анимации | Motion One (vanilla Framer Motion) |
| Расширение | Chrome/Edge Manifest V3 |

---

## Структура проекта

```
├── app/
│   ├── server.js          # Основное Express-приложение
│   ├── gen-favicon.js     # Генератор PNG-фавиконок
│   └── public/            # Статика (favicon, webmanifest) — генерируется
│
├── extension/
│   ├── manifest.json      # Манифест MV3
│   ├── background.js      # Service worker: контекст-меню, опрос, авто-загрузка
│   ├── popup.html         # UI попапа
│   ├── popup.js           # Логика попапа
│   ├── welcome.html       # Страница-инструкция при установке
│   ├── gen-icons.js       # Генератор иконок расширения
│   └── icons/             # PNG иконки 16/32/48/128px
│
├── setup.sh               # Bash-скрипт установки на VPS
├── deploy.js              # Node.js деплой через SSH (ssh2)
├── package.json
└── .gitignore
```

---

## Установка на VPS

### Требования

- Ubuntu 22.04 / 24.04
- Node.js 18+
- nginx
- aria2

### Быстрый деплой

1. **Клонируй репозиторий** на локальный компьютер:
   ```bash
   git clone https://github.com/<твой-юзер>/sipliy-folder-vps.git
   cd sipliy-folder-vps
   npm install
   ```

2. **Настрой параметры подключения** — создай файл `deploy.config.js` (он в `.gitignore`):
   ```js
   // deploy.config.js — не коммитить!
   module.exports = {
     host: 'YOUR_VPS_IP',   // IP твоего VPS
     port: 22,
     username: 'root',
     password: 'твой_пароль',
   };
   ```

3. **Запусти деплой:**
   ```bash
   node deploy.js
   ```
   Скрипт подключится по SSH, загрузит `setup.sh` и выполнит полную установку.

### Что делает `setup.sh`

- Устанавливает `aria2`, `nodejs`, `npm`, `nginx`, `certbot`
- Создаёт системный сервис `vps-downloader` (автозапуск)
- Копирует приложение в `/opt/vps-downloader/`
- Создаёт папку `/var/downloads/` с нужными правами
- Настраивает nginx как прокси на порт 3000
- Запускает aria2c как фоновый демон

### Настройка HTTPS (после деплоя)

```bash
# SSH на сервер
ssh root@YOUR_VPS_IP

# Замени на свой домен
certbot --nginx -d sipliyfolder.ru -d www.sipliyfolder.ru
```

Авто-продление через systemd timer настраивается автоматически certbot'ом.

---

## Конфигурация

Основные константы в `app/server.js`:

```js
const PORT          = 3000;
const ARIA2_URL     = 'http://localhost:6800/jsonrpc';
const ARIA2_TOKEN   = 'mySecretToken123';   // ← изменить
const DOWNLOADS_ROOT = '/var/downloads';

const USERS = {
  admin:  { password: 'admin123',  label: 'Admin' },  // ← изменить пароль
  friend: { password: 'friend123', label: 'Friend' }, // ← изменить пароль
};

const VT_API_KEY = '...'; // API ключ VirusTotal (опционально)
```

> **Важно:** смени пароли пользователей и токен aria2 перед деплоем на публичный сервер.

### Файлы конфигурации на сервере

| Файл | Назначение |
|------|-----------|
| `/opt/vps-downloader/settings.json` | Настройки авто-удаления по пользователям |
| `/opt/vps-downloader/tokens.json` | Токены для браузерного расширения |
| `/opt/vps-downloader/shares.json` | Активные публичные ссылки |
| `/etc/aria2/aria2.conf` | Конфиг aria2c |
| `/etc/nginx/sites-available/sipliyfolder` | nginx конфиг |

---

## Браузерное расширение

### Установка (Chrome / Edge / Brave / Opera)

1. Открой страницу расширений:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Включи **Режим разработчика** (переключатель в правом верхнем углу)
3. Нажми **«Загрузить распакованное»** → выбери папку `extension/`
4. После установки автоматически откроется страница с инструкцией

### Первоначальная настройка расширения

1. Войди в веб-интерфейс → ⚙ **Настройки** → раздел **Токен для расширения** → нажми **Показать** → скопируй токен
2. Кликни на иконку расширения в браузере → введи **URL сервера** и **токен** → **Сохранить**
3. Нажми **«Тест авто-загрузки»** чтобы проверить что авто-скачивание на ПК работает

### Использование

| Действие | Результат |
|----------|-----------|
| Правый клик по ссылке → «Скачать ссылку на VPS» | Файл качается на VPS |
| Правый клик по картинке → «Скачать изображение на VPS» | Картинка качается на VPS |
| Правый клик по видео → «Скачать видео/аудио на VPS» | Медиафайл качается на VPS |
| Файл готов на VPS | Уведомление + авто-загрузка на ПК |
| Иконка расширения → вкладка 📥 Загрузки | Список активных загрузок и готовых файлов |

### Регенерация иконок расширения

```bash
cd extension
node gen-icons.js   # создаёт icons/icon-{16,32,48,128}.png
```

---

## Генерация фавиконок для сайта

```bash
cd app
node gen-favicon.js
# создаёт app/public/favicon.ico, favicon-32.png, favicon-192.png,
#   favicon-512.png, apple-touch-icon.png, site.webmanifest
```

---

## API

Все эндпоинты требуют авторизацию через сессию (cookie) кроме помеченных Bearer.

| Метод | Путь | Описание |
|-------|------|---------|
| `GET` | `/api/downloads` | Список загрузок текущего пользователя |
| `POST` | `/api/add` | Добавить загрузку по URL |
| `DELETE` | `/api/downloads/:gid` | Удалить загрузку |
| `POST` | `/api/downloads/:gid/pause` | Поставить на паузу |
| `POST` | `/api/downloads/:gid/resume` | Возобновить |
| `GET` | `/api/files` | Список скачанных файлов |
| `POST` | `/api/upload` | Загрузить файл на сервер (multipart) |
| `DELETE` | `/api/files/:file` | Удалить файл |
| `GET` | `/api/disk` | Статистика диска |
| `GET` | `/api/vt/:file` | Проверка файла в VirusTotal |
| `POST` | `/api/share` | Создать публичную ссылку |
| `DELETE` | `/api/share/:token` | Отозвать публичную ссылку |
| `POST` | `/api/add-ext` | **[Bearer]** Добавить загрузку из расширения |
| `GET` | `/api/downloads-ext` | **[Bearer]** Активные загрузки для расширения |
| `GET` | `/api/files-ext` | **[Bearer]** Список файлов для расширения |
| `GET` | `/api/ext-dl/:file?t=TOKEN` | Скачать файл по токену (для расширения) |

---

## Лицензия

MIT — делай что хочешь.
