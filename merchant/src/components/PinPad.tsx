import { useEffect, useRef, useState } from "react";
import { message } from "../lib/api";
import { t } from "../lib/i18n";
import { Icon } from "./Icon";
import { Sheet } from "./ui";

// Six-digit PIN entry: big keys for thumbs, works with a hardware keyboard too. Submits by
// itself on the sixth digit.

export function PinPad({ onDone, busy, error, autoFocus = true }: { onDone: (pin: string) => void; busy?: boolean; error?: string | null; autoFocus?: boolean }) {
  const [pin, setPin] = useState("");
  const [shake, setShake] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (error) {
      setPin("");
      setShake(true);
      const id = setTimeout(() => setShake(false), 350);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [error]);

  const push = (d: string) => {
    if (busy) return;
    setPin((p) => {
      const next = (p + d).slice(0, 6);
      if (next.length === 6) setTimeout(() => onDone(next), 60);
      return next;
    });
  };

  return (
    <div onClick={() => input.current?.focus()}>
      <input
        ref={input}
        className="sr"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label={t("pin.title")}
        autoFocus={autoFocus}
        value={pin}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 6);
          setPin(v);
          if (v.length === 6) onDone(v);
        }}
      />
      <div className={`pin-dots${shake ? " shake" : ""}`} aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <i key={i} className={i < pin.length ? "on" : ""} />
        ))}
      </div>
      {error ? (
        <p className="err center" role="alert">
          {error}
        </p>
      ) : (
        <p className="hint center">&nbsp;</p>
      )}
      <div className="keypad">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" onClick={() => push(d)} disabled={busy}>
            {d}
          </button>
        ))}
        <span />
        <button type="button" onClick={() => push("0")} disabled={busy}>
          0
        </button>
        <button type="button" className="fn" aria-label="Delete" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy}>
          <Icon name="backspace" />
        </button>
      </div>
    </div>
  );
}

/** Asks for the PIN, runs the action, and shows its error in place. */
export function PinSheet({ open, onClose, title, onPin }: { open: boolean; onClose: () => void; title?: string; onPin: (pin: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (open) {
      setError(null);
      setNonce((n) => n + 1);
    }
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title={title ?? t("pin.title")}>
      <PinPad
        key={nonce}
        busy={busy}
        error={error}
        onDone={async (pin) => {
          setBusy(true);
          setError(null);
          try {
            await onPin(pin);
          } catch (e) {
            setError(message(e, t));
          } finally {
            setBusy(false);
          }
        }}
      />
      <p className="hint center" style={{ marginTop: 14 }}>
        {t("pin.forgot")}
      </p>
    </Sheet>
  );
}
