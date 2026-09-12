#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/opensips-sbc-ui}"
BACKEND_PORT="${BACKEND_PORT:-3000}"
SELF_SIGNED="${SELF_SIGNED:-false}"
BASIC_AUTH_USER="${BASIC_AUTH_USER:-}"
BASIC_AUTH_PASSWORD="${BASIC_AUTH_PASSWORD:-}"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this script as root, for example: sudo DOMAIN=sbc.example.com EMAIL=admin@example.com bash scripts/install-https-nginx.sh"
  exit 1
fi

if [[ -z "$DOMAIN" ]]; then
  echo "Set DOMAIN, for example: DOMAIN=sbc.example.com"
  exit 1
fi

if [[ "$SELF_SIGNED" != "true" && -z "$EMAIL" ]]; then
  echo "Set EMAIL for Let's Encrypt, or set SELF_SIGNED=true for a private certificate."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

apt-get update
apt-get install -y nginx nodejs npm rsync

if [[ "$SELF_SIGNED" != "true" ]]; then
  apt-get install -y certbot python3-certbot-nginx
else
  apt-get install -y openssl
fi

id -u opensips-sbc-ui >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin opensips-sbc-ui

mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude node_modules \
  --exclude backend/dist \
  --exclude frontend/dist \
  "$PROJECT_DIR/" "$APP_DIR/"

chown -R opensips-sbc-ui:opensips-sbc-ui "$APP_DIR"

if [[ ! -f "$APP_DIR/backend/.env" ]]; then
  cp "$APP_DIR/backend/.env.example" "$APP_DIR/backend/.env"
  chmod 600 "$APP_DIR/backend/.env"
  chown opensips-sbc-ui:opensips-sbc-ui "$APP_DIR/backend/.env"
  echo "Created $APP_DIR/backend/.env. Edit it with DB and MI settings, then rerun this script."
  exit 1
fi

if grep -q "^PORT=" "$APP_DIR/backend/.env"; then
  sed -i "s/^PORT=.*/PORT=$BACKEND_PORT/" "$APP_DIR/backend/.env"
else
  echo "PORT=$BACKEND_PORT" >> "$APP_DIR/backend/.env"
fi

runuser -u opensips-sbc-ui -- npm --prefix "$APP_DIR" install
runuser -u opensips-sbc-ui -- npm --prefix "$APP_DIR" run build

mkdir -p /var/www/html

if [[ "$SELF_SIGNED" == "true" ]]; then
  mkdir -p "/etc/letsencrypt/live/$DOMAIN"
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "/etc/letsencrypt/live/$DOMAIN/privkey.pem" \
    -out "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" \
    -subj "/CN=$DOMAIN"
else
  cat > /etc/nginx/sites-available/opensips-sbc-ui-bootstrap.conf <<BOOTSTRAP_NGINX
server {
    listen 80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 200 "OpenSIPS SBC UI certificate bootstrap\n";
    }
}
BOOTSTRAP_NGINX
  ln -sfn /etc/nginx/sites-available/opensips-sbc-ui-bootstrap.conf /etc/nginx/sites-enabled/opensips-sbc-ui-bootstrap.conf
  nginx -t
  systemctl reload nginx || systemctl restart nginx
  certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"
  rm -f /etc/nginx/sites-enabled/opensips-sbc-ui-bootstrap.conf
fi

auth_block=""
if [[ -n "$BASIC_AUTH_USER" && -n "$BASIC_AUTH_PASSWORD" ]]; then
  apt-get install -y apache2-utils
  htpasswd -bc /etc/nginx/.opensips-sbc-ui.htpasswd "$BASIC_AUTH_USER" "$BASIC_AUTH_PASSWORD"
  auth_block='    auth_basic "OpenSIPS SBC UI";
    auth_basic_user_file /etc/nginx/.opensips-sbc-ui.htpasswd;'
fi

tmp_nginx="$(mktemp)"
sed "s#__DOMAIN__#$DOMAIN#g; s#__BACKEND_PORT__#$BACKEND_PORT#g" "$APP_DIR/deploy/nginx/opensips-sbc-ui.conf" > "$tmp_nginx"
if [[ -n "$auth_block" ]]; then
  awk -v auth="$auth_block" '{ if ($0 == "__AUTH_BLOCK__") print auth; else print }' "$tmp_nginx" > /etc/nginx/sites-available/opensips-sbc-ui.conf
else
  sed "/__AUTH_BLOCK__/d" "$tmp_nginx" > /etc/nginx/sites-available/opensips-sbc-ui.conf
fi
rm -f "$tmp_nginx"
ln -sfn /etc/nginx/sites-available/opensips-sbc-ui.conf /etc/nginx/sites-enabled/opensips-sbc-ui.conf

sed "s#/opt/opensips-sbc-ui#$APP_DIR#g" \
  "$APP_DIR/deploy/systemd/opensips-sbc-ui.service" > /etc/systemd/system/opensips-sbc-ui.service

systemctl daemon-reload
systemctl enable --now opensips-sbc-ui

nginx -t
systemctl reload nginx || systemctl restart nginx

echo "OpenSIPS SBC UI is configured at https://$DOMAIN"
