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

has_supported_node=false
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
  if (( node_major == 18 || node_major == 20 || node_major >= 22 )); then
    has_supported_node=true
  fi
fi

if [[ ! -r /etc/os-release ]]; then
  echo "Cannot detect the operating system because /etc/os-release is unavailable."
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
os_family=""
case "${ID:-}" in
  rhel | centos | rocky | almalinux | ol | fedora) os_family="rhel" ;;
  debian | ubuntu) os_family="debian" ;;
esac
if [[ -z "$os_family" && " ${ID_LIKE:-} " == *" rhel "* ]]; then
  os_family="rhel"
elif [[ -z "$os_family" && " ${ID_LIKE:-} " == *" debian "* ]]; then
  os_family="debian"
fi

if [[ "$os_family" == "rhel" ]]; then
  rhel_packages=(nginx rsync mariadb openssl httpd-tools policycoreutils-python-utils)
  if [[ "$has_supported_node" != "true" ]]; then
    rhel_packages+=(nodejs npm)
  fi
  dnf install -y "${rhel_packages[@]}"
  nginx_config_dir="/etc/nginx/conf.d"
  nginx_config_path="$nginx_config_dir/opensips-sbc-ui.conf"
  nginx_bootstrap_path="$nginx_config_dir/opensips-sbc-ui-bootstrap.conf"
elif [[ "$os_family" == "debian" ]]; then
  apt-get update
  debian_packages=(nginx rsync default-mysql-client openssl apache2-utils)
  if [[ "$has_supported_node" != "true" ]]; then
    debian_packages+=(nodejs npm)
  fi
  apt-get install -y "${debian_packages[@]}"
  nginx_config_dir="/etc/nginx/sites-available"
  nginx_config_path="$nginx_config_dir/opensips-sbc-ui.conf"
  nginx_bootstrap_path="$nginx_config_dir/opensips-sbc-ui-bootstrap.conf"
else
  echo "Unsupported Linux distribution: ${PRETTY_NAME:-${ID:-unknown}}"
  exit 1
fi

if [[ "$SELF_SIGNED" != "true" ]] && ! command -v certbot >/dev/null 2>&1; then
  if [[ "$os_family" == "rhel" ]]; then
    if ! dnf install -y certbot; then
      echo "Certbot is unavailable. Enable a repository that provides certbot (commonly EPEL), or use SELF_SIGNED=true."
      exit 1
    fi
  else
    apt-get install -y certbot
  fi
fi

nologin_shell="$(command -v nologin || true)"
nologin_shell="${nologin_shell:-/sbin/nologin}"
id -u opensips-sbc-ui >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell "$nologin_shell" opensips-sbc-ui

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

if ! grep -q "^MI_TRANSPORT=" "$APP_DIR/backend/.env"; then
  echo "MI_TRANSPORT=cli" >> "$APP_DIR/backend/.env"
fi

if ! grep -q "^MI_CLI_PATH=" "$APP_DIR/backend/.env"; then
  echo "MI_CLI_PATH=/usr/bin/opensips-cli" >> "$APP_DIR/backend/.env"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm were not installed successfully. Install Node.js 18, 20, or 22+ and rerun."
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
if (( node_major != 18 && node_major != 20 && node_major < 22 )); then
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

if [[ "$os_family" == "rhel" ]]; then
  if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce)" != "Disabled" ]]; then
    setsebool -P httpd_can_network_connect 1
    semanage fcontext -a -t httpd_sys_content_t "$APP_DIR/frontend/dist(/.*)?" 2>/dev/null || \
      semanage fcontext -m -t httpd_sys_content_t "$APP_DIR/frontend/dist(/.*)?"
    restorecon -RF "$APP_DIR/frontend/dist"
  fi

  if systemctl is-active --quiet firewalld; then
    firewall-cmd --permanent --add-port=80/tcp
    firewall-cmd --permanent --add-port=443/tcp
    firewall-cmd --reload
  fi
fi

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
    cat > "$nginx_bootstrap_path" <<BOOTSTRAP_NGINX
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
    if [[ "$os_family" == "debian" ]]; then
      ln -sfn "$nginx_bootstrap_path" /etc/nginx/sites-enabled/opensips-sbc-ui-bootstrap.conf
    fi
    nginx -t
    systemctl reload nginx || systemctl restart nginx
    if ! certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"; then
      rm -f "$nginx_bootstrap_path"
      if [[ "$os_family" == "debian" ]]; then
        rm -f /etc/nginx/sites-enabled/opensips-sbc-ui-bootstrap.conf
      fi
      systemctl reload nginx || true
      exit 1
    fi
    rm -f "$nginx_bootstrap_path"
    if [[ "$os_family" == "debian" ]]; then
      rm -f /etc/nginx/sites-enabled/opensips-sbc-ui-bootstrap.conf
    fi
  fi
fi

auth_block=""
if [[ -n "$BASIC_AUTH_USER" && -n "$BASIC_AUTH_PASSWORD" ]]; then
  htpasswd -bc /etc/nginx/.opensips-sbc-ui.htpasswd "$BASIC_AUTH_USER" "$BASIC_AUTH_PASSWORD"
  auth_block='    auth_basic "OpenSIPS SBC UI";
    auth_basic_user_file /etc/nginx/.opensips-sbc-ui.htpasswd;'
fi

tmp_nginx="$(mktemp)"
sed "s#__DOMAIN__#$DOMAIN#g; s#__BACKEND_PORT__#$BACKEND_PORT#g; s#__APP_DIR__#$APP_DIR#g; s#__SSL_CERTIFICATE__#$certificate_path#g; s#__SSL_CERTIFICATE_KEY__#$certificate_key_path#g" \
  "$APP_DIR/deploy/nginx/opensips-sbc-ui.conf" > "$tmp_nginx"
if [[ -n "$auth_block" ]]; then
  awk -v auth="$auth_block" '{ if ($0 == "__AUTH_BLOCK__") print auth; else print }' "$tmp_nginx" > "$nginx_config_path"
else
  sed "/__AUTH_BLOCK__/d" "$tmp_nginx" > "$nginx_config_path"
fi
rm -f "$tmp_nginx"
if [[ "$os_family" == "debian" ]]; then
  ln -sfn "$nginx_config_path" /etc/nginx/sites-enabled/opensips-sbc-ui.conf
fi

sed "s#__APP_DIR__#$APP_DIR#g" \
  "$APP_DIR/deploy/systemd/opensips-sbc-ui.service" > /etc/systemd/system/opensips-sbc-ui.service

systemctl daemon-reload
systemctl enable opensips-sbc-ui
systemctl restart opensips-sbc-ui

nginx -t
systemctl enable nginx
systemctl reload nginx || systemctl restart nginx

echo "OpenSIPS SBC UI is configured at https://$DOMAIN"
