# HTTPS Deployment

This project includes an installer for RHEL-family and Debian-family Linux distributions. It runs the backend with systemd and exposes the UI over HTTPS with Nginx.

Prerequisites:

- Node.js 18, 20, or 22+ must be available from the configured package repositories.
- Supported package managers are DNF on RHEL, CentOS Stream, Rocky Linux, AlmaLinux, Oracle Linux, and Fedora, or APT on Debian and Ubuntu.
- For Let's Encrypt, the domain must resolve to this server and inbound ports 80 and 443 must be open.
- The OpenSIPS database and the tables in `database/schema.sql` must already exist.

On RHEL-family systems, the installer configures firewalld when it is active and applies the SELinux settings required for Nginx to serve the frontend and proxy the API. Public certificates require a repository that provides Certbot; if `dnf install certbot` cannot find it, enable EPEL or use the self-signed mode.

If a supported Node.js and npm installation already exists, including a NodeSource installation, the installer reuses it and does not ask DNF or APT to replace it.

For RHEL 8 or 9, if the default Node.js stream is older than version 18, select a supported stream before running the installer:

```bash
sudo dnf module install nodejs:20
```

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

The installer preserves `backend/.env` on subsequent deployments, validates the database schema, rebuilds both workspaces, and restarts the backend service.

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

The installer runs this check automatically using the deployed `backend/.env`. For an initial web-server-only setup when the database is deliberately unavailable, set `SKIP_DB_PREFLIGHT=true`; run the preflight manually before using the application.

## Services

```bash
sudo systemctl status opensips-sbc-ui
sudo journalctl -u opensips-sbc-ui -f
sudo nginx -t
```

## Generated Files

- `/etc/systemd/system/opensips-sbc-ui.service`
- RHEL family: `/etc/nginx/conf.d/opensips-sbc-ui.conf`
- Debian family: `/etc/nginx/sites-available/opensips-sbc-ui.conf` and `/etc/nginx/sites-enabled/opensips-sbc-ui.conf`
- Optional: `/etc/nginx/.opensips-sbc-ui.htpasswd`
- `/opt/opensips-sbc-ui/backend/.env`
