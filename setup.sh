#!/bin/bash
# ============================================================
# VPS Downloader Setup: aria2 + AriaNg + nginx
# Ubuntu 24.04
# ============================================================

set -e

DOWNLOAD_DIR="/var/downloads"
ARIA2_RPC_TOKEN="mySecretToken123"   # СМЕНИ НА СВОЙ!
ARIANG_VERSION="1.3.7"

echo "==> Обновляем пакеты..."
apt-get update -y
apt-get install -y nginx aria2 wget unzip curl

echo "==> Создаём папку загрузок..."
mkdir -p "$DOWNLOAD_DIR"
chmod 755 "$DOWNLOAD_DIR"

echo "==> Создаём конфиг aria2..."
mkdir -p /etc/aria2
mkdir -p /var/log/aria2

cat > /etc/aria2/aria2.conf << EOF
# Директория загрузок
dir=$DOWNLOAD_DIR

# Логи
log=/var/log/aria2/aria2.log
log-level=warn

# RPC
enable-rpc=true
rpc-listen-all=true
rpc-listen-port=6800
rpc-secret=$ARIA2_RPC_TOKEN
rpc-allow-origin-all=true

# Производительность
max-concurrent-downloads=5
continue=true
max-connection-per-server=16
min-split-size=1M
split=16

# Торренты
enable-dht=true
bt-enable-lpd=true
listen-port=6881-6999
dht-listen-port=6881-6999

# Сессия (возобновление после перезапуска)
save-session=/etc/aria2/aria2.session
input-file=/etc/aria2/aria2.session
save-session-interval=30
EOF

touch /etc/aria2/aria2.session

echo "==> Создаём systemd сервис для aria2..."
cat > /etc/systemd/system/aria2.service << EOF
[Unit]
Description=aria2 Download Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/aria2c --conf-path=/etc/aria2/aria2.conf
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable aria2
systemctl start aria2

echo "==> Загружаем AriaNg..."
mkdir -p /var/www/ariang
cd /tmp
wget -q "https://github.com/mayswind/AriaNg/releases/download/${ARIANG_VERSION}/AriaNg-${ARIANG_VERSION}-AllInOne.zip" -O ariang.zip
unzip -o ariang.zip -d /var/www/ariang/
rm ariang.zip
chmod -R 755 /var/www/ariang

echo "==> Настраиваем nginx..."
cat > /etc/nginx/sites-available/downloader << 'EOF'
server {
    listen 80;
    server_name _;

    # AriaNg UI
    location / {
        root /var/www/ariang;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # aria2 RPC proxy
    location /jsonrpc {
        proxy_pass http://127.0.0.1:6800/jsonrpc;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        add_header Access-Control-Allow-Origin *;
    }

    # Файловый сервер для скачивания готовых файлов
    location /files {
        alias /var/downloads;
        autoindex on;
        autoindex_exact_size off;
        autoindex_localtime on;
        charset utf-8;

        # Базовая авторизация
        auth_basic "Downloads";
        auth_basic_user_file /etc/nginx/.htpasswd;
    }
}
EOF

# Убираем дефолтный сайт
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/downloader /etc/nginx/sites-enabled/downloader

echo "==> Создаём пароль для файлового сервера..."
# Пароль: downloads123 (сгенерированный htpasswd без openssl)
HTPASSWD_USER="admin"
HTPASSWD_PASS="downloads123"
HTPASSWD_HASH=$(python3 -c "import crypt; print(crypt.crypt('$HTPASSWD_PASS', crypt.mksalt(crypt.METHOD_SHA512)))")
echo "${HTPASSWD_USER}:${HTPASSWD_HASH}" > /etc/nginx/.htpasswd

echo "==> Открываем порты в firewall (ufw)..."
ufw allow 80/tcp 2>/dev/null || true
ufw allow 6881:6999/tcp 2>/dev/null || true
ufw allow 6881:6999/udp 2>/dev/null || true

echo "==> Перезапускаем nginx..."
nginx -t && systemctl restart nginx

echo ""
echo "============================================================"
echo " ГОТОВО! Веб-качалка запущена."
echo "============================================================"
echo ""
echo " Веб-интерфейс (AriaNg):  http://YOUR_VPS_IP/"
echo " Скачать файлы:            http://YOUR_VPS_IP/files/"
echo ""
echo " Настройки подключения AriaNg:"
echo "   RPC адрес:  YOUR_VPS_IP"
echo "   RPC порт:   6800"
echo "   RPC путь:   /jsonrpc"
echo "   RPC токен:  $ARIA2_RPC_TOKEN"
echo ""
echo " Файловый сервер /files:"
echo "   Логин:   admin"
echo "   Пароль:  downloads123"
echo ""
echo " ВАЖНО: Смени токен и пароль!"
echo "============================================================"
