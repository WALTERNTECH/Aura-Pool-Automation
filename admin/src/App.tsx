import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { SessionProvider, useSession } from "./lib/session";
import { AcceptInvite, Login, Setup } from "./pages/Auth";
import Dashboard from "./pages/Dashboard";
import { MerchantDetail, MerchantList, MerchantView } from "./pages/Merchants";
import { Float, Ledger, LedgerTx, PayoutDetail, Payouts, PlatformPayouts, Pricing, Reconciliation, Reports, Transfers } from "./pages/Money";
import { Account, AlertDetail, Alerts, Announcements, Approvals, Audit, DisputeDetail, Disputes, Health, Provider, Settings, Simulator, Users } from "./pages/Ops";
import { Exceptions, PaymentDetail, PaymentList } from "./pages/Payments";
import { TableDetail, TableList } from "./pages/Tables";

function Guard({ children }: { children: ReactNode }) {
  const { me, ready } = useSession();
  const loc = useLocation();
  if (!ready) return <div style={{ padding: 40 }}><Loading h={300} /></div>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

function Home() {
  const { can } = useSession();
  return can("dashboard.view") ? <Dashboard /> : <Navigate to="/payments" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/invite/:token" element={<AcceptInvite />} />
          <Route element={<Guard><Layout /></Guard>}>
            <Route index element={<Home />} />
            <Route path="merchants" element={<MerchantList />} />
            <Route path="merchants/:id" element={<MerchantDetail />} />
            <Route path="merchants/:id/view/:imp" element={<MerchantView />} />
            <Route path="tables" element={<TableList />} />
            <Route path="tables/:id" element={<TableDetail />} />
            <Route path="payments" element={<PaymentList />} />
            <Route path="payments/:id" element={<PaymentDetail />} />
            <Route path="exceptions" element={<Exceptions />} />
            <Route path="payouts" element={<Payouts />} />
            <Route path="payouts/:id" element={<PayoutDetail />} />
            <Route path="platform-payouts" element={<PlatformPayouts />} />
            <Route path="float" element={<Float />} />
            <Route path="transfers" element={<Transfers />} />
            <Route path="reconciliation" element={<Reconciliation />} />
            <Route path="ledger" element={<Ledger />} />
            <Route path="ledger/tx/:id" element={<LedgerTx />} />
            <Route path="pricing" element={<Pricing />} />
            <Route path="reports" element={<Reports />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="alerts/:id" element={<AlertDetail />} />
            <Route path="approvals" element={<Approvals />} />
            <Route path="disputes" element={<Disputes />} />
            <Route path="disputes/:id" element={<DisputeDetail />} />
            <Route path="announcements" element={<Announcements />} />
            <Route path="provider" element={<Provider />} />
            <Route path="health" element={<Health />} />
            <Route path="audit" element={<Audit />} />
            <Route path="users" element={<Users />} />
            <Route path="settings" element={<Settings />} />
            <Route path="simulator" element={<Simulator />} />
            <Route path="account" element={<Account />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
