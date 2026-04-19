const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const config = {
  host: 'YOUR_VPS_IP',
  port: 22,
  username: 'root',
  password: '0UAxHGujXbxP',
  readyTimeout: 30000,
};

const setupScript = fs.readFileSync(path.join(__dirname, 'setup.sh'), 'utf8');

function runCommands(conn, commands) {
  return new Promise((resolve, reject) => {
    let idx = 0;

    function next() {
      if (idx >= commands.length) return resolve();
      const cmd = commands[idx++];
      console.log(`\n>>> ${cmd}`);
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        stream.on('data', (d) => process.stdout.write(d.toString()));
        stream.stderr.on('data', (d) => process.stderr.write(d.toString()));
        stream.on('close', (code) => {
          if (code !== 0 && code !== null) {
            console.warn(`[exit ${code}]`);
          }
          next();
        });
      });
    }
    next();
  });
}

function uploadAndRun() {
  const conn = new Client();

  conn.on('ready', async () => {
    console.log('==> SSH подключение установлено');

    // Загружаем скрипт через SFTP
    conn.sftp((err, sftp) => {
      if (err) throw err;

      const writeStream = sftp.createWriteStream('/tmp/setup.sh');
      writeStream.write(setupScript);
      writeStream.end();

      writeStream.on('close', async () => {
        console.log('==> Скрипт загружен на сервер');
        try {
          await runCommands(conn, [
            'chmod +x /tmp/setup.sh',
            'bash /tmp/setup.sh',
            'rm -f /tmp/setup.sh',
          ]);
          console.log('\n==> Деплой завершён!');
        } catch (e) {
          console.error('Ошибка:', e.message);
        } finally {
          conn.end();
        }
      });
    });
  });

  conn.on('error', (err) => {
    console.error('SSH ошибка:', err.message);
  });

  conn.connect(config);
}

uploadAndRun();
