import {
  Activity, ArrowDownToLine, ArrowUpFromLine, ChevronRight, CircleDot,
  Network, Plus, Power, RadioTower, RefreshCw, Save, Server, X,
} from 'lucide-react';
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  api, InboundRoute, InboundRouteInput, OutboundRoute, OutboundRouteInput,
  ProviderDispatcherSets, Trunk, TrunkInput, TrunkStatus,
} from './api/client';

type Section = 'trunks' | 'inbound' | 'outbound';
type Editor = { kind: Section; id?: number } | null;

const newTrunk = (providerDispatcherSet: number): TrunkInput => ({
  name: '', providerIp: '', providerPort: 5060, username: '', password: '',
  registrationEnabled: true, registrationExpiry: 3600,
  registrationServer: '', bindingUri: '', customPaiUri: '', providerDispatcherSet,
});

const newInbound = (trunks: Trunk[]): InboundRouteInput => ({
  startDid: '', endDid: '', trunkId: trunks[0]?.id ?? 0, applicationName: '',
  applicationIp: '', applicationPort: 5060, destinationSetId: 8, description: '',
});

const newOutbound = (trunks: Trunk[]): OutboundRouteInput => ({
  prefix: '', trunkId: trunks[0]?.id ?? 0, pilotCli: trunks[0]?.username ?? '',
  stripPrefix: true, routingMode: 'dial_prefix', description: '',
});

function trunkInput(trunk: Trunk): TrunkInput {
  return {
    name: trunk.name, providerIp: trunk.provider_ip, providerPort: trunk.provider_port,
    username: trunk.username, password: '', registrationEnabled: trunk.registration_enabled,
    registrationExpiry: trunk.registration_expiry ?? 3600,
    registrationServer: trunk.registration_server ?? '', bindingUri: '', customPaiUri: trunk.custom_pai_uri ?? '', providerDispatcherSet: trunk.provider_dispatcher_set,
  };
}

export function App() {
  const [section, setSection] = useState<Section>('trunks');
  const [trunks, setTrunks] = useState<Trunk[]>([]);
  const [statuses, setStatuses] = useState<Record<number, TrunkStatus>>({});
  const [providerSets, setProviderSets] = useState<ProviderDispatcherSets>({ sets: [], usedSetIds: [], nextSetId: 1 });
  const [inbound, setInbound] = useState<InboundRoute[]>([]);
  const [outbound, setOutbound] = useState<OutboundRoute[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const [trunkRows, statusRows, providerSetRows, inboundRows, outboundRows] = await Promise.all([
        api.listTrunks(), api.trunkStatuses(), api.providerSets(), api.listInboundRoutes(), api.listOutboundRoutes(),
      ]);
      setTrunks(trunkRows);
      setStatuses(Object.fromEntries(statusRows.map((status) => [status.trunkId, status])));
      setProviderSets(providerSetRows);
      setInbound(inboundRows); setOutbound(outboundRows);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSelected(null); }, [section]);

  const title = section === 'trunks' ? 'SIP Trunks' : section === 'inbound' ? 'Inbound Routing' : 'Outbound Routing';
  const subtitle = section === 'trunks'
    ? 'Manage provider connections and monitor their live OpenSIPS status.'
    : section === 'inbound'
      ? 'Route incoming DIDs from a provider trunk to an application server.'
      : 'Send dialled prefixes through the correct provider trunk.';

  const saved = async (text: string) => {
    setMessage(text); setEditor(null); await load();
    window.setTimeout(() => setMessage(''), 4000);
  };

  const toggleTrunk = async (trunk: Trunk) => {
    const action = trunk.enabled ? 'disable' : 'enable';
    if (trunk.enabled && !window.confirm(`Disable ${trunk.name}? New inbound and outbound calls will stop using this trunk.`)) return;
    setBusy(true); setError('');
    try {
      await api.setTrunkEnabled(trunk.id, !trunk.enabled);
      setMessage(`${trunk.name} ${action}d.`);
      await load();
      window.setTimeout(() => setMessage(''), 4000);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand"><span className="brandMark"><RadioTower size={22} /></span><span>OpenSIPS<br /><small>SBC Console</small></span></div>
        <nav>
          <Nav active={section === 'trunks'} icon={<Network />} label="SIP Trunks" count={trunks.length} onClick={() => setSection('trunks')} />
          <Nav active={section === 'inbound'} icon={<ArrowDownToLine />} label="Inbound Routing" count={inbound.length} onClick={() => setSection('inbound')} />
          <Nav active={section === 'outbound'} icon={<ArrowUpFromLine />} label="Outbound Routing" count={outbound.length} onClick={() => setSection('outbound')} />
        </nav>
        <div className="sidebarFoot"><CircleDot size={14} /> OpenSIPS provisioning</div>
      </aside>

      <main className="workspace">
        <header className="pageHeader">
          <div><p className="eyebrow">CONFIGURATION</p><h1>{title}</h1><p>{subtitle}</p></div>
          <div className="headerActions">
            <button className="iconButton" title="Refresh data" disabled={busy} onClick={() => void load()}><RefreshCw className={busy ? 'spin' : ''} size={18} /></button>
            <button className="primary" onClick={() => setEditor({ kind: section })}><Plus size={18} /> Add {section === 'trunks' ? 'trunk' : 'route'}</button>
          </div>
        </header>

        {message && <div className="toast success">{message}</div>}
        {error && <div className="toast error">{error}</div>}

        <section className="metrics">
          {section === 'trunks' && <>
            <Metric label="Enabled trunks" value={trunks.filter((trunk) => trunk.enabled).length} />
            <Metric label="Providers active" value={Object.values(statuses).filter((item) => item.provider.ok).length} tone="green" />
            <Metric label="Registered" value={Object.values(statuses).filter((item) => item.registration.ok && item.registration.enabled).length} tone="blue" />
          </>}
          {section === 'inbound' && <>
            <Metric label="Inbound routes" value={inbound.length} />
            <Metric label="DID ranges" value={inbound.filter((route) => route.end_did !== route.start_did).length} tone="blue" />
            <Metric label="Application sets" value={new Set(inbound.map((route) => route.destination_set_id)).size} tone="green" />
          </>}
          {section === 'outbound' && <>
            <Metric label="Outbound routes" value={outbound.length} />
            <Metric label="Provider trunks" value={new Set(outbound.map((route) => route.trunk_id).filter(Boolean)).size} tone="blue" />
            <Metric label="Strip prefix" value={outbound.filter((route) => route.strip_prefix).length} tone="green" />
          </>}
        </section>

        {section === 'trunks' && <TrunkList rows={trunks} statuses={statuses} selected={selected} onSelect={setSelected} onEdit={(id) => setEditor({ kind: 'trunks', id })} onToggle={toggleTrunk} busy={busy} />}
        {section === 'inbound' && <InboundList rows={inbound} selected={selected} onSelect={setSelected} onEdit={(id) => setEditor({ kind: 'inbound', id })} />}
        {section === 'outbound' && <OutboundList rows={outbound} selected={selected} onSelect={setSelected} onEdit={(id) => setEditor({ kind: 'outbound', id })} />}
      </main>

      {editor?.kind === 'trunks' && <TrunkEditor trunk={trunks.find((row) => row.id === editor.id)} providerSets={providerSets} onClose={() => setEditor(null)} onSaved={saved} />}
      {editor?.kind === 'inbound' && <InboundEditor route={inbound.find((row) => row.id === editor.id)} trunks={trunks} onClose={() => setEditor(null)} onSaved={saved} />}
      {editor?.kind === 'outbound' && <OutboundEditor route={outbound.find((row) => row.id === editor.id)} trunks={trunks} onClose={() => setEditor(null)} onSaved={saved} />}
    </div>
  );
}

function Nav({ active, icon, label, count, onClick }: { active: boolean; icon: ReactNode; label: string; count: number; onClick: () => void }) {
  return <button className={`navItem ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span><b>{count}</b></button>;
}

function Metric({ label, value, tone = '' }: { label: string; value: number; tone?: string }) {
  return <div className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function StatusPill({ ok, text }: { ok: boolean; text: string }) {
  return <span className={`statusPill ${ok ? 'ok' : 'warn'}`}><i />{text}</span>;
}

function Empty({ text }: { text: string }) {
  return <div className="emptyState"><Server size={34} /><h3>Nothing here yet</h3><p>{text}</p></div>;
}

function TrunkList({ rows, statuses, selected, onSelect, onEdit, onToggle, busy }: { rows: Trunk[]; statuses: Record<number, TrunkStatus>; selected: number | null; onSelect: (id: number) => void; onEdit: (id: number) => void; onToggle: (trunk: Trunk) => Promise<void>; busy: boolean }) {
  if (!rows.length) return <Empty text="Add your first provider trunk to begin." />;
  return <div className="contentGrid"><div className="dataPanel"><div className="tableHead"><span>Trunk</span><span>Provider</span><span>Registration</span><span>Gateway</span><span /></div>{rows.map((trunk) => {
    const status = statuses[trunk.id];
    return <button className={`dataRow trunkRow ${selected === trunk.id ? 'selected' : ''} ${trunk.enabled ? '' : 'disabledRow'}`} key={trunk.id} onClick={() => onSelect(trunk.id)}>
      <span className="primaryCell"><b>{trunk.name}</b><small>{trunk.username}{trunk.enabled ? '' : ' · Trunk disabled'}</small></span>
      <span><code>{trunk.provider_ip}:{trunk.provider_port}</code><small>Set {trunk.provider_dispatcher_set}</small></span>
      <StatusPill ok={status?.registration.ok ?? false} text={status?.registration.state ?? 'Checking'} />
      <StatusPill ok={status?.provider.ok ?? false} text={status?.provider.state ?? 'Checking'} />
      <ChevronRight size={18} />
    </button>;
  })}</div>{selected && <TrunkDetail trunk={rows.find((row) => row.id === selected)!} status={statuses[selected]} onEdit={() => onEdit(selected)} onToggle={onToggle} busy={busy} />}</div>;
}

function TrunkDetail({ trunk, status, onEdit, onToggle, busy }: { trunk: Trunk; status?: TrunkStatus; onEdit: () => void; onToggle: (trunk: Trunk) => Promise<void>; busy: boolean }) {
  return <Detail title={trunk.name} subtitle={trunk.enabled ? 'Provider trunk · Enabled' : 'Provider trunk · Disabled'} onEdit={onEdit} secondaryAction={<button className={trunk.enabled ? 'danger' : 'successAction'} disabled={busy} onClick={() => void onToggle(trunk)}><Power size={17} />{trunk.enabled ? 'Disable trunk' : 'Enable trunk'}</button>}>
    <DetailRow label="Provider address" value={`${trunk.provider_ip}:${trunk.provider_port}`} />
    <DetailRow label="Provider set" value={trunk.provider_dispatcher_set} />
    <DetailRow label="SIP username" value={trunk.username} />
    <DetailRow label="P-Asserted-Identity" value={trunk.custom_pai_uri || 'Same as From header'} />
    <DetailRow label="Registration" value={status?.registration.state ?? 'Unknown'} />
    {trunk.registration_enabled && <DetailRow label="Registration expiry" value={`${trunk.registration_expiry} seconds`} />}
    <DetailRow label="Gateway" value={status?.provider.state ?? 'Unknown'} />
    {status?.registration.error && <p className="inlineError">{status.registration.error}</p>}
  </Detail>;
}

function InboundList({ rows, selected, onSelect, onEdit }: { rows: InboundRoute[]; selected: number | null; onSelect: (id: number) => void; onEdit: (id: number) => void }) {
  if (!rows.length) return <Empty text="Add an inbound route to send a DID to an application server." />;
  return <div className="contentGrid"><div className="dataPanel"><div className="tableHead inboundHead"><span>Inbound ID / DID</span><span>From trunk</span><span>Destination server</span><span /></div>{rows.map((route) => <button className={`dataRow inboundRow ${selected === route.id ? 'selected' : ''}`} key={route.id} onClick={() => onSelect(route.id)}>
    <span className="primaryCell"><b>{route.start_did}{route.end_did !== route.start_did ? ` – ${route.end_did}` : ''}</b><small>Route #{route.id}</small></span>
    <span><b>{route.trunk_name}</b><small>Provider set {route.provider_set_id ?? '—'}</small></span>
    <span><code>{route.application_destination ?? 'Not provisioned'}</code><small>{route.application_name} · Set {route.destination_set_id}</small></span><ChevronRight size={18} />
  </button>)}</div>{selected && <InboundDetail route={rows.find((row) => row.id === selected)!} onEdit={() => onEdit(selected)} />}</div>;
}

function InboundDetail({ route, onEdit }: { route: InboundRoute; onEdit: () => void }) {
  return <Detail title={route.start_did} subtitle="Inbound call route" onEdit={onEdit}>
    <div className="routeFlow"><span>{route.trunk_name}</span><ArrowDownToLine size={18} /><span>{route.application_name}</span></div>
    <DetailRow label="End DID" value={route.end_did} /><DetailRow label="Provider set" value={route.provider_set_id ?? 'Unassigned'} />
    <DetailRow label="Application" value={route.application_destination ?? 'Not provisioned'} /><DetailRow label="Destination set" value={route.destination_set_id} />
    <DetailRow label="Description" value={route.description || '—'} />
  </Detail>;
}

function OutboundList({ rows, selected, onSelect, onEdit }: { rows: OutboundRoute[]; selected: number | null; onSelect: (id: number) => void; onEdit: (id: number) => void }) {
  if (!rows.length) return <Empty text="Add an outbound prefix and select the trunk that should carry it." />;
  return <div className="contentGrid"><div className="dataPanel"><div className="tableHead outboundHead"><span>Dial prefix</span><span>Provider trunk</span><span>Routing</span><span /></div>{rows.map((route) => <button className={`dataRow outboundRow ${selected === route.id ? 'selected' : ''}`} key={route.id} onClick={() => onSelect(route.id)}>
    <span className="prefixBadge">{route.prefix}</span><span className="primaryCell"><b>{route.trunk_name}</b><small>{route.provider_destination ?? `Set ${route.sipline_set_id}`}</small></span>
    <span><b>{route.strip_prefix ? 'Strip prefix' : 'Keep prefix'}</b><small>{route.routing_mode.replace('_', ' ')}</small></span><ChevronRight size={18} />
  </button>)}</div>{selected && <OutboundDetail route={rows.find((row) => row.id === selected)!} onEdit={() => onEdit(selected)} />}</div>;
}

function OutboundDetail({ route, onEdit }: { route: OutboundRoute; onEdit: () => void }) {
  return <Detail title={route.prefix} subtitle="Outbound dial prefix" onEdit={onEdit}>
    <DetailRow label="Provider trunk" value={route.trunk_name} /><DetailRow label="Provider destination" value={route.provider_destination ?? 'Not provisioned'} />
    <DetailRow label="Provider set" value={route.sipline_set_id} /><DetailRow label="Pilot CLI" value={route.pilot_cli ?? '—'} />
    <DetailRow label="Prefix handling" value={route.strip_prefix ? 'Strip before sending' : 'Keep in called number'} /><DetailRow label="Description" value={route.description || '—'} />
  </Detail>;
}

function Detail({ title, subtitle, onEdit, secondaryAction, children }: { title: string; subtitle: string; onEdit: () => void; secondaryAction?: ReactNode; children: ReactNode }) {
  return <aside className="detailPanel"><div className="detailTop"><span className="detailIcon"><Activity size={20} /></span><div><h2>{title}</h2><p>{subtitle}</p></div></div><div className="detailBody">{children}</div><div className="detailActions"><button onClick={onEdit}>Edit configuration</button>{secondaryAction}</div></aside>;
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return <div className="detailRow"><span>{label}</span><b>{value}</b></div>;
}

function Drawer({ title, description, busy, error, onClose, onSubmit, children }: { title: string; description: string; busy: boolean; error: string; onClose: () => void; onSubmit: (event: FormEvent) => void; children: ReactNode }) {
  return <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="drawer"><header><div><h2>{title}</h2><p>{description}</p></div><button className="iconButton" type="button" onClick={onClose}><X size={20} /></button></header><form onSubmit={onSubmit}><div className="formBody">{children}{error && <div className="toast error">{error}</div>}</div><footer><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}><Save size={17} />{busy ? 'Saving…' : 'Save'}</button></footer></form></aside></div>;
}

function TrunkEditor({ trunk, providerSets, onClose, onSaved }: { trunk?: Trunk; providerSets: ProviderDispatcherSets; onClose: () => void; onSaved: (text: string) => Promise<void> }) {
  const [setMode, setSetMode] = useState<'existing' | 'new'>(trunk ? 'existing' : 'new');
  const [setSearch, setSetSearch] = useState('');
  const [form, setForm] = useState<TrunkInput>(() => trunk
    ? trunkInput(trunk)
    : newTrunk(providerSets.nextSetId));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const selectedSet = providerSets.sets.find((item) => item.setId === form.providerDispatcherSet);
  const visibleSets = providerSets.sets.filter((item) =>
    `${item.setId} ${providerSetLabel(item)}`.toLowerCase().includes(setSearch.trim().toLowerCase()),
  );
  const selectMode = (mode: 'existing' | 'new') => {
    setSetMode(mode);
    setError('');
    setForm({
      ...form,
      providerDispatcherSet: mode === 'new'
        ? providerSets.nextSetId
        : trunk?.provider_dispatcher_set ?? providerSets.sets[0]?.setId ?? 0,
    });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    const setAlreadyUsed = providerSets.usedSetIds.includes(form.providerDispatcherSet)
      && form.providerDispatcherSet !== trunk?.provider_dispatcher_set;
    if (setMode === 'new' && setAlreadyUsed) {
      setError(`Set ${form.providerDispatcherSet} already exists. Choose “Use existing set” or enter an unused number.`);
      return;
    }
    setBusy(true);
    const normalizedForm: TrunkInput = { ...form, customPaiUri: form.customPaiUri?.trim() || undefined };
    const submittedForm: TrunkInput = normalizedForm.registrationEnabled
      ? normalizedForm
      : { ...normalizedForm, registrationExpiry: undefined };
    try { trunk ? await api.updateTrunk(trunk.id, submittedForm) : await api.createTrunk(submittedForm); await onSaved(trunk ? 'Trunk updated.' : 'Trunk added.'); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };
  return <Drawer title={trunk ? 'Edit trunk' : 'Add a new trunk'} description="Configure the SIP provider connection. Routes are managed separately." busy={busy} error={error} onClose={onClose} onSubmit={submit}>
    <FormSection title="Identity"><Field label="Trunk name"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="AdoGlobal" /></Field><Field label="SIP username / pilot"><input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="02013313100" /></Field><Field label="Custom P-Asserted-Identity (optional)" hint="Complete tel: or sip: URI. Leave blank to use the same identity as the From header."><input value={form.customPaiUri ?? ''} onChange={(e) => setForm({ ...form, customPaiUri: e.target.value })} placeholder="tel:+2348139856030;user=phone" /></Field></FormSection>
    <FormSection title="Provider gateway">
      <div className="twoCols"><Field label="Provider IP"><input required value={form.providerIp} onChange={(e) => setForm({ ...form, providerIp: e.target.value })} placeholder="46.62.134.9" /></Field><Field label="Port"><input required type="number" min="1" max="65535" value={form.providerPort} onChange={(e) => setForm({ ...form, providerPort: Number(e.target.value) })} /></Field></div>
      <div className="segmented" aria-label="Provider set mode"><button type="button" className={setMode === 'existing' ? 'active' : ''} disabled={!providerSets.sets.length} onClick={() => selectMode('existing')}>Use existing set</button><button type="button" className={setMode === 'new' ? 'active' : ''} onClick={() => selectMode('new')}>Create new set</button></div>
      {setMode === 'existing' ? <>
        <Field label="Search provider sets" hint="Search by set number, trunk name, provider name, or gateway."><input type="search" value={setSearch} onChange={(e) => setSetSearch(e.target.value)} placeholder="Search existing sets…" /></Field>
        <div className="setOptions">{visibleSets.map((item) => <button type="button" className={item.setId === form.providerDispatcherSet ? 'selected' : ''} key={item.setId} onClick={() => setForm({ ...form, providerDispatcherSet: item.setId })}><b>Set {item.setId}</b><span>{providerSetLabel(item)}</span></button>)}{!visibleSets.length && <p>No matching provider sets.</p>}</div>
        {selectedSet && <div className="setPreview"><b>Set {selectedSet.setId}</b><span>{providerSetLabel(selectedSet)}</span><small>{selectedSet.destinations.length} gateway{selectedSet.destinations.length === 1 ? '' : 's'} currently in this group</small></div>}
      </> : <>
        <Field label="New provider set number" hint={`Suggested next unused set: ${providerSets.nextSetId}`}><input required type="number" min="1" value={form.providerDispatcherSet} onChange={(e) => setForm({ ...form, providerDispatcherSet: Number(e.target.value) })} /></Field>
        <div className="setNotice">The set is created when this trunk is saved. OpenSIPS does not need a separate empty set record.</div>
      </>}
    </FormSection>
    <FormSection title="Registration">
      <label className="switchRow"><span><b>Register with provider</b><small>OpenSIPS sends REGISTER requests for this trunk</small></span><input type="checkbox" checked={form.registrationEnabled} onChange={(e) => setForm({ ...form, registrationEnabled: e.target.checked })} /></label>
      {form.registrationEnabled && <>
        <Field label={trunk ? 'Password (leave blank to keep current)' : 'Password'}><input required={!trunk} type="password" value={form.password ?? ''} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <Field label="Registration expiry" hint="How often OpenSIPS renews the provider registration. Default: 3600 seconds."><input required type="number" min="60" max="86400" step="1" value={form.registrationExpiry ?? 3600} onChange={(e) => setForm({ ...form, registrationExpiry: Number(e.target.value) })} /></Field>
        <Field label="Registrar (optional)" hint="Defaults to the provider IP and port"><input value={form.registrationServer ?? ''} onChange={(e) => setForm({ ...form, registrationServer: e.target.value })} placeholder="sip:46.62.134.9:5060" /></Field>
        <Field label="SBC Contact URI (optional)" hint="For example sip:02013313100@10.81.0.194:5060. Leave blank to reuse an existing binding or the server setting."><input value={form.bindingUri ?? ''} onChange={(e) => setForm({ ...form, bindingUri: e.target.value })} placeholder={`sip:${form.username || 'username'}@10.81.0.194:5060`} /></Field>
      </>}
    </FormSection>
  </Drawer>;
}

function InboundEditor({ route, trunks, onClose, onSaved }: { route?: InboundRoute; trunks: Trunk[]; onClose: () => void; onSaved: (text: string) => Promise<void> }) {
  const initial = useMemo<InboundRouteInput>(() => route ? { startDid: route.start_did, endDid: route.end_did, trunkId: route.trunk_id ?? trunks[0]?.id ?? 0, applicationName: route.application_name, applicationIp: route.application_ip ?? '', applicationPort: route.application_port ?? 5060, destinationSetId: route.destination_set_id, description: route.description ?? '' } : newInbound(trunks), [route, trunks]);
  const [form, setForm] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { route ? await api.updateInboundRoute(route.id, form) : await api.createInboundRoute(form); await onSaved(route ? 'Inbound route updated.' : 'Inbound route added.'); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  return <Drawer title={route ? 'Edit inbound route' : 'Add inbound route'} description="Define which incoming number goes from a provider trunk to an application." busy={busy} error={error} onClose={onClose} onSubmit={submit}>
    {!trunks.length && <div className="toast error">Add a trunk before creating a route.</div>}
    <FormSection title="Incoming call"><div className="twoCols"><Field label="Start DID"><input required value={form.startDid} onChange={(e) => setForm({ ...form, startDid: e.target.value })} placeholder="02013313100" /></Field><Field label="End DID (optional)"><input value={form.endDid ?? ''} onChange={(e) => setForm({ ...form, endDid: e.target.value })} placeholder="Same as start DID" /></Field></div><Field label="Incoming provider trunk"><select required value={form.trunkId} onChange={(e) => setForm({ ...form, trunkId: Number(e.target.value) })}><option value={0}>Select a trunk</option>{trunks.map((item) => <option key={item.id} value={item.id}>{item.name} — set {item.provider_dispatcher_set}</option>)}</select></Field></FormSection>
    <FormSection title="Destination application"><Field label="Server name"><input required value={form.applicationName} onChange={(e) => setForm({ ...form, applicationName: e.target.value })} placeholder="Voice1" /></Field><div className="twoCols"><Field label="Server IP"><input required value={form.applicationIp} onChange={(e) => setForm({ ...form, applicationIp: e.target.value })} placeholder="10.82.1.12" /></Field><Field label="SIP port"><input required type="number" min="1" max="65535" value={form.applicationPort} onChange={(e) => setForm({ ...form, applicationPort: Number(e.target.value) })} /></Field></div><Field label="Destination dispatcher set"><input required type="number" min="1" value={form.destinationSetId} onChange={(e) => setForm({ ...form, destinationSetId: Number(e.target.value) })} /></Field></FormSection>
    <FormSection title="Notes"><Field label="Description (optional)"><input value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field></FormSection>
  </Drawer>;
}

function OutboundEditor({ route, trunks, onClose, onSaved }: { route?: OutboundRoute; trunks: Trunk[]; onClose: () => void; onSaved: (text: string) => Promise<void> }) {
  const initial = useMemo<OutboundRouteInput>(() => route ? { prefix: route.prefix, trunkId: route.trunk_id ?? trunks[0]?.id ?? 0, pilotCli: route.pilot_cli ?? trunks.find((item) => item.id === route.trunk_id)?.username ?? '', stripPrefix: route.strip_prefix, routingMode: 'dial_prefix', description: route.description ?? '' } : newOutbound(trunks), [route, trunks]);
  const [form, setForm] = useState(initial); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const pickTrunk = (id: number) => setForm({ ...form, trunkId: id, pilotCli: trunks.find((item) => item.id === id)?.username ?? form.pilotCli });
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { route ? await api.updateOutboundRoute(route.id, form) : await api.createOutboundRoute(form); await onSaved(route ? 'Outbound route updated.' : 'Outbound route added.'); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } };
  return <Drawer title={route ? 'Edit outbound route' : 'Add outbound route'} description="Choose the access prefix and the provider trunk that will carry the call." busy={busy} error={error} onClose={onClose} onSubmit={submit}>
    {!trunks.length && <div className="toast error">Add a trunk before creating a route.</div>}
    <FormSection title="Dial rule"><Field label="Dial prefix" hint="Digits users dial before the destination number"><input required value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} placeholder="999" /></Field><label className="switchRow"><span><b>Strip prefix</b><small>Remove the access prefix before sending the call</small></span><input type="checkbox" checked={form.stripPrefix} onChange={(e) => setForm({ ...form, stripPrefix: e.target.checked })} /></label></FormSection>
    <FormSection title="Provider"><Field label="Outbound trunk"><select required value={form.trunkId} onChange={(e) => pickTrunk(Number(e.target.value))}><option value={0}>Select a trunk</option>{trunks.map((item) => <option key={item.id} value={item.id}>{item.name} — {item.provider_ip}</option>)}</select></Field><Field label="Pilot CLI" hint="Caller ID authorized for this provider"><input required value={form.pilotCli} onChange={(e) => setForm({ ...form, pilotCli: e.target.value })} /></Field></FormSection>
    <FormSection title="Notes"><Field label="Description (optional)"><input value={form.description ?? ''} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field></FormSection>
  </Drawer>;
}

function FormSection({ title, children }: { title: string; children: ReactNode }) { return <section className="formSection"><h3>{title}</h3>{children}</section>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function providerSetLabel(set: ProviderDispatcherSets['sets'][number]) {
  const names = set.trunks.length ? set.trunks.join(', ') : set.destinations.map((item) => item.description).filter(Boolean).join(', ');
  const gateways = set.destinations.map((item) => item.destination.replace(/^sip:/, '')).join(', ');
  return [names || 'Provider set', gateways].filter(Boolean).join(' — ');
}
function errorText(cause: unknown) { if (!(cause instanceof Error)) return 'Something went wrong.'; try { const parsed = JSON.parse(cause.message); return Array.isArray(parsed.message) ? parsed.message.join(' ') : parsed.message || cause.message; } catch { return cause.message; } }

export default App;
