import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, call, clearCache, readCache, whenSignedOut, writeCache } from "./api";
import { setLang } from "./i18n";
import { applyTheme } from "./theme";

// Who is signed in. Loaded once at start (from cache first, so the app opens offline), and
// re-fetched after sign-in and preference changes.

export type Me = {
  user: { id: string; name: string; role: "owner" | "staff"; phoneMasked: string; impersonatedBy: string | null };
  merchant: { id: string; code: string; businessName: string; ownerName: string; location: string | null; email: string | null; status: string; statusReason: string | null };
  prefs: { language?: "en" | "sw"; theme?: "system" | "light" | "dark"; notifications?: Record<string, { push?: boolean }>; quietHours?: { on: boolean; from: string; to: string } };
  tourDone: boolean;
  payoutNumberVerified: boolean;
  support: { phone: string; whatsapp: string; email: string; hours: string };
  notices: { killSwitch: string | null };
  push: { vapidPublicKey: string | null };
  testMode: { otpOnScreen: boolean; sandbox: boolean };
  notificationTypes: { type: string; label: string; critical: boolean }[];
  termsVersion: string;
};

type Ctx = { me: Me | null; ready: boolean; reload: () => Promise<Me | null>; signOut: () => Promise<void>; isOwner: boolean };
const SessionCtx = createContext<Ctx>({ me: null, ready: false, reload: async () => null, signOut: async () => {}, isOwner: false });

export function SessionProvider({ children }: { children: ReactNode }) {
  const cached = readCache<Me>("/me");
  const [me, setMe] = useState<Me | null>(cached?.data ?? null);
  const [ready, setReady] = useState(Boolean(cached));

  const apply = (m: Me | null) => {
    setMe(m);
    if (m?.prefs.language) setLang(m.prefs.language);
    applyTheme(m?.prefs.theme ?? "light");
  };

  const reload = useCallback(async () => {
    try {
      const m = await call<Me>("/me", { auth: false });
      writeCache("/me", m);
      apply(m);
      return m;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        apply(null);
        clearCache();
      }
      return null;
    } finally {
      setReady(true);
    }
  }, []);

  const signOut = useCallback(async () => {
    await call("/v1/auth/logout", { method: "POST", auth: false }).catch(() => {});
    clearCache();
    apply(null);
    location.assign("/login");
  }, []);

  useEffect(() => {
    if (cached) apply(cached.data);
    void reload();
    whenSignedOut(() => {
      clearCache();
      setMe(null);
      if (!/^\/(login|invite)/.test(location.pathname)) location.assign("/login");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <SessionCtx.Provider value={{ me, ready, reload, signOut, isOwner: me?.user.role === "owner" }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);
