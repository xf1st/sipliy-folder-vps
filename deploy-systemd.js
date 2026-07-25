const { Client } = require('ssh2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = __dirname;

let localConfig = {};
try {
  const configPath = path.join(root, 'deploy.config.js');
  if (fs.existsSync(configPath)) {
    localConfig = require(configPath);
  }
} catch (e) {
  console.warn('Предупреждение при загрузке deploy.config.js:', e.message);
}

const config = {
  host: process.env.DEPLOY_HOST || localConfig.host || '77.73.135.98',
  port: Number(process.env.DEPLOY_PORT || localConfig.port || 22),
  username: process.env.DEPLOY_USER || localConfig.username || 'root',
  password: process.env.DEPLOY_PASSWORD || localConfig.password,
  appDir: process.env.DEPLOY_APP_DIR || localConfig.appDir || '/opt/vps-downloader',
  service: process.env.DEPLOY_SERVICE || localConfig.service || 'vps-downloader',
  readyTimeout: 30000,
};

if (!config.password) {
  console.error('Ошибка: Пароль для деплоя не найден. Задайте переменную окружения DEPLOY_PASSWORD или создайте файл deploy.config.js с паролем.');
  process.exit(1);
}
const tmpZip = path.join(os.tmpdir(), `sipliyfolder-extension-${Date.now()}.zip`);

function mustRead(file) {
  return fs.readFileSync(path.join(root, file));
}

function runLocal(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} failed: ${(res.stderr || res.stdout || '').trim()}`);
  }
  return res.stdout;
}

function buildExtensionZip() {
  if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
  const extDir = path.join(root, 'extension');
  if (process.platform === 'win32') {
    runLocal('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Compress-Archive -Path "${extDir}\\*" -DestinationPath "${tmpZip}" -Force`,
    ]);
  } else {
    runLocal('python3', ['-m', 'zipfile', '-c', tmpZip, '.'], { cwd: extDir });
  }
  if (!fs.existsSync(tmpZip) || fs.statSync(tmpZip).size < 1024) {
    throw new Error('extension.zip was not created');
  }
  return tmpZip;
}

function uploadBuffer(sftp, remotePath, buffer) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath, { mode: 0o644 });
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.end(buffer);
  });
}

function uploadFile(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, { mode: 0o644 }, err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function exec(conn, cmd, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n>>> ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', d => {
        const s = d.toString();
        stdout += s;
        process.stdout.write(s);
      });
      stream.stderr.on('data', d => {
        const s = d.toString();
        stderr += s;
        process.stderr.write(s);
      });
      stream.on('close', code => {
        if (code && !allowFail) return reject(new Error(`Command failed (${code}): ${cmd}\n${stderr || stdout}`));
        resolve({ code, stdout, stderr });
      });
    });
  });
}

async function deploy() {
  const extensionZip = buildExtensionZip();
  const serverJs = mustRead(path.join('app', 'server.js'));
  const packageJson = mustRead('package.json');
  const packageLock = mustRead('package-lock.json');

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve);
    conn.on('error', reject);
    conn.connect(config);
  });

  try {
    console.log('==> SSH connected');
    await exec(conn, `mkdir -p ${config.appDir}`);

    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, s) => err ? reject(err) : resolve(s));
    });

    console.log('==> Uploading app files, package files, .env, extension.zip');
    const appDirLocal = path.join(root, 'app');
    const appFiles = fs.readdirSync(appDirLocal).filter(f => f.endsWith('.js'));
    for (const file of appFiles) {
      const content = fs.readFileSync(path.join(appDirLocal, file));
      await uploadBuffer(sftp, `${config.appDir}/${file}`, content);
      console.log(`    Uploaded ${file}`);
    }

    const localEnv = path.join(root, '.env');
    const localEnvExample = path.join(root, '.env.example');
    if (fs.existsSync(localEnv)) {
      await uploadBuffer(sftp, `${config.appDir}/.env`, fs.readFileSync(localEnv));
      console.log('    Uploaded .env');
    } else if (fs.existsSync(localEnvExample)) {
      await uploadBuffer(sftp, `${config.appDir}/.env`, fs.readFileSync(localEnvExample));
      console.log('    Uploaded .env from .env.example');
    }

    await uploadBuffer(sftp, `${config.appDir}/package.json`, packageJson);
    await uploadBuffer(sftp, `${config.appDir}/package-lock.json`, packageLock);
    await uploadFile(sftp, extensionZip, `${config.appDir}/extension.zip`);

    await exec(conn, `chmod 600 ${config.appDir}/.env 2>/dev/null || true`);
    await exec(conn, `cd ${config.appDir} && npm ci --omit=dev`);
    await exec(conn, `cd ${config.appDir} && node --check server.js`);

    if (process.env.DELETE_OPENCLAW === '1') {
      await exec(conn, `find / -xdev -iname '*openclaw*' -maxdepth 4 -print 2>/dev/null`, { allowFail: true });
      await exec(conn, `find /opt /root /tmp /var -xdev -maxdepth 4 -iname '*openclaw*' -exec rm -rf {} + 2>/dev/null`, { allowFail: true });
    }

    await exec(conn, `systemctl restart ${config.service}`);
    await exec(conn, `systemctl status ${config.service} --no-pager -n 20`);
    console.log('\n==> Deploy complete');
  } finally {
    conn.end();
    fs.rmSync(extensionZip, { force: true });
  }
}

deploy().catch(err => {
  console.error('\nDeploy failed:', err.message);
  process.exitCode = 1;
});
