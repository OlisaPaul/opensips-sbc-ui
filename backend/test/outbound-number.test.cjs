const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { validateSync } = require('class-validator');
const { plainToInstance } = require('class-transformer');
const { OutboundRouteInputDto } = require('../dist/routing/dto');
const { RoutingService } = require('../dist/routing/routing.service');

const valid = { prefix: '123', trunkId: 9, pilotCli: '02013313100', stripPrefix: true };
const checked = value => validateSync(plainToInstance(OutboundRouteInputDto, { ...valid, ...value }));
test('optional prepend accepts digits/leading plus, null, omitted and clearing; trims whitespace', () => {
  for (const addPrefix of [undefined, null, '', '+234', '234', '+', ' +234 ']) {
    assert.equal(checked({ addPrefix }).length, 0, String(addPrefix));
  }
  assert.equal(plainToInstance(OutboundRouteInputDto, { addPrefix: ' +234 ' }).addPrefix, '+234');
});
test('prepend rejects non-digits, SIP/header injection, misplaced plus, non-strings and oversized input', () => {
  for (const addPrefix of ['sip:234', '23+4', '++234', '234\r\nInjected: yes', '2;foo', '1'.repeat(33), 234, {}]) {
    assert.ok(checked({ addPrefix }).length > 0, JSON.stringify(addPrefix));
  }
});

function fixture() {
  const writes = [], audits = [];
  const db = {
    transaction: fn => fn({}),
    query: async (sql, params) => {
      if (/insert into prefix_mapping|update prefix_mapping/.test(sql)) {
        writes.push({ sql, params }); return { insertId: 7 };
      }
      throw Error(`Unexpected SQL: ${sql}`);
    },
  };
  const service = new RoutingService(db, { reloadProvisioning: async () => [] },
    { record: async (...args) => audits.push(args) });
  service.findTrunk = async () => ({ name: 'Carrier', provider_dispatcher_set: 9 });
  service.ensurePrefixAvailable = async () => {};
  service.upsertProviderAddress = async () => {};
  service.findOutbound = async () => ({ id: 7 });
  service.getOutbound = async () => ({ id: 7 });
  return { service, writes, audits };
}
test('create saves prepend through a bound SQL parameter and preserves strip selection', async () => {
  const { service, writes, audits } = fixture();
  await service.createOutbound({ ...valid, addPrefix: '+234', stripPrefix: false });
  assert.match(writes[0].sql, /strip_prefix, add_prefix/);
  assert.match(writes[0].sql, /:addPrefix/);
  assert.equal(writes[0].params.addPrefix, '+234');
  assert.equal(writes[0].params.stripPrefix, 0);
  assert.equal(audits[0][0], 'outbound-route.create');
});
test('edit can change and clear a prepend; omitted/NULL/blank all mean no prepend', async () => {
  const { service, writes } = fixture();
  for (const value of ['+234', '44', '', ' ', null, undefined]) {
    await service.updateOutbound(7, { ...valid, addPrefix: value });
    const { sql, params } = writes.at(-1);
    assert.match(sql, /add_prefix = :addPrefix/);
    assert.equal(params.addPrefix, value?.trim() || null);
    assert.equal(params.id, 7);
  }
});
test('list returns existing prepend and normalizes legacy missing/NULL values', async () => {
  const db = { query: async sql => sql.includes('select * from prefix_mapping') ? [
    { id: 1, strip_prefix: 1, add_prefix: '+234' },
    { id: 2, strip_prefix: 0, add_prefix: null },
    { id: 3, strip_prefix: 1 },
  ] : [] };
  const service = new RoutingService(db, {}, {});
  const routes = await service.listOutbound();
  assert.deepEqual(routes.map(r => r.add_prefix), ['+234', null, null]);
  assert.deepEqual(routes.map(r => r.strip_prefix), [true, false, true]);
});

const ui = { exports: {} };
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../frontend/src/routing/outbound-number.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
new Function('exports', 'module', compiled)(ui.exports, ui);
const { outboundNumber } = ui.exports;
test('number preview strips first, then prepends without automatic national-number conversion', () => {
  assert.equal(outboundNumber('1238012345678', '123', true, '+234'), '+2348012345678');
  assert.equal(outboundNumber('1238012345678', '123', true), '8012345678');
  assert.equal(outboundNumber('1238012345678', '123', false, '+234'), '+2341238012345678');
  assert.equal(outboundNumber('1238012345678', '123', false), '1238012345678');
  assert.equal(outboundNumber('12308012345678', '123', true, '+234'), '+23408012345678');
  assert.equal(outboundNumber('1232348012345678', '123', true, '+'), '+2348012345678');
  assert.equal(outboundNumber('9998012345678', '123', true, '+234'), null);
  assert.equal(outboundNumber('8012345678', '', true, '+234'), null);
});
test('retry preview rebuilt from original input produces the same number, not double prepend', () => {
  const initial = outboundNumber('1238012345678', '123', true, '+234');
  const retry = outboundNumber('1238012345678', '123', true, '+234');
  assert.equal(initial, retry);
  assert.equal(retry, '+2348012345678');
});
test('tracked SIP snippet bypasses stale prefix caches and rewrites original dialed number', () => {
  // Static contract only: real OpenSIPS syntax and retry behavior need RHEL validation.
  const doc = fs.readFileSync(path.join(__dirname, '../../deploy/opensips-outbound-number-snippets.md'), 'utf8');
  const blocks = [...doc.matchAll(/```opensips\n([\s\S]*?)```/g)].map(m => m[1]);
  assert.equal(blocks.length, 3);
  assert.match(blocks[0], /SELECT prefix,sipline_set_id,CAST\(COALESCE\(strip_prefix,1\) AS CHAR\),COALESCE\(add_prefix,''\)/);
  assert.match(blocks[0], /dialed_number\)\{s.escape.common\}/);
  assert.doesNotMatch(blocks[0], /cache_fetch\(/);
  assert.match(blocks[1], /\$avp\(add_prefix\) = NULL/);
  assert.match(blocks[2], /\$\(avp\(dialed_number\)\{s.substr/);
  assert.match(blocks[2], /\$avp\(add_prefix\) \+ \$avp\(final_dialed_number\)/);
  assert.doesNotMatch(blocks[2], /\$avp\(add_prefix\) \+ \$rU/);
});
test('migration adds one nullable column without rewriting rows; preflight identifies it', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../database/migrations/006_outbound_add_prefix.sql'), 'utf8')
    .replace(/^--.*$/gm, '');
  assert.match(migration, /ALTER TABLE prefix_mapping\s+ADD COLUMN IF NOT EXISTS add_prefix varchar\(32\) NULL DEFAULT NULL AFTER strip_prefix;/);
  assert.doesNotMatch(migration, /\b(DROP|DELETE|UPDATE|TRUNCATE)\b/i);
  const preflight = fs.readFileSync(path.join(__dirname, '../../scripts/preflight-db.sh'), 'utf8');
  assert.match(preflight, /strip_prefix add_prefix; do check_column prefix_mapping/);
  assert.match(preflight, /006_outbound_add_prefix.sql/);
});
