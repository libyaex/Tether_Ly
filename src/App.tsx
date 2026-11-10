import { lazy, Suspense, useEffect } from "react";
import { RouterProvider, Routes, useNav, type Route } from "./lib/router";
import { AuthProvider, useAuth } from "./lib/auth";
import { SettingsProvider } from "./lib/settings";
import { ToastProvider } from "./lib/toast";
import { configured } from "./lib/supabase";
import { PublicLayout, AppLayout, AdminLayout } from "./components/Layouts";
import { Banner, Button, Card, Skeleton } from "./components/ui";
import { Home, PricesPage, InfoPage, NotFound, NotConfigured } from "./pages/public";
import { Login, Register, ForgotPassword, ResetPassword } from "./pages/auth";
import { Dashboard, Deposit, DepositReturn, Buy, Sell } from "./pages/app1";
import { WalletPage } from "./pages/WalletPage";
import { OrderDetail, Transactions, PayoutMethods, Notifications, SupportList, NewTicket, TicketThread, More, Profile } from "./pages/app2";

// Admin code is a SEPARATE chunk: customers never download it. The route still lives at /admin (gated by
// RequireStaff below), but Vite builds admin1/admin2/admin3 into their own files loaded only on demand.
const AdminDashboard = lazy(() => import("./pages/admin/admin1").then((m) => ({ default: m.AdminDashboard })));
const AdminOrders = lazy(() => import("./pages/admin/admin1").then((m) => ({ default: m.AdminOrders })));
const AdminOrderDetail = lazy(() => import("./pages/admin/admin1").then((m) => ({ default: m.AdminOrderDetail })));
const AdminRates = lazy(() => import("./pages/admin/admin1").then((m) => ({ default: m.AdminRates })));
const AdminUsers = lazy(() => import("./pages/admin/admin2").then((m) => ({ default: m.AdminUsers })));
const AdminUserDetail = lazy(() => import("./pages/admin/admin2").then((m) => ({ default: m.AdminUserDetail })));
const AdminStaff = lazy(() => import("./pages/admin/admin2").then((m) => ({ default: m.AdminStaff })));
const AdminAdjustments = lazy(() => import("./pages/admin/admin2").then((m) => ({ default: m.AdminAdjustments })));
const AdminSupport = lazy(() => import("./pages/admin/admin2").then((m) => ({ default: m.AdminSupport })));
const AdminTicket = lazy(() => import("./pages/admin/admin2").then((m) => ({ default: m.AdminTicket })));
const AdminReports = lazy(() => import("./pages/admin/admin2").then((m) => ({ default: m.AdminReports })));
const AdminAudit = lazy(() => import("./pages/admin/admin2").then((m) => ({ default: m.AdminAudit })));
const AdminHealth = lazy(() => import("./pages/admin/admin2").then((m) => ({ default: m.AdminHealth })));
const AdminSettings = lazy(() => import("./pages/admin/admin3").then((m) => ({ default: m.AdminSettings })));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { loading, session } = useAuth(); const { path, navigate } = useNav();
  useEffect(() => { if (!loading && !session) navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true }); }, [loading, session, path]);
  if (loading) return <div className="page"><Skeleton lines={4} /></div>;
  if (!session) return null;
  return <>{children}</>;
}
function RequireStaff({ perm, children }: { perm?: string; children: React.ReactNode }) {
  const { loading, isStaff, has, profile, signOut } = useAuth();
  const { navigate } = useNav();
  if (loading) return <div className="page"><Skeleton lines={4} /></div>;

  if (!isStaff) {
    return (
      <div className="page" style={{ maxWidth: 520, margin: "2.5rem auto", padding: "1rem" }}>
        <Card title="منطقة الإدارة" sub="مخصصة لموظفي المنصة المعتمدين فقط">
          <Banner tone="warn" icon="shield">
            هذا الحساب لا يملك صلاحيات إدارية. إن كنت موظفًا فسجّل الخروج ثم ادخل بحساب الموظف المعتمد.
          </Banner>
          <div className="row" style={{ marginTop: "1rem", gap: "0.75rem" }}>
            <Button onClick={() => navigate("/app")}>العودة إلى حسابي</Button>
            <Button variant="ghost" onClick={() => void signOut()}>تسجيل الخروج</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (perm && !has(perm)) {
    return (
      <div className="page">
        <Banner tone="warn" icon="shield">
          حسابك الحالي ({profile?.full_name}) لا يملك صلاحية الوصول لهذا القسم ({perm}).
        </Banner>
        <div style={{ marginTop: "1rem" }}>
          <button className="btn" onClick={() => navigate("/admin")}>العودة للوحة الإدارة الرئيسية</button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

const publicRoutes: Route[] = [
  { path: "/", element: <Home /> }, { path: "/prices", element: <PricesPage /> }, { path: "/info/:slug", element: <InfoPage /> },
  { path: "/login", element: <Login /> }, { path: "/register", element: <Register /> }, { path: "/forgot-password", element: <ForgotPassword /> }, { path: "/reset-password", element: <ResetPassword /> },
];
const appRoutes: [string, React.ReactNode][] = [
  ["/app", <Dashboard />],
  ["/wallet", <WalletPage />],
  ["/wallet/deposit", <Deposit />],
  ["/wallet/deposits/:id/return", <DepositReturn />],
  ["/wallet/deposits/:id", <OrderDetail kind="deposit" />],
  ["/buy", <Buy />], ["/sell", <Sell />], ["/orders/:kind/:id", <OrderDetail kind={undefined as any} />],
  ["/transactions", <Transactions />], ["/payout-methods", <PayoutMethods />], ["/notifications", <Notifications />],
  ["/support", <SupportList />], ["/support/new", <NewTicket />], ["/support/:id", <TicketThread />],
  ["/more", <More />], ["/profile", <Profile />],
];
const adminRoutes: [string, React.ReactNode, string | undefined][] = [
  ["/admin", <AdminDashboard />, "reports.read"], ["/admin/orders", <AdminOrders />, "orders.read"],
  ["/admin/orders/buy/:id", <AdminOrderDetail kind="buy" />, "orders.read"], ["/admin/orders/sell/:id", <AdminOrderDetail kind="sell" />, "orders.read"], ["/admin/orders/deposit/:id", <AdminOrderDetail kind="deposit" />, "orders.read"],
  ["/admin/rates", <AdminRates />, "rates.write"], ["/admin/users", <AdminUsers />, "users.read"], ["/admin/users/:id", <AdminUserDetail />, "users.read"],
  ["/admin/staff", <AdminStaff />, "roles.manage"], ["/admin/adjustments", <AdminAdjustments />, "ledger.adjust"],
  ["/admin/support", <AdminSupport />, "support.reply"], ["/admin/support/:id", <AdminTicket />, "support.reply"],
  ["/admin/reports", <AdminReports />, "reports.read"], ["/admin/settings", <AdminSettings />, "settings.read"],
  ["/admin/audit", <AdminAudit />, "audit.read"], ["/admin/health", <AdminHealth />, "settings.read"],
];

function AppRoot() {
  const routes: Route[] = [
    ...publicRoutes,
    ...appRoutes.map(([path, element]) => ({ path, element: <RequireAuth><AppLayout>{element}</AppLayout></RequireAuth> })),
    ...adminRoutes.map(([path, element, perm]) => ({ path, element: <RequireAuth><RequireStaff perm={perm}><AdminLayout><Suspense fallback={<Skeleton lines={5} />}>{element}</Suspense></AdminLayout></RequireStaff></RequireAuth> })),
  ];
  return <Routes routes={routes} fallback={<PublicLayout><NotFound /></PublicLayout>} />;
}
// Public routes render inside PublicLayout; app/admin routes carry their own layout above, so we branch here.
function Shell() {
  const { path } = useNav();
  const isApp = appRoutes.some(([p]) => path === p || (p.includes(":") && path.startsWith(p.split(":")[0])));
  const isAdmin = path === "/admin" || path.startsWith("/admin/");
  if (isApp || isAdmin) return <AppRoot />;
  return <PublicLayout><AppRoot /></PublicLayout>;
}

export default function App() {
  if (!configured) return <NotConfigured />;
  return (
    <RouterProvider>
      <ToastProvider>
        <AuthProvider>
          <SettingsProvider>
            <Shell />
          </SettingsProvider>
        </AuthProvider>
      </ToastProvider>
    </RouterProvider>
  );
}
