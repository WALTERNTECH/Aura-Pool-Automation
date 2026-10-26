import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { errText } from "../lib/api";
import { humanize, ksh } from "../lib/format";
import { Icon } from "./Icon";

export type Tone = "ok" | "wait" | "bad" | "info" | "";

export function Badge({ tone = "", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return <span className={`badge ${tone}${dot ? " dot" : ""}`}>{children}</span>;
}

/** Colour for a status word anywhere in the console. */
export function toneOf(status: string | null | undefined): Tone {
  const s = String(status ?? "");
  if (/^(online|active|credited|succeeded|acked|match|executed|verified|resolved|recorded|paid|ok|closed_ok)$/.test(s)) return "ok";
  if (/^(offline|failed|rejected|mismatch|critical|unmatched|underpaid|expired|timed_out|timeout|error|suspended|revoked|deactivated|closed)$/.test(s)) return "bad";
  if (/^(pending|pending_approval|queued|held|requested|submitted|invited|maintenance|verifying|received|refund_pending|warning|open|in_progress|waiting_merchant|dispatched|sent|busy|running|approved)$/.test(s)) return "wait";
  return "info";
}

export function Status({ s }: { s: string | null | undefined }) {
  return <Badge tone={toneOf(s)} dot>{humanize(s)}</Badge>;
}

export function Money({ v, sign }: { v: number | null | undefined; sign?: boolean }) {
  return <span className="num">{ksh(v, { sign })}</span>;
}

export function Stat({ label, value, delta, to, tone }: { label: string; value: ReactNode; delta?: ReactNode; to?: string; tone?: "bad" | "wait" }) {
  const body = (
    <>
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {delta != null ? <span className="delta">{delta}</span> : null}
    </>
  );
  return to ? <Link className={`stat${tone ? ` ${tone}` : ""}`} to={to}>{body}</Link> : <div className={`stat${tone ? ` ${tone}` : ""}`}>{body}</div>;
}

export function PageHead({ title, sub, crumb, actions }: { title: ReactNode; sub?: ReactNode; crumb?: { to: string; label: string }; actions?: ReactNode }) {
  return (
    <div className="pagehead">
      <div>
        {crumb ? (
          <div className="crumb">
            <Link to={crumb.to}>← {crumb.label}</Link>
          </div>
        ) : null}
        <h1>{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions ? <div className="row wrap">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, actions, children, flush, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) {
  return (
    <section className={`card${flush ? " flush" : ""}${className ? ` ${className}` : ""}`}>
      {title || actions ? (
        <div className="cardhead" style={flush ? { padding: "14px 16px 0" } : undefined}>
          {title ? <h2>{title}</h2> : <span />}
          {actions ? <div className="row wrap">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ h = 200 }: { h?: number }) {
  return <div className="skel" style={{ height: h }} aria-busy="true" />;
}

export function ErrorBox({ error, text }: { error?: unknown; text?: string }) {
  return (
    <div className="banner bad" role="alert">
      <Icon name="alert" />
      <span className="body">{text ?? errText(error)}</span>
    </div>
  );
}

export function Banner({ tone, icon = "info", title, children }: { tone: "bad" | "wait" | "info" | "ok"; icon?: string; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`banner ${tone}`}>
      <Icon name={icon} />
      <div className="grow">
        {title ? <b style={{ display: "block" }}>{title}</b> : null}
        {children ? <span className="body">{children}</span> : null}
      </div>
    </div>
  );
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : undefined}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string; n?: number; alert?: boolean }[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}>
          {t.label}
          {t.n != null ? <span className={`n${t.alert && t.n ? " alert" : ""}`}>{t.n}</span> : null}
        </button>
      ))}
    </div>
  );
}

let pushToast: ((m: { text: string; bad?: boolean }) => void) | null = null;
export function toast(text: string, bad = false) {
  pushToast?.({ text, bad });
}
export function Toaster() {
  const [m, setM] = useState<{ text: string; bad?: boolean } | null>(null);
  useEffect(() => {
    pushToast = setM;
    return () => {
      pushToast = null;
    };
  }, []);
  useEffect(() => {
    if (!m) return;
    const id = setTimeout(() => setM(null), 3500);
    return () => clearTimeout(id);
  }, [m]);
  return m ? <div className={`toast${m.bad ? " bad" : ""}`} role="status">{m.text}</div> : null;
}

export function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm"
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}
