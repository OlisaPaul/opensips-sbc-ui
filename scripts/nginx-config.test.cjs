// Static contracts only: run nginx -t and browser/auth checks on the RHEL host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r/g, '');
const uncomment = value => value.replace(/^\s*#.*$/gm, '');
const template = uncomment(read('deploy/nginx/opensips-sbc-ui.conf'));
const homer = uncomment(read('deploy/nginx/homer.locations.conf.example'));
function block(text, declaration) {
  const start = text.indexOf(declaration);
  assert.notEqual(start, -1, `Missing ${declaration}`);
  const open = text.indexOf('{', start);
  let depth = 1;
  for (let index = open + 1; index < text.length; index++) {
    if (text[index] === '{') depth++;
    if (text[index] === '}') depth--;
    if (!depth) return text.slice(open + 1, index);
  }
  assert.fail(`Unclosed ${declaration}`);
}
test('optional extension include is inside HTTPS only; SBC API/root remain unchanged', () => {
  const servers = template.split(/(?=server\s*\{)/).filter(s => s.includes('server {'));
  assert.equal(servers.length, 2);
  assert.doesNotMatch(servers[0], /opensips-sbc-ui\.d/);
  assert.equal((servers[1].match(/include \/etc\/nginx\/opensips-sbc-ui\.d\/\*\.conf;/g) ?? []).length, 1);
  assert.match(servers[1], /listen 443 ssl http2/);
  assert.ok(servers[1].indexOf('__AUTH_BLOCK__') < servers[1].indexOf('include /etc/nginx/opensips-sbc-ui.d'));
  assert.match(block(servers[1], 'location /api/'), /proxy_pass http:\/\/127\.0\.0\.1:__BACKEND_PORT__\/api\/;/);
  assert.match(block(servers[1], 'location / {'), /try_files \$uri \$uri\/ \/index\.html;/);
  assert.doesNotMatch(servers[1], /auth_basic off/);
});
test('installer creates root-owned extension directory but never overwrites its fragments', () => {
  const installer = read('scripts/install-https-nginx.sh');
  assert.match(installer, /install -d -o root -g root -m 755 \/etc\/nginx\/opensips-sbc-ui\.d/);
  const activeLines = uncomment(installer).split('\n').filter(line => line.includes('/etc/nginx/opensips-sbc-ui.d'));
  assert.equal(activeLines.length, 1);
  assert.ok(installer.indexOf('install -d -o root -g root -m 755 /etc/nginx/opensips-sbc-ui.d') < installer.indexOf('tmp_nginx='));
});
test('Homer fragment contains only location blocks and leaves SBC endpoints/auth untouched', () => {
  assert.doesNotMatch(homer, /\b(?:server|http|map)\s*\{|\blisten\s/);
  assert.doesNotMatch(homer, /location\s+\/\s*\{|location\s+\/api\/\s*\{/);
  for (const declaration of ['location = /homer', 'location ^~ /homer/', 'location ^~ /api/v4/',
    'location = /logo.png', 'location = /favicon.ico', 'location ^~ /export/', 'location ^~ /gamedata/']) {
    assert.match(block(homer, declaration), /auth_basic off;/);
  }
  assert.doesNotMatch(homer, /proxy_set_header Authorization|proxy_hide_header WWW-Authenticate|\$http_referer/);
});
test('initial HTML uses Homer namespace; API keeps its original /api/v4 path', () => {
  const ui = block(homer, 'location ^~ /homer/');
  const api = block(homer, 'location ^~ /api/v4/');
  assert.match(ui, /proxy_pass http:\/\/127\.0\.0\.1:8080\/;/);
  assert.match(api, /proxy_pass http:\/\/127\.0\.0\.1:8080;/);
  assert.match(ui, /proxy_set_header Accept-Encoding "";/);
  assert.match(ui, /sub_filter '="\/assets\/' '="\/homer\/assets\/';/);
  assert.doesNotMatch(ui, /sub_filter_types\s+text\/html/);
  assert.match(ui, /proxy_redirect \/ \/homer\/;/);
  assert.match(api, /proxy_set_header Upgrade \$http_upgrade;/);
});
test('root assets keep inherited auth if file exists; missing files rewrite before access', () => {
  const assets = block(homer, 'location ^~ /assets/');
  assert.match(assets, /if \(!-f \$request_filename\)\s*\{\s*rewrite \^ \/homer\$uri last;/);
  assert.match(assets, /try_files \$uri =404;/);
  assert.doesNotMatch(assets, /auth_basic off|proxy_pass|alias /);
  assert.ok(assets.indexOf('rewrite ^ /homer$uri last;') < assets.indexOf('try_files'));
});
test('restore guide stages a private backup and gates reload on validation success', () => {
  const guide = read('deploy/nginx/HOMER.md');
  assert.match(guide, /mktemp \/var\/tmp\/opensips-nginx-before-homer/);
  assert.match(guide, /sudo nginx -t && sudo systemctl reload nginx/);
  assert.match(guide, /existing SBC\s+asset/);
  assert.match(guide, /Do not create a separate `server`/);
});
