const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { validateSync } = require('class-validator');
const { plainToInstance } = require('class-transformer');
const { RoutingService } = require('../dist/routing/routing.service');
const { ApplicationDestinationMemberInputDto } = require('../dist/routing/dto');

const target = { id: 1, name: 'Production', dispatcher_set_id: 56,
  destinations: [{ id: 162, setid: 56, destination: 'sip:10.81.0.11:5060', priority: 0 }] };
const source = { id: 163, setid: 57, destination: 'sip:10.3.0.150:5060', priority: 0,
  state: 0, description: 'DR Server', socket: 'udp:10.81.0.194:5060', attrs: 'test=1', group_id: 2, group_name: 'DR' };
function fixture(options = {}) {
  const writes = [], audit = []; let reloads = 0;
  const db = {
    transaction: async fn => fn({}),
    query: async (sql, params) => {
      if (sql.includes('where id = :id for update')) return [{ id: 1 }];
      if (sql.includes('g.id as group_id')) return options.missing ? [] : [{ ...source, ...options.source }];
      if (sql.includes('join sbc_trunks t')) return options.provider ? [{ setid: 9, trunk_name: 'Carrier' }] : [];
      if (sql.includes('insert into dispatcher')) { writes.push(params); return { insertId: 999 }; }
      if (sql.includes('select start_did from did_mapping')) return [{ start_did: '2019080000' }];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const service = new RoutingService(db, { reloadProvisioning: async () => { reloads++; return { ok: true }; } },
    { record: async (...args) => audit.push(args) });
  service.findApplicationDestinationGroup = async id => {
    if (id === 1) return options.target ?? structuredClone(target);
    if (options.sourceConflict) throw new Error('Source destination conflicts with provider');
    return { id: 2, name: 'DR', dispatcher_set_id: 57, destinations: [source] };
  };
  service.upsertAddress = async (...args) => { service.authorized = args.slice(0, 4); };
  service.listApplicationDestinations = async () => [{ id: 1, name: 'Production', destinations: writes }];
  return { service, writes, audit, reloads: () => reloads };
}

test('reference DTO accepts an integer server ID; new server fields remain required/validated', () => {
  const valid = input => validateSync(plainToInstance(ApplicationDestinationMemberInputDto, input)).length === 0;
  assert.ok(valid({ existingDestinationId: 163 }));
  assert.ok(valid({ name: 'DR', ip: '10.3.0.150', port: 5060 }));
  for (const input of [{}, { existingDestinationId: 0 }, { existingDestinationId: '163' }, { existingDestinationId: null },
    { name: 'DR', ip: 'not-an-ip', port: 5060 }, { name: 'DR', ip: '10.3.0.150', port: 70000 }]) assert.equal(valid(input), false);
});

test('existing server is resolved from DB and appended without moving or changing its source group', async () => {
  const f = fixture(); await f.service.addApplicationDestinationFailover(1, { existingDestinationId: 163 });
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0], { setId: 56, destination: 'sip:10.3.0.150:5060', socket: source.socket,
    attrs: source.attrs, state: 0, priority: 10, description: 'DR Server' });
  assert.deepEqual(f.service.authorized, [2, '10.3.0.150', 5060, '2019080000']);
  assert.equal(source.setid, 57); assert.equal(f.reloads(), 1); assert.equal(f.audit.length, 1);
});

test('new manual server remains supported; later fallback gets the next priority', async () => {
  const f = fixture({ target: { ...target, destinations: [...target.destinations, { destination: 'sip:10.3.0.150:5060', priority: 10 }] } });
  await f.service.addApplicationDestinationFailover(1, { name: 'UAT', ip: '10.82.1.12', port: 5060 });
  assert.equal(f.writes[0].priority, 20); assert.equal(f.writes[0].destination, 'sip:10.82.1.12:5060');
});

test('stale, provider-owned, conflicted, mixed-input and already-used servers are rejected before writing/reloading', async () => {
  const cases = [
    [fixture({ missing: true }), { existingDestinationId: 163 }],
    [fixture({ provider: true }), { existingDestinationId: 163 }],
    [fixture({ sourceConflict: true }), { existingDestinationId: 163 }],
    [fixture(), { existingDestinationId: 163, ip: '10.0.0.1' }],
    [fixture({ source: { destination: target.destinations[0].destination } }), { existingDestinationId: 163 }],
    [fixture({ source: { destination: 'sip:invalid-host' } }), { existingDestinationId: 163 }],
  ];
  for (const [f, input] of cases) {
    await assert.rejects(f.service.addApplicationDestinationFailover(1, input));
    assert.equal(f.writes.length, 0); assert.equal(f.reloads(), 0);
  }
});

test('reuse preserves disabled state and IPv6 formatting', async () => {
  const f = fixture({ source: { state: 1, destination: 'sip:[2001:db8::10]:5070' } });
  await f.service.addApplicationDestinationFailover(1, { existingDestinationId: 163 });
  assert.equal(f.writes[0].state, 1); assert.equal(f.writes[0].destination, 'sip:[2001:db8::10]:5070');
});

// Test the real UI option builder without introducing a browser/test-framework dependency.
const src = fs.readFileSync(path.resolve(__dirname, '../../frontend/src/routing/failover-servers.ts'), 'utf8');
const compiled = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const ui = { exports: {} }; new Function('exports', 'module', compiled)(ui.exports, ui);
const { failoverServerOptions } = ui.exports;
function group(id, name, members, conflicts = []) {
  return { id, name, dispatcherSetId: id, routeCount: 1, conflicts, destinations: members };
}
function member(id, ip, description, port = 5060) { return { id, ip, port, description, state: 0, destination: `sip:${ip}:${port}` }; }

test('dropdown lists individual servers, deduplicates addresses, excludes target members/provider conflicts', () => {
  const production = group(1, 'Production', [member(10, '10.81.0.11', 'Production'), member(11, '10.3.0.150', 'DR')]);
  const groups = [production, group(2, 'DR', [member(12, '10.3.0.150', 'DR')]),
    group(3, 'UAT', [member(13, '10.82.1.12', 'UAT'), member(14, '10.82.2.12', 'UAT backup')]),
    group(4, 'Other', [member(15, '10.82.1.12', 'Same UAT')]),
    group(5, 'Carrier', [member(16, '46.62.134.9', 'Carrier')], ['provider conflict'])];
  assert.deepEqual(failoverServerOptions(groups, production).map(s => s.id), [13, 14]);
  assert.deepEqual(failoverServerOptions(groups), []);
  assert.deepEqual(failoverServerOptions(groups, { ...production, conflicts: ['bad group'] }), []);
});
