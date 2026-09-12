import { Activity, CheckCircle2, ClipboardList, Plus, RadioTower, RefreshCw, Save } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, ProvisionPlan, Trunk, TrunkInput } from './api/client';

const blankTrunk: TrunkInput = {
  name: 'AdoGlobal',
  providerIp: '46.62.134.9',
  providerPort: 5060,
  username: '02013313100',
  password: '',
  registrationEnabled: true,
  registrationServer: '',
  applicationName: 'Voice1',
  applicationIp: '10.82.1.12',
  applicationPort: 5060,
  accessPrefix: '999',
  stripPrefix: true,
  pilotCli: '02013313100',
  providerDispatcherSet: 1,
  applicationDispatcherSet: 8,
};

function fromTrunk(trunk: Trunk): TrunkInput {
  return {
    name: trunk.name,
    providerIp: trunk.provider_ip,
    providerPort: trunk.provider_port,
    username: trunk.username,
    password: '',
    registrationEnabled: trunk.registration_enabled,
    registrationServer: trunk.registration_server ?? '',
    applicationName: trunk.application_name,
    applicationIp: trunk.application_ip,
    applicationPort: trunk.application_port,
    accessPrefix: trunk.access_prefix,
    stripPrefix: trunk.strip_prefix,
    pilotCli: trunk.pilot_cli,
    providerDispatcherSet: trunk.provider_dispatcher_set,
    applicationDispatcherSet: trunk.application_dispatcher_set,
  };
}

export function App() {
  const [trunks, setTrunks] = useState<Trunk[]>([]);
  const [selected, setSelected] = useState<Trunk | null>(null);
  const [form, setForm] = useState<TrunkInput>(blankTrunk);
  const [plan, setPlan] = useState<ProvisionPlan | null>(null);
  const [status, setStatus] = useState<unknown>(null);
  const [message, setMessage] = useState('');

  async function refresh() {
    setTrunks(await api.listTrunks());
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, []);

  const dashboard = useMemo(
    () =>
      trunks.map((trunk) => ({
        trunk,
        inbound: `${trunk.username} -> ${trunk.application_name} (${trunk.application_ip}:${trunk.application_port})`,
        outbound: `${trunk.access_prefix} -> ${trunk.name}`,
      })),
    [trunks],
  );

  function update<K extends keyof TrunkInput>(key: K, value: TrunkInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setPlan(null);
  }

  function edit(trunk: Trunk) {
    setSelected(trunk);
    setForm(fromTrunk(trunk));
    setPlan(null);
    setStatus(null);
  }

  async function preview(event: FormEvent) {
    event.preventDefault();
    setPlan(await api.previewTrunk(form));
    setMessage('Preview ready. Review the actions before saving.');
  }

  async function save() {
    if (selected) {
      await api.updateTrunk(selected.id, form);
    } else {
      await api.createTrunk(form);
    }
    setMessage('Trunk saved and OpenSIPS reload requested.');
    setSelected(null);
    setForm(blankTrunk);
    setPlan(null);
    await refresh();
  }

  async function checkStatus(trunk: Trunk) {
    setSelected(trunk);
    setStatus(await api.status(trunk.id));
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>OpenSIPS SBC</h1>
          <p>Trunks, registrations, routing, and reload checks.</p>
        </div>
        <button type="button" onClick={() => { setSelected(null); setForm(blankTrunk); setPlan(null); }}>
          <Plus size={18} /> Add trunk
        </button>
      </header>

      {message && <div className="notice">{message}</div>}

      <section className="layout">
        <div className="panel">
          <div className="panelTitle">
            <RadioTower size={18} />
            <h2>Trunks Dashboard</h2>
          </div>
          <div className="trunkList">
            {dashboard.map(({ trunk, inbound, outbound }) => (
              <article className="trunkCard" key={trunk.id}>
                <div>
                  <h3>{trunk.name}</h3>
                  <p>{trunk.provider_ip}:{trunk.provider_port}</p>
                </div>
                <div className="statusLine"><CheckCircle2 size={16} /> REGISTER {trunk.registration_enabled ? 'enabled' : 'off'}</div>
                <div className="routeText">Inbound: {inbound}</div>
                <div className="routeText">Outbound: {outbound}</div>
                <div className="actions">
                  <button type="button" onClick={() => edit(trunk)}>Edit</button>
                  <button type="button" onClick={() => checkStatus(trunk)}><RefreshCw size={16} /> Status</button>
                </div>
              </article>
            ))}
            {trunks.length === 0 && <p className="empty">No trunks provisioned yet.</p>}
          </div>
        </div>

        <form className="panel formPanel" onSubmit={preview}>
          <div className="panelTitle">
            <ClipboardList size={18} />
            <h2>{selected ? `Edit ${selected.name}` : 'Add Trunk'}</h2>
          </div>

          <fieldset>
            <legend>Provider</legend>
            <label>Name<input value={form.name} onChange={(e) => update('name', e.target.value)} required /></label>
            <label>Provider IP<input value={form.providerIp} onChange={(e) => update('providerIp', e.target.value)} required /></label>
            <label>Provider port<input type="number" value={form.providerPort} onChange={(e) => update('providerPort', Number(e.target.value))} required /></label>
            <label>Username / DID<input value={form.username} onChange={(e) => update('username', e.target.value)} required /></label>
            <label>Password<input type="password" value={form.password} onChange={(e) => update('password', e.target.value)} placeholder={selected ? 'Leave blank to keep current' : ''} /></label>
            <label>Registration server<input value={form.registrationServer} onChange={(e) => update('registrationServer', e.target.value)} placeholder="Defaults to provider socket" /></label>
            <label className="check"><input type="checkbox" checked={form.registrationEnabled} onChange={(e) => update('registrationEnabled', e.target.checked)} /> Registration enabled</label>
          </fieldset>

          <fieldset>
            <legend>Inbound</legend>
            <label>Application<input value={form.applicationName} onChange={(e) => update('applicationName', e.target.value)} required /></label>
            <label>Application IP<input value={form.applicationIp} onChange={(e) => update('applicationIp', e.target.value)} required /></label>
            <label>Application port<input type="number" value={form.applicationPort} onChange={(e) => update('applicationPort', Number(e.target.value))} required /></label>
          </fieldset>

          <fieldset>
            <legend>Outbound</legend>
            <label>Access prefix<input value={form.accessPrefix} onChange={(e) => update('accessPrefix', e.target.value)} required /></label>
            <label>Pilot CLI<input value={form.pilotCli} onChange={(e) => update('pilotCli', e.target.value)} required /></label>
            <label>Provider set<input type="number" value={form.providerDispatcherSet} onChange={(e) => update('providerDispatcherSet', Number(e.target.value))} /></label>
            <label>Application set<input type="number" value={form.applicationDispatcherSet} onChange={(e) => update('applicationDispatcherSet', Number(e.target.value))} /></label>
            <label className="check"><input type="checkbox" checked={form.stripPrefix} onChange={(e) => update('stripPrefix', e.target.checked)} /> Strip prefix</label>
          </fieldset>

          <div className="formActions">
            <button type="submit"><Activity size={16} /> Preview</button>
            <button type="button" className="primary" onClick={save} disabled={!plan}><Save size={16} /> Save trunk</button>
          </div>
        </form>
      </section>

      <section className="bottomGrid">
        <PlanPanel plan={plan} />
        <StatusPanel status={status} />
      </section>
    </main>
  );
}

function PlanPanel({ plan }: { plan: ProvisionPlan | null }) {
  return (
    <div className="panel">
      <div className="panelTitle"><Activity size={18} /><h2>Dry-run Preview</h2></div>
      {!plan && <p className="empty">Submit the form to preview SQL and MI actions.</p>}
      {plan?.warnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
      {plan?.summary.map((item) => <p className="summary" key={item}>{item}</p>)}
      {plan?.actions.map((action) => (
        <article className="actionCard" key={action.label}>
          <strong>{action.label}</strong>
          {action.sql && <code>{action.sql}</code>}
          {action.mi && <code>MI: {action.mi}</code>}
          {action.params && <pre>{JSON.stringify(action.params, null, 2)}</pre>}
        </article>
      ))}
    </div>
  );
}

function StatusPanel({ status }: { status: unknown }) {
  return (
    <div className="panel">
      <div className="panelTitle"><RefreshCw size={18} /><h2>Live Status</h2></div>
      {!status && <p className="empty">Choose Status on a trunk to query OpenSIPS MI.</p>}
      {status && <pre className="statusBox">{JSON.stringify(status, null, 2)}</pre>}
    </div>
  );
}
