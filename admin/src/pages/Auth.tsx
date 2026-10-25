import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Icon";
import { Banner, Copy, ErrorBox } from "../components/ui";
import { call, errText } from "../lib/api";
import { useApi } from "../lib/hooks";
import { useSession } from "../lib/session";

// Sign-in: email and password, then the authenticator code (or a recovery code). First run:
// the setup key creates the first super admin. Invited admins set a password and enrol an
// authenticator. Recovery codes are shown exactly once.

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="box stack">
        <div className="row" style={{ fontWeight: 750, fontSize: 17 }}>
          <Logo size={34} /> Aura Pool console
        </div>
        <section className="card stack">{children}</section>
      </div>
    </main>
  );
}

export function Login() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { reload, me } = useSession();
  const setup = useApi<{ needed: boolean; setupEnabled: boolean }>("/v1/auth/admin/setup");
  const [step, setStep] = useState<"password" | "totp">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (me) nav("/", { replace: true });
  }, [me, nav]);
  const why = sp.get("why");

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (step === "password") {
        await call("/v1/auth/login/admin", { method: "POST", body: { email, password } });
        setStep("totp");
      } else {
        const r = await call<{ recoveryCodesLeft?: number }>("/v1/auth/login/admin/totp", { method: "POST", body: recovery ? { recoveryCode: code } : { code } });
        if (r.recoveryCodesLeft != null) setLeft(r.recoveryCodesLeft);
        await reload();
        nav("/", { replace: true });
      }
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <h1>Sign in</h1>
      {why === "idle" ? <Banner tone="info">You were signed out after 30 minutes without activity.</Banner> : null}
      {why === "expired" ? <Banner tone="info">Your session ended. Sign in again.</Banner> : null}
      {setup.data?.needed ? (
        <Banner tone="wait" title="No admin account yet">
          <Link className="link" to="/setup">
            Create the first admin
          </Link>{" "}
          with the setup key.
        </Banner>
      ) : null}
      {left != null && left < 3 ? <Banner tone="wait">Only {left} recovery codes left. Reset your authenticator from Account.</Banner> : null}
      <form className="stack" onSubmit={go}>
        {step === "password" ? (
          <>
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </div>
            <div className="field">
              <label htmlFor="pw">Password</label>
              <input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor="code">{recovery ? "Recovery code" : "Code from your authenticator app"}</label>
            <input
              id="code"
              className="input"
              inputMode={recovery ? "text" : "numeric"}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(recovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, "").slice(0, 6))}
              autoFocus
              style={{ letterSpacing: recovery ? "0.1em" : "0.3em", fontSize: 18 }}
            />
            <button type="button" className="link small" style={{ justifySelf: "start" }} onClick={() => setRecovery(!recovery)}>
              {recovery ? "Use the authenticator instead" : "Lost your phone? Use a recovery code"}
            </button>
          </div>
        )}
        {err ? <ErrorBox text={err} /> : null}
        <button className="btn primary block" disabled={busy || (step === "password" ? !email || !password : recovery ? code.length < 6 : code.length !== 6)}>
          {step === "password" ? "Continue" : "Sign in"}
        </button>
      </form>
    </Shell>
  );
}

function Enrol({ data, onDone }: { data: { secret: string; otpauthUri: string; qrSvg: string }; onDone: (codes: string[]) => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          const r = await call<{ recoveryCodes: string[] }>("/v1/auth/admin/setup/confirm", { method: "POST", body: { code } });
          onDone(r.recoveryCodes);
        } catch (x) {
          setErr(errText(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Set up your authenticator</h2>
      <p className="muted small">Scan this with Google Authenticator, Microsoft Authenticator or 1Password, then enter the 6-digit code it shows.</p>
      <div className="qr" dangerouslySetInnerHTML={{ __html: data.qrSvg }} />
      <div className="field">
        <span className="label">Or enter this key</span>
        <div className="row">
          <span className="secret grow">{data.secret}</span>
          <Copy text={data.secret} />
        </div>
      </div>
      <input className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} aria-label="Code" style={{ letterSpacing: "0.3em", fontSize: 18 }} />
      {err ? <ErrorBox text={err} /> : null}
      <button className="btn primary block" disabled={busy || code.length !== 6}>
        Confirm
      </button>
    </form>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const { reload } = useSession();
  const nav = useNavigate();
  const [saved, setSaved] = useState(false);
  return (
    <div className="stack">
      <h2>Save your recovery codes</h2>
      <p className="muted small">Each code signs you in once if you lose your phone. They are shown only now. Store them somewhere safe, away from your phone.</p>
      <div className="codes">{codes.map((c) => <span key={c}>{c}</span>)}</div>
      <Copy text={codes.join("\n")} />
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I've stored these codes
      </label>
      <button
        className="btn primary block"
        disabled={!saved}
        onClick={async () => {
          await reload();
          nav("/", { replace: true });
        }}
      >
        Open the console
      </button>
    </div>
  );
}

export function Setup() {
  const [enrol, setEnrol] = useState<{ secret: string; otpauthUri: string; qrSvg: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [f, setF] = useState({ setupToken: "", name: "", email: "", phone: "", password: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (codes) return <Shell><RecoveryCodes codes={codes} /></Shell>;
  if (enrol) return <Shell><Enrol data={enrol} onDone={setCodes} /></Shell>;
  return (
    <Shell>
      <h1>Create the first admin</h1>
      <p className="muted small">This account is the super admin. It needs the setup key from the server's ADMIN_SETUP_TOKEN, and an authenticator app.</p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            setEnrol(await call("/v1/auth/admin/setup", { method: "POST", body: { ...f, phone: f.phone || undefined } }));
          } catch (x) {
            setErr(errText(x));
          } finally {
            setBusy(false);
          }
        }}
      >
        {(
          [
            ["setupToken", "Setup key", "password"],
            ["name", "Your name", "text"],
            ["email", "Email", "email"],
            ["phone", "Phone (for critical alerts by SMS)", "tel"],
            ["password", "Password (12 characters or more)", "password"],
          ] as const
        ).map(([k, label, type]) => (
          <div className="field" key={k}>
            <label htmlFor={k}>{label}</label>
            <input id={k} className="input" type={type} autoComplete={k === "password" ? "new-password" : k === "email" ? "username" : "off"} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </div>
        ))}
        {err ? <ErrorBox text={err} /> : null}
        <button className="btn primary block" disabled={busy || !f.setupToken || !f.name || !f.email || f.password.length < 12}>
          Continue
        </button>
      </form>
    </Shell>
  );
}

export function AcceptInvite() {
  const { token = "" } = useParams();
  const inv = useApi<{ email: string; name: string; role: string }>(`/v1/auth/admin/invite/${token}`);
  const [pw, setPw] = useState("");
  const [enrol, setEnrol] = useState<{ secret: string; otpauthUri: string; qrSvg: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (codes) return <Shell><RecoveryCodes codes={codes} /></Shell>;
  if (enrol) return <Shell><Enrol data={enrol} onDone={setCodes} /></Shell>;
  if (inv.error) return <Shell><ErrorBox error={inv.error} /></Shell>;
  return (
    <Shell>
      <h1>Join the console</h1>
      {inv.data ? <p className="muted">{inv.data.email} · {inv.data.role.replace("_", " ")}</p> : null}
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            setEnrol(await call(`/v1/auth/admin/invite/${token}`, { method: "POST", body: { password: pw } }));
          } catch (x) {
            setErr(errText(x));
          }
        }}
      >
        <div className="field">
          <label htmlFor="pw">Choose a password (12 characters or more)</label>
          <input id="pw" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
        {err ? <ErrorBox text={err} /> : null}
        <button className="btn primary block" disabled={pw.length < 12}>
          Continue
        </button>
      </form>
    </Shell>
  );
}
