import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ActionButton } from "../components/Action";
import { DataTable, SimpleTable } from "../components/DataTable";
import { Banner, Card, Copy, ErrorBox, Json, KV, Loading, Money, PageHead, Stat, Status, Tabs, toast } from "../components/ui";
import { call, errText } from "../lib/api";
import { ago, dt, dtFull, humanize, ksh, parseKsh, until } from "../lib/format";
import { useApi, useQueryState } from "../lib/hooks";
import { useSession } from "../lib/session";

// ------------------------------------------------------------------ alerts

const ALERT_LINK = (a: any) =>
  a.entity_type === "payment" ? `/payments/${a.entity_id}` : a.entity_type === "table" ? `/tables/${a.entity_id}` : a.entity_type === "payout" ? `/payouts/${a.entity_id}` : a.entity_type === "merchant" ? `/merchants/${a.entity_id}` : a.entity_type === "approval" ? "/approvals" : a.entity_type === "reconciliation_run" ? "/reconciliation" : a.entity_type === "float" ? "/float" : a.entity_type === "partial_credit" ? "/exceptions" : null;

export function Alerts() {
  const [f, setF] = useQueryState({ status: "active", severity: "" });
  return (
    <div className="stack">
      <PageHead title="Alerts" sub="Critical alerts also go out by SMS and email. Alerts resolve themselves when their condition clears; the history stays." />
      <DataTable
        path="/alerts"
        params={f}
        refreshMs={30_000}
        rowLink={(a) => `/alerts/${a.id}`}
        toolbar={
          <>
            <select className="input sm" value={f.status} onChange={(e) => setF({ status: e.target.value })}>
              <option value="active">Open and acknowledged</option>
              <option value="open">Open</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="resolved">Resolved</option>
            </select>
            <select className="input sm" value={f.severity} onChange={(e) => setF({ severity: e.target.value })}>
              <option value="">Any severity</option>
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </>
        }
        columns={[
          { key: "sev", label: "Severity", render: (a) => <span className={`sev-${a.severity}`} style={{ fontWeight: 650 }}>● {humanize(a.severity)}</span> },
          { key: "title", label: "Alert", render: (a) => <><b>{a.title}</b>{a.detail ? <div className="small muted" style={{ maxWidth: 520 }}>{a.detail}</div> : null}</> },
          { key: "type", label: "Type", render: (a) => <span className="mono tiny">{a.type}</span>, hidden: true },
          { key: "n", label: "Times", right: true, render: (a) => a.occurrences },
          { key: "status", label: "Status", render: (a) => <Status s={a.status} /> },
          { key: "owner", label: "Owner", render: (a) => a.owner_name ?? "—" },
          { key: "seen", label: "Last seen", render: (a) => <span className="small">{ago(a.last_seen_at)}</span> },
        ]}
        empty="No alerts. Quiet is good."
      />
    </div>
  );
}

export function AlertDetail() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const d = useApi<any>(`/alerts/${id}`);
  const users = useApi<any>(can("alerts.manage") ? "/users" : null);
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const a = d.data.alert;
  const link = ALERT_LINK(a);
  const reload = () => void d.reload();
  return (
    <div className="stack">
      <PageHead
        crumb={{ to: "/alerts", label: "Alerts" }}
        title={<span className={`sev-${a.severity}`}>{a.title}</span>}
        sub={<>{humanize(a.severity)} · <Status s={a.status} /> · opened {dt(a.created_at)} · seen {a.occurrences}×</>}
        actions={
          can("alerts.manage") ? (
            <>
              {link ? <Link className="btn" to={link}>Open what it's about</Link> : null}
              {a.status === "open" ? <ActionButton label="Acknowledge" title="Acknowledge" reason="Note" path={`/alerts/${id}/ack`} build={(v) => ({ note: v.reason })} onDone={reload} /> : null}
              {a.status !== "resolved" ? <ActionButton tone="plain" label="Resolve" title="Resolve" reason="What was done" path={`/alerts/${id}/resolve`} build={(v) => ({ note: v.reason })} onDone={reload} /> : <ActionButton tone="plain" label="Reopen" title="Reopen" reason="Why" path={`/alerts/${id}/reopen`} build={(v) => ({ note: v.reason })} onDone={reload} />}
            </>
          ) : null
        }
      />
      {a.detail ? <Banner tone={a.severity === "critical" ? "bad" : a.severity === "warning" ? "wait" : "info"}>{a.detail}</Banner> : null}
      <div className="grid2">
        <Card title="History">
          <SimpleTable rows={d.data.history} columns={[{ key: "t", label: "When", render: (h: any) => dt(h.at) }, { key: "k", label: "What", render: (h: any) => humanize(h.kind) }, { key: "w", label: "Who", render: (h: any) => h.actor ?? "system" }, { key: "n", label: "Note", render: (h: any) => <span className="small">{h.note}</span> }]} />
        </Card>
        <Card title="Owner and notes">
          {can("alerts.manage") ? (
            <div className="stack">
              <select className="input" value={a.owner_id ?? ""} onChange={async (e) => { await call(`/alerts/${id}/assign`, { method: "POST", body: { adminId: e.target.value || null } }); reload(); }} aria-label="Owner">
                <option value="">No owner</option>
                {(users.data?.users ?? []).filter((u: any) => u.status === "active").map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <ActionButton tone="plain" label="Add note" title="Add a note" reason="Note" path={`/alerts/${id}/note`} build={(v) => ({ note: v.reason })} onDone={reload} />
            </div>
          ) : <p className="muted">{a.owner_name ?? "No owner"}</p>}
          {Object.keys(a.data ?? {}).length ? <div style={{ marginTop: 12 }}><Json value={a.data} /></div> : null}
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ approvals

export function Approvals() {
  const { me } = useSession();
  const [status, setStatus] = useState("pending");
  const d = useApi<any>(`/approvals?status=${status}`, { refreshMs: 30_000 });
  const reload = () => void d.reload();
  return (
    <div className="stack">
      <PageHead title="Approvals" sub="Four-eyes requests. The requester can't approve their own request" />
      {d.data?.singleOperator.on ? <Banner tone="info" icon="approve" title="Single-operator mode is on">You may approve your own request, but only {d.data.singleOperator.delay_minutes} minutes after making it. The team gets an SMS and email at request time and at approval. Change it in Settings.</Banner> : null}
      <Tabs value={status} onChange={setStatus} tabs={["pending", "executed", "rejected", "cancelled", "all"].map((s) => ({ value: s, label: humanize(s), n: s === "pending" ? d.data?.items.length : undefined }))} />
      <Card flush>
        {d.data ? (
          <SimpleTable
            rows={d.data.items}
            columns={[
              { key: "s", label: "Request", render: (a: any) => <><b>{a.summary}</b><div className="small muted">{a.reason}</div></> },
              { key: "by", label: "Requested by", render: (a: any) => <>{a.requested_by_name}<div className="tiny faint">{dt(a.requested_at)}</div></> },
              { key: "st", label: "Status", render: (a: any) => <><Status s={a.status} />{a.decided_by_name ? <div className="tiny faint">{a.decided_by_name} · {dt(a.decided_at)}</div> : null}</> },
              {
                key: "act",
                label: "",
                render: (a: any) => {
                  if (a.status !== "pending") return a.result ? <span className="mono tiny">{JSON.stringify(a.result).slice(0, 80)}</span> : null;
                  const own = a.requested_by === me?.id;
                  const wait = a.executable_after && new Date(a.executable_after) > new Date();
                  return (
                    <div className="row">
                      <ActionButton small label="Approve" title={`Approve: ${a.summary}`} description={own ? "This is your own request (single-operator mode)." : `Requested by ${a.requested_by_name}: ${a.reason}`} path={`/approvals/${a.id}/approve`} reason={false} fields={[{ name: "note", label: "Note (optional)", kind: "text" }]} disabled={own && Boolean(wait)} onDone={reload} />
                      <ActionButton small tone="danger" label="Reject" title={`Reject: ${a.summary}`} reason="Why" path={`/approvals/${a.id}/reject`} build={(v) => ({ note: v.reason })} onDone={reload} />
                      {own ? <ActionButton small tone="plain" label="Withdraw" title="Withdraw your request" reason={false} path={`/approvals/${a.id}/cancel`} confirm="Withdraw" onDone={reload} /> : null}
                      {own && wait ? <span className="tiny faint">you can approve in {until(a.executable_after)}</span> : null}
                    </div>
                  );
                },
              },
            ]}
            empty="Nothing waiting."
          />
        ) : <Loading />}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ disputes

export function Disputes() {
  const [f, setF] = useQueryState({ status: "open,in_progress,waiting_merchant", mine: "" });
  const d = useApi<any>(`/disputes?status=${encodeURIComponent(f.status)}${f.mine ? "&mine=true" : ""}`, { refreshMs: 60_000 });
  return (
    <div className="stack">
      <PageHead title="Disputes" sub="Problems merchants reported about payments and tables." />
      <div className="row">
        <select className="input sm" value={f.status} onChange={(e) => setF({ status: e.target.value })} aria-label="Status">
          <option value="open,in_progress,waiting_merchant">Not resolved</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="waiting_merchant">Waiting for merchant</option>
          <option value="resolved,closed">Resolved and closed</option>
        </select>
        <label className="check"><input type="checkbox" checked={Boolean(f.mine)} onChange={(e) => setF({ mine: e.target.checked ? "1" : "" })} /> Assigned to me</label>
      </div>
      <Card flush>
        <SimpleTable rows={d.data?.items ?? []} rowLink={(x: any) => `/disputes/${x.id}`} columns={[
          { key: "r", label: "Ref", render: (x: any) => <span className="mono">{x.ref}</span> },
          { key: "s", label: "Subject", render: (x: any) => <><b>{x.subject}</b><div className="small faint">{x.merchant} · {humanize(x.kind)}</div></> },
          { key: "st", label: "Status", render: (x: any) => <Status s={x.status} /> },
          { key: "a", label: "Assignee", render: (x: any) => x.assignee ?? "—" },
          { key: "l", label: "Last message", render: (x: any) => (x.last_author === "merchant" ? <span className="badge wait">merchant waiting</span> : "us") },
          { key: "u", label: "Updated", render: (x: any) => ago(x.updated_at) },
        ]} empty="No disputes." />
      </Card>
    </div>
  );
}

export function DisputeDetail() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const d = useApi<any>(`/disputes/${id}`);
  const users = useApi<any>(can("disputes.handle") ? "/users" : null);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const x = d.data.dispute;
  const reload = () => void d.reload();
  return (
    <div className="stack">
      <PageHead crumb={{ to: "/disputes", label: "Disputes" }} title={x.subject} sub={<>{x.ref} · {x.merchant} · <Status s={x.status} /></>} />
      <div className="grid2">
        <Card title="Conversation">
          <div className="stack-sm">
            {d.data.messages.map((m: any) => (
              <div key={m.id} className={`msg${m.author_type === "admin" ? (m.internal ? " internal" : " admin") : ""}`}>
                <div className="tiny faint">{m.author_type === "admin" ? (m.internal ? "Internal note" : "Aura Pool") : m.author_label} · {dt(m.created_at)}</div>
                {m.body}
              </div>
            ))}
            {can("disputes.handle") ? (
              <form className="stack-sm" onSubmit={async (e) => { e.preventDefault(); await call(`/disputes/${id}/messages`, { method: "POST", body: { body, internal } }); setBody(""); reload(); }}>
                <textarea className="input" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Reply" />
                <div className="spread">
                  <label className="check"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (merchant doesn't see it)</label>
                  <button className="btn primary sm" disabled={!body.trim()}>{internal ? "Add note" : "Send reply"}</button>
                </div>
              </form>
            ) : null}
          </div>
        </Card>
        <Card title="Details">
          <KV rows={[["Kind", humanize(x.kind)], ["Payment", x.payment_id ? <Link className="link" to={`/payments/${x.payment_id}`}>open payment</Link> : "—"], ["Table", x.table_id ? <Link className="link" to={`/tables/${x.table_id}`}>{x.table_id}</Link> : "—"], ["Opened", dtFull(x.created_at)]]} />
          {can("disputes.handle") ? (
            <div className="stack-sm" style={{ marginTop: 12 }}>
              <select className="input" value={x.status} onChange={async (e) => { await call(`/disputes/${id}/status`, { method: "POST", body: { status: e.target.value } }); reload(); }} aria-label="Status">
                {["open", "in_progress", "waiting_merchant", "resolved", "closed"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
              </select>
              <select className="input" value={x.assignee_id ?? ""} onChange={async (e) => { await call(`/disputes/${id}/status`, { method: "POST", body: { assigneeId: e.target.value || null } }); reload(); }} aria-label="Assignee">
                <option value="">Unassigned</option>
                {(users.data?.users ?? []).filter((u: any) => u.status === "active").map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ announcements

export function Announcements() {
  const { can } = useSession();
  const d = useApi<any>("/announcements");
  const merchants = useApi<any>("/merchants?pageSize=500");
  return (
    <div className="stack">
      <PageHead
        title="Announcements"
        sub="Messages to all or selected merchants: in the app, by push, and optionally by SMS."
        actions={
          can("announcements.send") ? (
            <ActionButton
              label="New announcement"
              title="Send an announcement"
              reason={false}
              path="/announcements"
              fields={[
                { name: "title", label: "Title", kind: "text", required: true },
                { name: "body", label: "Message (500 characters)", kind: "textarea", required: true },
                { name: "audience", label: "To", kind: "select", required: true, initial: "all", options: [{ value: "all", label: "All active merchants" }, { value: "selected", label: "One merchant" }] },
                { name: "merchant", label: "Merchant (if one)", kind: "select", options: (merchants.data?.items ?? []).map((m: any) => ({ value: m.id, label: `${m.code} · ${m.business_name}` })) },
                { name: "sms", label: "Also send by SMS", kind: "check" },
              ]}
              build={(v) => ({ title: v.title, body: v.body, audience: v.audience, merchantIds: v.audience === "selected" && v.merchant ? [v.merchant] : [], channels: ["in_app", "push", ...(v.sms ? ["sms"] : [])] })}
              onDone={(r) => { toast(`Sent to ${r.recipients} merchant(s)`); void d.reload(); }}
            />
          ) : null
        }
      />
      <Card flush>
        <SimpleTable rows={d.data?.items ?? []} columns={[
          { key: "t", label: "Sent", render: (a: any) => dt(a.created_at) },
          { key: "ti", label: "Announcement", render: (a: any) => <><b>{a.title}</b><div className="small muted">{a.body}</div></> },
          { key: "to", label: "To", render: (a: any) => (a.audience === "all" ? "Everyone" : `${a.merchant_ids.length} selected`) },
          { key: "ch", label: "Channels", render: (a: any) => a.channels.join(", ") },
          { key: "n", label: "Recipients", right: true, render: (a: any) => a.recipients },
          { key: "b", label: "By", render: (a: any) => a.sent_by_name },
        ]} empty="Nothing sent yet." />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ provider

export function Provider() {
  const { can } = useSession();
  const d = useApi<any>("/provider", { refreshMs: 60_000 });
  const [kind, setKind] = useState("");
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const p = d.data;
  const reload = () => void d.reload();
  return (
    <div className="stack">
      <PageHead
        title="Provider and integrations"
        sub="Secrets are never shown here; they live in the server's environment. Rotate them there."
        actions={can("provider.manage") ? <ActionButton label="Register C2B URLs" title="Register the validation and confirmation URLs" description="Safaricom may limit re-registering production URLs. Confirm the rules before doing this in production." path="/provider/register-urls" reason={false} confirm="Register" onDone={(r) => { toast(r.detail); reload(); }} /> : null}
      />
      <div className="grid2">
        <Card title={p.provider.name}>
          <KV rows={[
            ["Environment", <Status s={p.provider.environment} />],
            ["Shortcode (Paybill)", <b className="mono">{p.provider.shortcode}</b>],
            ...Object.entries(p.provider.configured as Record<string, boolean>).map(([k, v]) => [humanize(k), v ? <Status s="ok" /> : <span className="badge wait">not configured</span>] as [string, ReactNode]),
            ["Consumer key", p.provider.maskedConsumerKey ?? "—"],
            ["Credentials rotated", p.provider.credentialsRotatedAt ?? "not recorded"],
            ["URL registration", p.urlRegistration.at ? `${dt(p.urlRegistration.at)}: ${p.urlRegistration.result}` : p.urlRegistration.result ?? "not yet"],
            ["Verification mode", <><b>{p.verifyMode}</b> <span className="small faint">{p.verifyMode === "sync" ? "waits up to 5 s for M-Pesa before unlocking" : "unlocks at once, verifies within 60 s, reverses on a mismatch"}</span></>],
            ["Last callback", p.lastCallback ? `${humanize(p.lastCallback.kind)} ${ago(p.lastCallback.received_at)}` : "none yet"],
          ]} />
        </Card>
        <Card title="Callback URLs (secret path masked)">
          <KV rows={Object.entries(p.callbackUrls as Record<string, string>).map(([k, v]) => [humanize(k), <span className="mono tiny">{v}</span>])} />
        </Card>
      </div>
      <div className="grid2">
        <Card title="API health">
          <SimpleTable rows={p.health} columns={[
            { key: "a", label: "API", render: (h: any) => <b>{h.api}</b> },
            { key: "ok", label: "Last OK", render: (h: any) => ago(h.last_ok_at) },
            { key: "e", label: "Last error", render: (h: any) => (h.last_error_at ? <span className="err">{ago(h.last_error_at)}: {h.last_error}</span> : "—") },
            { key: "c", label: "OK / errors", right: true, render: (h: any) => `${h.ok_count} / ${h.error_count}` },
            { key: "ms", label: "ms", right: true, render: (h: any) => h.last_ms },
          ]} empty="No provider calls yet." />
        </Card>
        <Card title="Callbacks per hour (24 h)">
          <SimpleTable rows={p.callbacksByHour.slice(-12)} columns={[
            { key: "h", label: "Hour", render: (r: any) => dt(r.hour) },
            { key: "n", label: "Received", right: true, render: (r: any) => r.n },
            { key: "f", label: "Failed", right: true, render: (r: any) => (r.failed ? <span className="err">{r.failed}</span> : 0) },
            { key: "ms", label: "Avg ms", right: true, render: (r: any) => r.avg_ms },
          ]} empty="No callbacks in 24 hours." />
        </Card>
      </div>
      <div className="grid2">
        <Card title={p.intasend.name}>
          <Banner tone="info" icon="plug" title={`${p.intasend.phase}: not enabled`}>{p.intasend.note}</Banner>
        </Card>
        <Card title="Messaging">
          <KV rows={[["SMS", p.messaging.sms.configured ? `${p.messaging.sms.provider}` : <span className="badge wait">not configured: codes go to the server log</span>], ["Email", p.messaging.email.configured ? "Resend" : <span className="badge wait">not configured</span>], ["Web push", p.messaging.push.configured ? "VAPID keys set" : <span className="badge wait">not configured</span>]]} />
          {can("provider.manage") ? <div style={{ marginTop: 10 }}><ActionButton tone="plain" label="Send a test" title="Send a test message" reason={false} path="/provider/messaging/test" fields={[{ name: "channel", label: "Channel", kind: "select", required: true, options: [{ value: "sms", label: "SMS" }, { value: "email", label: "Email" }, { value: "push", label: "Push (to a merchant user's phone number)" }] }, { name: "to", label: "To (phone or email)", kind: "text", required: true }]} onDone={(r) => toast(r.ok ? `Sent via ${r.channel}` : `Not sent: ${r.detail}`, !r.ok)} /></div> : null}
        </Card>
      </div>
      <DataTable
        path="/provider/callbacks"
        params={{ kind }}
        toolbar={<select className="input sm" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All callbacks</option>{["c2b_validation", "c2b_confirmation", "stk", "b2c_result", "b2c_timeout", "status_result", "status_timeout", "balance"].map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select>}
        columns={[
          { key: "t", label: "Received", render: (c: any) => <span className="small">{dtFull(c.received_at)}</span> },
          { key: "k", label: "Kind", render: (c: any) => humanize(c.kind) },
          { key: "ok", label: "Result", render: (c: any) => (c.ok ? <Status s="ok" /> : <span className="err small">{c.error}</span>) },
          { key: "ms", label: "ms", right: true, render: (c: any) => c.processing_ms },
          { key: "ip", label: "From", render: (c: any) => <span className="mono tiny">{c.source_ip}</span> },
          { key: "p", label: "Payload", render: (c: any) => <details><summary className="small link">view</summary><Json value={c.payload} /></details> },
          { key: "r", label: "", render: (c: any) => (p.sandbox && can("provider.manage") ? <ActionButton small tone="plain" label="Replay" title="Replay this callback (sandbox)" reason={false} confirm="Replay" path={`/provider/callbacks/${c.id}/replay`} onDone={(r) => toast(`Replayed: HTTP ${r.status}`)} /> : null) },
        ]}
      />
    </div>
  );
}

// ------------------------------------------------------------------ health

export function Health() {
  const d = useApi<any>("/health/system", { refreshMs: 15_000 });
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const h = d.data;
  return (
    <div className="stack">
      <PageHead title="System health" sub={`Version ${h.version} · up ${Math.round(h.uptimeS / 3600)} h · refreshes every 15 seconds`} />
      <div className="grid4">
        <Stat label="API latency p50 / p95" value={`${h.api.p50Ms} / ${h.api.p95Ms} ms`} delta={`${h.api.requests} requests in 15 min`} />
        <Stat label="Error rate (5xx)" value={`${h.api.errorRatePct}%`} tone={h.api.errors5xx ? "bad" : undefined} delta={`${h.api.errors5xx} errors`} />
        <Stat label="Job queue" value={h.queue.due} delta={`oldest ${h.queue.oldest_s ?? 0}s · ${h.queue.failed} failed today`} tone={h.queue.due > 20 ? "wait" : undefined} />
        <Stat label="Database" value={`${h.database.latencyMs} ms`} delta={h.database.kind} />
      </div>
      <div className="grid2">
        <Card title="Device broker">
          <KV rows={[["Transport", h.broker?.kind], ["Connected", h.broker?.connected ? <Status s="ok" /> : <Status s="offline" />], ["Clients", h.broker?.clients >= 0 ? h.broker.clients : "managed by the external broker"], ["Detail", h.broker?.detail], ["Devices online", `${h.devices?.online ?? 0} of ${h.devices?.provisioned ?? 0}`]]} />
        </Card>
        <Card title="Callbacks and backups">
          <KV rows={[["Last callback", h.lastCallback ? `${humanize(h.lastCallback.kind)} ${ago(h.lastCallback.received_at)}` : "none"], ["Backups", h.backups.note], ["Last restore test", h.backups.last_verified_at ?? "not recorded: test a restore and record it in Settings"]]} />
        </Card>
      </div>
      <Card title="Slowest requests (15 min)">
        <SimpleTable rows={h.api.slowest} columns={[{ key: "r", label: "Route", render: (s: any) => <span className="mono small">{s.route}</span> }, { key: "ms", label: "ms", right: true, render: (s: any) => s.ms }, { key: "s", label: "Status", right: true, render: (s: any) => s.status }]} />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ audit

export function Audit() {
  const [f, setF] = useQueryState({ actor: "", action: "", entity: "", entityId: "", from: "", to: "" });
  return (
    <div className="stack">
      <PageHead title="Audit log" sub="Every sensitive action: who, what, before and after, IP and device. Nobody can edit or delete it, including the database role." />
      <DataTable
        path="/audit"
        params={{ ...f, from: f.from ? `${f.from}T00:00:00+03:00` : "", to: f.to ? `${f.to}T23:59:59+03:00` : "" }}
        exportPath="/audit/export"
        toolbar={
          <>
            <input className="input sm" placeholder="Actor (name or id)" value={f.actor} onChange={(e) => setF({ actor: e.target.value })} style={{ width: 160 }} />
            <input className="input sm" placeholder="Action starts with" value={f.action} onChange={(e) => setF({ action: e.target.value })} style={{ width: 160 }} />
            <input className="input sm" placeholder="Entity type" value={f.entity} onChange={(e) => setF({ entity: e.target.value })} style={{ width: 120 }} />
            <input className="input sm" placeholder="Entity id" value={f.entityId} onChange={(e) => setF({ entityId: e.target.value })} style={{ width: 140 }} />
            <input className="input sm" type="date" value={f.from} onChange={(e) => setF({ from: e.target.value })} aria-label="From" />
            <input className="input sm" type="date" value={f.to} onChange={(e) => setF({ to: e.target.value })} aria-label="To" />
          </>
        }
        columns={[
          { key: "at", label: "When", render: (a: any) => <span className="small">{dtFull(a.at)}</span> },
          { key: "who", label: "Who", render: (a: any) => <><span className="small">{a.actor_label ?? a.actor_type}</span><div className="tiny faint">{a.ip}</div></> },
          { key: "act", label: "Action", render: (a: any) => <span className="mono">{a.action}</span> },
          { key: "ent", label: "Entity", render: (a: any) => <span className="small">{a.entity_type} <span className="mono tiny">{a.entity_id}</span></span> },
          { key: "ch", label: "Change", render: (a: any) => (a.before || a.after ? <details><summary className="small link">before / after</summary><div className="grid2"><Json value={a.before} /><Json value={a.after} /></div></details> : null) },
          { key: "ua", label: "Device", render: (a: any) => <span className="tiny faint">{a.user_agent?.slice(0, 60)}</span>, hidden: true },
        ]}
      />
    </div>
  );
}

// ------------------------------------------------------------------ users

export function Users() {
  const { can, me } = useSession();
  const d = useApi<any>("/users");
  const [link, setLink] = useState<string | null>(null);
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const reload = () => void d.reload();
  const roles = [{ value: "super_admin", label: "Super admin" }, { value: "finance", label: "Finance" }, { value: "support", label: "Support" }, { value: "auditor", label: "Auditor" }];
  return (
    <div className="stack">
      <PageHead
        title="Users and roles"
        sub="Role changes need a second approver. Every admin signs in with a password and an authenticator."
        actions={can("users.manage") ? <ActionButton label="Invite admin" title="Invite an admin" reason={false} path="/users" fields={[{ name: "name", label: "Name", kind: "text", required: true }, { name: "email", label: "Email", kind: "text", required: true }, { name: "phone", label: "Phone (for critical alerts)", kind: "text" }, { name: "role", label: "Role", kind: "select", required: true, options: roles }]} build={(v) => ({ ...v, phone: v.phone || undefined })} onDone={(r) => { setLink(r.inviteLink); reload(); }} /> : null}
      />
      {link ? <Banner tone="ok" icon="check" title="Invite created">They were emailed the link (if email is configured). You can also send it yourself: <span className="mono small">{link}</span> <Copy text={link} /></Banner> : null}
      {d.data.pendingRoleChanges.length ? <Banner tone="wait" icon="approve" title="Role changes waiting">{d.data.pendingRoleChanges.map((x: any) => x.summary).join(" · ")} <Link className="link" to="/approvals">Approvals</Link></Banner> : null}
      <Card flush>
        <SimpleTable rows={d.data.users} columns={[
          { key: "n", label: "Name", render: (u: any) => <><b>{u.name}</b>{u.id === me?.id ? <span className="badge info" style={{ marginLeft: 6 }}>you</span> : null}<div className="small faint">{u.email}</div></> },
          { key: "r", label: "Role", render: (u: any) => humanize(u.role) },
          { key: "s", label: "Status", render: (u: any) => <><Status s={u.status} />{u.locked_until && new Date(u.locked_until) > new Date() ? <div className="tiny err">locked</div> : null}</> },
          { key: "t", label: "Authenticator", render: (u: any) => (u.totp_enabled_at ? `${u.recovery_codes_left} recovery codes left` : "not set up") },
          { key: "ip", label: "IP allowlist", render: (u: any) => (u.ip_allowlist.length ? u.ip_allowlist.join(", ") : "any") },
          { key: "l", label: "Last sign-in", render: (u: any) => ago(u.last_login_at) },
          {
            key: "a",
            label: "",
            render: (u: any) =>
              can("users.manage") && u.id !== me?.id ? (
                <div className="row wrap">
                  <ActionButton small tone="plain" label="Role" title={`Change ${u.name}'s role`} description="Needs a second approver. They're signed out when it takes effect." path={`/users/${u.id}/role`} fields={[{ name: "role", label: "New role", kind: "select", required: true, options: roles.filter((r) => r.value !== u.role) }]} onDone={reload} />
                  {u.status === "active" ? <ActionButton small tone="danger" label="Deactivate" title={`Deactivate ${u.name}`} path={`/users/${u.id}/deactivate`} onDone={reload} /> : u.status === "deactivated" ? <ActionButton small label="Reactivate" title={`Reactivate ${u.name}`} reason={false} path={`/users/${u.id}/reactivate`} onDone={reload} /> : null}
                  <ActionButton small tone="plain" label="Reset" title={`Reset ${u.name}'s password and authenticator`} description="Signs them out and emails a link to set both again." path={`/users/${u.id}/reset`} onDone={(r) => { setLink(r.inviteLink); reload(); }} />
                  <ActionButton small tone="plain" label="IPs" title={`IP allowlist for ${u.name}`} reason={false} path={`/users/${u.id}/ip-allowlist`} method="PUT" fields={[{ name: "ips", label: "Addresses, comma separated (empty: any)", kind: "text", initial: u.ip_allowlist.join(", ") }]} build={(v) => ({ ips: String(v.ips ?? "").split(",").map((s: string) => s.trim()).filter(Boolean) })} onDone={reload} />
                </div>
              ) : null,
          },
        ]} />
      </Card>
      <Card title="What each role can do">
        <div className="grid2">
          {Object.entries(d.data.roles as Record<string, string[]>).map(([role, perms]) => (
            <div key={role}>
              <h3>{humanize(role)}</h3>
              <p className="small muted" style={{ marginTop: 4 }}>{perms.map((p) => p.replace(".", ": ")).join(" · ")}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ settings

type SettingForm = { key: string; title: string; note?: string; fields: { name: string; label: string; kind: "money" | "number" | "text" | "bool" | "select" | "list" | "bands"; options?: string[] }[] };
const FORMS: SettingForm[] = [
  { key: "payout", title: "Payouts", fields: [{ name: "min_minor", label: "Minimum withdrawal", kind: "money" }, { name: "daily_cap_minor", label: "Daily cap per merchant", kind: "money" }, { name: "approval_threshold_minor", label: "Approval above", kind: "money" }, { name: "finance_approval_limit_minor", label: "Finance can approve up to", kind: "money" }, { name: "cooling_hours", label: "Number-change cooling-off (hours)", kind: "number" }, { name: "result_timeout_min", label: "B2C result timeout (minutes)", kind: "number" }, { name: "float_wait_estimate_hours", label: "Float-wait estimate shown to owners (hours)", kind: "number" }] },
  { key: "defaults", title: "Table defaults and owner bounds", note: "Commission here is read-only; change it from Pricing (second approver).", fields: [{ name: "price_minor", label: "Default price", kind: "money" }, { name: "unlock_seconds", label: "Default unlock (s)", kind: "number" }, { name: "price_min_minor", label: "Owner price minimum", kind: "money" }, { name: "price_max_minor", label: "Owner price maximum", kind: "money" }, { name: "unlock_min_s", label: "Owner unlock minimum (s)", kind: "number" }, { name: "unlock_max_s", label: "Owner unlock maximum (s)", kind: "number" }] },
  { key: "amount_rules", title: "Amount rules", fields: [{ name: "partial_window_min", label: "Part-payment and remainder window (minutes)", kind: "number" }, { name: "offline_retry_min", label: "Offline retry window (minutes)", kind: "number" }, { name: "games_cap", label: "Games cap per payment", kind: "number" }] },
  { key: "manual_unlock", title: "Manual unlocks", fields: [{ name: "daily_limit", label: "Per table per day", kind: "number" }, { name: "reasons", label: "Reasons owners pick from (one per line)", kind: "list" }] },
  { key: "float", title: "Float", fields: [{ name: "buffer_pct", label: "Buffer on the 24 h requirement (%)", kind: "number" }, { name: "minimum_minor", label: "Critical minimum", kind: "money" }, { name: "poll_minutes", label: "Balance poll (minutes)", kind: "number" }, { name: "max_snapshot_age_s", label: "Balance age accepted before a payout (s)", kind: "number" }, { name: "transfer_approval_threshold_minor", label: "Transfers above this need a second approver", kind: "money" }] },
  { key: "alert_rules", title: "Alert rules", fields: [{ name: "offline_minutes", label: "Table offline alert after (minutes)", kind: "number" }, { name: "override_presses_per_hour", label: "Unusual override presses per hour", kind: "number" }, { name: "callback_silence_minutes", label: "Callback silence alert after (minutes)", kind: "number" }, { name: "failed_logins", label: "Admin lockout after failed sign-ins", kind: "number" }, { name: "queue_backlog", label: "Queue backlog alert at", kind: "number" }, { name: "large_payout_minor", label: "Large payout (activity feed)", kind: "money" }] },
  { key: "verify_mode", title: "Verification mode", fields: [{ name: "_", label: "Mode", kind: "select", options: ["sync", "async"] }] },
  { key: "reconciliation", title: "Reconciliation", fields: [{ name: "tolerance_minor", label: "Tolerance", kind: "money" }] },
  { key: "platform_payout", title: "Platform payout", fields: [{ name: "msisdn", label: "M-Pesa number for the operator's commission", kind: "text" }] },
  { key: "support", title: "Support contacts (shown to merchants)", fields: [{ name: "phone", label: "Phone", kind: "text" }, { name: "whatsapp", label: "WhatsApp", kind: "text" }, { name: "email", label: "Email", kind: "text" }, { name: "hours", label: "Hours", kind: "text" }] },
  { key: "operator_contacts", title: "Critical alert recipients", note: "Active super admins with a phone get SMS automatically.", fields: [{ name: "sms", label: "Extra SMS numbers (one per line)", kind: "list" }, { name: "email", label: "Extra emails (one per line)", kind: "list" }] },
  { key: "reports", title: "Scheduled reports", fields: [{ name: "daily_email", label: "Email the daily close", kind: "bool" }, { name: "monthly_email", label: "Email the monthly summary", kind: "bool" }, { name: "recipients", label: "Recipients (one per line)", kind: "list" }] },
  { key: "b2c_tariff", title: "B2C tariff bands", note: "One per line: up-to amount in KSh, then fee in KSh. Confirm with Safaricom.", fields: [{ name: "_", label: "Bands", kind: "bands" }] },
  { key: "collection_tariff", title: "Paybill collection tariff bands", note: "Empty if Safaricom charges nothing per collection.", fields: [{ name: "_", label: "Bands", kind: "bands" }] },
  { key: "terms_version", title: "Terms version", note: "Bump when the merchant terms change.", fields: [{ name: "_", label: "Version", kind: "text" }] },
  { key: "backups", title: "Backups", fields: [{ name: "note", label: "Where backups are kept", kind: "text" }, { name: "last_verified_at", label: "Last restore test (ISO date)", kind: "text" }] },
];

export function Settings() {
  const { can } = useSession();
  const d = useApi<any>("/settings");
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const s = d.data.settings;
  return (
    <div className="stack">
      <PageHead title="Settings" sub="Every change is audited, and asks you to confirm it's you." />
      <SingleOperator so={s.single_operator} reload={() => void d.reload()} />
      <div className="grid2">
        {FORMS.map((f) => <SettingCard key={f.key} form={f} value={s[f.key]} editable={can("settings.manage")} onSaved={() => void d.reload()} />)}
      </div>
    </div>
  );
}

function SingleOperator({ so, reload }: { so: { on: boolean; delay_minutes: number }; reload: () => void }) {
  const { can } = useSession();
  return (
    <Card title="Single-operator mode" actions={can("users.manage") ? <ActionButton tone="plain" label={so.on ? "Turn off" : "Turn on"} title={so.on ? "Turn single-operator mode off" : "Turn single-operator mode on"} description={so.on ? `Takes effect by itself after ${so.delay_minutes} minutes, and is audited. After that every four-eyes action needs a second person.` : "Needs a second approver. Lets one operator approve their own requests after a delay."} path="/settings/single-operator" build={(v) => ({ on: !so.on, reason: v.reason })} onDone={reload} /> : null}>
      <p>{so.on ? <>On: you can approve your own requests after <b>{so.delay_minutes} minutes</b>, with SMS and email to the team at request and at approval.</> : "Off: every four-eyes action needs a second person."}</p>
    </Card>
  );
}

function SettingCard({ form, value, editable, onSaved }: { form: SettingForm; value: any; editable: boolean; onSaved: () => void }) {
  const toField = (f: SettingForm["fields"][number]) => {
    const v = f.name === "_" ? value : value?.[f.name];
    if (f.kind === "money") return v == null ? "" : String(v / 100);
    if (f.kind === "list") return (v ?? []).join("\n");
    if (f.kind === "bands") return (v ?? []).map((b: any) => `${b.upTo / 100} ${b.fee / 100}`).join("\n");
    if (f.kind === "bool") return Boolean(v);
    return v == null ? "" : String(v);
  };
  const [vals, setVals] = useState<Record<string, any>>(() => Object.fromEntries(form.fields.map((f) => [f.name, toField(f)])));
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    const out: any = form.fields.length === 1 && form.fields[0].name === "_" ? undefined : { ...(value ?? {}) };
    let single: any;
    for (const f of form.fields) {
      const raw = vals[f.name];
      const v = f.kind === "money" ? parseKsh(raw) : f.kind === "number" ? Number(raw) : f.kind === "list" ? String(raw).split("\n").map((x) => x.trim()).filter(Boolean) : f.kind === "bands" ? String(raw).split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [u, fee] = l.split(/\s+/); return { upTo: parseKsh(u) ?? 0, fee: parseKsh(fee) ?? 0 }; }) : f.kind === "bool" ? Boolean(raw) : raw === "" && (f.name === "msisdn" || f.name === "last_verified_at") ? null : raw;
      if (f.name === "_") single = v;
      else out[f.name] = v;
    }
    try {
      await call(`/settings/${form.key}`, { method: "PUT", body: { value: out ?? single } });
      toast(`${form.title} saved`);
      onSaved();
    } catch (x) {
      setErr(errText(x));
    }
  };
  return (
    <Card title={form.title}>
      <div className="stack-sm">
        {form.note ? <p className="hint">{form.note}</p> : null}
        {form.fields.map((f) => (
          <div className="field" key={f.name}>
            {f.kind === "bool" ? (
              <label className="check"><input type="checkbox" checked={Boolean(vals[f.name])} disabled={!editable} onChange={(e) => setVals({ ...vals, [f.name]: e.target.checked })} /> {f.label}</label>
            ) : (
              <>
                <label>{f.label}{f.kind === "money" ? " (KSh)" : ""}</label>
                {f.kind === "select" ? (
                  <select className="input" value={vals[f.name]} disabled={!editable} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>
                ) : f.kind === "list" || f.kind === "bands" ? (
                  <textarea className="input mono" value={vals[f.name]} disabled={!editable} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />
                ) : (
                  <input className="input" value={vals[f.name]} disabled={!editable} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />
                )}
              </>
            )}
          </div>
        ))}
        {form.key === "defaults" ? <p className="small muted">Commission: {ksh(value.commission_minor)} a game{value.commission_pct ? ` + ${value.commission_pct}%` : ""}</p> : null}
        {err ? <ErrorBox text={err} /> : null}
        {editable ? <div><button className="btn sm primary" onClick={() => void save()}>Save</button></div> : null}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ simulator

export function Simulator() {
  const d = useApi<any>("/sim", { refreshMs: 5000 });
  const tables = useApi<any>("/tables?pageSize=500");
  const [log, setLog] = useState<string[]>([]);
  const add = (s: string) => setLog((l) => [`${new Date().toLocaleTimeString("en-KE", { timeZone: "Africa/Nairobi", hour12: false })}  ${s}`, ...l].slice(0, 30));
  if (d.error) return <ErrorBox error={d.error} />;
  const tableOpts = (tables.data?.items ?? []).map((t: any) => ({ value: t.id, label: `${t.id} · ${t.name}` }));
  return (
    <div className="stack">
      <PageHead title="Simulator" sub="Sandbox only. Plays a customer paying the Paybill, the M-Pesa portal, and virtual table devices, through the real callback routes and MQTT." />
      <div className="grid4">
        <Stat label="Simulated Utility account" value={<Money v={d.data?.balances.utilityMinor} />} />
        <Stat label="Simulated Working account" value={<Money v={d.data?.balances.workingMinor} />} />
        <Stat label="Virtual devices running" value={d.data?.devices.length ?? 0} />
        <Stat label="Payout test numbers" value={<span className="small">…000 fails · …999 times out</span>} />
      </div>
      <div className="grid2">
        <Card title="A customer pays">
          <div className="row wrap">
            <ActionButton
              label="Pay the Paybill"
              title="Simulate a customer payment"
              reason={false}
              path="/sim/payment"
              fields={[
                { name: "accountRef", label: "Account number the customer types", kind: "text", required: true, initial: tableOpts[0]?.value ?? "T001" },
                { name: "amount", label: "Amount (KSh)", kind: "money", required: true, initial: "50" },
                { name: "msisdn", label: "Customer phone", kind: "text", initial: "0712345678" },
                { name: "duplicate", label: "Send the confirmation twice (duplicate)", kind: "check" },
                { name: "skipValidation", label: "Skip validation (as if not enabled)", kind: "check" },
                { name: "forged", label: "Forged callback (M-Pesa never saw it)", kind: "check" },
              ]}
              build={(v) => ({ accountRef: v.accountRef, amountMinor: parseKsh(v.amount), msisdn: v.msisdn || undefined, duplicate: Boolean(v.duplicate), skipValidation: Boolean(v.skipValidation), forged: Boolean(v.forged) })}
              onDone={(r) => add(r.charged ? `Paid: ${r.txn} → ${JSON.stringify(r.confirmation)}` : `Refused at validation: ${JSON.stringify(r.validation)}`)}
            />
          </div>
          <p className="hint" style={{ marginTop: 8 }}>Try: an unknown account (T999), a loose one ("t 1"), KSh 30 then KSh 20 from the same phone, or KSh 120.</p>
        </Card>
        <Card title="M-Pesa portal: move money">
          <ActionButton
            label="Transfer Utility → Working"
            title="Simulated portal transfer"
            description="Moves money in the simulated M-Pesa accounts, as the operator would in the real portal. Then record it in Transfers, or reconciliation will (rightly) show a difference."
            reason={false}
            path="/sim/transfer"
            fields={[{ name: "amount", label: "Amount (KSh)", kind: "money", required: true, initial: String(Math.floor((d.data?.balances.utilityMinor ?? 0) / 100)) }]}
            build={(v) => ({ from: "utility", to: "working", amountMinor: parseKsh(v.amount) })}
            onDone={(r) => add(`Portal transfer done, reference ${r.reference}. Record it in Transfers.`)}
          />
        </Card>
      </div>
      <Card title="Virtual devices">
        <SimpleTable rows={d.data?.devices ?? []} columns={[
          { key: "t", label: "Table", render: (x: any) => <Link className="link" to={`/tables/${x.tableId}`}>{x.tableId}</Link> },
          { key: "d", label: "Device", render: (x: any) => <span className="mono">{x.deviceId}</span> },
          { key: "r", label: "Relay", render: (x: any) => (x.relayOn ? <span className="badge ok">on</span> : "off") },
          { key: "u", label: "Unlocks", right: true, render: (x: any) => x.unlocks },
          { key: "o", label: "Override presses", right: true, render: (x: any) => x.overridePresses },
          { key: "a", label: "", render: (x: any) => (
            <div className="row">
              <button className="btn sm" onClick={async () => { await call(`/sim/device/${x.tableId}/override`, { method: "POST" }); add(`${x.tableId}: override button pressed`); }}>Press override</button>
              <button className="btn sm" onClick={async () => { await call(`/sim/device/${x.tableId}/offline`, { method: "POST" }); add(`${x.tableId}: dropped off the network`); }}>Go offline</button>
            </div>
          ) },
        ]} empty="No virtual devices. Provision a table with 'Run a virtual device' ticked." />
        {tableOpts.length ? (
          <div className="row" style={{ marginTop: 10 }}>
            <span className="small muted">Bring a virtual device back online:</span>
            {tableOpts.map((t: any) => <button key={t.value} className="btn sm" onClick={async () => { try { await call(`/sim/device/${t.value}/online`, { method: "POST" }); add(`${t.value}: back online`); } catch (x) { toast(errText(x), true); } }}>{t.value}</button>)}
          </div>
        ) : null}
      </Card>
      <Card title="Log">
        {log.length ? <pre className="json">{log.join("\n")}</pre> : <p className="muted">Actions you take here are listed.</p>}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ account

export function Account() {
  const { me } = useSession();
  const s = useApi<any>("/me/sessions");
  return (
    <div className="stack">
      <PageHead title="Your account" sub={`${me?.email} · ${humanize(me?.role)}`} />
      <div className="grid2">
        <Card title="Security">
          <KV rows={[["Recovery codes left", me?.recoveryCodesLeft], ["Re-authenticated until", me?.reauthValidUntil ? dt(me.reauthValidUntil) : "not now"], ["Idle sign-out", "after 30 minutes"]]} />
          <p className="hint" style={{ marginTop: 10 }}>Lost your authenticator or running low on recovery codes? Ask another super admin to reset your access from Users.</p>
        </Card>
        <Card title="Signed-in sessions">
          <SimpleTable rows={s.data?.sessions ?? []} columns={[
            { key: "d", label: "Device", render: (x: any) => <>{x.device}{x.current ? <span className="badge info" style={{ marginLeft: 6 }}>this one</span> : null}</> },
            { key: "ip", label: "IP", render: (x: any) => <span className="mono tiny">{x.ip}</span> },
            { key: "l", label: "Last used", render: (x: any) => ago(x.lastUsedAt) },
            { key: "a", label: "", render: (x: any) => (!x.current ? <button className="btn sm" onClick={async () => { await call(`/me/sessions/${x.id}`, { method: "DELETE" }); void s.reload(); }}>Sign out</button> : null) },
          ]} />
        </Card>
      </div>
    </div>
  );
}
