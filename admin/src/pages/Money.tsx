import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ActionButton } from "../components/Action";
import { BarChart } from "../components/Charts";
import { DataTable, SimpleTable } from "../components/DataTable";
import { Banner, Card, ErrorBox, Json, KV, Loading, Money, PageHead, Stat, Status, Tabs, toast } from "../components/ui";
import { call, errText } from "../lib/api";
import { ago, day, dt, dtFull, humanize, ksh, nairobiDay, parseKsh } from "../lib/format";
import { useApi, useQueryState } from "../lib/hooks";
import { useSession } from "../lib/session";
import { payoutCols } from "./Merchants";

// ------------------------------------------------------------------ payouts

const STATUS_TABS = [
  { value: "pending_approval", label: "Pending approval" },
  { value: "queued", label: "Queued for float" },
  { value: "requested,held", label: "Requested / held" },
  { value: "submitted", label: "Submitted" },
  { value: "timed_out", label: "Timed out" },
  { value: "failed", label: "Failed" },
  { value: "succeeded", label: "Succeeded" },
  { value: "", label: "All" },
];

export function Payouts() {
  const { can } = useSession();
  const [f, setF] = useQueryState({ status: "pending_approval", kind: "" });
  const [counts, setCounts] = useState<Record<string, { count: number; amountMinor: number }>>({});
  const ks = useApi<any>("/kill-switch", { refreshMs: 30_000 });
  const [key, setKey] = useState(0);
  const refresh = () => {
    setKey((k) => k + 1);
    void ks.reload();
  };
  const n = (v: string) => v.split(",").reduce((s, x) => s + (counts[x]?.count ?? 0), 0);
  return (
    <div className="stack">
      <PageHead
        title="Payouts"
        sub="Every withdrawal by status. Timed-out payouts can't be retried until M-Pesa confirms the real outcome."
        actions={
          <>
            <Link className="btn" to="/platform-payouts">Platform payouts</Link>
            {can("killswitch.engage") ? (
              ks.data?.state.on ? (
                <ActionButton label="Release kill switch" title="Release the payout kill switch" description="Needs a second approver (in single-operator mode, you after the delay). Payouts resume once it's approved." path="/kill-switch/release" onDone={refresh} />
              ) : (
                <ActionButton tone="danger" label="Pause all payouts" title="Engage the kill switch" description="Stops every payout path (manual, scheduled, admin) immediately. The team is told by SMS and email; merchants see a notice. Releasing it needs a second approver." path="/kill-switch/engage" confirm="Pause all payouts" onDone={refresh} />
              )
            ) : null}
          </>
        }
      />
      {ks.data?.state.on ? <Banner tone="bad" icon="power" title="Kill switch is on: nothing is being sent">{ks.data.state.reason} — {ks.data.state.by}, {dt(ks.data.state.at)}{ks.data.pendingRelease ? ". Release is waiting for approval." : ""}</Banner> : null}
      <div className="tabs" role="tablist">
        {STATUS_TABS.map((t) => (
          <button key={t.value} role="tab" aria-selected={f.status === t.value} onClick={() => setF({ status: t.value })}>
            {t.label}
            {t.value ? <span className={`n${["pending_approval", "timed_out", "queued"].includes(t.value) && n(t.value) ? " alert" : ""}`}>{n(t.value)}</span> : null}
          </button>
        ))}
      </div>
      <DataTable
        key={key}
        storageKey="payouts"
        path="/payouts"
        params={{ status: f.status, kind: f.kind }}
        refreshMs={20_000}
        onData={(d) => setCounts((d.counts as typeof counts) ?? {})}
        rowLink={(p) => `/payouts/${p.id}`}
        toolbar={
          <select className="input sm" value={f.kind} onChange={(e) => setF({ kind: e.target.value })}>
            <option value="">Merchant and platform</option>
            <option value="merchant">Merchant</option>
            <option value="platform">Platform</option>
          </select>
        }
        columns={[
          ...payoutCols,
          {
            key: "act",
            label: "",
            render: (p: any) => <PayoutActions p={p} onDone={refresh} />,
          },
        ]}
      />
    </div>
  );
}

function PayoutActions({ p, onDone }: { p: any; onDone: () => void }) {
  const { can } = useSession();
  return (
    <div className="row">
      {p.status === "pending_approval" && can("payouts.approve") ? (
        <>
          <ActionButton small label="Approve" title={`Approve ${p.ref}`} description={<>Sends <b>{ksh(p.net_minor)}</b> (gross {ksh(p.gross_minor)}, fee {ksh(p.fee_minor)}) to {p.msisdn}. {p.approval_required_reason}</>} path={`/payouts/${p.id}/approve`} reason={false} fields={[{ name: "note", label: "Note (optional)", kind: "text" }]} onDone={onDone} />
          <ActionButton small tone="danger" label="Reject" title={`Reject ${p.ref}`} description={`${ksh(p.gross_minor)} goes back to the merchant's balance.`} path={`/payouts/${p.id}/reject`} onDone={onDone} />
        </>
      ) : null}
      {p.status === "failed" && !p.retried && can("payouts.retry") ? <ActionButton small label="Retry" title={`Retry ${p.ref}`} description={`Creates a new attempt for ${ksh(p.gross_minor)} from the merchant's balance.`} path={`/payouts/${p.id}/retry`} reason={false} confirm="Retry payout" onDone={onDone} /> : null}
      {["submitted", "timed_out"].includes(p.status) && can("payouts.retry") ? <ActionButton small tone="plain" label="Query status" title={`Ask M-Pesa about ${p.ref}`} description="The answer arrives on the status result URL and settles the payout if it's conclusive." path={`/payouts/${p.id}/query`} reason={false} confirm="Query" onDone={onDone} /> : null}
      {["queued", "requested", "held"].includes(p.status) && can("payouts.approve") ? <ActionButton small tone="danger" label="Reject" title={`Reject ${p.ref}`} path={`/payouts/${p.id}/reject`} onDone={onDone} /> : null}
    </div>
  );
}

export function PayoutDetail() {
  const { id = "" } = useParams();
  const d = useApi<any>(`/payouts/${id}`, { refreshMs: 15_000 });
  if (d.loading) return <Loading h={300} />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const p = d.data.payout;
  return (
    <div className="stack">
      <PageHead crumb={{ to: "/payouts", label: "Payouts" }} title={<span className="mono">{p.ref}</span>} sub={<>{p.merchant ?? "Platform"} · <Status s={p.status} /> · {humanize(p.trigger)}</>} actions={<PayoutActions p={p} onDone={() => void d.reload()} />} />
      {p.status === "timed_out" ? <Banner tone="bad" icon="alert" title="Outcome unknown">Don't retry. Query the status; the payout settles itself when M-Pesa answers.</Banner> : null}
      <div className="grid2">
        <Card title="Payout">
          <KV rows={[
            ["Gross (from balance)", <Money v={p.gross_minor} />],
            ["Fee charged", <Money v={p.fee_minor} />],
            ["Net sent", <Money v={p.net_minor} />],
            ["M-Pesa tariff", <Money v={p.tariff_minor} />],
            ["Fee borne by", humanize(p.fee_borne_by)],
            ["To", p.msisdn],
            ["Requested by", p.requested_by_label ?? p.requested_by],
            ["Approval", p.approval_required_reason ? `${p.approval_required_reason}${p.approved_at ? ` · approved ${dt(p.approved_at)}` : ""}` : "Not needed"],
            ["Held until", dt(p.hold_until)],
            ["Status note", p.status_reason ?? "—"],
            ["Failure", p.failure_reason ?? "—"],
            ["M-Pesa receipt", p.mpesa_receipt ?? "—"],
            ["Conversation", <span className="mono tiny">{p.originator_conversation_id ?? "—"}</span>],
            ["Requested", dtFull(p.requested_at)],
            ["Submitted", dtFull(p.submitted_at)],
            ["Completed", dtFull(p.completed_at)],
            ["Attempt", p.attempt + (p.retry_of ? " (retry)" : "")],
          ]} />
        </Card>
        <div className="stack">
          <Card title="Ledger">
            <SimpleTable rows={d.data.ledger} columns={[
              { key: "k", label: "Kind", render: (e: any) => <Link className="link mono" to={`/ledger/tx/${e.transaction_id}`}>{e.kind}</Link> },
              { key: "a", label: "Account", render: (e: any) => <span className="mono">{e.account}</span> },
              { key: "v", label: "Amount", right: true, render: (e: any) => ksh(e.amount_minor, { sign: true }) },
            ]} />
          </Card>
          <Card title="History">
            <SimpleTable rows={d.data.history} columns={[{ key: "t", label: "When", render: (h: any) => dt(h.at) }, { key: "w", label: "Who", render: (h: any) => h.actor_label }, { key: "a", label: "Action", render: (h: any) => <span className="mono">{h.action}</span> }]} />
          </Card>
          {d.data.providerRequests.length ? <Card title="Status queries"><Json value={d.data.providerRequests} /></Card> : null}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ float and transfers

export function Float() {
  const { can } = useSession();
  const d = useApi<any>("/float", { refreshMs: 60_000 });
  const [busy, setBusy] = useState(false);
  if (d.loading) return <Loading h={300} />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const f = d.data;
  return (
    <div className="stack">
      <PageHead
        title="Float"
        sub="C2B collections land in the Utility account; B2C payouts leave from the Working account. Money must be moved across in the M-Pesa portal and recorded here."
        actions={
          <button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await call("/float/poll", { method: "POST" }); await d.reload(); } catch (x) { toast(errText(x), true); } finally { setBusy(false); } }}>
            {busy ? "Asking M-Pesa…" : "Check balances now"}
          </button>
        }
      />
      {f.transferNeeded ? (
        <Banner tone={f.status === "critical" ? "bad" : "wait"} icon="float" title={`Transfer needed: ${ksh(f.suggestedTransferMinor)} from Utility to Working`}>
          {f.status === "critical" ? "Working float is below the minimum. " : ""}Make the transfer in the M-Pesa portal, then <Link className="link" to="/transfers">record it</Link>.
        </Banner>
      ) : f.status === "ok" ? <Banner tone="ok" icon="check" title="Float covers the next 24 hours" /> : null}
      <div className="grid4">
        <Stat label="Working account (provider)" value={<Money v={f.workingMinor} />} delta={f.takenAt ? `${f.snapshotSource} · ${ago(f.takenAt)}` : "not read yet"} tone={f.status === "critical" ? "bad" : f.status === "warning" ? "wait" : undefined} />
        <Stat label="Utility account (provider)" value={<Money v={f.utilityMinor} />} />
        <Stat label="Required (24 h + buffer)" value={<Money v={f.requiredMinor} />} delta={`${f.bufferPct}% buffer, minimum ${ksh(f.minimumMinor)}`} />
        <Stat label="Suggested transfer" value={<Money v={f.suggestedTransferMinor} />} />
      </div>
      <div className="grid2">
        <Card title="What the requirement is made of">
          <KV rows={[
            ["Payouts waiting (requested, queued, held, approval)", `${f.queuedCount} · ${ksh(f.queuedMinor)}`],
            ["Scheduled in the next 24 h (auto-withdraw balances)", ksh(f.scheduledNext24hMinor)],
            ["Buffer", `${f.bufferPct}%`],
            ["Ledger: Working", ksh(f.ledgerWorkingMinor)],
            ["Ledger: Utility", ksh(f.ledgerUtilityMinor)],
          ]} />
          {can("settings.manage") ? <p className="hint" style={{ marginTop: 10 }}>Buffer, minimum and alert thresholds are in <Link className="link" to="/settings">Settings → Float</Link>.</p> : null}
        </Card>
        <Card title="Working balance history">
          <FloatChart rows={[...f.history].reverse()} />
        </Card>
      </div>
    </div>
  );
}

function FloatChart({ rows }: { rows: { working_minor: number | null; utility_minor: number | null; taken_at: string }[] }) {
  const pts = rows.filter((r) => r.working_minor != null);
  if (pts.length < 2) return <p className="muted">Not enough readings yet.</p>;
  const W = 520;
  const H = 160;
  const max = Math.max(1, ...pts.map((p) => Math.max(p.working_minor ?? 0, p.utility_minor ?? 0)));
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => H - 14 - (v / max) * (H - 28);
  const path = (k: "working_minor" | "utility_minor") => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k] ?? 0).toFixed(1)}`).join(" ");
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Working and Utility balances over time">
        <line className="grid" x1={0} x2={W} y1={H - 14} y2={H - 14} />
        <path className="line" d={path("working_minor")} />
        <path className="line2" d={path("utility_minor")} />
        <text className="axis" x={W} y={10} textAnchor="end">{ksh(max)}</text>
        <text className="axis" x={0} y={H - 2}>{dt(pts[0].taken_at)}</text>
        <text className="axis" x={W} y={H - 2} textAnchor="end">{dt(pts[pts.length - 1].taken_at)}</text>
      </svg>
      <p className="hint">Solid: Working. Dashed: Utility. Latest Working {ksh(pts[pts.length - 1].working_minor)}.</p>
    </>
  );
}

export function Transfers() {
  const { can, me } = useSession();
  const d = useApi<any>("/transfers");
  const reload = () => void d.reload();
  return (
    <div className="stack">
      <PageHead
        title="Provider transfers"
        sub="Transfers between the Utility and Working accounts, made in the M-Pesa portal and recorded here. Each one writes balanced ledger entries; large ones need a second approver."
        actions={
          can("transfers.record") ? (
            <ActionButton
              label="Record a transfer"
              title="Record a transfer made in the M-Pesa portal"
              money
              reason={false}
              path="/transfers"
              fields={[
                { name: "from", label: "From", kind: "select", required: true, initial: "utility", options: [{ value: "utility", label: "Utility" }, { value: "working", label: "Working" }] },
                { name: "to", label: "To", kind: "select", required: true, initial: "working", options: [{ value: "working", label: "Working" }, { value: "utility", label: "Utility" }] },
                { name: "amount", label: "Amount (KSh)", kind: "money", required: true },
                { name: "reference", label: "M-Pesa reference", kind: "text", required: true },
                { name: "transferredAt", label: "When it was made", kind: "datetime", required: true, initial: new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16) },
                { name: "note", label: "Note", kind: "text" },
              ]}
              build={(v) => ({ from: v.from, to: v.to, amountMinor: parseKsh(v.amount), reference: v.reference, transferredAt: new Date(`${v.transferredAt}:00+03:00`).toISOString(), note: v.note || undefined })}
              onDone={(r) => { toast(r.status === "pending_approval" ? "Sent for approval" : "Recorded"); reload(); }}
            />
          ) : null
        }
      />
      {me?.environment.provider === "simulated" ? <Banner tone="info" icon="flask">Sandbox: make the transfer in the <Link className="link" to="/simulator">simulated M-Pesa portal</Link> first, then record it here with its reference.</Banner> : null}
      {d.data?.pending?.length ? <Banner tone="wait" icon="approve" title={`${d.data.pending.length} transfer(s) waiting for approval`}><Link className="link" to="/approvals">Approvals</Link></Banner> : null}
      <Card flush>
        <SimpleTable rows={d.data?.items ?? []} columns={[
          { key: "t", label: "Made", render: (x: any) => dt(x.transferred_at) },
          { key: "d", label: "Direction", render: (x: any) => `${humanize(x.from_account)} → ${humanize(x.to_account)}` },
          { key: "a", label: "Amount", right: true, render: (x: any) => <b>{ksh(x.amount_minor)}</b> },
          { key: "r", label: "M-Pesa ref", render: (x: any) => <span className="mono">{x.reference}</span> },
          { key: "b", label: "Recorded by", render: (x: any) => x.recorded_by_name },
          { key: "ap", label: "Approved", render: (x: any) => (x.approved_by ? "yes" : "—") },
          { key: "l", label: "Ledger", render: (x: any) => (x.ledger_transaction_id ? <Link className="link" to={`/ledger/tx/${x.ledger_transaction_id}`}>entries</Link> : "—") },
        ]} empty="No transfers recorded." />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ reconciliation

export function Reconciliation() {
  const { can } = useSession();
  const d = useApi<any>("/reconciliation");
  const [busy, setBusy] = useState(false);
  if (d.loading) return <Loading h={300} />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const latest = d.data.runs[0];
  const reload = () => void d.reload();
  return (
    <div className="stack">
      <PageHead
        title="Reconciliation"
        sub="Ledger balances against M-Pesa's Utility and Working balances, line by line. Runs nightly at 00:05; any difference pauses automatic payouts until someone acknowledges it with a note."
        actions={can("reconciliation.run") ? <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); try { await call("/reconciliation/run", { method: "POST" }); reload(); } catch (x) { toast(errText(x), true); } finally { setBusy(false); } }}>{busy ? "Running…" : "Run now"}</button> : null}
      />
      {d.data.autoPayoutsPaused.on ? <Banner tone="bad" icon="power" title="Automatic payouts are paused">{d.data.autoPayoutsPaused.reason}</Banner> : null}
      {latest ? (
        <Card title={<>Latest run <Status s={latest.status} /> <span className="small faint">{dt(latest.finished_at ?? latest.started_at)} · {latest.trigger}</span></>} actions={latest.status === "mismatch" && !latest.acknowledged_at && can("reconciliation.ack") ? <ActionButton label="Acknowledge" title="Acknowledge this difference" description="Say what caused it and what was done. Acknowledging releases the pause on automatic payouts." path={`/reconciliation/${latest.id}/acknowledge`} reason="What caused it, and what you did" build={(v) => ({ note: v.reason })} onDone={reload} /> : null}>
          {latest.error ? <ErrorBox text={latest.error} /> : null}
          <SimpleTable rows={latest.lines} columns={[
            { key: "c", label: "Check", render: (l: any) => l.check },
            { key: "l", label: "Ledger", right: true, render: (l: any) => (l.ledgerMinor == null ? "" : ksh(l.ledgerMinor)) },
            { key: "p", label: "Provider", right: true, render: (l: any) => (l.providerMinor == null ? "" : ksh(l.providerMinor)) },
            { key: "d", label: "Difference", right: true, render: (l: any) => (l.differenceMinor ? <b className={l.ok ? "" : "err"}>{ksh(l.differenceMinor, { sign: true })}</b> : "0") },
            { key: "ok", label: "", render: (l: any) => <Status s={l.ok ? "ok" : "mismatch"} /> },
            { key: "n", label: "Note", render: (l: any) => <span className="small">{l.note}</span> },
          ]} />
          {latest.acknowledged_at ? <p className="hint" style={{ marginTop: 8 }}>Acknowledged {dt(latest.acknowledged_at)}: {latest.ack_note}</p> : null}
        </Card>
      ) : <Card><p className="muted">No runs yet. Run it now.</p></Card>}
      <Card title="Earlier runs" flush>
        <SimpleTable rows={d.data.runs.slice(1)} columns={[
          { key: "t", label: "When", render: (r: any) => dt(r.started_at) },
          { key: "tr", label: "Trigger", render: (r: any) => r.trigger },
          { key: "s", label: "Result", render: (r: any) => <Status s={r.status} /> },
          { key: "a", label: "Acknowledged", render: (r: any) => (r.acknowledged_at ? `${dt(r.acknowledged_at)}: ${r.ack_note}` : r.status === "mismatch" ? <span className="err">no</span> : "—") },
        ]} />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ ledger

export function Ledger() {
  const { can } = useSession();
  const [tab, setTab] = useState("accounts");
  const accounts = useApi<any>("/ledger/accounts");
  const platform = useApi<any>("/ledger/platform");
  const balances = useApi<any>(tab === "merchants" ? "/ledger/merchant-balances" : null);
  const [f, setF] = useQueryState({ account: "", ref: "", kind: "", from: "", to: "" });
  return (
    <div className="stack">
      <PageHead
        title="Ledger"
        sub="Double entry, append-only, integer minor units. Debits positive, credits negative. Entries are never edited; corrections are new entries with a second approver."
        actions={can("ledger.adjust") ? (
          <ActionButton
            label="Request an adjustment"
            title="Correcting entry or reversal"
            description="Either reverse an existing transaction, or give balanced lines (they must sum to zero). A second approver must approve before it's posted."
            path="/ledger/adjustments"
            fields={[
              { name: "reverses", label: "Transaction to reverse (ID), or leave empty", kind: "text" },
              { name: "lines", label: "Lines, one per row: account amount_KSh (debit +, credit −)", kind: "textarea", hint: "e.g.\nsuspense 50\nmerchant_payable:<merchant id> -50" },
            ]}
            build={(v) => ({ reason: v.reason, reverses: v.reverses || undefined, lines: v.lines ? String(v.lines).split("\n").map((l: string) => l.trim()).filter(Boolean).map((l: string) => { const [account, amt] = l.split(/\s+/); return { account, amountMinor: parseKsh(amt) ?? 0 }; }) : undefined })}
          />
        ) : null}
      />
      {platform.data ? (
        <div className="grid4">
          <Stat label="Platform revenue (commission)" value={<Money v={platform.data.revenueMinor} />} />
          <Stat label="Provider fees (net of recoveries)" value={<Money v={platform.data.providerFeesMinor} />} />
          <Stat label="Net" value={<Money v={platform.data.netMinor} />} />
          <Stat label="Available to withdraw" value={<Money v={platform.data.availableMinor} />} delta={`withdrawn ${ksh(platform.data.withdrawnMinor)}`} to="/platform-payouts" />
        </div>
      ) : null}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "accounts", label: "Accounts" }, { value: "entries", label: "Entries" }, { value: "merchants", label: "Merchant balances" }]} />
      {tab === "accounts" ? (
        <Card flush>
          {accounts.data ? (
            <SimpleTable rows={accounts.data.accounts} columns={[
              { key: "c", label: "Account", render: (a: any) => <button className="link mono" onClick={() => { setF({ account: a.code }); setTab("entries"); }}>{a.code}</button> },
              { key: "n", label: "Name", render: (a: any) => <>{a.name}{a.merchant ? <span className="faint"> · {a.merchant}</span> : null}</> },
              { key: "t", label: "Type", render: (a: any) => humanize(a.type) },
              { key: "b", label: "Balance", right: true, render: (a: any) => <b className="num">{ksh(a.balance_minor, { sign: true })}</b> },
            ]} />
          ) : <Loading />}
        </Card>
      ) : null}
      {tab === "entries" ? (
        <DataTable
          path="/ledger/entries"
          params={f}
          toolbar={
            <>
              <input className="input sm" placeholder="Account code" value={f.account} onChange={(e) => setF({ account: e.target.value })} style={{ width: 220 }} />
              <input className="input sm" placeholder="Reference / transaction" value={f.ref} onChange={(e) => setF({ ref: e.target.value })} style={{ width: 200 }} />
              <input className="input sm" placeholder="Kind" value={f.kind} onChange={(e) => setF({ kind: e.target.value })} style={{ width: 130 }} />
              <input className="input sm" type="date" value={f.from} onChange={(e) => setF({ from: e.target.value })} aria-label="From" />
              <input className="input sm" type="date" value={f.to} onChange={(e) => setF({ to: e.target.value })} aria-label="To" />
            </>
          }
          columns={[
            { key: "t", label: "When", render: (e: any) => <span className="small">{dt(e.created_at)}</span> },
            { key: "k", label: "Kind", render: (e: any) => <Link className="link mono" to={`/ledger/tx/${e.transaction_id}`}>{e.kind}</Link> },
            { key: "a", label: "Account", render: (e: any) => <span className="mono small">{e.account}</span> },
            { key: "dr", label: "Debit", right: true, render: (e: any) => (e.amount_minor > 0 ? ksh(e.amount_minor) : "") },
            { key: "cr", label: "Credit", right: true, render: (e: any) => (e.amount_minor < 0 ? ksh(-e.amount_minor) : "") },
            { key: "r", label: "Reference", render: (e: any) => <RefLink type={e.ref_type} id={e.ref_id} /> },
            { key: "m", label: "Memo", render: (e: any) => <span className="small">{e.memo}</span> },
          ]}
        />
      ) : null}
      {tab === "merchants" ? (
        <Card flush>
          {balances.data ? (
            <SimpleTable rows={balances.data.items} rowLink={(m: any) => `/merchants/${m.id}`} columns={[
              { key: "c", label: "Merchant", render: (m: any) => <>{m.code} · {m.business_name}</> },
              { key: "s", label: "Status", render: (m: any) => <Status s={m.status} /> },
              { key: "a", label: "Available", right: true, render: (m: any) => ksh(m.available) },
              { key: "r", label: "Reserved", right: true, render: (m: any) => ksh(m.reserved) },
              { key: "e", label: "Lifetime earned", right: true, render: (m: any) => ksh(m.lifetime_earned) },
              { key: "p", label: "Lifetime paid out", right: true, render: (m: any) => ksh(m.lifetime_paid_out) },
            ]} />
          ) : <Loading />}
        </Card>
      ) : null}
    </div>
  );
}

function RefLink({ type, id }: { type: string | null; id: string | null }) {
  if (!type || !id) return <>—</>;
  const to = type === "payment" ? `/payments/${id}` : type === "payout" ? `/payouts/${id}` : type === "ledger_transaction" ? `/ledger/tx/${id}` : null;
  return to ? <Link className="link small" to={to}>{type.replace("_", " ")}</Link> : <span className="small faint">{type.replace("_", " ")}</span>;
}

export function LedgerTx() {
  const { id = "" } = useParams();
  const d = useApi<any>(`/ledger/transactions/${id}`);
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const t = d.data.transaction;
  const sum = d.data.entries.reduce((s: number, e: any) => s + e.amount_minor, 0);
  return (
    <div className="stack">
      <PageHead crumb={{ to: "/ledger", label: "Ledger" }} title={<span className="mono">{t.kind}</span>} sub={<>{dtFull(t.created_at)} · {t.memo} · by {t.created_by}</>} />
      <Card title="Entries" actions={<Status s={sum === 0 ? "ok" : "mismatch"} />}>
        <SimpleTable rows={d.data.entries} columns={[
          { key: "a", label: "Account", render: (e: any) => <span className="mono">{e.account}</span> },
          { key: "dr", label: "Debit", right: true, render: (e: any) => (e.amount_minor > 0 ? ksh(e.amount_minor) : "") },
          { key: "cr", label: "Credit", right: true, render: (e: any) => (e.amount_minor < 0 ? ksh(-e.amount_minor) : "") },
        ]} />
        <KV rows={[["Reference", <RefLink type={t.ref_type} id={t.ref_id} />], ["Reverses", t.reverses ? <Link className="link mono" to={`/ledger/tx/${t.reverses}`}>{t.reverses}</Link> : "—"], ["Idempotency key", <span className="mono tiny">{t.idempotency_key ?? "—"}</span>]]} />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ platform payouts

export function PlatformPayouts() {
  const { can } = useSession();
  const d = useApi<any>("/platform-payouts");
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error} />;
  return (
    <div className="stack">
      <PageHead
        crumb={{ to: "/payouts", label: "Payouts" }}
        title="Platform payouts"
        sub="Withdraw the operator's commission to the configured number, with the same safeguards as merchant payouts."
        actions={
          can("payouts.platform") && d.data.destination ? (
            <ActionButton money label="Withdraw commission" title="Withdraw platform commission" description={`Available: ${ksh(d.data.availableMinor)}. Goes to ${d.data.destination}. Above the approval threshold, a second approver is needed and you can't approve your own.`} path="/platform-payouts" reason={false} fields={[{ name: "amount", label: "Amount (KSh)", kind: "money", required: true, initial: String(Math.floor(d.data.availableMinor / 100)) }]} build={(v) => ({ amountMinor: parseKsh(v.amount) })} onDone={() => void d.reload()} />
          ) : null
        }
      />
      {!d.data.destination ? <Banner tone="wait" title="No platform payout number">Set it in <Link className="link" to="/settings">Settings → Platform payout</Link>.</Banner> : null}
      <div className="grid2">
        <Stat label="Available" value={<Money v={d.data.availableMinor} />} />
        <Stat label="Destination" value={d.data.destination ?? "—"} />
      </div>
      <Card flush>
        <SimpleTable rows={d.data.items} rowLink={(p: any) => `/payouts/${p.id}`} columns={[
          { key: "r", label: "Ref", render: (p: any) => <span className="mono">{p.ref}</span> },
          { key: "a", label: "Amount", right: true, render: (p: any) => ksh(p.gross_minor) },
          { key: "s", label: "Status", render: (p: any) => <Status s={p.status} /> },
          { key: "b", label: "By", render: (p: any) => p.requested_by_label },
          { key: "t", label: "Requested", render: (p: any) => dt(p.requested_at) },
          { key: "m", label: "Receipt", render: (p: any) => p.mpesa_receipt ?? p.failure_reason ?? "—" },
        ]} empty="No platform payouts yet." />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ pricing

export function Pricing() {
  const { can } = useSession();
  const d = useApi<any>("/pricing");
  const merchants = useApi<any>("/merchants?pageSize=500");
  const tables = useApi<any>("/tables?pageSize=500");
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const p = d.data;
  const reload = () => void d.reload();
  return (
    <div className="stack">
      <PageHead
        title="Pricing and commission"
        sub="Commission changes apply only to payments after their effective time, and need a second approver."
        actions={
          can("pricing.manage") ? (
            <>
              <ActionButton
                label="Change commission"
                title="Request a commission change"
                path="/pricing/commission"
                fields={[
                  { name: "scope", label: "Applies to", kind: "select", required: true, initial: "default", options: [{ value: "default", label: "Platform default" }, { value: "merchant", label: "One merchant" }, { value: "table", label: "One table" }] },
                  { name: "scopeId", label: "Merchant or table", kind: "select", options: [...(merchants.data?.items ?? []).map((m: any) => ({ value: m.id, label: `Merchant ${m.code} · ${m.business_name}` })), ...(tables.data?.items ?? []).map((t: any) => ({ value: t.id, label: `Table ${t.id} · ${t.name}` }))] },
                  { name: "commission", label: "Fixed per game (KSh)", kind: "money", required: true, initial: String(p.defaults.commission_minor / 100) },
                  { name: "pct", label: "Plus percentage (optional)", kind: "number", initial: "0" },
                  { name: "effectiveFrom", label: "Effective from (Nairobi time; empty = on approval)", kind: "datetime" },
                ]}
                build={(v) => ({ scope: v.scope, scopeId: v.scope === "default" ? undefined : v.scopeId, commissionMinor: parseKsh(v.commission), commissionPct: Number(v.pct || 0), effectiveFrom: v.effectiveFrom ? new Date(`${v.effectiveFrom}:00+03:00`).toISOString() : undefined, reason: v.reason })}
                onDone={reload}
              />
              <ActionButton
                tone="plain"
                label="Change fee policy"
                title="Who bears the fees"
                path="/pricing/fee-policy"
                fields={[
                  { name: "b2c", label: "B2C (withdrawal) fee borne by", kind: "select", required: true, initial: p.feePolicy.b2c, options: [{ value: "merchant", label: "Merchant (deducted from the payout)" }, { value: "platform", label: "Platform (absorbed)" }] },
                  { name: "collection", label: "Paybill collection fee borne by", kind: "select", required: true, initial: p.feePolicy.collection, options: [{ value: "platform", label: "Platform (expense)" }, { value: "merchant", label: "Merchant" }] },
                ]}
                onDone={reload}
              />
            </>
          ) : null
        }
      />
      {p.pending.length ? <Banner tone="wait" icon="approve" title={`${p.pending.length} pricing change(s) waiting for approval`}>{p.pending.map((x: any) => x.summary).join(" · ")} <Link className="link" to="/approvals">Approvals</Link></Banner> : null}
      <div className="grid2">
        <Card title="Defaults" actions={can("settings.manage") ? <Link className="link small" to="/settings">Edit in Settings</Link> : null}>
          <KV rows={[
            ["Price per game", ksh(p.defaults.price_minor)],
            ["Unlock time", `${p.defaults.unlock_seconds} s`],
            ["Commission", `${ksh(p.defaults.commission_minor)} a game${p.defaults.commission_pct ? ` + ${p.defaults.commission_pct}%` : ""}`],
            ["Owner price bounds", `${ksh(p.defaults.price_min_minor)} – ${ksh(p.defaults.price_max_minor)}`],
            ["Owner unlock bounds", `${p.defaults.unlock_min_s} – ${p.defaults.unlock_max_s} s`],
            ["B2C fee borne by", humanize(p.feePolicy.b2c)],
            ["Paybill fee borne by", humanize(p.feePolicy.collection)],
          ]} />
        </Card>
        <Card title="Payout and amount rules">
          <KV rows={[
            ["Minimum withdrawal", ksh(p.payout.min_minor)],
            ["Daily cap", ksh(p.payout.daily_cap_minor)],
            ["Approval above", ksh(p.payout.approval_threshold_minor)],
            ["Finance can approve up to", ksh(p.payout.finance_approval_limit_minor)],
            ["Number-change cooling-off", `${p.payout.cooling_hours} h`],
            ["Part-payment window", `${p.amountRules.partial_window_min} min`],
            ["Offline retry window", `${p.amountRules.offline_retry_min} min`],
            ["Games cap per payment", p.amountRules.games_cap],
          ]} />
        </Card>
      </div>
      <Card title="Commission rules" flush>
        <SimpleTable rows={p.rules} columns={[
          { key: "s", label: "Scope", render: (r: any) => (r.scope === "default" ? "Platform default" : `${humanize(r.scope)}: ${r.scope_name ?? r.scope_id}`) },
          { key: "c", label: "Per game", right: true, render: (r: any) => ksh(r.commission_minor) },
          { key: "p", label: "%", right: true, render: (r: any) => Number(r.commission_pct) || "—" },
          { key: "e", label: "Effective from", render: (r: any) => dtFull(r.effective_from) },
          { key: "a", label: "Approval", render: (r: any) => (r.approval_id ? "four-eyes" : "—") },
        ]} empty="No rules yet: the default in Settings applies." />
      </Card>
      <div className="grid2">
        <Card title="B2C tariff (what Safaricom charges per payout)">
          <SimpleTable rows={p.b2cTariff} columns={[{ key: "u", label: "Up to", render: (b: any) => ksh(b.upTo) }, { key: "f", label: "Fee", right: true, render: (b: any) => ksh(b.fee) }]} />
          <p className="hint" style={{ marginTop: 8 }}>Confirm against the current Safaricom tariff. Edit in Settings.</p>
        </Card>
        <Card title="Paybill collection tariff">
          <SimpleTable rows={p.collectionTariff} columns={[{ key: "u", label: "Up to", render: (b: any) => ksh(b.upTo) }, { key: "f", label: "Fee", right: true, render: (b: any) => ksh(b.fee) }]} empty="None booked. If Safaricom charges a collection fee, set it in Settings or reconciliation will show the gap." />
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ reports

export function Reports() {
  const { can } = useSession();
  const [date, setDate] = useState(nairobiDay(new Date(Date.now() - 86_400_000)));
  const d = useApi<any>(`/reports/daily?date=${date}`);
  const [period, setPeriod] = useState("month");
  const s = useApi<any>(`/stats?period=${period}`);
  const r = d.data?.report;
  return (
    <div className="stack">
      <PageHead title="Reports" sub="The daily close (emailed at 00:05 to the report recipients) and platform analytics." />
      <Card
        title="Daily close"
        actions={
          <>
            <input className="input sm" type="date" value={date} max={nairobiDay()} onChange={(e) => setDate(e.target.value)} aria-label="Day" />
            <a className="btn sm" href={`/v1/a/reports/daily.csv?date=${date}`} download>CSV</a>
            {can("reports.manage") ? <button className="btn sm" onClick={async () => { try { await call("/reports/daily/run", { method: "POST", body: { date } }); toast("Rebuilt and emailed"); void d.reload(); } catch (x) { toast(errText(x), true); } }}>Rebuild and email</button> : null}
          </>
        }
      >
        {r ? (
          <div className="grid2">
            <KV rows={[
              ["Payments", r.collections.payments],
              ["Collected", ksh(r.collections.totalMinor)],
              ["Credited to tables", ksh(r.collections.creditedMinor)],
              ["Unmatched (suspense)", ksh(r.collections.unmatchedMinor)],
              ["Games", r.collections.games],
              ["Commission", ksh(r.commissionMinor)],
              ["Payouts", `${r.payouts.count} · ${ksh(r.payouts.grossMinor)} gross, ${ksh(r.payouts.netMinor)} net`],
              ["Withdrawal fees charged", ksh(r.payouts.feesChargedMinor)],
              ["B2C tariff paid", ksh(r.payouts.providerTariffMinor)],
              ["Refunds paid", `${r.refunds.count} · ${ksh(r.refunds.totalMinor)}`],
            ]} />
            <SimpleTable rows={r.closingBalances} columns={[{ key: "n", label: "Closing balance", render: (b: any) => b.name }, { key: "v", label: "", right: true, render: (b: any) => ksh(b.balanceMinor, { sign: true }) }]} />
          </div>
        ) : d.error ? <ErrorBox error={d.error} /> : <Loading />}
        {d.data ? <p className="hint" style={{ marginTop: 8 }}>{d.data.stored ? `Stored${d.data.emailedAt ? `, emailed ${dt(d.data.emailedAt)}` : ", not emailed"}` : "Computed live (not stored yet)"}.</p> : null}
      </Card>
      <Card title="Analytics" actions={<select className="input sm" value={period} onChange={(e) => setPeriod(e.target.value)}>{[["today", "Today"], ["7d", "7 days"], ["month", "This month"], ["year", "This year"], ["all", "All time"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}>
        {s.data ? (
          <div className="stack">
            <div className="grid4">
              <Stat label="Games" value={s.data.kpis.games} />
              <Stat label="Collected" value={ksh(s.data.kpis.collectedMinor)} />
              <Stat label="Commission" value={ksh(s.data.kpis.commissionMinor)} />
              <Stat label="Failed payment rate" value={`${s.data.kpis.failedRate}%`} delta={Object.entries(s.data.kpis.failedByCategory).map(([k, v]) => `${humanize(k)} ${v}`).join(" · ")} />
            </div>
            <BarChart
              height={180}
              ariaLabel="Games per period"
              format={(v) => String(Math.round(v))}
              data={s.data.series.map((x: any) => ({
                key: x.bucket,
                label: x.bucket.length > 7 ? x.bucket.slice(8) : x.bucket.slice(5),
                value: x.games,
                tip: (
                  <>
                    <b>{x.bucket}</b>
                    {x.games} <span>games</span> · {ksh(x.collectedMinor)} <span>collected</span>
                  </>
                ),
              }))}
            />
            <SimpleTable rows={s.data.byTable} rowLink={(t: any) => `/tables/${t.tableId}`} columns={[{ key: "t", label: "Table", render: (t: any) => `${t.tableId} · ${t.name}` }, { key: "g", label: "Games", right: true, render: (t: any) => t.games }, { key: "e", label: "Merchant earnings", right: true, render: (t: any) => ksh(t.earningsMinor) }]} />
          </div>
        ) : <Loading />}
      </Card>
    </div>
  );
}
