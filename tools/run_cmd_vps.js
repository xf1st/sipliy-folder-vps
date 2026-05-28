const { Client } = require('ssh2');

const config = {
  host: '77.73.135.98',
  port: 2222,
  username: 'root',
  password: '0UAxHGujXbxP',
};

const cmd = process.argv.slice(2).join(' ');
if (!cmd) {
  console.error('Usage: node run_cmd_vps.js <command>');
  process.exit(1);
}

const conn = new Client();
conn.on('ready', () => {
  console.log(`SSH Executing: ${cmd}`);
  conn.exec(cmd, (err, stream) => {
    if (err) throw err;
    stream.on('data', (d) => process.stdout.write(d));
    stream.stderr.on('data', (d) => process.stderr.write(d));
    stream.on('close', (code) => {
      console.log(`\nExit code: ${code}`);
      conn.end();
    });
  });
}).connect(config);
