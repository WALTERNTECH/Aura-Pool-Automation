import { useEffect, useMemo, useState, type ReactNode } from "react";
import { call, errText, newKey } from "../lib/api";
import { Banner, Dialog, ErrorBox, toast } from "./ui";

// Every action that changes something goes through this dialog: it says what will happen
// (and the amounts), asks for a reason where one is required, disables itself while the
// request is in flight, and sends an Idempotency-Key for money-moving calls.

export type Field =
  | { name: string; label: string; kind: "text" | "number" | "money" | "datetime" | "textarea" | "password"; required?: boolean; hint?: string; initial?: string; placeholder?: string }
  | { name: string; label: string; kind: "select"; options: { value: string; label: string }[]; required?: boolean; hint?: string; initial?: string }
  | { name: string; label: string; kind: "check"; hint?: string; initial?: boolean };

export function ActionButton({
  label,
  title,
  description,
  method = "POST",
  path,
  fields = [],
  reason = true,
  build,
  confirm,
  tone = "primary",
  money,
  onDone,
  small,
  disabled,
  icon,
}: {
  label: ReactNode;
  title: string;
  description?: ReactNode;
  method?: string;
  path: string;
  fields?: Field[];
  reason?: boolean | string;
  build?: (v: Record<string, any>) => unknown;
  confirm?: string;
  tone?: "primary" | "danger" | "plain";
  money?: boolean;
  onDone?: (result: any) => void;
  small?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`btn${tone === "plain" ? "" : ` ${tone}`}${small ? " sm" : ""}`} onClick={() => setOpen(true)} disabled={disabled}>
        {icon}
        {label}
      </button>
      {open ? (
        <ActionDialog
          title={title}
          description={description}
          method={method}
          path={path}
          fields={fields}
          reason={reason}
          build={build}
          confirm={confirm ?? (typeof label === "string" ? label : "Confirm")}
          tone={tone}
          money={money}
          onClose={() => setOpen(false)}
          onDone={(r) => {
            setOpen(false);
            onDone?.(r);
          }}
        />
      ) : null}
    </>
  );
}

export function ActionDialog({
  title,
  description,
  method,
  path,
  fields,
  reason,
  build,
  confirm,
  tone,
  money,
  onClose,
  onDone,
}: {
  title: string;
  description?: ReactNode;
  method: string;
  path: string;
  fields: Field[];
  reason: boolean | string;
  build?: (v: Record<string, any>) => unknown;
  confirm: string;
  tone: "primary" | "danger" | "plain";
  money?: boolean;
  onClose: () => void;
  onDone: (r: any) => void;
}) {
  const all: Field[] = useMemo(() => [...fields, ...(reason ? [{ name: "reason", label: typeof reason === "string" ? reason : "Reason", kind: "textarea" as const, required: true, hint: "Recorded in the audit log." }] : [])], [fields, reason]);
  const [v, setV] = useState<Record<string, any>>(() => Object.fromEntries(all.map((f) => [f.name, "initial" in f && f.initial != null ? f.initial : f.kind === "check" ? false : ""])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [key] = useState(newKey);
  const [approval, setApproval] = useState<{ id: string; summary: string; executable_after: string | null } | null>(null);
  useEffect(() => setErr(null), [v]);

  const missing = all.some((f) => f.kind !== "check" && (f as { required?: boolean }).required && !String(v[f.name] ?? "").trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const body = build ? build(v) : Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ""));
      const r = await call(path, { method, body, idem: money ? key : undefined });
      // Four-eyes actions answer with the approval request rather than the effect.
      if (r && typeof r === "object" && "action" in r && "requested_by" in r && (r as { status?: string }).status === "pending") {
        setApproval(r as never);
        return;
      }
      toast("Done");
      onDone(r);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };

  if (approval)
    return (
      <Dialog open onClose={() => onDone(approval)} title="Sent for approval">
        <Banner tone="info" icon="approve" title={approval.summary}>
          A second authorised person must approve this before it happens.
          {approval.executable_after ? ` In single-operator mode you can approve it yourself after ${new Date(approval.executable_after).toLocaleTimeString("en-KE", { timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit" })}.` : ""}
        </Banner>
        <div className="actions">
          <button className="btn primary" onClick={() => onDone(approval)}>
            OK
          </button>
        </div>
      </Dialog>
    );

  return (
    <Dialog open onClose={onClose} title={title}>
      <form className="stack" onSubmit={submit}>
        {description ? <div className="muted">{description}</div> : null}
        {all.map((f) => (
          <div className="field" key={f.name}>
            {f.kind === "check" ? (
              <label className="check">
                <input type="checkbox" checked={Boolean(v[f.name])} onChange={(e) => setV({ ...v, [f.name]: e.target.checked })} />
                {f.label}
              </label>
            ) : (
              <>
                <label htmlFor={`f-${f.name}`}>{f.label}</label>
                {f.kind === "select" ? (
                  <select id={`f-${f.name}`} className="input" value={v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.value })}>
                    <option value="">Choose…</option>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : f.kind === "textarea" ? (
                  <textarea id={`f-${f.name}`} className="input" value={v[f.name]} onChange={(e) => setV({ ...v, [f.name]: e.target.value })} />
                ) : (
                  <input
                    id={`f-${f.name}`}
                    className="input"
                    type={f.kind === "number" || f.kind === "money" ? "text" : f.kind === "datetime" ? "datetime-local" : f.kind}
                    inputMode={f.kind === "number" || f.kind === "money" ? "decimal" : undefined}
                    placeholder={"placeholder" in f ? f.placeholder : undefined}
                    value={v[f.name]}
                    onChange={(e) => setV({ ...v, [f.name]: e.target.value })}
                  />
                )}
              </>
            )}
            {f.hint ? <span className="hint">{f.hint}</span> : null}
          </div>
        ))}
        {err ? <ErrorBox text={err} /> : null}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${tone === "danger" ? "danger" : "primary"}`} disabled={busy || missing}>
            {busy ? "Working…" : confirm}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
