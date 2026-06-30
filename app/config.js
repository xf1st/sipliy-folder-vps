const path = require('path');

const PORT = 3000;
const SITE_VERSION = '2.21.0';
const ARIA2_URL = 'http://localhost:6800/jsonrpc';
const ARIA2_TOKEN = 'mySecretToken123';
const DOWNLOADS_ROOT = '/var/downloads';

// VirusTotal
const VT_API = 'https://www.virustotal.com/api/v3';
const VT_API_KEY = '93c0c934a298f0f35b0f95be051de5b4e4ea7340fa3c7bb8fd5c1f572a13c2b8';

// Telegram
const TG_TOKEN = '8981938565:AAGrVbZwhuuw_AEFauvwr4tWVVhOgUCHNQ4';
const TG_BOT_NAME = 'SiplyiFolderUpload_bot';

// File Paths
const BASE_DIR = '/opt/vps-downloader';
const SHARES_FILE = path.join(BASE_DIR, 'shares.json');
const MEDIA_JOBS_FILE = path.join(BASE_DIR, 'media-jobs.json');
const TOKENS_FILE = path.join(BASE_DIR, 'tokens.json');
const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json');
const YTDLP_COOKIES_FILE = path.join(BASE_DIR, 'yt-cookies.txt');
const TG_USERS_FILE = path.join(BASE_DIR, 'tg-users.json');
const USERS_FILE = path.join(BASE_DIR, 'users.json');
const SECRET_FILE = path.join(BASE_DIR, 'session-secret.txt');
const UPLOADS_FILE = path.join(BASE_DIR, 'uploads.json');
const ACTIVITY_FILE = path.join(BASE_DIR, 'activity.json');
const VAPID_FILE = path.join(BASE_DIR, 'vapid.json');
const PUSH_SUBS_FILE = path.join(BASE_DIR, 'push-subs.json');
const MEDIA_CACHE_DIR = path.join(BASE_DIR, 'media-cache');

// Upload permissions
const FORBIDDEN_UPLOAD_EXT = new Set(['.html', '.htm', '.svg', '.xhtml', '.xml', '.js', '.mjs']);

function getUserCookiesPath(username) {
  if (!username) return YTDLP_COOKIES_FILE;
  return path.join(BASE_DIR, `yt-cookies-${username}.txt`);
}

module.exports = {
  PORT,
  SITE_VERSION,
  ARIA2_URL,
  ARIA2_TOKEN,
  DOWNLOADS_ROOT,
  VT_API,
  VT_API_KEY,
  TG_TOKEN,
  TG_BOT_NAME,
  BASE_DIR,
  SHARES_FILE,
  MEDIA_JOBS_FILE,
  TOKENS_FILE,
  SETTINGS_FILE,
  YTDLP_COOKIES_FILE,
  TG_USERS_FILE,
  USERS_FILE,
  SECRET_FILE,
  UPLOADS_FILE,
  ACTIVITY_FILE,
  VAPID_FILE,
  PUSH_SUBS_FILE,
  MEDIA_CACHE_DIR,
  FORBIDDEN_UPLOAD_EXT,
  getUserCookiesPath,
};
