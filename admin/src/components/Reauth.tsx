import { useState } from "react";
import { call, errText } from "../lib/api";
import { useSession } from "../lib/session";
import { Dialog, ErrorBox } from "./ui";

// Shown when the server asks for a fresh confirmation before a sensitive action. The action
// that triggered it is retried automatically once this succeeds.

export function ReauthDialog() {
  const { reauthOpen, resolveReauth } = useSession();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [usePw, setUsePw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!reauthOpen) return null;
  return (
    <Dialog open onClose={() => resolveReauth(false)} title="Confirm it's you">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await call("/me/reauth", { method: "POST", body: usePw ? { password } : { code } });
            setCode("");
            setPassword("");
            resolveReauth(true);
          } catch (x) {
            setErr(errText(x));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">This action changes money or security settings. Confirm with {usePw ? "your password" : "the code from your authenticator app"}. It stays confirmed for 10 minutes.</p>
        {usePw ? (
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus aria-label="Password" />
        ) : (
          <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus aria-label="Authenticator code" style={{ letterSpacing: "0.3em", fontSize: 20, textAlign: "center" }} />
        )}
        <button type="button" className="link small" style={{ justifySelf: "start" }} onClick={() => setUsePw(!usePw)}>
          {usePw ? "Use the authenticator code instead" : "Use my password instead"}
        </button>
        {err ? <ErrorBox text={err} /> : null}
        <div className="actions">
          <button type="button" className="btn" onClick={() => resolveReauth(false)}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (usePw ? !password : code.length !== 6)}>
            Confirm
          </button>
        </div>
      </form>
    </Dialog>
  );
}
