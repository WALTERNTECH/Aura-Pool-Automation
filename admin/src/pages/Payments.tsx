import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ActionButton } from "../components/Action";
import { DataTable, SimpleTable } from "../components/DataTable";
import { Banner, Card, ErrorBox, Json, KV, Loading, Money, PageHead, Status, Tabs } from "../components/ui";
import { ago, dt, dtFull, humanize, ksh, parseKsh } from "../lib/format";
import { useApi, useQueryState } from "../lib/hooks";
import { useSession } from "../lib/session";
import { payCols } from "./Merchants";

export function PaymentList() {
  const [f, setF] = useQueryState({ q: "", status: "", table: "", account: "", phone: "", amount: "", from: "", to: "" });
  const params = { ...f, amount: undefined, amountMinor: f.amount ? parseKsh(f.amount) ?? undefined : undefined };
  return (
    <div className="stack">
      <PageHead title="Payments" sub="Every M-Pesa payment, from callback to unlock." actions={<Link className="btn" to="/exceptions">Exception queues</Link>} />
      <DataTable
        storageKey="payments"
        path="/payments"
        params={params}
        exportPath="/payments/export"
        refreshMs={30_000}
        rowLink={(p) => `/payments/${p.id}`}
        toolbar={
          <>
            <input className="input sm" placeholder="M-Pesa code" value={f.q} onChange={(e) => setF({ q: e.target.value })} style={{ width: 140 }} />
            <input className="input sm" placeholder="Account no." value={f.account} onChange={(e) => setF({ account: e.target.value })} style={{ width: 110 }} />
            <input className="input sm" placeholder="Table" value={f.table} onChange={(e) => setF({ table: e.target.value })} style={{ width: 80 }} />
            <input className="input sm" placeholder="Phone (masked)" value={f.phone} onChange={(e) => setF({ phone: e.target.value })} style={{ width: 130 }} />
            <input className="input sm" placeholder="Amount KSh" value={f.amount} onChange={(e) => setF({ amount: e.target.value })} style={{ width: 100 }} />
            <select className="input sm" value={f.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="">Any status</option>
              {["received", "verifying", "credited", "unmatched", "underpaid", "refund_pending", "refunded", "rejected"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
            </select>
            <input className="input sm" type="date" value={f.from} onChange={(e) => setF({ from: e.target.value })} aria-label="From" />
            <input className="input sm" type="date" value={f.to} onChange={(e) => setF({ to: e.target.value })} aria-label="To" />
          </>
        }
        columns={payCols}
      />
    </div>
  );
}

export function PaymentDetail() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const d = useApi<any>(`/payments/${id}`);
  const tables = useApi<any>(can("payments.resolve") ? "/tables?pageSize=500" : null);
  if (d.loading) return <Loading h={400} />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const p = d.data.payment;
  const reload = () => void d.reload();
  const failedCredits = d.data.credits.filter((c: any) => ["expired", "failed"].includes(c.status));
  return (
    <div className="stack">
      <PageHead
        crumb={{ to: "/payments", label: "Payments" }}
        title={<span className="mono" style={{ fontSize: 22 }}>{p.provider_txn_id}</span>}
        sub={<>{ksh(p.amount_minor)} · {humanize(p.channel)} · account <span className="mono">{p.account_ref}</span> · <Status s={p.status} /> {p.problem ? <span className="badge bad">{humanize(p.problem)}</span> : null}</>}
        actions={
          can("payments.resolve") ? (
            <>
              {p.status === "unmatched" ? (
                <>
                  <ActionButton label="Assign to a table" title="Assign this payment to a table" description={`Credits the merchant from suspense (${ksh(p.amount_minor)}) using the normal split, and writes the ledger entries.`} path={`/payments/${id}/assign`} fields={[{ name: "tableId", label: "Table", kind: "select", required: true, options: (tables.data?.items ?? []).map((t: any) => ({ value: t.id, label: `${t.id} · ${t.name} (${t.merchant})` })) }, { name: "unlock", label: "Also unlock the table for the games paid", kind: "check", initial: true }]} build={(v) => ({ tableId: v.tableId, unlock: Boolean(v.unlock), reason: v.reason })} onDone={reload} />
                  <ActionButton tone="plain" label="Keep in suspense" title="Keep this payment in suspense" path={`/payments/${id}/keep`} onDone={reload} />
                </>
              ) : null}
              {p.status === "unmatched" || (p.status === "credited" && failedCredits.length) ? (
                <ActionButton tone="danger" label="Mark for refund" title="Mark for refund" description={p.status === "unmatched" ? `Moves ${ksh(p.amount_minor)} from suspense to refunds owed. Then make the refund in the M-Pesa portal and record it.` : `Takes back the ${failedCredits.length} game(s) that never unlocked from the merchant and platform, and owes it to the customer.`} path={`/payments/${id}/refund`} onDone={reload} />
              ) : null}
              {p.status === "rejected" && p.verification_status === "mismatch" ? (
                <ActionButton label="Clear verification" title="Confirm this payment is genuine" description="Only after checking the transaction in the M-Pesa portal. The payment then continues as normal and the merchant's payouts are restored if nothing else is under review." path={`/payments/${id}/clear-verification`} onDone={reload} />
              ) : null}
            </>
          ) : null
        }
      />
      {p.verification_status === "mismatch" ? <Banner tone="bad" icon="alert" title="Failed verification">{p.verification_detail?.reason}</Banner> : null}
      <div className="grid2">
        <Card title="Payment">
          <KV rows={[
            ["Amount", <Money v={p.amount_minor} />],
            ["Table", p.table_id ? <Link className="link" to={`/tables/${p.table_id}`}>{p.table_id}</Link> : "—"],
            ["Merchant", p.merchant_id ? <Link className="link" to={`/merchants/${p.merchant_id}`}>{p.merchant}</Link> : "—"],
            ["Payer", `${p.payer_name_masked ?? ""} ${p.payer_msisdn_masked ?? ""}`],
            ["Price at the time", p.price_minor ? ksh(p.price_minor) : "—"],
            ["Games credited", p.games_credited],
            ["Commission", <Money v={p.commission_minor} />],
            ["Merchant share", <Money v={p.merchant_share_minor} />],
            ["Held (left over)", <Money v={p.remainder_minor} />],
            ["Part payment applied", <Money v={p.partial_applied_minor} />],
            ["Refunded", <Money v={p.refund_minor} />],
            ["M-Pesa time", dtFull(p.trans_time)],
            ["Verification", <><Status s={p.verification_status} /> {p.verified_at ? <span className="small faint">{dt(p.verified_at)}</span> : null}</>],
            ["Resolution", p.resolution ? <span className="small">{humanize(p.resolution.action)}: {p.resolution.reason}</span> : "—"],
          ]} />
        </Card>
        <Card title="Timeline">
          <div className="timeline">
            {d.data.timeline.map((s: any) => (
              <div key={s.step} className={`t${s.at ? " done" : ""}`}>
                <span className="m" />
                <span>{s.step}</span>
                <span className="small faint">{s.at ? dtFull(s.at) : "—"}</span>
              </div>
            ))}
          </div>
          <h3 style={{ margin: "14px 0 6px" }}>Games</h3>
          <SimpleTable rows={d.data.credits} columns={[
            { key: "s", label: "Status", render: (c: any) => <Status s={c.status} /> },
            { key: "a", label: "Tries", right: true, render: (c: any) => c.attempts },
            { key: "ak", label: "Acknowledged", render: (c: any) => dt(c.acked_at) },
            { key: "e", label: "Expires", render: (c: any) => dt(c.expires_at) },
            { key: "x", label: "", render: (c: any) => (can("payments.resolve") && ["expired", "failed"].includes(c.status) ? <ActionButton small label="Retry unlock" title="Send this game's unlock again" description="The game waits for the table for another 15 minutes." path={`/credits/${c.id}/retry`} onDone={reload} /> : c.resolution ? <span className="tiny faint">{c.resolution}</span> : null) },
          ]} empty="No games (not credited)." />
        </Card>
      </div>
      <Card title="Ledger entries">
        <SimpleTable rows={d.data.ledger} columns={[
          { key: "t", label: "When", render: (e: any) => <span className="small">{dt(e.created_at)}</span> },
          { key: "k", label: "Kind", render: (e: any) => <Link className="link mono" to={`/ledger/tx/${e.transaction_id}`}>{e.kind}</Link> },
          { key: "a", label: "Account", render: (e: any) => <span className="mono">{e.account}</span> },
          { key: "dr", label: "Debit", right: true, render: (e: any) => (e.amount_minor > 0 ? ksh(e.amount_minor) : "") },
          { key: "cr", label: "Credit", right: true, render: (e: any) => (e.amount_minor < 0 ? ksh(-e.amount_minor) : "") },
        ]} empty="No ledger entries (nothing credited)." />
      </Card>
      <div className="grid2">
        <Card title="Unlock commands">
          <SimpleTable rows={d.data.commands} columns={[
            { key: "i", label: "Issued", render: (c: any) => dt(c.issued_at) },
            { key: "s", label: "Status", render: (c: any) => <Status s={c.status} /> },
            { key: "a", label: "Tries", right: true, render: (c: any) => c.attempts },
            { key: "ack", label: "Ack", render: (c: any) => (c.ack_result ? `${c.ack_result} ${c.ack_reason ?? ""}` : "—") },
          ]} empty="None." />
        </Card>
        <Card title="Callbacks and refunds">
          <SimpleTable rows={d.data.callbacks} columns={[
            { key: "k", label: "Callback", render: (c: any) => humanize(c.kind) },
            { key: "t", label: "Received", render: (c: any) => dt(c.received_at) },
            { key: "ms", label: "ms", right: true, render: (c: any) => c.processing_ms },
            { key: "ok", label: "", render: (c: any) => (c.ok ? <Status s="ok" /> : <span className="err">{c.error}</span>) },
          ]} empty="None logged." />
          {d.data.refunds.length ? <SimpleTable rows={d.data.refunds} columns={[{ key: "r", label: "Refund", render: (r: any) => r.ref }, { key: "a", label: "Amount", right: true, render: (r: any) => ksh(r.amount_minor) }, { key: "s", label: "Status", render: (r: any) => <Status s={r.status} /> }, { key: "m", label: "M-Pesa", render: (r: any) => r.mpesa_ref ?? "—" }]} /> : null}
        </Card>
      </div>
      <Card title="Raw callback payload (read-only; phone numbers masked)">
        <Json value={p.raw_payload} />
      </Card>
    </div>
  );
}

export function Exceptions() {
  const { can } = useSession();
  const [tab, setTab] = useState("unmatched");
  const d = useApi<any>("/exceptions", { refreshMs: 30_000 });
  const tables = useApi<any>(can("payments.resolve") ? "/tables?pageSize=500" : null);
  if (d.loading) return <Loading h={300} />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const c = d.data.counts;
  const reload = () => void d.reload();
  const resolvePartial = (kind: "underpaid" | "remainder") => (x: any) =>
    can("payments.resolve") ? (
      <div className="row wrap">
        <ActionButton small tone="danger" label="Refund" title={`Refund ${ksh(x.amount_minor)}`} path={`/partials/${x.id}/resolve`} build={(v) => ({ decision: "refund", reason: v.reason })} onDone={reload} />
        <ActionButton small tone="plain" label="Credit merchant" title={`Credit ${ksh(x.amount_minor)} to the merchant`} description="The full amount goes to the merchant's balance; no game is unlocked." path={`/partials/${x.id}/resolve`} build={(v) => ({ decision: "credit_merchant", reason: v.reason })} onDone={reload} />
        {kind === "underpaid" ? <ActionButton small label="Give a game" title="Unlock one game for this underpayment" description="The merchant gets the amount less up to one commission; the table unlocks once." path={`/partials/${x.id}/resolve`} build={(v) => ({ decision: "grant_game", reason: v.reason })} onDone={reload} /> : null}
      </div>
    ) : null;
  return (
    <div className="stack">
      <PageHead title="Exception queues" sub="Every payment must end in a resolved status within 24 hours. Each resolution writes its own ledger entries; amounts are never edited." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "unmatched", label: "Unmatched", n: c.unmatched, alert: true },
          { value: "underpaid", label: "Underpaid", n: c.underpaid, alert: true },
          { value: "overpaid", label: "Overpaid", n: c.overpaid, alert: true },
          { value: "unlock", label: "Unlock failed", n: c.unlock_failed, alert: true },
          { value: "verification", label: "Verification failed", n: c.verification_failed, alert: true },
          { value: "refund", label: "Refund pending", n: c.refund_pending, alert: true },
        ]}
      />
      {tab === "unmatched" ? (
        <Card flush>
          <SimpleTable rows={d.data.unmatched} rowLink={(p: any) => `/payments/${p.id}`} columns={[
            { key: "t", label: "Received", render: (p: any) => dt(p.received_at) },
            { key: "c", label: "Code", render: (p: any) => <span className="mono">{p.provider_txn_id}</span> },
            { key: "a", label: "Account typed", render: (p: any) => <b className="mono">{p.account_ref || "(blank)"}</b> },
            { key: "am", label: "Amount", right: true, render: (p: any) => ksh(p.amount_minor) },
            { key: "ph", label: "Payer", render: (p: any) => p.payer_msisdn_masked },
            { key: "pr", label: "Why", render: (p: any) => humanize(p.problem) },
            { key: "r", label: "", render: (p: any) => (p.resolution ? <span className="badge">kept in suspense</span> : can("payments.resolve") ? <ActionButton small label="Assign" title={`Assign ${p.provider_txn_id}`} path={`/payments/${p.id}/assign`} fields={[{ name: "tableId", label: "Table", kind: "select", required: true, options: (tables.data?.items ?? []).map((t: any) => ({ value: t.id, label: `${t.id} · ${t.name}` })) }, { name: "unlock", label: "Also unlock the table", kind: "check", initial: true }]} build={(v) => ({ tableId: v.tableId, unlock: Boolean(v.unlock), reason: v.reason })} onDone={reload} /> : null) },
          ]} empty="No unmatched payments." />
        </Card>
      ) : null}
      {tab === "underpaid" || tab === "overpaid" ? (
        <Card flush>
          <SimpleTable rows={tab === "underpaid" ? d.data.underpaid : d.data.overpaid} columns={[
            { key: "t", label: "Since", render: (x: any) => dt(x.created_at) },
            { key: "tb", label: "Table", render: (x: any) => x.table_id },
            { key: "m", label: "Merchant", render: (x: any) => x.merchant },
            { key: "a", label: tab === "underpaid" ? "Paid" : "Left over", right: true, render: (x: any) => ksh(x.amount_minor) },
            { key: "s", label: "State", render: (x: any) => (x.status === "open" ? <span className="badge wait">held until {dt(x.expires_at)}</span> : <Status s="review" />) },
            { key: "p", label: "Payment", render: (x: any) => <Link className="link" to={`/payments/${x.payment_ids[x.payment_ids.length - 1]}`}>open</Link> },
            { key: "act", label: "", render: resolvePartial(tab === "underpaid" ? "underpaid" : "remainder") },
          ]} empty="Nothing waiting." />
        </Card>
      ) : null}
      {tab === "unlock" ? (
        <Card flush>
          <SimpleTable rows={d.data.unlockFailed} columns={[
            { key: "t", label: "Paid", render: (x: any) => dt(x.created_at) },
            { key: "tb", label: "Table", render: (x: any) => <Link className="link" to={`/tables/${x.table_id}`}>{x.table_id}</Link> },
            { key: "c", label: "Payment", render: (x: any) => <Link className="link mono" to={`/payments/${x.payment_id}`}>{x.provider_txn_id}</Link> },
            { key: "a", label: "Amount", right: true, render: (x: any) => ksh(x.amount_minor) },
            { key: "s", label: "Status", render: (x: any) => <Status s={x.status} /> },
            { key: "act", label: "", render: (x: any) => (can("payments.resolve") ? <div className="row"><ActionButton small label="Retry unlock" title="Send the unlock again" path={`/credits/${x.credit_id}/retry`} onDone={reload} /><ActionButton small tone="danger" label="Refund" title="Mark for refund" path={`/payments/${x.payment_id}/refund`} onDone={reload} /></div> : null) },
          ]} empty="No failed unlocks." />
        </Card>
      ) : null}
      {tab === "verification" ? (
        <Card flush>
          <SimpleTable rows={d.data.verificationFailed} rowLink={(p: any) => `/payments/${p.id}`} columns={[
            { key: "t", label: "Received", render: (p: any) => dt(p.received_at) },
            { key: "c", label: "Code", render: (p: any) => <span className="mono">{p.provider_txn_id}</span> },
            { key: "a", label: "Account", render: (p: any) => p.account_ref },
            { key: "am", label: "Amount", right: true, render: (p: any) => ksh(p.amount_minor) },
            { key: "r", label: "Mismatch", render: (p: any) => <span className="err">{p.verification_detail?.reason}</span> },
          ]} empty="No verification failures." />
        </Card>
      ) : null}
      {tab === "refund" ? (
        <Card flush>
          <SimpleTable rows={d.data.refundPending} columns={[
            { key: "r", label: "Refund", render: (x: any) => <span className="mono">{x.ref}</span> },
            { key: "t", label: "Since", render: (x: any) => `${dt(x.created_at)} (${ago(x.created_at)})` },
            { key: "a", label: "Amount", right: true, render: (x: any) => <b>{ksh(x.amount_minor)}</b> },
            { key: "to", label: "To", render: (x: any) => x.msisdn_masked ?? "see payment" },
            { key: "w", label: "Why", render: (x: any) => <span className="small">{x.reason}</span> },
            { key: "p", label: "Payment", render: (x: any) => (x.payment_id ? <Link className="link" to={`/payments/${x.payment_id}`}>open</Link> : "—") },
            {
              key: "act",
              label: "",
              render: (x: any) =>
                can("refunds.record") ? (
                  <ActionButton small label="Record refund" title={`Record refund ${x.ref}`} description={`Record the ${ksh(x.amount_minor)} reversal or payment you made in the M-Pesa portal. This closes it and writes the ledger entries.`} path={`/refunds/${x.id}/record`} reason={false} fields={[{ name: "mpesaRef", label: "M-Pesa reference", kind: "text", required: true }, { name: "paidFrom", label: "Paid from", kind: "select", required: true, options: [{ value: "utility", label: "Utility account (reversal)" }, { value: "working", label: "Working account (B2C)" }] }]} onDone={reload} />
                ) : null,
            },
          ]} empty="No refunds pending." />
        </Card>
      ) : null}
    </div>
  );
}
