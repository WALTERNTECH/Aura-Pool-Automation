import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { message } from "../lib/api";
import { when } from "../lib/format";
import { t } from "../lib/i18n";
import { useOnline } from "../lib/hooks";
import { Icon } from "./Icon";

export function TopBar({ title, back, action }: { title: string; back?: string | true; action?: ReactNode }) {
  const nav = useNavigate();
  return (
    <header className="topbar">
      {back ? (
        <button className="icon-btn" aria-label={t("app.back")} onClick={() => (back === true ? nav(-1) : nav(back))}>
          <Icon name="back" />
        </button>
      ) : null}
      <h1>{title}</h1>
      {action}
    </header>
  );
}

export function Badge({ tone = "info", children, plain }: { tone?: "ok" | "wait" | "bad" | "info"; children: ReactNode; plain?: boolean }) {
  return <span className={`badge ${tone}${plain ? " plain" : ""}`}>{children}</span>;
}

export function Skeleton({ h = 18, w = "100%", r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skel" style={{ height: h, width: w, borderRadius: r }} />;
}

export function PageSkeleton() {
  return (
    <div className="stack" aria-busy="true" aria-label={t("app.loading")}>
      <Skeleton h={30} w="55%" />
      <div className="kpis">
        <Skeleton h={84} />
        <Skeleton h={84} />
        <Skeleton h={84} />
        <Skeleton h={84} />
      </div>
      <Skeleton h={120} />
      <Skeleton h={180} />
    </div>
  );
}

export function Empty({ icon = "info", children, action }: { icon?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <div>{children}</div>
      {action}
    </div>
  );
}

export function ErrorBox({ error, text, retry }: { error?: unknown; text?: string; retry?: () => void }) {
  return (
    <div className="banner bad" role="alert">
      <Icon name="alert" />
      <div className="grow">
        <span className="sub">{text ?? message(error, t)}</span>
      </div>
      {retry ? (
        <button className="btn sm" onClick={retry}>
          {t("app.retry")}
        </button>
      ) : null}
    </div>
  );
}

export function Stale({ savedAt, stale }: { savedAt: number | null; stale: boolean }) {
  const online = useOnline();
  if (!savedAt) return null;
  if (!stale && online) return null;
  return <p className="stale">{t("stale.updated", { when: when(new Date(savedAt)) })}</p>;
}

export function OfflineBar() {
  const online = useOnline();
  const [back, setBack] = useState(false);
  const [wasOff, setWasOff] = useState(false);
  useEffect(() => {
    if (!online) setWasOff(true);
    else if (wasOff) {
      setBack(true);
      const id = setTimeout(() => setBack(false), 2500);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [online, wasOff]);
  if (online && !back) return null;
  return (
    <div className="offline" role="status">
      {online ? t("offline.back") : t("offline.banner", { when: lastLoaded() })}
    </div>
  );
}

function lastLoaded() {
  try {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("aura:cache:"));
    const latest = Math.max(0, ...keys.map((k) => JSON.parse(localStorage.getItem(k) ?? "{}").savedAt ?? 0));
    return latest ? when(new Date(latest)) : "—";
  } catch {
    return "—";
  }
}

export function Sheet({ open, onClose, title, children, label }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; label?: string }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", k);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label ?? title}>
        <div className="grabber" />
        {title ? <h2>{title}</h2> : null}
        {children}
      </div>
    </div>
  );
}

export function Row({ to, onClick, lead, title, sub, end, chevron = true }: { to?: string; onClick?: () => void; lead?: ReactNode; title: ReactNode; sub?: ReactNode; end?: ReactNode; chevron?: boolean }) {
  const body = (
    <>
      {lead ? <span className="lead">{lead}</span> : null}
      <span className="main">
        <span className="title ellipsis">{title}</span>
        {sub ? <span className="sub ellipsis">{sub}</span> : null}
      </span>
      {end ? <span className="end">{end}</span> : null}
      {chevron && (to || onClick) ? <Icon name="right" className="chev" /> : null}
    </>
  );
  if (to) return <Link className="item" to={to}>{body}</Link>;
  if (onClick) return <button className="item" onClick={onClick}>{body}</button>;
  return <div className="item">{body}</div>;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="chip" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

let toastSet: ((m: string | null) => void) | null = null;
export function toast(m: string) {
  toastSet?.(m);
}
export function Toaster() {
  const [m, setM] = useState<string | null>(null);
  useEffect(() => {
    toastSet = setM;
    return () => {
      toastSet = null;
    };
  }, []);
  useEffect(() => {
    if (!m) return;
    const id = setTimeout(() => setM(null), 2800);
    return () => clearTimeout(id);
  }, [m]);
  return m ? (
    <div className="toast" role="status">
      {m}
    </div>
  ) : null;
}

export function Spinner() {
  return <span className="spinner" aria-label={t("app.loading")} />;
}

export function stateTone(state: string): "ok" | "wait" | "bad" | "info" {
  return state === "online" ? "ok" : state === "maintenance" ? "wait" : state === "offline" ? "bad" : "info";
}
