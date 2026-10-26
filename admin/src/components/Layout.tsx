import { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { call } from "../lib/api";
import { ago } from "../lib/format";
import { LiveProvider, useLive } from "../lib/live";
import { useSession } from "../lib/session";
import { Icon, Logo } from "./Icon";
import { ACCOUNT, DASHBOARD, GROUPS, findCurrent, type NavGroup, type NavItem } from "./nav";
import { ReauthDialog } from "./Reauth";
import { Toaster } from "./ui";

// The console frame. Desktop: a sidebar with Dashboard first and groups that open like
// dropdowns, a top bar with the page's place, "Jump to", alerts and the account menu.
// Phone: the same sidebar slides in from the left behind a menu button.

type Badge = { n?: number; tone: "bad" | "wait" | "info" };

export function Layout() {
  return (
    <LiveProvider>
      <Frame />
    </LiveProvider>
  );
}

function Frame() {
  const { me, can } = useSession();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [jump, setJump] = useState(false);
  const current = findCurrent(loc.pathname);
  const badges = useBadges();

  const visible = (i: NavItem) => (!i.perm || can(i.perm)) && (!i.sandbox || me?.environment.provider === "simulated");
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: g.items.filter(visible) })).filter((g) => g.items.length), [me]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setDrawer(false), [loc.pathname]);
  useEffect(() => {
    document.body.classList.toggle("locked", drawer);
    return () => document.body.classList.remove("locked");
  }, [drawer]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setJump((j) => !j);
      } else if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  return (
    <div className="console">
      <div className="app-bg" aria-hidden="true" />
      <Sidebar open={drawer} groups={groups} badges={badges} current={current} showDashboard={visible(DASHBOARD)} onClose={() => setDrawer(false)} />
      {drawer ? <div className="side-scrim" onClick={() => setDrawer(false)} aria-hidden="true" /> : null}
      <div className="console-main">
        <Topbar current={current} onMenu={() => setDrawer(true)} onJump={() => setJump(true)} />
        <Strips />
        <main className="content" key={loc.pathname}>
          <Outlet />
        </main>
      </div>
      <Jump open={jump} onClose={() => setJump(false)} groups={groups} showDashboard={visible(DASHBOARD)} />
      <ReauthDialog />
      <Toaster />
    </div>
  );
}

/** Live counts beside menu items, from the shared dashboard data. */
function useBadges(): Record<string, Badge | undefined> {
  const { dash, approvals } = useLive();
  const d = dash.data;
  if (!d) return { "/approvals": approvals ? { n: approvals, tone: "wait" } : undefined };
  const a = d.attention ?? {};
  const exceptions = (a.unmatched ?? 0) + (a.underpaid ?? 0) + (a.overpaid ?? 0) + (a.unlock_failed ?? 0) + (a.verification_failed ?? 0) + (a.refund_pending ?? 0);
  const counts = (d.alerts?.counts ?? {}) as Record<string, number>;
  const alerts = Object.values(counts).reduce((s, n) => s + n, 0);
  const money = d.money ?? {};
  const b: Record<string, Badge | undefined> = {
    "/alerts": alerts ? { n: alerts, tone: counts.critical ? "bad" : "wait" } : undefined,
    "/exceptions": exceptions ? { n: exceptions, tone: "bad" } : undefined,
    "/approvals": approvals ? { n: approvals, tone: "wait" } : undefined,
    "/disputes": d.disputesOpen ? { n: d.disputesOpen, tone: "wait" } : undefined,
    "/tables": d.fleet?.offline ? { n: d.fleet.offline, tone: "wait" } : undefined,
    "/payouts": money.pendingApproval?.count ? { n: money.pendingApproval.count, tone: "wait" } : undefined,
    "/float": money.float?.status === "critical" ? { tone: "bad" } : money.float?.status === "warning" ? { tone: "wait" } : undefined,
    "/reconciliation": money.reconciliation?.status === "mismatch" ? { tone: "bad" } : undefined,
  };
  return b;
}

function BadgeView({ b }: { b?: Badge }) {
  if (!b) return null;
  return b.n ? <span className={`nav-count ${b.tone}`}>{b.n > 99 ? "99+" : b.n}</span> : <span className={`nav-dot ${b.tone}`} aria-label="Needs a look" />;
}

const OPEN_KEY = "aura:nav-open";

function Sidebar({ open, groups, badges, current, showDashboard, onClose }: { open: boolean; groups: NavGroup[]; badges: Record<string, Badge | undefined>; current: ReturnType<typeof findCurrent>; showDashboard: boolean; onClose: () => void }) {
  const { me, signOut } = useSession();
  const [openIds, setOpenIds] = useState<Set<string>>(() => {
    try {
      const v = localStorage.getItem(OPEN_KEY);
      if (v) return new Set(JSON.parse(v));
    } catch {
      /* ignore */
    }
    return new Set(["attention"]);
  });
  const groupId = current?.group?.id;
  // The group holding the page you're on is always open.
  useEffect(() => {
    if (groupId) setOpenIds((s) => (s.has(groupId) ? s : new Set(s).add(groupId)));
  }, [groupId]);
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...openIds]));
    } catch {
      /* ignore */
    }
  }, [openIds]);
  const toggle = (id: string) =>
    setOpenIds((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const initials = (me?.name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <aside className={`side${open ? " open" : ""}`} aria-label="Console menu">
      <div className="side-top">
        <Link to="/" className="side-brand">
          <Logo size={32} />
          <span>
            <b>Aura Pool</b>
            <small>Operations console</small>
          </span>
        </Link>
        <button className="icon-btn side-close" onClick={onClose} aria-label="Close menu">
          <Icon name="x" />
        </button>
      </div>
      {me?.environment.sandbox ? (
        <div className="side-env">
          <span className="env-pill">
            <span className="d" />
            Sandbox: {me.environment.provider === "simulated" ? "simulated M-Pesa" : "Daraja sandbox"}
          </span>
        </div>
      ) : null}
      <nav className="side-nav">
        {showDashboard ? (
          <NavLink to="/" end className="side-link side-home">
            <Icon name={DASHBOARD.icon} />
            <span className="grow">Dashboard</span>
          </NavLink>
        ) : null}
        {groups.map((g) => {
          const isOpen = openIds.has(g.id);
          const inGroup = g.items.map((i) => badges[i.to]).filter(Boolean) as Badge[];
          const sum = inGroup.reduce((s, b) => s + (b.n ?? 0), 0);
          const tone = inGroup.some((b) => b.tone === "bad") ? "bad" : inGroup.length ? "wait" : null;
          return (
            <div key={g.id} className={`side-group${isOpen ? " open" : ""}${groupId === g.id ? " here" : ""}`}>
              <button className="side-head" aria-expanded={isOpen} onClick={() => toggle(g.id)}>
                <Icon name={g.icon} />
                <span className="grow">{g.label}</span>
                {!isOpen && tone ? <BadgeView b={{ n: sum || undefined, tone }} /> : null}
                <Icon name="down" className="chev" />
              </button>
              <div className="side-items" inert={!isOpen}>
                <div>
                  {g.items.map((i) => (
                    <NavLink key={i.to} to={i.to} end={false} className="side-link">
                      <Icon name={i.icon} />
                      <span className="grow">{i.label}</span>
                      <BadgeView b={badges[i.to]} />
                    </NavLink>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </nav>
      <div className="side-foot">
        <NavLink to={ACCOUNT.to} className="side-me">
          <span className="monogram">{initials || "A"}</span>
          <span className="grow">
            <b>{me?.name}</b>
            <small>{me?.role.replace("_", " ")}</small>
          </span>
        </NavLink>
        <button className="icon-btn" onClick={() => void signOut()} aria-label="Sign out" title="Sign out">
          <Icon name="logout" />
        </button>
      </div>
    </aside>
  );
}

function Topbar({ current, onMenu, onJump }: { current: ReturnType<typeof findCurrent>; onMenu: () => void; onJump: () => void }) {
  const { me, signOut, can } = useSession();
  const { dash } = useLive();
  const loc = useLocation();
  const [menu, setMenu] = useState<"bell" | "me" | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => setMenu(null), [loc.pathname]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setMenu(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);
  const counts = (dash.data?.alerts?.counts ?? {}) as Record<string, number>;
  const alertN = Object.values(counts).reduce((s, n) => s + n, 0);
  const open = (dash.data?.alerts?.open ?? []) as any[];
  const env = me?.environment;

  return (
    <header className={`topbar${env?.sandbox ? " sandbox" : ""}`}>
      <button className="icon-btn topbar-menu" onClick={onMenu} aria-label="Open menu">
        <Icon name="menu" />
      </button>
      <div className="crumbs">
        {current?.group ? <span className="crumb-g">{current.group.label}</span> : null}
        <b>{current?.item.label ?? "Console"}</b>
      </div>
      <span className="grow" />
      <button className="jump-btn" onClick={onJump} aria-label="Jump to a page, merchant or table">
        <Icon name="search" />
        <span>Jump to…</span>
        <kbd>Ctrl K</kbd>
      </button>
      {env?.sandbox ? (
        <span className="env-pill" title={`${env.provider === "simulated" ? "Simulated M-Pesa: no real money moves." : "Daraja sandbox."}${env.otpOnScreen ? " One-time codes are shown on screen." : ""}`}>
          <span className="d" />
          Sandbox
        </span>
      ) : null}
      <div className="top-actions" ref={wrap}>
        {can("alerts.view") ? (
          <div className="pop-wrap">
            <button className="icon-btn" onClick={() => setMenu(menu === "bell" ? null : "bell")} aria-label={`Alerts${alertN ? `, ${alertN} open` : ""}`} aria-expanded={menu === "bell"}>
              <Icon name="bell" />
              {alertN ? <span className={`bell-n${counts.critical ? " bad" : ""}`}>{alertN > 9 ? "9+" : alertN}</span> : null}
            </button>
            {menu === "bell" ? (
              <div className="pop wide" role="menu">
                <div className="pop-head">
                  <b>Open alerts</b>
                  <span>{alertN ? `${counts.critical ?? 0} critical · ${counts.warning ?? 0} warning` : "Nothing open"}</span>
                </div>
                {open.length ? (
                  open.slice(0, 6).map((a) => (
                    <Link key={a.id} to={`/alerts/${a.id}`} className="pop-row" role="menuitem">
                      <span className={`sev-dot ${a.severity}`} />
                      <span className="grow">{a.title}</span>
                      <time>{ago(a.last_seen_at)}</time>
                    </Link>
                  ))
                ) : (
                  <div className="pop-empty">
                    <Icon name="check" /> All clear
                  </div>
                )}
                <Link to="/alerts" className="pop-foot">
                  All alerts <Icon name="arrowRight" />
                </Link>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="pop-wrap">
          <button className="avatar-btn" onClick={() => setMenu(menu === "me" ? null : "me")} aria-label="Account" aria-expanded={menu === "me"}>
            <span className="monogram">
              {(me?.name ?? "A")
                .split(/\s+/)
                .slice(0, 2)
                .map((w) => w[0])
                .join("")
                .toUpperCase()}
            </span>
          </button>
          {menu === "me" ? (
            <div className="pop" role="menu">
              <div className="pop-head">
                <b>{me?.name}</b>
                <span>{me?.email}</span>
                <span className="role">{me?.role.replace("_", " ")}</span>
              </div>
              <Link to="/account" className="pop-row" role="menuitem">
                <Icon name="user" /> Your account
              </Link>
              <button className="pop-row" role="menuitem" onClick={() => void signOut()}>
                <Icon name="logout" /> Sign out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/** Platform-wide conditions every page should show: the kill switch and paused auto-payouts. */
function Strips() {
  const { dash } = useLive();
  const m = dash.data?.money;
  if (!m) return null;
  return (
    <>
      {m.killSwitch?.on ? (
        <div className="strip bad" role="alert">
          <Icon name="power" />
          <span className="grow">
            <b>Payout kill switch is on.</b> No payouts are being sent.
          </span>
          <Link to="/payouts">Manage</Link>
        </div>
      ) : null}
      {m.autoPayoutsPaused?.on ? (
        <div className="strip wait" role="status">
          <Icon name="alert" />
          <span className="grow">
            <b>Automatic payouts are paused</b> after a reconciliation difference.
          </span>
          <Link to="/reconciliation">Review</Link>
        </div>
      ) : null}
    </>
  );
}

type Hit = { key: string; label: string; sub?: string; to: string; icon: string; kind: string };

/** Ctrl K: jump to any page, merchant, table or payment. */
function Jump({ open, onClose, groups, showDashboard }: { open: boolean; onClose: () => void; groups: NavGroup[]; showDashboard: boolean }) {
  const nav = useNavigate();
  const { can } = useSession();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [remote, setRemote] = useState<Hit[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setRemote([]);
      setTimeout(() => input.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < 2) return setRemote([]);
    const id = setTimeout(async () => {
      const enc = encodeURIComponent(term);
      const out: Hit[] = [];
      const [m, t, p] = await Promise.all([
        can("merchants.view") ? call<any>(`/merchants?q=${enc}&pageSize=5`, { quiet: true }).catch(() => null) : null,
        can("tables.view") ? call<any>(`/tables?q=${enc}&pageSize=5`, { quiet: true }).catch(() => null) : null,
        can("payments.view") && /^[A-Za-z0-9]{6,}$/.test(term) ? call<any>(`/payments?q=${enc}&pageSize=5`, { quiet: true }).catch(() => null) : null,
      ]);
      for (const x of m?.items ?? []) out.push({ key: `m${x.id}`, label: x.business_name, sub: `${x.code} · ${x.owner_name}`, to: `/merchants/${x.id}`, icon: "users", kind: "Merchant" });
      for (const x of t?.items ?? []) out.push({ key: `t${x.id}`, label: `${x.id} · ${x.name}`, sub: x.merchant ?? "", to: `/tables/${x.id}`, icon: "table", kind: "Table" });
      for (const x of p?.items ?? []) out.push({ key: `p${x.id}`, label: x.provider_txn_id ?? x.id, sub: [x.merchant, x.account_ref].filter(Boolean).join(" · "), to: `/payments/${x.id}`, icon: "payments", kind: "Payment" });
      setRemote(out);
    }, 220);
    return () => clearTimeout(id);
  }, [q, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pages: Hit[] = useMemo(() => {
    const all: Hit[] = [];
    if (showDashboard) all.push({ key: "/", label: "Dashboard", to: "/", icon: DASHBOARD.icon, kind: "Page" });
    for (const g of groups) for (const i of g.items) all.push({ key: i.to, label: i.label, sub: g.label, to: i.to, icon: i.icon, kind: "Page" });
    if (can("merchants.manage")) all.push({ key: "new-m", label: "New merchant", sub: "Create and invite an owner", to: "/merchants?new=1", icon: "plus", kind: "Action" });
    if (can("tables.manage")) all.push({ key: "new-t", label: "New table", sub: "Add a table for a merchant", to: "/tables?new=1", icon: "plus", kind: "Action" });
    all.push({ key: ACCOUNT.to, label: ACCOUNT.label, to: ACCOUNT.to, icon: ACCOUNT.icon, kind: "Page" });
    const t = q.trim().toLowerCase();
    return t ? all.filter((h) => `${h.label} ${h.sub ?? ""}`.toLowerCase().includes(t)) : all;
  }, [groups, q, showDashboard, can]);

  const hits = [...pages, ...remote];
  useEffect(() => setSel(0), [q]);
  if (!open) return null;
  const go = (h?: Hit) => {
    if (!h) return;
    onClose();
    nav(h.to);
  };

  return (
    <div className="scrim jump-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="jump" role="dialog" aria-modal="true" aria-label="Jump to">
        <div className="jump-in">
          <Icon name="search" />
          <input
            ref={input}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Page, merchant, table or M-Pesa code"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(hits.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") go(hits[sel]);
              else if (e.key === "Escape") onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="jump-list">
          {hits.length ? (
            hits.map((h, i) => (
              <button key={h.key} className={`jump-row${i === sel ? " sel" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => go(h)}>
                <span className="jump-ic">
                  <Icon name={h.icon} />
                </span>
                <span className="grow">
                  <b>{h.label}</b>
                  {h.sub ? <small>{h.sub}</small> : null}
                </span>
                <span className="jump-kind">{h.kind}</span>
              </button>
            ))
          ) : (
            <div className="pop-empty">Nothing matches “{q}”.</div>
          )}
        </div>
      </div>
    </div>
  );
}
