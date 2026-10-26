import { createContext, useContext, type ReactNode } from "react";
import { useApi } from "./hooks";
import { useSession } from "./session";

// One live copy of the command dashboard, shared by the frame (menu counts, the bell) and the
// dashboard page, refreshed every 30 seconds while the tab is visible.

type Live = { dash: ReturnType<typeof useApi<any>>; approvals: number };
const C = createContext<Live | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const { me, can } = useSession();
  const dash = useApi<any>(me && can("dashboard.view") ? "/dashboard" : null, { refreshMs: 30_000 });
  const ap = useApi<any>(me && can("approvals.view") ? "/approvals?status=pending" : null, { refreshMs: 60_000 });
  return <C.Provider value={{ dash, approvals: ap.data?.items?.length ?? 0 }}>{children}</C.Provider>;
}

export const useLive = () => useContext(C)!;
