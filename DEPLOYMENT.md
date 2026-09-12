# HTTPS Deployment

This project includes an Ubuntu/Debian-oriented installer that runs the backend with systemd and exposes the UI over HTTPS with Nginx.

## Production With Let's Encrypt

Run from the project root on the OpenSIPS/SBC host:

```bash
sudo DOMAIN=sbc.example.com EMAIL=admin@example.com bash scripts/install-https-nginx.sh
```

The first run copies the app to `/opt/opensips-sbc-ui`, creates `/opt/opensips-sbc-ui/backend/.env`, and stops so you can set the database, MI URL, and credential encryption key.

Edit:

```bash
sudo nano /opt/opensips-sbc-ui/backend/.env
```

Then rerun:

```bash
sudo DOMAIN=sbc.example.com EMAIL=admin@example.com bash scripts/install-https-nginx.sh
```

## Private/Internal HTTPS

For an internal host without public DNS or Let's Encrypt access:

```bash
sudo DOMAIN=sbc.internal SELF_SIGNED=true bash scripts/install-https-nginx.sh
```

Your browser will warn about the private certificate unless you install/trust it locally.

## Basic Password Protection

Until application login is added, use Nginx basic auth:

```bash
sudo DOMAIN=sbc.example.com \
  EMAIL=admin@example.com \
  BASIC_AUTH_USER=admin \
  BASIC_AUTH_PASSWORD='change-this-password' \
  bash scripts/install-https-nginx.sh
```

## Custom Install Directory Or Port

```bash
sudo DOMAIN=sbc.example.com \
  EMAIL=admin@example.com \
  APP_DIR=/opt/opensips-sbc-ui \
  BACKEND_PORT=3000 \
  bash scripts/install-https-nginx.sh
```

Nginx listens on ports `80` and `443`. The NestJS backend listens only on localhost at `BACKEND_PORT`.

## Database Preflight

Before applying the schema or saving trunks, check that the expected OpenSIPS/custom tables exist:

```bash
DB_HOST=127.0.0.1 \
DB_PORT=3306 \
DB_USER=opensips \
DB_PASSWORD='your-password' \
DB_NAME=opensips \
bash scripts/preflight-db.sh
```

## Services

```bash
sudo systemctl status opensips-sbc-ui
sudo journalctl -u opensips-sbc-ui -f
sudo nginx -t
```

## Generated Files

- `/etc/systemd/system/opensips-sbc-ui.service`
- `/etc/nginx/sites-available/opensips-sbc-ui.conf`
- `/etc/nginx/sites-enabled/opensips-sbc-ui.conf`
- Optional: `/etc/nginx/.opensips-sbc-ui.htpasswd`
- `/opt/opensips-sbc-ui/backend/.env`
