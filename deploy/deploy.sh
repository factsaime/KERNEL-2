#!/usr/bin/env bash
# Run ON THE SERVER as root, after the project is copied to /opt/kernel.
# Installs an isolated systemd service (kernel) + its own nginx site.
#
#   PUBLIC_PORT=8088 bash /opt/kernel/deploy/deploy.sh
#
# End-to-end encryption needs a secure context: browsers only expose Web Crypto
# over HTTPS (or on localhost). Serving plain HTTP keeps the app usable but the
# client will refuse to encrypt and shows "шифрование недоступно".
#
# To enable HTTPS, point the script at a certificate:
#
#   TLS_CERT=/etc/letsencrypt/live/example.com/fullchain.pem \
#   TLS_KEY=/etc/letsencrypt/live/example.com/privkey.pem \
#   PUBLIC_PORT=8443 bash /opt/kernel/deploy/deploy.sh
#
# With SELF_SIGNED=1 and no certificate given, a self-signed one is generated
# (browsers warn once; the page is still a secure context afterwards).
set -euo pipefail

APP_DIR=/opt/kernel
PUBLIC_PORT="${PUBLIC_PORT:-8088}"   # nginx listens here
INNER_PORT="${INNER_PORT:-18050}"    # gunicorn, localhost only
TLS_CERT="${TLS_CERT:-}"
TLS_KEY="${TLS_KEY:-}"
SELF_SIGNED="${SELF_SIGNED:-0}"

if [ -z "$TLS_CERT" ] && [ "$SELF_SIGNED" = "1" ]; then
  TLS_DIR=/etc/nginx/kernel-tls
  mkdir -p "$TLS_DIR"
  if [ ! -f "$TLS_DIR/cert.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
      -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
      -subj "/CN=$(hostname -I | awk '{print $1}')"
  fi
  TLS_CERT="$TLS_DIR/cert.pem"
  TLS_KEY="$TLS_DIR/key.pem"
fi

if [ -n "$TLS_CERT" ] && [ ! -r "$TLS_CERT" ]; then
  echo "certificate not readable: $TLS_CERT"; exit 1
fi
if [ -n "$TLS_KEY" ] && [ ! -r "$TLS_KEY" ]; then
  echo "key not readable: $TLS_KEY"; exit 1
fi

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
# Set to 1 when this site is served over HTTPS, so the session cookie is
# never sent in the clear.
Environment=KERNEL_SECURE_COOKIE=$([ -n "$TLS_CERT" ] && echo 1 || echo 0)

[Install]
WantedBy=multi-user.target
UNIT

if [ -n "$TLS_CERT" ]; then
  cat > /etc/nginx/sites-available/kernel <<NGINX
server {
    listen $PUBLIC_PORT ssl;
    server_name _;
    ssl_certificate     $TLS_CERT;
    ssl_certificate_key $TLS_KEY;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:$INNER_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
else
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
fi

ln -sf /etc/nginx/sites-available/kernel /etc/nginx/sites-enabled/kernel

systemctl daemon-reload
systemctl enable --now kernel
systemctl restart kernel
nginx -t && systemctl reload nginx

SCHEME=$([ -n "$TLS_CERT" ] && echo https || echo http)
if [ "$SCHEME" = "http" ]; then
  echo "WARNING: served over HTTP, so browsers will not offer Web Crypto."
  echo "         The messenger will refuse to send messages. Use TLS_CERT/TLS_KEY"
  echo "         or SELF_SIGNED=1 to enable encryption."
fi
echo "done: $SCHEME://$(hostname -I | awk '{print $1}'):$PUBLIC_PORT"
