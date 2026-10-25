import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Shell } from "./components/Shell";
import { PageSkeleton, Toaster } from "./components/ui";
import { InstallPrompt } from "./components/InstallPrompt";
import { useLang } from "./lib/hooks";
import { SessionProvider, useSession } from "./lib/session";
import Home from "./pages/Home";
import Login from "./pages/Login";

// Home and sign-in ship in the first bundle; every other screen loads when first opened.
const Invite = lazy(() => import("./pages/Invite"));
const Tour = lazy(() => import("./pages/Tour"));
const Tables = lazy(() => import("./pages/Tables"));
const TableDetail = lazy(() => import("./pages/TableDetail"));
const Payments = lazy(() => import("./pages/Payments"));
const PaymentDetail = lazy(() => import("./pages/PaymentDetail"));
const Money = lazy(() => import("./pages/Money"));
const Withdraw = lazy(() => import("./pages/Withdraw"));
const History = lazy(() => import("./pages/History"));
const AutoWithdraw = lazy(() => import("./pages/AutoWithdraw"));
const PayoutNumber = lazy(() => import("./pages/PayoutNumber"));
const Stats = lazy(() => import("./pages/Stats"));
const Alerts = lazy(() => import("./pages/Alerts"));
const More = lazy(() => import("./pages/More"));
const Staff = lazy(() => import("./pages/Staff"));
const Settings = lazy(() => import("./pages/Settings"));
const Help = lazy(() => import("./pages/Help"));
const Support = lazy(() => import("./pages/Support"));
const Dispute = lazy(() => import("./pages/Dispute"));
const Legal = lazy(() => import("./pages/Legal"));

function Page({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <main className="page">
          <PageSkeleton />
        </main>
      }
    >
      {children}
    </Suspense>
  );
}

function Guard({ children, owner }: { children: ReactNode; owner?: boolean }) {
  const { me, ready, isOwner } = useSession();
  const loc = useLocation();
  if (!ready && !me) {
    return (
      <main className="page">
        <PageSkeleton />
      </main>
    );
  }
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!me.tourDone && loc.pathname !== "/tour") return <Navigate to="/tour" replace />;
  if (owner && !isOwner) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Routed() {
  useLang();
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <>
            <Login />
            <InstallPrompt />
            <Toaster />
          </>
        }
      />
      <Route path="/invite/:token" element={<Page><Invite /></Page>} />
      <Route path="/legal/:doc" element={<Page><Legal /></Page>} />
      <Route path="/tour" element={<Guard><Page><Tour /></Page></Guard>} />
      <Route element={<Guard><Shell /></Guard>}>
        <Route index element={<Home />} />
        <Route path="tables" element={<Page><Tables /></Page>} />
        <Route path="tables/:id" element={<Page><TableDetail /></Page>} />
        <Route path="payments" element={<Page><Payments /></Page>} />
        <Route path="payments/:id" element={<Page><PaymentDetail /></Page>} />
        <Route path="money" element={<Guard owner><Page><Money /></Page></Guard>} />
        <Route path="money/withdraw" element={<Guard owner><Page><Withdraw /></Page></Guard>} />
        <Route path="money/history" element={<Guard owner><Page><History /></Page></Guard>} />
        <Route path="money/auto" element={<Guard owner><Page><AutoWithdraw /></Page></Guard>} />
        <Route path="money/number" element={<Guard owner><Page><PayoutNumber /></Page></Guard>} />
        <Route path="stats" element={<Guard owner><Page><Stats /></Page></Guard>} />
        <Route path="alerts" element={<Page><Alerts /></Page>} />
        <Route path="more" element={<Page><More /></Page>} />
        <Route path="more/staff" element={<Guard owner><Page><Staff /></Page></Guard>} />
        <Route path="more/settings" element={<Page><Settings /></Page>} />
        <Route path="more/help" element={<Page><Help /></Page>} />
        <Route path="more/support" element={<Page><Support /></Page>} />
        <Route path="more/disputes/:id" element={<Page><Dispute /></Page>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routed />
      </SessionProvider>
    </BrowserRouter>
  );
}
