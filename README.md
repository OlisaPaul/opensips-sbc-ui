# OpenSIPS SBC UI

A small management UI for the OpenSIPS SBC provisioning model used in the AdoGlobal-style trunk flow.

It creates and edits trunks without modifying `opensips.cfg`. Version 1 operates through existing MariaDB tables plus OpenSIPS MI commands.

## What It Manages

- Provider/trunk metadata.
- `registrant` entries for REGISTER-based trunks.
- Provider gateways in `dispatcher`.
- Provider authorization in `address` group `1`.
- DID routing to an application dispatcher set through `did_mapping`.
- Application/PBX authorization in `address` group `2`.
- Outbound prefix routing through `prefix_mapping`.
- Pilot CLI through `address.pattern` and `prefix_mapping.pilot_cli`.
- MI reloads for `address_reload` and `ds_reload`.
- MI status checks for registration and dispatcher state.
- Audit log entries for create/update operations.
- Dry-run previews of SQL/actions before provisioning.

## Stack

- Backend: NestJS
- Frontend: React + Vite
- Database: MariaDB / MySQL-compatible OpenSIPS database

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create backend environment:

   ```bash
   cp backend/.env.example backend/.env
   ```

3. Edit `backend/.env` for your OpenSIPS database and MI endpoint.

4. Apply app-owned schema:

   ```bash
   mysql -h 127.0.0.1 -u opensips -p opensips < database/schema.sql
   ```

   Review the generated unique indexes first if your OpenSIPS tables already have conflicting duplicate rows.

5. Run the backend:

   ```bash
   npm run dev:backend
   ```

6. Run the frontend in another terminal:

   ```bash
   npm run dev:frontend
   ```

## HTTPS Deployment

See `DEPLOYMENT.md` for the Nginx + systemd installer.

Typical production install:

```bash
sudo DOMAIN=sbc.example.com EMAIL=admin@example.com bash scripts/install-https-nginx.sh
```

For internal-only HTTPS with a self-signed certificate:

```bash
sudo DOMAIN=sbc.internal SELF_SIGNED=true bash scripts/install-https-nginx.sh
```

Use `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` with the installer to protect the UI at Nginx until app-level login is added.

## Preflight Check

Before provisioning live trunks, verify the expected OpenSIPS tables and custom mapping tables:

```bash
DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=opensips DB_PASSWORD='your-password' DB_NAME=opensips bash scripts/preflight-db.sh
```

## Important Notes

- The app stores a local encrypted copy of SIP credentials in `sbc_trunks.encrypted_password`, but OpenSIPS `registrant.password` still receives the plaintext secret because OpenSIPS needs it to authenticate REGISTER.
- Set `CREDENTIAL_ENCRYPTION_KEY` to a long random secret before production use. Rotating it requires re-entering trunk passwords.
- Set `MI_ENABLED=false` in development if OpenSIPS MI is not available.
- The UI assumes the custom tables `did_mapping` and `prefix_mapping` already exist and match the columns shown in `database/schema.sql` usage.
- The app does not edit `opensips.cfg` in v1.
