import { useState } from "react";
import { Icon } from "../components/Icon";
import { Badge, Empty, ErrorBox, PageSkeleton, Sheet, TopBar, toast } from "../components/ui";
import { call, message } from "../lib/api";
import { prettyPhone, when } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang } from "../lib/hooks";

type S = { id: string; name: string; phoneMasked: string; status: "invited" | "active" | "revoked"; lastSeenAt: string | null };
type Activity = { activity: { action: string; entity_id: string | null; at: string }[]; unlocks: { cmd_id: string; table_id: string; reason: string; status: string; issued_at: string }[] };

export default function Staff() {
  useLang();
  const d = useApi<{ staff: S[] }>("/staff");
  const [add, setAdd] = useState(false);
  const [open, setOpen] = useState<S | null>(null);
  return (
    <main className="page">
      <TopBar title={t("staff.title")} back="/more" />
      <div className="stack">
        <p className="muted small">{t("staff.body")}</p>
        {d.loading ? <PageSkeleton /> : null}
        {d.error && !d.data ? <ErrorBox error={d.error} retry={d.reload} /> : null}
        {d.data ? (
          d.data.staff.length ? (
            <div className="list">
              {d.data.staff.map((s) => (
                <button key={s.id} className="item" onClick={() => setOpen(s)}>
                  <span className="lead"><Icon name="user" /></span>
                  <span className="main">
                    <span className="title">{s.name}</span>
                    <span className="sub">{s.phoneMasked}{s.lastSeenAt ? ` · ${t("staff.lastSeen", { when: when(s.lastSeenAt) })}` : ""}</span>
                  </span>
                  <Badge tone={s.status === "active" ? "ok" : s.status === "invited" ? "wait" : "info"}>{t(`staff.${s.status === "invited" ? "pending" : s.status}`)}</Badge>
                </button>
              ))}
            </div>
          ) : (
            <div className="card"><Empty icon="users">{t("staff.none")}</Empty></div>
          )
        ) : null}
        <button className="btn primary block" onClick={() => setAdd(true)}>
          <Icon name="plus" /> {t("staff.add")}
        </button>
      </div>
      <AddStaff open={add} onClose={() => setAdd(false)} onDone={d.reload} />
      {open ? <StaffSheet s={open} onClose={() => setOpen(null)} onChanged={d.reload} /> : null}
    </main>
  );
}

function AddStaff({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} title={t("staff.add")}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await call("/staff", { method: "POST", body: { name, phone } });
            toast(t("staff.invited", { phone }));
            setName("");
            setPhone("");
            onDone();
            onClose();
          } catch (x) {
            setErr(message(x, t));
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label htmlFor="sn">{t("staff.name")}</label>
          <input id="sn" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="sp">{t("staff.phone")}</label>
          <input id="sp" className="input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(prettyPhone(e.target.value))} />
        </div>
        {err ? <ErrorBox text={err} /> : null}
        <button className="btn primary block" disabled={busy || name.trim().length < 2 || phone.replace(/\D/g, "").length < 9}>{t("staff.invite")}</button>
      </form>
    </Sheet>
  );
}

function StaffSheet({ s, onClose, onChanged }: { s: S; onClose: () => void; onChanged: () => void }) {
  const a = useApi<Activity>(`/staff/${s.id}/activity`);
  const [confirm, setConfirm] = useState(false);
  return (
    <Sheet open onClose={onClose} title={s.name}>
      <div className="stack">
        <p className="muted small">{s.phoneMasked}</p>
        <h3>{t("staff.activity")}</h3>
        {a.data ? (
          a.data.unlocks.length || a.data.activity.length ? (
            <ul className="stack-sm small" style={{ margin: 0, paddingLeft: 18 }}>
              {a.data.unlocks.map((u) => (
                <li key={u.cmd_id}>{when(u.issued_at)} · {t("tables.manual")} {u.table_id} · {u.reason} · {u.status}</li>
              ))}
              {a.data.activity.filter((x) => x.action !== "table.manual_unlock").slice(0, 30).map((x, i) => (
                <li key={i}>{when(x.at)} · {x.action.replace(/[._]/g, " ")}</li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{t("staff.noActivity")}</p>
          )
        ) : null}
        {s.status === "invited" ? (
          <button className="btn block" onClick={async () => { await call(`/staff/${s.id}/resend`, { method: "POST" }).catch((e) => toast(message(e, t))); toast(t("staff.invited", { phone: s.phoneMasked })); }}>
            {t("staff.resend")}
          </button>
        ) : null}
        {s.status !== "revoked" ? (
          confirm ? (
            <>
              <p className="banner bad"><Icon name="alert" /><span className="sub">{t("staff.revokeConfirm", { name: s.name })}</span></p>
              <button className="btn danger block" onClick={async () => { await call(`/staff/${s.id}/revoke`, { method: "POST" }); onChanged(); onClose(); }}>{t("staff.revoke")}</button>
            </>
          ) : (
            <button className="btn danger block" onClick={() => setConfirm(true)}>{t("staff.revoke")}</button>
          )
        ) : null}
      </div>
    </Sheet>
  );
}
