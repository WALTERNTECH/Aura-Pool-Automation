import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ActionButton } from "../components/Action";
import { DataTable, SimpleTable } from "../components/DataTable";
import { Banner, Card, Copy, Dialog, ErrorBox, KV, Loading, PageHead, Status, Tabs, toast } from "../components/ui";
import { call, errText } from "../lib/api";
import { ago, dt, humanize, ksh, parseKsh } from "../lib/format";
import { useApi, useInterval, useQueryState } from "../lib/hooks";
import { useSession } from "../lib/session";

export function TableList() {
  const { can } = useSession();
  const [sp] = useSearchParams();
  const [f, setF] = useQueryState({ q: "", status: "", merchant: "" });
  const [open, setOpen] = useState(sp.get("new") === "1");
  return (
    <div className="stack">
      <PageHead title="Tables and devices" sub="Every table, its device, and whether it can take a game right now." actions={can("tables.manage") ? <button className="btn primary" onClick={() => setOpen(true)}>New table</button> : null} />
      <DataTable
        storageKey="tables"
        path="/tables"
        params={f}
        refreshMs={30_000}
        rowLink={(t) => `/tables/${t.id}`}
        toolbar={
          <>
            <input className="input sm" placeholder="Search ID, name, location" value={f.q} onChange={(e) => setF({ q: e.target.value })} style={{ width: 220 }} />
            <select className="input sm" value={f.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">Any status</option>
              {["active", "maintenance", "disabled"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
          </>
        }
        columns={[
          { key: "id", label: "Table", render: (t) => <b>{t.id}</b> },
          { key: "name", label: "Name", render: (t) => <>{t.name}<div className="tiny faint">{t.location}</div></> },
          { key: "merchant", label: "Merchant", render: (t) => <span className="small">{t.merchant}</span> },
          { key: "status", label: "Status", render: (t) => <Status s={t.status} /> },
          { key: "device", label: "Device", render: (t) => (t.device_id ? <><Status s={t.device_status === "revoked" ? "revoked" : t.online ? "online" : "offline"} />{t.virtual ? <span className="badge info" style={{ marginLeft: 4 }}>virtual</span> : null}<div className="tiny faint">seen {ago(t.last_seen_at)}</div></> : <span className="badge">none</span>) },
          { key: "rssi", label: "Signal", right: true, render: (t) => (t.rssi != null ? `${t.rssi} dBm` : "—"), hidden: true },
          { key: "fw", label: "Firmware", render: (t) => <span className="mono">{t.firmware_version ?? "—"}</span>, hidden: true },
          { key: "price", label: "Price", right: true, render: (t) => ksh(t.price_minor) },
          { key: "waiting", label: "Waiting", right: true, render: (t) => (t.waiting ? <span className="badge wait">{t.waiting}</span> : "0") },
          { key: "last", label: "Last game", render: (t) => <span className="small">{ago(t.last_game_at)}</span> },
        ]}
      />
      {open ? <NewTable merchant={sp.get("merchant") ?? ""} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function NewTable({ merchant, onClose }: { merchant: string; onClose: () => void }) {
  const nav = useNavigate();
  const merchants = useApi<any>("/merchants?pageSize=500&status=");
  const pricing = useApi<any>("/pricing");
  const [f, setF] = useState({ merchantId: merchant, name: "", location: "", price: "", unlock: "", status: "active" });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (pricing.data && !f.price) setF((x) => ({ ...x, price: String(pricing.data.defaults.price_minor / 100), unlock: String(pricing.data.defaults.unlock_seconds) }));
  }, [pricing.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open onClose={onClose} title="New table">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const r = await call<{ id: string }>("/tables", { method: "POST", body: { merchantId: f.merchantId, name: f.name, location: f.location || null, priceMinor: parseKsh(f.price) ?? undefined, unlockSeconds: Number(f.unlock) || undefined, status: f.status } });
            toast(`${r.id} created`);
            nav(`/tables/${r.id}`);
          } catch (x) {
            setErr(errText(x));
          }
        }}
      >
        <p className="muted small">The next table ID is assigned automatically. The table counts as started the first time its device comes online.</p>
        <div className="field">
          <label htmlFor="m">Merchant</label>
          <select id="m" className="input" value={f.merchantId} onChange={(e) => setF({ ...f, merchantId: e.target.value })}>
            <option value="">Choose…</option>
            {(merchants.data?.items ?? []).filter((m: any) => m.status !== "closed").map((m: any) => <option key={m.id} value={m.id}>{m.code} · {m.business_name}</option>)}
          </select>
        </div>
        <div className="grid2">
          <div className="field"><label>Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label>Location</label><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></div>
          <div className="field"><label>Price per game (KSh)</label><input className="input" inputMode="numeric" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></div>
          <div className="field"><label>Unlock time (seconds, 5–60)</label><input className="input" inputMode="numeric" value={f.unlock} onChange={(e) => setF({ ...f, unlock: e.target.value })} /></div>
        </div>
        <div className="field">
          <label>Status</label>
          <select className="input" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="active">Active</option>
            <option value="maintenance">Maintenance</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
        {err ? <ErrorBox text={err} /> : null}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!f.merchantId || f.name.length < 2}>Create table</button></div>
      </form>
    </Dialog>
  );
}

export function TableDetail() {
  const { id = "" } = useParams();
  const { can, me } = useSession();
  const d = useApi<any>(`/tables/${id}`, { refreshMs: 15_000 });
  const merchants = useApi<any>(can("tables.manage") ? "/merchants?pageSize=500" : null);
  const [tab, setTab] = useState("device");
  const [creds, setCreds] = useState<any>(null);
  const [cmd, setCmd] = useState<string | null>(null);
  if (d.loading) return <Loading h={400} />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const t = d.data.table;
  const dev = d.data.device;
  const reload = () => void d.reload();
  const provision = async (replace: boolean, virtual: boolean) => {
    try {
      setCreds(await call(`/tables/${id}/provision`, { method: "POST", body: { replace, virtual } }));
      reload();
    } catch (x) {
      toast(errText(x), true);
    }
  };
  return (
    <div className="stack">
      <PageHead
        crumb={{ to: "/tables", label: "Tables" }}
        title={<>{t.id} · {t.name}</>}
        sub={<>{t.merchant} · {t.location ?? "no location"} · <Status s={t.status} /> {dev ? <Status s={dev.status === "provisioned" ? (dev.online ? "online" : "offline") : dev.status} /> : null}</>}
        actions={
          <>
            <a className="btn" href={`/v1/a/tables/${id}/sheet`} target="_blank" rel="noopener">Print sheet</a>
            {can("tables.test_unlock") && dev?.status === "provisioned" ? (
              <ActionButton label="Test unlock" title={`Test unlock ${t.id}`} description={`Runs the relay for ${t.unlock_seconds} seconds. Not counted as a paid game. The result shows here as soon as the table acknowledges.`} path={`/tables/${id}/test-unlock`} confirm="Send test unlock" onDone={(r) => setCmd(r.cmdId)} />
            ) : null}
            {can("tables.manual_unlock") && dev?.status === "provisioned" ? (
              <ActionButton tone="plain" label="Manual unlock" title={`Manual unlock ${t.id}`} description="For a customer whose game couldn't be unlocked any other way. Not counted as a paid game; logged and visible to the merchant." path={`/tables/${id}/manual-unlock`} confirm="Unlock" onDone={(r) => setCmd(r.cmdId)} />
            ) : null}
          </>
        }
      />
      {cmd ? <CommandWatch tableId={id} cmdId={cmd} onClose={() => { setCmd(null); reload(); }} /> : null}
      {d.data.waiting.length ? <Banner tone="wait" icon="clock" title={`${d.data.waiting.length} paid game(s) waiting for this table`}>They retry until {dt(d.data.waiting[0].expires_at)} and then expire to the Unlock failed queue.</Banner> : null}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "device", label: "Device" }, { value: "settings", label: "Table" }, { value: "commands", label: "Commands", n: d.data.commands.length }, { value: "events", label: "Events" }, { value: "payments", label: "Payments" }]} />
      {tab === "device" ? (
        <div className="grid2">
          <Card title="Device">
            {dev ? (
              <KV rows={[
                ["Device ID", <span className="mono">{dev.id}</span>],
                ["Credentials", <><Status s={dev.status} /> <span className="small faint">version {dev.credential_version}</span>{dev.virtual ? <span className="badge info" style={{ marginLeft: 6 }}>virtual</span> : null}</>],
                ["Online", dev.online ? <Status s="online" /> : <><Status s="offline" /> <span className="small faint">since {ago(dev.online_changed_at)}</span></>],
                ["Last seen", `${dt(dev.last_seen_at)} (${ago(dev.last_seen_at)})`],
                ["Signal", dev.rssi != null ? `${dev.rssi} dBm` : "—"],
                ["Firmware", <span className="mono">{dev.firmware_version ?? "—"}</span>],
                ["Relay", dev.relay_state ?? "—"],
                ["Uptime", dev.uptime_s != null ? `${Math.floor(dev.uptime_s / 3600)} h ${Math.floor((dev.uptime_s % 3600) / 60)} min` : "—"],
                ["IP", dev.ip ?? "—"],
                ["Provisioned", dt(dev.provisioned_at)],
              ]} />
            ) : (
              <p className="muted">No device yet. Provision one to get its credentials.</p>
            )}
            {can("tables.manage") ? (
              <div className="row wrap" style={{ marginTop: 12 }}>
                <ProvisionButton label={dev ? "Re-provision (new credentials)" : "Provision device"} sandbox={Boolean(me?.environment.virtualDevices)} onGo={(v) => provision(false, v)} />
                {dev ? <ProvisionButton label="Replace device" sandbox={Boolean(me?.environment.virtualDevices)} onGo={(v) => provision(true, v)} danger /> : null}
                {dev && dev.status === "provisioned" ? <ActionButton tone="danger" label="Revoke credentials" title="Revoke this device's credentials" description="The device is disconnected at once and can't sign in again until re-provisioned." path={`/devices/${dev.id}/revoke`} onDone={reload} /> : null}
              </div>
            ) : null}
          </Card>
          <Card title="Payment instructions">
            <KV rows={[["Paybill", <b className="num" style={{ fontSize: 18 }}>{d.data.paymentInstructions.paybill}</b>], ["Account", <b className="num" style={{ fontSize: 18 }}>{d.data.paymentInstructions.account}</b>], ["QR pay page", <a className="link" href={d.data.paymentInstructions.payPageUrl} target="_blank" rel="noopener">{d.data.paymentInstructions.payPageUrl}</a>]]} />
          </Card>
        </div>
      ) : null}
      {tab === "settings" ? <TableSettings d={d.data} merchants={merchants.data?.items ?? []} reload={reload} /> : null}
      {tab === "commands" ? (
        <Card title="Commands and acknowledgements">
          <SimpleTable rows={d.data.commands} columns={[
            { key: "t", label: "Issued", render: (c: any) => <span className="small">{dt(c.issued_at)}</span> },
            { key: "s", label: "Source", render: (c: any) => humanize(c.source) },
            { key: "r", label: "Reason", render: (c: any) => <span className="small">{c.reason ?? "—"}{c.issued_by_label ? <div className="tiny faint">{c.issued_by_label}</div> : null}</span> },
            { key: "st", label: "Status", render: (c: any) => <Status s={c.status} /> },
            { key: "a", label: "Attempts", right: true, render: (c: any) => c.attempts },
            { key: "ack", label: "Ack", render: (c: any) => <span className="small">{c.ack_result ? `${c.ack_result}${c.ack_reason ? ` (${c.ack_reason})` : ""} · ${dt(c.ack_at)}` : "—"}</span> },
            { key: "id", label: "Command", render: (c: any) => <span className="mono tiny">{c.cmd_id.slice(0, 8)}</span> },
          ]} empty="No commands yet." />
        </Card>
      ) : null}
      {tab === "events" ? (
        <Card title="Device events (override button, connection, errors)">
          <SimpleTable rows={d.data.events} columns={[
            { key: "t", label: "When", render: (e: any) => <span className="small">{dt(e.at)}</span> },
            { key: "k", label: "Event", render: (e: any) => (e.type === "manual_override" ? <span className="badge wait">override button</span> : humanize(e.type)) },
            { key: "d", label: "Detail", render: (e: any) => <span className="mono tiny">{JSON.stringify(e.payload).slice(0, 120)}</span> },
          ]} empty="No events." />
        </Card>
      ) : null}
      {tab === "payments" ? (
        <Card title="Recent payments">
          <SimpleTable rows={d.data.recentPayments} rowLink={(p: any) => `/payments/${p.id}`} columns={[
            { key: "t", label: "When", render: (p: any) => dt(p.received_at) },
            { key: "c", label: "Code", render: (p: any) => <span className="mono">{p.provider_txn_id}</span> },
            { key: "a", label: "Amount", right: true, render: (p: any) => ksh(p.amount_minor) },
            { key: "g", label: "Games", right: true, render: (p: any) => p.games_credited },
            { key: "s", label: "Status", render: (p: any) => <Status s={p.status} /> },
          ]} />
        </Card>
      ) : null}
      {creds ? <Credentials c={creds} onClose={() => setCreds(null)} /> : null}
    </div>
  );
}

function ProvisionButton({ label, sandbox, onGo, danger }: { label: string; sandbox: boolean; onGo: (virtual: boolean) => Promise<void>; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [virtual, setVirtual] = useState(false);
  return (
    <>
      <button className={`btn${danger ? " danger" : ""}`} onClick={() => setOpen(true)}>{label}</button>
      {open ? (
        <Dialog open onClose={() => setOpen(false)} title={label}>
          <div className="stack">
            <p className="muted">New credentials and a new HMAC secret are generated and shown once. Any device using the old ones is cut off.{danger ? " The old device is retired from this table." : ""}</p>
            {sandbox ? <label className="check"><input type="checkbox" checked={virtual} onChange={(e) => setVirtual(e.target.checked)} /> Run a virtual device on the server (sandbox only, for testing without hardware)</label> : null}
            <div className="actions"><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className={`btn ${danger ? "danger" : "primary"}`} onClick={async () => { setOpen(false); await onGo(virtual); }}>Generate credentials</button></div>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function Credentials({ c, onClose }: { c: any; onClose: () => void }) {
  const [saved, setSaved] = useState(false);
  const all = `Device ID: ${c.deviceId}\nTable: ${c.tableId}\nMQTT URL: ${c.mqtt.url}\nPassword: ${c.mqtt.password}\nHMAC secret: ${c.hmacSecret}`;
  return (
    <Dialog open onClose={() => saved && onClose()} title="Device credentials (shown once)" wide>
      <div className="stack">
        <Banner tone="wait" icon="lock">Copy these into the device's setup portal now. They aren't stored in readable form and can't be shown again.</Banner>
        <KV rows={[
          ["Device ID (username, client ID)", <span className="secret">{c.deviceId}</span>],
          ["Table", c.tableId],
          ["MQTT URL", <span className="secret">{c.mqtt.url}</span>],
          ["Password", <span className="secret">{c.mqtt.password}</span>],
          ["HMAC secret", <span className="secret">{c.hmacSecret}</span>],
          ["Topics", <span className="mono tiny">{Object.values(c.mqtt.topics).join("  ")}</span>],
        ]} />
        <div className="row"><Copy text={all} /><span className="hint">Copies all five values.</span></div>
        <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I've copied them</label>
        <div className="actions"><button className="btn primary" disabled={!saved} onClick={onClose}>Done</button></div>
      </div>
    </Dialog>
  );
}

function CommandWatch({ tableId, cmdId, onClose }: { tableId: string; cmdId: string; onClose: () => void }) {
  const [c, setC] = useState<any>(null);
  const done = c && ["acked", "failed", "timeout", "rejected"].includes(c.status);
  useInterval(async () => {
    const x = await call(`/tables/${tableId}/commands/${cmdId}`, { background: true }).catch(() => null);
    if (x) setC(x);
  }, done ? null : 1000);
  return (
    <Banner tone={!c ? "info" : c.status === "acked" ? "ok" : done ? "bad" : "wait"} icon={c?.status === "acked" ? "check" : "clock"} title={!c ? "Sending…" : c.status === "acked" ? `Unlocked: the table confirmed (${c.duration_s}s)` : done ? `Not confirmed: ${humanize(c.status)}${c.ack_reason ? ` (${c.ack_reason})` : ""}` : `${humanize(c.status)}… attempt ${c.attempts}`}>
      {done ? <button className="link" onClick={onClose}>Dismiss</button> : null}
    </Banner>
  );
}

function TableSettings({ d, merchants, reload }: { d: any; merchants: any[]; reload: () => void }) {
  const { can } = useSession();
  const t = d.table;
  const k = (v: number | null) => (v == null ? "" : String(v / 100));
  const [f, setF] = useState({ name: t.name, location: t.location ?? "", price: k(t.price_minor), unlock: String(t.unlock_seconds), priceMin: k(t.price_min_minor), priceMax: k(t.price_max_minor), unlockMin: t.unlock_min_s ?? "", unlockMax: t.unlock_max_s ?? "", startedAt: t.started_at ? new Date(t.started_at).toISOString().slice(0, 16) : "" });
  const [err, setErr] = useState<string | null>(null);
  const editable = can("tables.manage");
  return (
    <div className="grid2">
      <Card title="Table">
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await call(`/tables/${t.id}`, {
                method: "PATCH",
                body: {
                  name: f.name,
                  location: f.location || null,
                  priceMinor: parseKsh(f.price) ?? undefined,
                  unlockSeconds: Number(f.unlock),
                  priceMinMinor: f.priceMin === "" ? null : parseKsh(f.priceMin),
                  priceMaxMinor: f.priceMax === "" ? null : parseKsh(f.priceMax),
                  unlockMinS: f.unlockMin === "" ? null : Number(f.unlockMin),
                  unlockMaxS: f.unlockMax === "" ? null : Number(f.unlockMax),
                  startedAt: f.startedAt ? new Date(f.startedAt).toISOString() : null,
                },
              });
              toast("Saved");
              reload();
            } catch (x) {
              setErr(errText(x));
            }
          }}
        >
          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <div className="grid2">
              <div className="field"><label>Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
              <div className="field"><label>Location</label><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></div>
              <div className="field"><label>Price (KSh)</label><input className="input" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></div>
              <div className="field"><label>Unlock seconds</label><input className="input" value={f.unlock} onChange={(e) => setF({ ...f, unlock: e.target.value })} /></div>
              <div className="field"><label>Owner price min (KSh)</label><input className="input" placeholder="Merchant default" value={f.priceMin} onChange={(e) => setF({ ...f, priceMin: e.target.value })} /></div>
              <div className="field"><label>Owner price max (KSh)</label><input className="input" placeholder="Merchant default" value={f.priceMax} onChange={(e) => setF({ ...f, priceMax: e.target.value })} /></div>
              <div className="field"><label>Owner unlock min (s)</label><input className="input" placeholder="Default" value={f.unlockMin} onChange={(e) => setF({ ...f, unlockMin: e.target.value })} /></div>
              <div className="field"><label>Owner unlock max (s)</label><input className="input" placeholder="Default" value={f.unlockMax} onChange={(e) => setF({ ...f, unlockMax: e.target.value })} /></div>
            </div>
            <div className="field"><label>Started (drives Since started stats)</label><input className="input" type="datetime-local" value={f.startedAt} onChange={(e) => setF({ ...f, startedAt: e.target.value })} /></div>
          </fieldset>
          {err ? <ErrorBox text={err} /> : null}
          {editable ? <div><button className="btn primary">Save</button></div> : null}
        </form>
      </Card>
      <div className="stack">
        <Card title="Pricing in effect">
          <KV rows={[
            ["Commission", `${ksh(d.pricing.commission.commissionMinor)} a game${d.pricing.commission.commissionPct ? ` + ${d.pricing.commission.commissionPct}%` : ""} (${d.pricing.commission.source})`],
            ["Owner may set price", `${ksh(d.pricing.bounds.priceMinMinor)} – ${ksh(d.pricing.bounds.priceMaxMinor)}`],
            ["Owner may set unlock", `${d.pricing.bounds.unlockMinS} – ${d.pricing.bounds.unlockMaxS} s`],
          ]} />
        </Card>
        {editable ? (
          <Card title="Status and ownership">
            <div className="row wrap">
              {(["active", "maintenance", "disabled"] as const).filter((s) => s !== t.status).map((s) => (
                <StatusAction key={s} id={t.id} to={s} waiting={d.waiting.length} onDone={reload} />
              ))}
              <ActionButton tone="plain" label="Move to another merchant" title={`Move ${t.id}`} path={`/tables/${t.id}/move`} fields={[{ name: "merchantId", label: "New merchant", kind: "select", required: true, options: merchants.filter((m) => m.id !== t.merchant_id && m.status !== "closed").map((m) => ({ value: m.id, label: `${m.code} · ${m.business_name}` })) }]} onDone={reload} />
            </div>
            <p className="hint" style={{ marginTop: 8 }}>Disabled or in maintenance: customers see Out of service and Paybill validation refuses payments for this table.</p>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function StatusAction({ id, to, waiting, onDone }: { id: string; to: "active" | "maintenance" | "disabled"; waiting: number; onDone: () => void }) {
  const label = to === "active" ? "Enable" : to === "maintenance" ? "Set maintenance" : "Disable";
  return (
    <ActionButton
      tone={to === "disabled" ? "danger" : to === "active" ? "primary" : "plain"}
      label={label}
      title={`${label} ${id}`}
      description={waiting && to !== "active" ? <Banner tone="wait" title={`${waiting} paid game(s) are waiting on this table`}>They will expire and need refunds. Confirm below to go ahead.</Banner> : undefined}
      path={`/tables/${id}/status`}
      fields={waiting && to !== "active" ? [{ name: "confirm", label: "Yes, the waiting games will expire", kind: "check" }] : []}
      build={(v) => ({ status: to, reason: v.reason, confirm: Boolean(v.confirm) })}
      onDone={onDone}
    />
  );
}
