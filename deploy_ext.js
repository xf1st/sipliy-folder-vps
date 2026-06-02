const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const cfg = require('./deploy.config.js');

const config = { host: cfg.host, port: cfg.port || 22, username: cfg.username, password: cfg.password, readyTimeout: 30000 };
const APP_DIR = cfg.appDir || '/opt/vps-downloader';
const SERVICE = cfg.service || 'vps-downloader';

function uploadFile(sftp, local, remote) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(local);
    const ws = sftp.createWriteStream(remote);
    ws.on('close', resolve); ws.on('error', reject); rs.pipe(ws);
  });
}
function runCommand(conn, cmd) {
  return new Promise((resolve, reject) => {
    console.log(`\n>>> ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      stream.on('data', (d) => process.stdout.write(d.toString()));
      stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
      stream.on('close', (code) => resolve(code));
    });
  });
}

async function deploy() {
  const conn = new Client();
  conn.on('error', (err) => console.error('SSH error:', err.message));
  conn.on('ready', () => {
    console.log('==> SSH подключение установлено');
    conn.sftp(async (err, sftp) => {
      if (err) { conn.end(); throw err; }
      console.log('==> Загружаем файлы...');
      await uploadFile(sftp, path.join(__dirname, 'app/server.js'), `${APP_DIR}/server.js`);
      console.log('==> server.js загружен');
      await uploadFile(sftp, path.join(__dirname, 'extension-build/sipliyfolder-extension-v2.13.0.zip'), `${APP_DIR}/extension.zip`);
      console.log('==> extension.zip загружен');
      sftp.end();
      await runCommand(conn, `pm2 restart ${SERVICE} || pm2 start ${APP_DIR}/server.js --name ${SERVICE}`);
      conn.end();
      console.log('\n==> Деплой завершён!');
    });
  });
  conn.connect(config);
}
deploy();
