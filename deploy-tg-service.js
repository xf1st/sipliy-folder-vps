const { Client } = require('ssh2');

const config = {
  host: '77.73.135.98',
  port: 2222,
  username: 'root',
  password: '0UAxHGujXbxP',
};

const serviceContent = `[Unit]
Description=Telegram Bot API Server
After=docker.service
Requires=docker.service

[Service]
TimeoutStartSec=0
Restart=always
ExecStartPre=-/usr/bin/docker stop telegram-bot-api
ExecStartPre=-/usr/bin/docker rm telegram-bot-api
ExecStart=/usr/bin/docker run --name telegram-bot-api -p 8081:8081 -e TELEGRAM_API_ID=2040 -e TELEGRAM_API_HASH=b18441a1ff607e10a989891a5462e627 -e TELEGRAM_LOCAL=true -v /var/lib/telegram-bot-api:/var/lib/telegram-bot-api evilfreelancer/docker-telegram-bot-api:latest
ExecStop=/usr/bin/docker stop telegram-bot-api

[Install]
WantedBy=multi-user.target
`;

const conn = new Client();

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    console.log(`>>> ${cmd}`);
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', d => {
        stdout += d.toString();
        process.stdout.write(d.toString());
      });
      stream.stderr.on('data', d => {
        stderr += d.toString();
        process.stderr.write(d.toString());
      });
      stream.on('close', code => {
        if (code !== 0) return reject(new Error(`Command failed with code ${code}`));
        resolve({ stdout, stderr });
      });
    });
  });
}

conn.on('ready', async () => {
  console.log('SSH Connected to VPS!');
  try {
    // 1. Remove the test container if it exists
    await exec(conn, 'docker rm -f telegram-bot-api-test || true');
    await exec(conn, 'docker rm -f telegram-bot-api || true');

    // 2. Write systemd service file
    conn.sftp(async (err, sftp) => {
      if (err) throw err;
      console.log('Writing systemd service file to /etc/systemd/system/telegram-bot-api.service...');
      const stream = sftp.createWriteStream('/etc/systemd/system/telegram-bot-api.service', { mode: 0o644 });
      stream.on('error', (err) => {
        console.error('SFTP Write Error:', err);
        conn.end();
      });
      stream.on('close', async () => {
        console.log('Service file written successfully.');
        try {
          // 3. Enable and start the systemd service
          await exec(conn, 'systemctl daemon-reload');
          await exec(conn, 'systemctl enable telegram-bot-api.service');
          await exec(conn, 'systemctl restart telegram-bot-api.service');
          
          // Wait a moment for it to start up
          console.log('Waiting for service to start...');
          await new Promise(r => setTimeout(r, 3000));

          await exec(conn, 'systemctl status telegram-bot-api.service --no-pager');
          await exec(conn, 'docker ps');
          
          // Verify with a curl
          await exec(conn, 'curl -s http://localhost:8081/bot8981938565:AAGrVbZwhuuw_AEFauvwr4tWVVhOgUCHNQ4/getMe');
          
          console.log('\nTG Bot API Service setup complete!');
        } catch (e) {
          console.error('Failed to enable/start service:', e.message);
        } finally {
          conn.end();
        }
      });
      stream.end(serviceContent);
    });
  } catch (e) {
    console.error('Error:', e.message);
    conn.end();
  }
}).connect(config);
