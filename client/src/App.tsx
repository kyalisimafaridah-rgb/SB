import { Switch, Route, Redirect } from "wouter";
import { isTokenValid, getUser, clearToken } from "./_core/hooks/useAuth";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import ForgotPassword from "./pages/ForgotPassword";
import Dashboard from "./pages/Dashboard";
import Students from "./pages/Students";
import Fees from "./pages/Fees";
import Defaulters from "./pages/Defaulters";
import FinancialSummary from "./pages/FinancialSummary";
import ExamClearance from "./pages/ExamClearance";
import BulkSMS from "./pages/BulkSMS";
import ParentPortal from "./pages/ParentPortal";
import AdminDashboard from "./pages/AdminDashboard";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound";
import SubscriptionBlocked from "./pages/SubscriptionBlocked";
import { DashboardLayout } from "./components/DashboardLayout";

// Wraps a dashboard page behind the auth check + DashboardLayout shell. This
// previously was hand-rolled separately at each of the 9 routes below — easy
// to update one and forget the rest. `ownerOnly` redirects any non-owner
// straight to /dashboard instead of rendering a page whose every query will
// fail with FORBIDDEN (the server already blocks the data via ownerProcedure
// either way — this is just so the page doesn't look broken). `customerOnly`
// is the mirror image: the owner's account is mechanically a real school too
// (created at registration, same as any customer's), so without this an
// owner could still reach /students, /fees, etc. directly by URL even though
// they're hidden from their nav — a real customer feature with nothing
// behind it for an account that isn't actually running a school.
function ProtectedPage({
  component: Component,
  ownerOnly = false,
  customerOnly = false,
}: {
  component: React.ComponentType;
  ownerOnly?: boolean;
  customerOnly?: boolean;
}) {
  if (!isTokenValid()) {
    return <Redirect to="/login" />;
  }
  // Token and user are two separate localStorage keys with no atomic
  // guarantee they stay in sync (storage quota edge cases, manual
  // tampering, a future bug elsewhere). Treat that inconsistent state as
  // logged-out rather than rendering pages built around a null user object.
  if (!getUser()) {
    clearToken();
    return <Redirect to="/login" />;
  }
  if (ownerOnly && !getUser()?.isOwner) {
    return <Redirect to="/dashboard" />;
  }
  if (customerOnly && getUser()?.isOwner) {
    return <Redirect to="/admin" />;
  }
  // A customer who hasn't finished the 4-step onboarding wizard (school
  // details, first class, fee structure) could previously escape it just by
  // tapping any bottom-tab item — the wizard only ever gated /dashboard
  // itself, and every other page worked normally regardless of the flag.
  // That left schools stuck with zero classes/fee structure and no way back
  // into the wizard. Force them onto /dashboard (where the wizard lives)
  // until it's actually complete.
  const user = getUser();
  if (!ownerOnly && !user?.isOwner && user?.onboarded === false && Component !== Dashboard) {
    return <Redirect to="/dashboard" />;
  }
  return (
    <DashboardLayout>
      <Component />
    </DashboardLayout>
  );
}

function postLoginRedirectPath() {
  return getUser()?.isOwner ? "/admin" : "/dashboard";
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="dark" switchable={false}>
    <Switch>
      {/* Public routes — redirect to dashboard if already logged in */}
      <Route path="/">
        {isTokenValid() ? <Redirect to={postLoginRedirectPath()} /> : <Home />}
      </Route>
      <Route path="/login">
        {isTokenValid() ? <Redirect to={postLoginRedirectPath()} /> : <Login />}
      </Route>
      <Route path="/signup">
        {isTokenValid() ? <Redirect to={postLoginRedirectPath()} /> : <Signup />}
      </Route>
      <Route path="/forgot-password">
        {isTokenValid() ? <Redirect to={postLoginRedirectPath()} /> : <ForgotPassword />}
      </Route>
      <Route path="/portal/:schoolCode" component={ParentPortal} />

      {/* Reached via redirect from main.tsx's handleAuthError when a query/mutation
          fails with TRIAL_EXPIRED / SUBSCRIPTION_EXPIRED / ACCOUNT_SUSPENDED. Not
          wrapped in ProtectedPage: the user's JWT is still perfectly valid (this
          isn't an auth problem), it's their school's subscription status that's
          blocking every subscribedProcedure call — an orthogonal, per-school concern. */}
      <Route path="/subscription-blocked" component={SubscriptionBlocked} />

      {/* Protected routes inside DashboardLayout */}
      <Route path="/dashboard">
        <ProtectedPage component={Dashboard} customerOnly />
      </Route>

      <Route path="/students">
        <ProtectedPage component={Students} customerOnly />
      </Route>

      <Route path="/fees">
        <ProtectedPage component={Fees} customerOnly />
      </Route>

      <Route path="/defaulters">
        <ProtectedPage component={Defaulters} customerOnly />
      </Route>

      <Route path="/financial-summary">
        <ProtectedPage component={FinancialSummary} customerOnly />
      </Route>

      <Route path="/exam-clearance">
        <ProtectedPage component={ExamClearance} customerOnly />
      </Route>

      <Route path="/sms">
        <ProtectedPage component={BulkSMS} customerOnly />
      </Route>

      <Route path="/settings">
        <ProtectedPage component={Settings} />
      </Route>

      <Route path="/admin">
        <ProtectedPage component={AdminDashboard} ownerOnly />
      </Route>

      <Route component={NotFound} />
    </Switch>
    </ThemeProvider>
  );
}
