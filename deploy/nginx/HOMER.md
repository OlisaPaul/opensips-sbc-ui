# Restore Homer 11 under /homer/ without losing it on SBC redeployment

The installer regenerates `/etc/nginx/conf.d/opensips-sbc-ui.conf` (RHEL) from
the repository template. Handwritten locations in that generated file are lost.
When `/homer/` is missing, the SBC's `try_files ... /index.html` serves the SBC UI
instead. A 200 response from `http://127.0.0.1:8080/` confirms Homer is available
locally; it does not confirm the external proxy, authentication or assets work.

The updated template includes `/etc/nginx/opensips-sbc-ui.d/*.conf` inside ONLY
the HTTPS server block. The installer creates that directory but does not replace
its contents. Homer support is opt-in; installing/deploying the SBC app alone
does not publish Homer or disable its own Basic Auth.

## Restore on the existing RHEL server

Run from the updated project checkout (the example fragment must be present).
No npm install, web build, database change or SIP-service restart is needed.
First save the current main config outside any Nginx include directory:

```bash
nginx_backup=$(mktemp /var/tmp/opensips-nginx-before-homer.XXXXXX.conf)
sudo install -o root -g root -m 600 /etc/nginx/conf.d/opensips-sbc-ui.conf "$nginx_backup"
printf 'Nginx backup: %s\n' "$nginx_backup"
sudo install -d -o root -g root -m 755 /etc/nginx/opensips-sbc-ui.d
```

Do not leave backups ending `.conf` inside `conf.d`: Nginx can load them as extra
servers. If `/etc/nginx/opensips-sbc-ui.d/homer.conf` already exists, inspect and
back it up before overwriting it. For this first restore, install the fragment:

```bash
sudo install -o root -g root -m 644 deploy/nginx/homer.locations.conf.example /etc/nginx/opensips-sbc-ui.d/homer.conf
sudo vi /etc/nginx/conf.d/opensips-sbc-ui.conf
```

Inside `server { listen 443 ... }`, immediately after `auth_basic_user_file ...;`,
add this line ONCE (leave existing authentication, certificates, /api/ and /
locations unchanged):

```nginx
include /etc/nginx/opensips-sbc-ui.d/*.conf;
```

Do not create a separate `server` for this IP/port. Do not put the fragment in
`/etc/nginx/conf.d/homer.conf`: bare `location` directives are invalid at that
level. Do not paste a second copy if old Homer locations already exist. This
fragment reserves `/api/v4/`, `/export/`, `/gamedata/`, `/logo.png` and
`/favicon.ico` for Homer on the shared origin; check for other users of these
paths before enabling. A separate hostname remains the cleaner long-term option
if both apps need the same paths.

Validate, and reload only if validation succeeds:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

If validation fails, DO NOT restart Nginx. Its previous configuration continues
serving requests. Check the reported file and line, or restore the saved main
config and validate again. Keep SELinux enabled. The previously working reverse
proxy should already have the appropriate network access; investigate scoped
AVC denials if proxying returns 502.

## Why assets and logins need special handling

The observed Homer 11 bundle uses `/api/v4/` and root-relative lazy imports such
as `/assets/SearchPanel-....js`. Rewriting only the initial HTML does not fix
imports requested after login. The fragment routes missing SBC asset files to
`/homer/assets/...` internally, before Basic Auth, and proxies them to Homer.
Existing SBC asset files continue to inherit SBC Basic Auth. It never selects
an application based on a spoofable Referer header. Both filesystems must remain
readable to Nginx; a permissions/SELinux problem on SBC assets must be corrected,
not treated as a Homer fallback. Identical asset filenames belonging to both
apps would collide; SBC files take precedence, so use separate origins if that
occurs. During an SBC deployment, a stale/missing hashed SBC asset can similarly
fall through; refresh the SBC page after deployment.

Basic Auth is disabled ONLY on Homer routes, not on the SBC page, backend API,
or real SBC assets. Homer must retain its own authentication; do not hide upstream
401 challenges or strip Authorization headers. A Homer 401 before login may be
normal. A popup with the SBC Basic Auth realm when loading a Homer asset is not.

## Verify with GET requests (not curl -I)

The observed upstream returns 405 to HEAD for some static files. Use GET, inspect
the status AND Content-Type, and check browser DevTools Network after login:

```bash
curl -ksS -D - -o /dev/null https://10.81.0.194/homer/
curl -ksS -D - -o /dev/null https://10.81.0.194/
curl -ksS -D - -o /dev/null https://10.81.0.194/api/trunks
curl -ksS -D - -o /dev/null https://10.81.0.194/api/v4/auth/providers
```

Expected: `/homer/` serves Homer HTML without the SBC Basic Auth challenge;
SBC `/` and `/api/trunks` still return 401 without SBC credentials. Homer API
behavior is controlled by Homer (a 401 can be its own login requirement).
Verify with a real current Homer asset URL from browser DevTools, using BOTH
`/homer/assets/<file>` and `/assets/<file>`: both should return the correct JS/CSS
or font, not HTML and not the SBC Basic Auth challenge. For a real existing SBC
asset under `/assets/`, an unauthenticated GET must still return SBC Basic Auth
401, and an authenticated GET must return its original JS/CSS. Do not use an old
hashed filename unless it still exists in the current upstream bundle.

Open `https://10.81.0.194/homer/` in a fresh private browser window. Log in with
Homer credentials, open Search and a dashboard to exercise lazy imports, and
confirm there is no SBC credential popup. Verify SBC login/API still work too.
Use the existing certificate or your organization's trusted CA; `curl -k` here
is only for diagnosis of the current self-signed setup.

After future deployments from the updated repository, verify the include is
still present and repeat `nginx -t`. The installer preserves the fragment but
does not overwrite/update it automatically if a later Homer version needs
different routes. The change has static tests locally; actual Nginx syntax,
upstream/browser integration and authentication must be tested on the server.

Nginx references: [location/try_files](https://nginx.org/en/docs/http/ngx_http_core_module.html#location),
[rewrite processing](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html),
[Basic Auth inheritance](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html),
[sub_filter](https://nginx.org/en/docs/http/ngx_http_sub_module.html).
