#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
APP_DIR="${APP_DIR:-/opt/opensips-sbc-ui}"
BACKEND_PORT="${BACKEND_PORT:-3000}"
SELF_SIGNED="${SELF_SIGNED:-false}"
BASIC_AUTH_USER="${BASIC_AUTH_USER:-}"
BASIC_AUTH_PASSWORD="${BASIC_AUTH_PASSWORD:-}"
SKIP_DB_PREFLIGHT="${SKIP_DB_PREFLIGHT:-false}"

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

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "DOMAIN may contain only letters, numbers, dots, and hyphens."
  exit 1
fi

if [[ ! "$APP_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
  echo "APP_DIR must be an absolute path containing only letters, numbers, dots, underscores, slashes, and hyphens."
  exit 1
fi

if [[ ! "$BACKEND_PORT" =~ ^[0-9]+$ ]] || (( BACKEND_PORT < 1 || BACKEND_PORT > 65535 )); then
  echo "BACKEND_PORT must be a number between 1 and 65535."
  exit 1
fi

if [[ -n "$BASIC_AUTH_USER" || -n "$BASIC_AUTH_PASSWORD" ]]; then
  if [[ -z "$BASIC_AUTH_USER" || -z "$BASIC_AUTH_PASSWORD" ]]; then
    echo "Set both BASIC_AUTH_USER and BASIC_AUTH_PASSWORD, or neither."
    exit 1
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

apt-get update
apt-get install -y nginx nodejs npm rsync default-mysql-client

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
  --exclude backend/.env \
  "$PROJECT_DIR/" "$APP_DIR/"

chown -R opensips-sbc-ui:opensips-sbc-ui "$APP_DIR"

if [[ ! -f "$APP_DIR/backend/.env" ]]; then
  cp "$APP_DIR/backend/.env.example" "$APP_DIR/backend/.env"
  chmod 600 "$APP_DIR/backend/.env"
  chown opensips-sbc-ui:opensips-sbc-ui "$APP_DIR/backend/.env"
  echo "Created $APP_DIR/backend/.env. Edit it with DB and MI settings, then rerun this script."
  exit 1
fi

chmod 600 "$APP_DIR/backend/.env"
chown opensips-sbc-ui:opensips-sbc-ui "$APP_DIR/backend/.env"

if grep -q "^PORT=" "$APP_DIR/backend/.env"; then
  sed -i "s/^PORT=.*/PORT=$BACKEND_PORT/" "$APP_DIR/backend/.env"
else
  echo "PORT=$BACKEND_PORT" >> "$APP_DIR/backend/.env"
fi

if grep -q "^BACKEND_HOST=" "$APP_DIR/backend/.env"; then
  sed -i "s/^BACKEND_HOST=.*/BACKEND_HOST=127.0.0.1/" "$APP_DIR/backend/.env"
else
  echo "BACKEND_HOST=127.0.0.1" >> "$APP_DIR/backend/.env"
fi

if grep -q "^FRONTEND_ORIGIN=" "$APP_DIR/backend/.env"; then
  sed -i "s#^FRONTEND_ORIGIN=.*#FRONTEND_ORIGIN=https://$DOMAIN#" "$APP_DIR/backend/.env"
else
  echo "FRONTEND_ORIGIN=https://$DOMAIN" >> "$APP_DIR/backend/.env"
fi

node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
if (( node_major < 18 )) || [[ "$node_major" == "19" || "$node_major" == "21" ]]; then
  echo "Unsupported Node.js version: $(node --version). Install Node.js 18, 20, or 22+ and rerun."
  exit 1
fi

runuser -u opensips-sbc-ui -- npm --prefix "$APP_DIR" ci
runuser -u opensips-sbc-ui -- npm --prefix "$APP_DIR" run build

if [[ "$SKIP_DB_PREFLIGHT" != "true" ]]; then
  runuser -u opensips-sbc-ui -- env ENV_FILE="$APP_DIR/backend/.env" \
    bash "$APP_DIR/scripts/preflight-db.sh"
fi

mkdir -p /var/www/html

if [[ "$SELF_SIGNED" == "true" ]]; then
  certificate_dir="/etc/ssl/opensips-sbc-ui/$DOMAIN"
  certificate_path="$certificate_dir/fullchain.pem"
  certificate_key_path="$certificate_dir/privkey.pem"
  certificate_san="DNS:$DOMAIN"
  if [[ "$DOMAIN" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    certificate_san="IP:$DOMAIN"
  fi
  mkdir -p "$certificate_dir"
  if [[ ! -s "$certificate_key_path" || ! -s "$certificate_path" ]]; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
      -keyout "$certificate_key_path" \
      -out "$certificate_path" \
      -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=$certificate_san"
    chmod 600 "$certificate_key_path"
  fi
else
  certificate_path="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  certificate_key_path="/etc/letsencrypt/live/$DOMAIN/privkey.pem"
  if [[ ! -s "$certificate_key_path" || ! -s "$certificate_path" ]]; then
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
    if ! certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"; then
      rm -f /etc/nginx/sites-enabled/opensips-sbc-ui-bootstrap.conf
      systemctl reload nginx || true
      exit 1
    fi
    rm -f /etc/nginx/sites-enabled/opensips-sbc-ui-bootstrap.conf
  fi
fi

auth_block=""
if [[ -n "$BASIC_AUTH_USER" && -n "$BASIC_AUTH_PASSWORD" ]]; then
  apt-get install -y apache2-utils
  htpasswd -bc /etc/nginx/.opensips-sbc-ui.htpasswd "$BASIC_AUTH_USER" "$BASIC_AUTH_PASSWORD"
  auth_block='    auth_basic "OpenSIPS SBC UI";
    auth_basic_user_file /etc/nginx/.opensips-sbc-ui.htpasswd;'
fi

tmp_nginx="$(mktemp)"
sed "s#__DOMAIN__#$DOMAIN#g; s#__BACKEND_PORT__#$BACKEND_PORT#g; s#__APP_DIR__#$APP_DIR#g; s#__SSL_CERTIFICATE__#$certificate_path#g; s#__SSL_CERTIFICATE_KEY__#$certificate_key_path#g" \
  "$APP_DIR/deploy/nginx/opensips-sbc-ui.conf" > "$tmp_nginx"
if [[ -n "$auth_block" ]]; then
  awk -v auth="$auth_block" '{ if ($0 == "__AUTH_BLOCK__") print auth; else print }' "$tmp_nginx" > /etc/nginx/sites-available/opensips-sbc-ui.conf
else
  sed "/__AUTH_BLOCK__/d" "$tmp_nginx" > /etc/nginx/sites-available/opensips-sbc-ui.conf
fi
rm -f "$tmp_nginx"
ln -sfn /etc/nginx/sites-available/opensips-sbc-ui.conf /etc/nginx/sites-enabled/opensips-sbc-ui.conf

sed "s#__APP_DIR__#$APP_DIR#g" \
  "$APP_DIR/deploy/systemd/opensips-sbc-ui.service" > /etc/systemd/system/opensips-sbc-ui.service

systemctl daemon-reload
systemctl enable opensips-sbc-ui
systemctl restart opensips-sbc-ui

nginx -t
systemctl reload nginx || systemctl restart nginx

echo "OpenSIPS SBC UI is configured at https://$DOMAIN"
