const { Client } = require('ssh2');

const config = {
  host: '77.73.135.98',
  port: 2222,
  username: 'root',
  password: '0UAxHGujXbxP',
};

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH Connected!');
  conn.exec('uname -a && lsb_release -a && arch && which telegram-bot-api', (err, stream) => {
    if (err) throw err;
    stream.on('data', (d) => process.stdout.write(d));
    stream.stderr.on('data', (d) => process.stderr.write(d));
    stream.on('close', () => conn.end());
  });
}).connect(config);
