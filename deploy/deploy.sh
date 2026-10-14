#!/usr/bin/env bash
# Run ON THE SERVER as root, after the project is copied to /opt/kernel.
# Installs an isolated systemd service (kernel) + its own nginx site.
# Usage: PUBLIC_PORT=8088 bash /opt/kernel/deploy/deploy.sh
set -euo pipefail

APP_DIR=/opt/kernel
PUBLIC_PORT="${PUBLIC_PORT:-8088}"   # nginx listens here (browser: http://SERVER_IP:PUBLIC_PORT)
INNER_PORT="${INNER_PORT:-18050}"    # gunicorn, localhost only

for p in "$PUBLIC_PORT" "$INNER_PORT"; do
  if ss -ltn "sport = :$p" | grep -q LISTEN && ! systemctl is-active --quiet kernel; then
    echo "port $p is already used by another project - pick another (PUBLIC_PORT=... INNER_PORT=...)"; exit 1
  fi
done

command -v nginx >/dev/null || { apt-get update -y && apt-get install -y nginx; }
apt-get install -y python3-venv >/dev/null

cd "$APP_DIR"
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
chown -R www-data:www-data "$APP_DIR"

cat > /etc/systemd/system/kernel.service <<UNIT
[Unit]
Description=Kernel messenger
After=network.target

[Service]
User=www-data
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/gunicorn -w 1 --threads 8 -b 127.0.0.1:$INNER_PORT app:app
Restart=always

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/nginx/sites-available/kernel <<NGINX
server {
    listen $PUBLIC_PORT;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:$INNER_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/kernel /etc/nginx/sites-enabled/kernel

systemctl daemon-reload
systemctl enable --now kernel
systemctl restart kernel
nginx -t && systemctl reload nginx
echo "done: http://$(hostname -I | awk '{print $1}'):$PUBLIC_PORT"
