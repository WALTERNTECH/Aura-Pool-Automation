import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ActionButton } from "../components/Action";
import { DataTable, SimpleTable } from "../components/DataTable";
import { Banner, Card, Copy, Dialog, ErrorBox, KV, Loading, Money, PageHead, Stat, Status, Tabs, toast } from "../components/ui";
import { call, errText } from "../lib/api";
import { ago, day, dt, humanize, ksh, parseKsh, until } from "../lib/format";
import { useApi, useQueryState } from "../lib/hooks";
import { useSession } from "../lib/session";

export function MerchantList() {
  const { can } = useSession();
  const [f, setF] = useQueryState({ q: "", status: "" });
  const [sp] = useSearchParams();
  const [open, setOpen] = useState(sp.get("new") === "1");
  return (
    <div className="stack">
      <PageHead title="Merchants" sub="Table owners: their status, balance and activity." actions={can("merchants.manage") ? <button className="btn primary" onClick={() => setOpen(true)}>New merchant</button> : null} />
      <DataTable
        storageKey="merchants"
        path="/merchants"
        params={f}
        rowLink={(m) => `/merchants/${m.id}`}
        toolbar={
          <>
            <input className="input sm" placeholder="Search name, code, phone" value={f.q} onChange={(e) => setF({ q: e.target.value })} style={{ width: 240 }} />
            <select className="input sm" value={f.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">Any status</option>
              {["invited", "active", "suspended", "closed"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
          </>
        }
        columns={[
          { key: "code", label: "Code", render: (m) => <span className="mono">{m.code}</span> },
          { key: "name", label: "Business", sort: "business_name", render: (m) => <b>{m.business_name}</b> },
          { key: "owner", label: "Owner", render: (m) => <>{m.owner_name}<div className="tiny faint">{m.phone}</div></> },
          { key: "status", label: "Status", render: (m) => <><Status s={m.status} />{m.payouts_suspended ? <div className="tiny" style={{ color: "var(--bad)" }}>payouts suspended</div> : null}{m.flagged_for_review ? <div className="tiny" style={{ color: "var(--wait)" }}>flagged</div> : null}</> },
          { key: "tables", label: "Tables", right: true, render: (m) => m.tables },
          { key: "balance", label: "Balance", sort: "balance", right: true, render: (m) => <Money v={m.available} /> },
          { key: "last", label: "Last payment", sort: "last_payment", render: (m) => <span className="small">{ago(m.last_payment_at)}</span> },
          { key: "joined", label: "Joined", sort: "created_at", render: (m) => <span className="small">{day(m.created_at)}</span> },
        ]}
      />
      <NewMerchant open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

function NewMerchant({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [f, setF] = useState<Record<string, string>>({ businessName: "", ownerName: "", phone: "", email: "", location: "", payoutMsisdn: "", priceMin: "", priceMax: "", payoutMin: "", dailyCap: "", threshold: "", manualLimit: "", feePolicy: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; code: string; inviteLink?: string } | null>(null);
  const money = (s: string) => (s ? parseKsh(s) : undefined);
  if (done)
    return (
      <Dialog open={open} onClose={() => nav(`/merchants/${done.id}`)} title={`${done.code} created`}>
        <div className="stack">
          <Banner tone="ok" icon="check">The owner has been sent an SMS invite to set their PIN.</Banner>
          {done.inviteLink ? (
            <div className="field">
              <span className="label">Invite link (shown because test mode is on)</span>
              <div className="row"><span className="secret grow">{done.inviteLink}</span><Copy text={done.inviteLink} /></div>
            </div>
          ) : null}
          <p className="muted small">Next: create a table for them and provision its device.</p>
          <div className="actions" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button className="btn primary" onClick={() => nav(`/merchants/${done.id}`)}>Open merchant</button>
          </div>
        </div>
      </Dialog>
    );
  return (
    <Dialog open={open} onClose={onClose} title="New merchant" wide>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const r = await call("/merchants", {
              method: "POST",
              body: {
                businessName: f.businessName,
                ownerName: f.ownerName,
                phone: f.phone,
                email: f.email || null,
                location: f.location || null,
                payoutMsisdn: f.payoutMsisdn || null,
                feePolicy: f.feePolicy || null,
                priceMinMinor: money(f.priceMin),
                priceMaxMinor: money(f.priceMax),
                payoutMinMinor: money(f.payoutMin),
                payoutDailyCapMinor: money(f.dailyCap),
                payoutApprovalThresholdMinor: money(f.threshold),
                manualUnlockDailyLimit: f.manualLimit ? Number(f.manualLimit) : undefined,
              },
            });
            setDone(r);
          } catch (x) {
            setErr(errText(x));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="grid2">
          {([["businessName", "Business name"], ["ownerName", "Owner's name"], ["phone", "Owner's phone (gets the SMS invite)"], ["email", "Email (optional)"], ["location", "Location"], ["payoutMsisdn", "Payout number (owner verifies it; default: owner's phone)"]] as const).map(([k, l]) => (
            <div className="field" key={k}>
              <label htmlFor={k}>{l}</label>
              <input id={k} className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <h3>Overrides (leave empty for platform defaults)</h3>
        <div className="grid3">
          {([["priceMin", "Owner price, minimum (KSh)"], ["priceMax", "Owner price, maximum (KSh)"], ["payoutMin", "Minimum withdrawal (KSh)"], ["dailyCap", "Daily withdrawal cap (KSh)"], ["threshold", "Approval threshold (KSh)"], ["manualLimit", "Manual unlocks per table per day"]] as const).map(([k, l]) => (
            <div className="field" key={k}>
              <label htmlFor={k}>{l}</label>
              <input id={k} className="input" inputMode="numeric" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/[^\d.]/g, "") })} />
            </div>
          ))}
          <div className="field">
            <label htmlFor="fee">B2C fee borne by</label>
            <select id="fee" className="input" value={f.feePolicy} onChange={(e) => setF({ ...f, feePolicy: e.target.value })}>
              <option value="">Platform default</option>
              <option value="merchant">Merchant</option>
              <option value="platform">Platform</option>
            </select>
          </div>
        </div>
        <p className="hint">Commission is set in Pricing (changes there need a second approver).</p>
        {err ? <ErrorBox text={err} /> : null}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !f.businessName || !f.ownerName || !f.phone}>Create and send invite</button>
        </div>
      </form>
    </Dialog>
  );
}

export function MerchantDetail() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const nav = useNavigate();
  const d = useApi<any>(`/merchants/${id}`);
  const [tab, setTab] = useState("overview");
  if (d.loading) return <Loading h={400} />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const { merchant: m, balance: b } = d.data;
  const reload = () => void d.reload();
  return (
    <div className="stack">
      <PageHead
        crumb={{ to: "/merchants", label: "Merchants" }}
        title={<>{m.business_name} <span className="faint mono" style={{ fontSize: 15 }}>{m.code}</span></>}
        sub={<>{m.owner_name} · {m.phone} · <Status s={m.status} /> {m.status_reason ? <span className="small">({m.status_reason})</span> : null}</>}
        actions={
          <>
            {can("impersonate") ? (
              <ActionButton
                tone="plain"
                label="View as merchant"
                title="Read-only view as this merchant"
                description="Opens the merchant's own screens for 15 minutes. Nothing can be changed and no money can move. The view is recorded in the audit log."
                path="/impersonations"
                build={(v) => ({ merchantId: id, reason: v.reason })}
                confirm="Open view"
                onDone={(r) => nav(`/merchants/${id}/view/${r.id}`)}
              />
            ) : null}
            {can("merchants.manage") && m.status === "invited" ? <ActionButton tone="plain" label="Resend invite" title="Send the owner's invite again" path={`/merchants/${id}/resend-invite`} reason={false} confirm="Send" onDone={(r) => { if (r?.inviteLink) toast(`Invite: ${r.inviteLink}`); reload(); }} /> : null}
            {can("merchants.manage") && m.status !== "suspended" && m.status !== "closed" ? (
              <ActionButton
                tone="danger"
                label="Suspend"
                title={`Suspend ${m.business_name}`}
                description="Stops new payouts. The owner can still sign in and see their history. Optionally refuse payments to their tables too."
                path={`/merchants/${id}/suspend`}
                fields={[{ name: "blockTablePayments", label: "Also refuse payments to their tables", kind: "check" }]}
                onDone={reload}
              />
            ) : null}
            {can("merchants.manage") && m.status === "suspended" ? <ActionButton label="Reactivate" title={`Reactivate ${m.business_name}`} path={`/merchants/${id}/reactivate`} onDone={reload} /> : null}
            {can("merchants.manage") && m.status !== "closed" ? (
              <ActionButton
                tone="danger"
                label="Close"
                title={`Close ${m.business_name}`}
                description={`Closing needs a zero balance (now ${ksh(b.availableMinor)}) and a second approver. Tables are disabled and every sign-in is revoked.`}
                path={`/merchants/${id}/close`}
                onDone={reload}
              />
            ) : null}
          </>
        }
      />
      {m.payouts_suspended ? <Banner tone="bad" icon="alert" title="Payouts suspended">{m.payouts_suspended_reason}. Clear the verification exception to restore them.</Banner> : null}
      {d.data.pendingNumberChange ? (
        <Banner tone="wait" icon="shield" title={`Payout number change ${d.data.pendingNumberChange.status === "cooling" ? "cooling off" : "awaiting codes"}`}>
          {d.data.pendingNumberChange.old_msisdn ?? "—"} → {d.data.pendingNumberChange.new_msisdn}
          {d.data.pendingNumberChange.hold_until ? ` · withdrawals held for ${until(d.data.pendingNumberChange.hold_until)}` : ""}
          {d.data.pendingNumberChange.status === "cooling" && can("merchants.manage") ? (
            <span style={{ marginLeft: 10 }}>
              <ActionButton small label="Fast-track" title="End the cooling-off early" description="Needs a second approver. Use only after confirming the change with the owner by phone." path={`/merchants/${id}/payout-number/fast-track`} onDone={reload} />
            </span>
          ) : null}
        </Banner>
      ) : null}
      <div className="grid4">
        <Stat label="Available" value={<Money v={b.availableMinor} />} />
        <Stat label="Withdrawals in progress" value={<Money v={b.pendingMinor} />} />
        <Stat label="Total earned" value={<Money v={b.totalEarnedMinor} />} />
        <Stat label="Total paid out" value={<Money v={b.totalPaidOutMinor} />} />
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "tables", label: "Tables", n: d.data.tables.length },
          { value: "payments", label: "Payments" },
          { value: "payouts", label: "Payouts" },
          { value: "staff", label: "Staff", n: d.data.staff.length },
          { value: "notes", label: "Notes", n: d.data.notes.length },
          { value: "documents", label: "Documents", n: d.data.documents.length },
          { value: "activity", label: "Activity" },
        ]}
      />
      {tab === "overview" ? <Overview d={d.data} reload={reload} /> : null}
      {tab === "tables" ? (
        <Card title="Tables" actions={can("tables.manage") ? <Link className="btn sm" to={`/tables?new=1&merchant=${id}`}>New table</Link> : null}>
          <SimpleTable rows={d.data.tables} rowLink={(t: any) => `/tables/${t.id}`} columns={[
            { key: "id", label: "Table", render: (t: any) => <b>{t.id}</b> },
            { key: "name", label: "Name", render: (t: any) => t.name },
            { key: "s", label: "Status", render: (t: any) => <><Status s={t.status} /> <Status s={t.online ? "online" : "offline"} /></> },
            { key: "p", label: "Price", right: true, render: (t: any) => ksh(t.price_minor) },
            { key: "u", label: "Unlock", right: true, render: (t: any) => `${t.unlock_seconds}s` },
            { key: "seen", label: "Last seen", render: (t: any) => ago(t.last_seen_at) },
          ]} />
        </Card>
      ) : null}
      {tab === "payments" ? (
        <DataTable path="/payments" params={{ merchant: id }} rowLink={(p) => `/payments/${p.id}`} columns={payCols} exportPath="/payments/export" />
      ) : null}
      {tab === "payouts" ? <DataTable path="/payouts" params={{ merchant: id }} rowLink={(p) => `/payouts/${p.id}`} columns={payoutCols} /> : null}
      {tab === "staff" ? (
        <Card title="Accounts">
          <SimpleTable rows={d.data.staff} columns={[
            { key: "n", label: "Name", render: (u: any) => u.name },
            { key: "r", label: "Role", render: (u: any) => humanize(u.role) },
            { key: "p", label: "Phone", render: (u: any) => u.phone },
            { key: "s", label: "Status", render: (u: any) => <Status s={u.status} /> },
            { key: "l", label: "Last sign-in", render: (u: any) => dt(u.last_login_at) },
          ]} />
        </Card>
      ) : null}
      {tab === "notes" ? <Notes id={id} notes={d.data.notes} reload={reload} /> : null}
      {tab === "documents" ? <Documents id={id} docs={d.data.documents} reload={reload} /> : null}
      {tab === "activity" ? (
        <Card title="Activity">
          <SimpleTable rows={d.data.activity} columns={[
            { key: "at", label: "When", render: (a: any) => <span className="small">{dt(a.at)}</span> },
            { key: "who", label: "Who", render: (a: any) => <span className="small">{a.actor_label ?? a.actor_type}</span> },
            { key: "what", label: "Action", render: (a: any) => <span className="mono">{a.action}</span> },
            { key: "e", label: "Entity", render: (a: any) => <span className="small faint">{a.entity_type} {a.entity_id?.slice(0, 8)}</span> },
          ]} />
        </Card>
      ) : null}
    </div>
  );
}

function Overview({ d, reload }: { d: any; reload: () => void }) {
  const { can } = useSession();
  const m = d.merchant;
  const [edit, setEdit] = useState(false);
  return (
    <div className="grid2">
      <Card title="Profile" actions={can("merchants.manage") ? <button className="btn sm" onClick={() => setEdit(true)}>Edit</button> : null}>
        <KV rows={[
          ["Owner", m.owner_name],
          ["Phone", m.phone],
          ["Email", m.email],
          ["Location", m.location],
          ["Payout number", m.payout_msisdn ? <>{m.payout_msisdn} {m.payout_msisdn_verified_at ? <span className="badge ok">verified</span> : <span className="badge wait">not verified</span>}</> : "—"],
          ["Joined", day(m.created_at)],
          ["Flagged for review", m.flagged_for_review ? "Yes: every payout needs approval" : "No"],
        ]} />
      </Card>
      <Card title="Limits and auto-withdraw">
        <KV rows={[
          ["Minimum withdrawal", ksh(d.limits.minMinor)],
          ["Daily cap", ksh(d.limits.dailyCapMinor)],
          ["Approval above", ksh(d.limits.approvalThresholdMinor)],
          ["B2C fee borne by", m.fee_policy ? humanize(m.fee_policy) : "Platform default"],
          ["Owner price bounds", m.price_min_minor || m.price_max_minor ? `${ksh(m.price_min_minor)} – ${ksh(m.price_max_minor)}` : "Platform default"],
          ["Manual unlocks a day", m.manual_unlock_daily_limit ?? "Platform default"],
          ["Auto-withdraw", m.auto_withdraw_enabled ? `Daily at ${m.auto_withdraw_time}, minimum ${ksh(m.auto_withdraw_min_minor)}` : "Off"],
          ["Last auto run", m.auto_withdraw_last_run ? `${dt(m.auto_withdraw_last_run.at)} · ${m.auto_withdraw_last_run.outcome}` : "—"],
        ]} />
        {can("pricing.manage") ? (
          <div style={{ marginTop: 10 }}>
            <ActionButton small tone="plain" label="Change B2C fee policy" title="Who bears the B2C fee for this merchant" description="Needs a second approver." path={`/merchants/${m.id}/fee-policy`} fields={[{ name: "b2c", label: "Borne by", kind: "select", options: [{ value: "merchant", label: "Merchant" }, { value: "platform", label: "Platform" }, { value: "default", label: "Platform default" }] }]} build={(v) => ({ b2c: v.b2c === "default" ? null : v.b2c, reason: v.reason })} onDone={reload} />
          </div>
        ) : null}
      </Card>
      <Card title="Recent payments">
        <SimpleTable rows={d.recentPayments} rowLink={(p: any) => `/payments/${p.id}`} columns={[
          { key: "t", label: "When", render: (p: any) => <span className="small">{dt(p.received_at)}</span> },
          { key: "c", label: "Code", render: (p: any) => <span className="mono">{p.provider_txn_id}</span> },
          { key: "tb", label: "Table", render: (p: any) => p.table_id },
          { key: "a", label: "Amount", right: true, render: (p: any) => ksh(p.amount_minor) },
          { key: "s", label: "Status", render: (p: any) => <Status s={p.status} /> },
        ]} />
      </Card>
      <Card title="Recent payouts">
        <SimpleTable rows={d.payouts} rowLink={(p: any) => `/payouts/${p.id}`} columns={[
          { key: "r", label: "Ref", render: (p: any) => <span className="mono">{p.ref}</span> },
          { key: "a", label: "Gross", right: true, render: (p: any) => ksh(p.gross_minor) },
          { key: "s", label: "Status", render: (p: any) => <Status s={p.status} /> },
          { key: "t", label: "Requested", render: (p: any) => <span className="small">{dt(p.requested_at)}</span> },
        ]} />
      </Card>
      {edit ? <EditMerchant m={m} onClose={() => setEdit(false)} onDone={() => { setEdit(false); reload(); }} /> : null}
    </div>
  );
}

function EditMerchant({ m, onClose, onDone }: { m: any; onClose: () => void; onDone: () => void }) {
  const toK = (v: number | null) => (v == null ? "" : String(v / 100));
  const [f, setF] = useState<Record<string, string>>({ businessName: m.business_name, ownerName: m.owner_name, email: m.email ?? "", location: m.location ?? "", priceMin: toK(m.price_min_minor), priceMax: toK(m.price_max_minor), payoutMin: toK(m.payout_min_minor), dailyCap: toK(m.payout_daily_cap_minor), threshold: toK(m.payout_approval_threshold_minor), manualLimit: m.manual_unlock_daily_limit == null ? "" : String(m.manual_unlock_daily_limit) });
  const [flag, setFlag] = useState<boolean>(m.flagged_for_review);
  const [err, setErr] = useState<string | null>(null);
  const money = (s: string) => (s === "" ? null : parseKsh(s));
  return (
    <Dialog open onClose={onClose} title="Edit merchant" wide>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await call(`/merchants/${m.id}`, { method: "PATCH", body: { businessName: f.businessName, ownerName: f.ownerName, email: f.email || null, location: f.location || null, priceMinMinor: money(f.priceMin), priceMaxMinor: money(f.priceMax), payoutMinMinor: money(f.payoutMin), payoutDailyCapMinor: money(f.dailyCap), payoutApprovalThresholdMinor: money(f.threshold), manualUnlockDailyLimit: f.manualLimit === "" ? null : Number(f.manualLimit), flaggedForReview: flag } });
            toast("Saved");
            onDone();
          } catch (x) {
            setErr(errText(x));
          }
        }}
      >
        <div className="grid2">
          {([["businessName", "Business name"], ["ownerName", "Owner's name"], ["email", "Email"], ["location", "Location"]] as const).map(([k, l]) => (
            <div className="field" key={k}><label>{l}</label><input className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></div>
          ))}
        </div>
        <div className="grid3">
          {([["priceMin", "Owner price min (KSh)"], ["priceMax", "Owner price max (KSh)"], ["payoutMin", "Min withdrawal (KSh)"], ["dailyCap", "Daily cap (KSh)"], ["threshold", "Approval threshold (KSh)"], ["manualLimit", "Manual unlocks a day"]] as const).map(([k, l]) => (
            <div className="field" key={k}><label>{l}</label><input className="input" placeholder="Default" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/[^\d.]/g, "") })} /></div>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={flag} onChange={(e) => setFlag(e.target.checked)} /> Flag for review (every payout needs approval)</label>
        <p className="hint">The owner's phone is changed by support on request; the payout number only by the owner. Every change is audited.</p>
        {err ? <ErrorBox text={err} /> : null}
        <div className="actions"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Save</button></div>
      </form>
    </Dialog>
  );
}

function Notes({ id, notes, reload }: { id: string; notes: any[]; reload: () => void }) {
  const { can } = useSession();
  const [body, setBody] = useState("");
  return (
    <Card title="Internal notes (never shown to the merchant)">
      <div className="stack">
        {can("merchants.notes") ? (
          <form className="stack-sm" onSubmit={async (e) => { e.preventDefault(); await call(`/merchants/${id}/notes`, { method: "POST", body: { body } }); setBody(""); reload(); }}>
            <textarea className="input" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Note" />
            <div><button className="btn sm primary" disabled={!body.trim()}>Add note</button></div>
          </form>
        ) : null}
        {notes.map((n) => (
          <div key={n.id} className="msg"><div className="tiny faint">{n.author_label} · {dt(n.created_at)}</div>{n.body}</div>
        ))}
      </div>
    </Card>
  );
}

function Documents({ id, docs, reload }: { id: string; docs: any[]; reload: () => void }) {
  const { can } = useSession();
  const [kind, setKind] = useState("id");
  const [busy, setBusy] = useState(false);
  return (
    <Card title="Documents">
      <div className="stack">
        {can("merchants.documents") ? (
          <div className="row wrap">
            <select className="input sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
              <option value="id">ID</option>
              <option value="agreement">Agreement</option>
              <option value="other">Other</option>
            </select>
            <label className="btn sm">
              {busy ? "Uploading…" : "Upload PDF or image (5 MB max)"}
              <input
                type="file"
                accept="application/pdf,image/jpeg,image/png,image/webp"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 5 * 1024 * 1024) return toast("Files must be under 5 MB", true);
                  setBusy(true);
                  try {
                    const buf = new Uint8Array(await file.arrayBuffer());
                    let bin = "";
                    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
                    await call(`/merchants/${id}/documents`, { method: "POST", body: { kind, filename: file.name, mime: file.type, dataBase64: btoa(bin) } });
                    toast("Uploaded");
                    reload();
                  } catch (x) {
                    toast(errText(x), true);
                  } finally {
                    setBusy(false);
                    e.target.value = "";
                  }
                }}
              />
            </label>
          </div>
        ) : null}
        <SimpleTable rows={docs} columns={[
          { key: "k", label: "Kind", render: (x: any) => humanize(x.kind) },
          { key: "f", label: "File", render: (x: any) => can("merchants.documents") ? <a className="link" href={`/v1/a/merchants/${id}/documents/${x.id}`}>{x.filename}</a> : x.filename },
          { key: "s", label: "Size", right: true, render: (x: any) => `${Math.round(x.size / 1024)} KB` },
          { key: "t", label: "Uploaded", render: (x: any) => dt(x.created_at) },
        ]} empty="No documents." />
      </div>
    </Card>
  );
}

export const payCols = [
  { key: "t", label: "Received", render: (p: any) => <span className="small">{dt(p.received_at)}</span> },
  { key: "c", label: "M-Pesa code", render: (p: any) => <span className="mono">{p.provider_txn_id}</span> },
  { key: "acc", label: "Account", render: (p: any) => <span className="mono">{p.account_ref}</span>, hidden: true },
  { key: "tb", label: "Table", render: (p: any) => p.table_id ?? "—" },
  { key: "m", label: "Merchant", render: (p: any) => <span className="small">{p.merchant ?? "—"}</span> },
  { key: "a", label: "Amount", right: true, render: (p: any) => <Money v={p.amount_minor} /> },
  { key: "ph", label: "Payer", render: (p: any) => <span className="small">{p.payer_msisdn_masked}</span> },
  { key: "g", label: "Games", right: true, render: (p: any) => p.games_credited },
  { key: "s", label: "Status", render: (p: any) => <><Status s={p.status} />{p.problem ? <div className="tiny faint">{humanize(p.problem)}</div> : null}</> },
  { key: "v", label: "Verified", render: (p: any) => <Status s={p.verification_status} />, hidden: true },
];

export const payoutCols = [
  { key: "r", label: "Ref", render: (p: any) => <span className="mono">{p.ref}</span> },
  { key: "m", label: "Merchant", render: (p: any) => <span className="small">{p.merchant ?? (p.kind === "platform" ? "Platform" : "—")}</span> },
  { key: "g", label: "Gross", right: true, render: (p: any) => <Money v={p.gross_minor} /> },
  { key: "f", label: "Fee", right: true, render: (p: any) => <Money v={p.fee_minor} /> },
  { key: "n", label: "Net", right: true, render: (p: any) => <Money v={p.net_minor} /> },
  { key: "d", label: "To", render: (p: any) => <span className="small">{p.msisdn}</span> },
  { key: "tr", label: "Trigger", render: (p: any) => <span className="small">{humanize(p.trigger)}</span> },
  { key: "s", label: "Status", render: (p: any) => <><Status s={p.status} />{p.status_reason ? <div className="tiny faint" style={{ maxWidth: 220 }}>{p.status_reason}</div> : null}</> },
  { key: "age", label: "Age", render: (p: any) => <span className="small">{p.ageMinutes != null ? (p.ageMinutes < 60 ? `${p.ageMinutes} min` : `${Math.round(p.ageMinutes / 60)} h`) : ago(p.requested_at)}</span> },
];

export function MerchantView() {
  const { id = "", imp = "" } = useParams();
  const base = `/impersonations/${imp}/m`;
  const home = useApi<any>(`${base}/dashboard`);
  const money = useApi<any>(`${base}/money`);
  const pays = useApi<any>(`${base}/payments?limit=20`);
  const err = home.error ?? money.error;
  return (
    <div className="stack">
      <div className="impersonation">
        <span>Read-only view as {home.data?.businessName ?? "merchant"}. Nothing can be changed here. This view is recorded.</span>
        <button className="btn sm" onClick={async () => { await call(`/impersonations/${imp}/end`, { method: "POST" }).catch(() => {}); location.assign(`/merchants/${id}`); }}>End view</button>
      </div>
      {err ? <ErrorBox error={err} /> : null}
      {home.data ? (
        <>
          {home.data.alerts.map((a: any) => <Banner key={a.title} tone={a.tone === "info" ? "info" : a.tone} title={a.title}>{a.body}</Banner>)}
          <div className="grid4">
            <Stat label="Games today" value={home.data.today.games} />
            <Stat label="Collected today" value={ksh(home.data.today.collectedMinor)} />
            <Stat label="Earnings today" value={ksh(home.data.today.earningsMinor)} />
            <Stat label="Needs attention" value={home.data.today.needsAttention} />
          </div>
          <div className="grid2">
            <Card title="Tables">
              <SimpleTable rows={home.data.tables} columns={[
                { key: "i", label: "Table", render: (t: any) => `${t.id} · ${t.name}` },
                { key: "s", label: "State", render: (t: any) => <Status s={t.state} /> },
                { key: "g", label: "Today", right: true, render: (t: any) => t.gamesToday },
                { key: "l", label: "Last game", render: (t: any) => ago(t.lastGameAt) },
              ]} />
            </Card>
            <Card title="Money">
              {money.data ? <KV rows={[["Available", ksh(money.data.availableMinor)], ["In progress", ksh(money.data.pendingWithdrawalsMinor)], ["Total earned", ksh(money.data.totalEarnedMinor)], ["Payout number", money.data.payoutNumber.masked ?? "not set"], ["Auto-withdraw", money.data.autoWithdraw.enabled ? `at ${money.data.autoWithdraw.time}` : "off"]]} /> : <Loading h={120} />}
            </Card>
          </div>
          <Card title="Payments the owner sees">
            <SimpleTable rows={pays.data?.items ?? []} columns={[
              { key: "t", label: "When", render: (p: any) => dt(p.receivedAt) },
              { key: "tb", label: "Table", render: (p: any) => p.tableId },
              { key: "a", label: "Amount", right: true, render: (p: any) => ksh(p.amountMinor) },
              { key: "ph", label: "Payer", render: (p: any) => p.payer },
              { key: "s", label: "Owner sees", render: (p: any) => p.status.label },
            ]} />
          </Card>
        </>
      ) : !err ? <Loading h={300} /> : null}
    </div>
  );
}
