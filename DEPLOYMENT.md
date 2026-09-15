# HTTPS Deployment

This project includes an installer for RHEL-family and Debian-family Linux distributions. It runs the backend with systemd and exposes the UI over HTTPS with Nginx.

Prerequisites:

- Node.js 18, 20, or 22+ must be available from the configured package repositories.
- Supported package managers are DNF on RHEL, CentOS Stream, Rocky Linux, AlmaLinux, Oracle Linux, and Fedora, or APT on Debian and Ubuntu.
- For Let's Encrypt, the domain must resolve to this server and inbound ports 80 and 443 must be open.
- The OpenSIPS database and the tables in `database/schema.sql` must already exist.

If the preflight reports that `sbc_trunks` or `sbc_audit_log` is missing, create only these app-owned tables once:

```bash
mariadb -h 127.0.0.1 -u opensips -p opensips < database/schema.sql
```

This schema file does not alter any existing OpenSIPS or custom routing table.

## Upgrading An Existing Installation

The separate Trunks, Inbound Routing, and Outbound Routing screens require the old embedded route fields in the app-owned `sbc_trunks` table to be optional. Apply this migration once, before rerunning the installer:

```bash
mariadb -h 127.0.0.1 -u opensips -p opensips < database/migrations/001_separate_routing.sql
```

This migration preserves all rows and does not alter any OpenSIPS or custom routing table. The installer intentionally does not run database migrations automatically.

To add the operational trunk enable/disable switch, apply the second app-owned
migration before deploying the updated backend:

```bash
sudo mysql opensips < database/migrations/002_trunk_enabled.sql
```

It adds only `enabled`, `registration_expiry`, and `binding_uri` to
`sbc_trunks`. Existing registration expiry and binding values are copied from
the latest matching `registrant` row so a disabled trunk can be restored later.

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

The backend uses the local `/usr/bin/opensips-cli` MI transport by default. The `opensips-sbc-ui` service account must be able to run MI commands, as verified with `sudo -u opensips-sbc-ui opensips-cli -x mi reg_list`. HTTP MI remains available by setting `MI_TRANSPORT=http` and `MI_URL`.

Set `SIP_BINDING_IP` and `SIP_BINDING_PORT` in the deployed `backend/.env` to the local OpenSIPS SIP listener. For example, `SIP_BINDING_IP=10.81.0.194` and `SIP_BINDING_PORT=5060`. New REGISTER contacts use this listener unless a trunk supplies an explicit SBC Contact URI.

## Private/Internal HTTPS

For an internal host without public DNS or Let's Encrypt access:

```bash
sudo DOMAIN=sbc.internal SELF_SIGNED=true bash scripts/install-https-nginx.sh
```

Your browser will warn about the private certificate unless you install/trust it locally.

## Saved Deployment Settings

Instead of passing the domain and password on every deployment, keep them in a
root-owned file outside the Git checkout. Set it up once from the project root:

```bash
sudo install -d -m 700 /etc/opensips-sbc-ui
sudo install -o root -g root -m 600 \
  deploy/deploy.env.example /etc/opensips-sbc-ui/deploy.env
sudo vi /etc/opensips-sbc-ui/deploy.env
```

After editing the values, future deployments require one command:

```bash
sudo bash scripts/deploy.sh
```

The wrapper reads `/etc/opensips-sbc-ui/deploy.env`, verifies that it is private
and root-owned, then runs the standard installer. To use another settings file,
set `DEPLOY_CONFIG` when invoking the wrapper.

A service restart alone does not copy or rebuild newly pulled source code. If no
code or deployment settings changed and only the existing backend process needs
restarting, use `sudo systemctl restart opensips-sbc-ui`.

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
