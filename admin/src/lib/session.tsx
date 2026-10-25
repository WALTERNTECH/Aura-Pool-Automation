import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { call, hooks } from "./api";

// The signed-in admin, their permissions, the 30-minute idle sign-out, and the re-auth prompt.

export type Me = {
  id: string;
  email: string;
  name: string;
  role: "super_admin" | "finance" | "support" | "auditor";
  permissions: string[];
  recoveryCodesLeft: number;
  reauthValidUntil: string | null;
  environment: { provider: string; darajaEnv: string; sandbox: boolean; paybill: string; merchantUrl: string; otpOnScreen: boolean; virtualDevices: boolean };
  singleOperator: { on: boolean; delay_minutes: number };
};

type Ctx = { me: Me | null; ready: boolean; can: (p: string) => boolean; reload: () => Promise<void>; signOut: (why?: string) => Promise<void>; reauthOpen: boolean; resolveReauth: (ok: boolean) => void; requestReauth: () => Promise<boolean> };
const C = createContext<Ctx>(null as never);
const IDLE_MS = 30 * 60_000;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [reauthOpen, setReauthOpen] = useState(false);
  const waiter = useRef<((ok: boolean) => void) | null>(null);
  const lastActive = useRef(Date.now());

  const reload = useCallback(async () => {
    try {
      setMe(await call<Me>("/me", { quiet: true }));
    } catch {
      setMe(null);
    } finally {
      setReady(true);
    }
  }, []);

  const signOut = useCallback(async (why?: string) => {
    await call("/v1/auth/admin/logout", { method: "POST", quiet: true }).catch(() => {});
    setMe(null);
    location.assign(`/login${why ? `?why=${encodeURIComponent(why)}` : ""}`);
  }, []);

  const requestReauth = useCallback(() => {
    setReauthOpen(true);
    return new Promise<boolean>((res) => (waiter.current = res));
  }, []);
  const resolveReauth = useCallback((ok: boolean) => {
    setReauthOpen(false);
    waiter.current?.(ok);
    waiter.current = null;
  }, []);

  useEffect(() => {
    hooks({
      signedOut: () => {
        setMe(null);
        if (!/^\/(login|setup|invite)/.test(location.pathname)) location.assign("/login?why=expired");
      },
      reauth: requestReauth,
    });
    void reload();
  }, [reload, requestReauth]);

  // Idle sign-out: the server enforces 30 minutes too; this just says so on screen in time.
  useEffect(() => {
    const touch = () => (lastActive.current = Date.now());
    const events = ["pointerdown", "keydown", "scroll"] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const id = setInterval(() => {
      if (me && Date.now() - lastActive.current > IDLE_MS) void signOut("idle");
    }, 30_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      clearInterval(id);
    };
  }, [me, signOut]);

  const can = useCallback((p: string) => Boolean(me?.permissions.includes(p)), [me]);
  return <C.Provider value={{ me, ready, can, reload, signOut, reauthOpen, resolveReauth, requestReauth }}>{children}</C.Provider>;
}

export const useSession = () => useContext(C);
