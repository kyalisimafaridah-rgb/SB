import { useEffect, useState } from "react";
import { useLocation, Redirect } from "wouter";
import { clearToken, getUser } from "../_core/hooks/useAuth";
import { trpc } from "../lib/trpc";
import { Sheet, SheetContent } from "./ui/sheet";
import { OfflineBanner } from "./OfflineBanner";
import { initOfflineSync } from "../lib/offlineSync";
import { SUPPORT_WHATSAPP } from "../lib/const";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import {
  LayoutDashboard, Users, DollarSign, AlertTriangle,
  BarChart3, CheckSquare, MessageSquare, Settings,
  LogOut, ShieldCheck, MoreHorizontal
} from "lucide-react";
import { cn } from "../lib/utils";
import { useIsMobile } from "../hooks/useMobile";
import logoWordmark from "../assets/logo-wordmark.png";
import logoWordmarkLight from "../assets/logo-wordmark-light.png";

interface NavItem {
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
}

// Full nav for the desktop sidebar (unchanged) and the mobile "More" sheet.
const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
  { label: "Students", path: "/students", icon: Users },
  { label: "Fees", path: "/fees", icon: DollarSign },
  { label: "Defaulters", path: "/defaulters", icon: AlertTriangle },
  { label: "Financial Summary", path: "/financial-summary", icon: BarChart3 },
  { label: "Exam Clearance", path: "/exam-clearance", icon: CheckSquare },
  { label: "Bulk SMS", path: "/sms", icon: MessageSquare },
  { label: "Settings", path: "/settings", icon: Settings },
];

// The 4 most frequently-touched screens for day-to-day fee management get a
// direct bottom-tab slot; everything else (periodic/occasional tasks) lives
// behind "More". This is the standard mobile-app pattern for >5 destinations
// (bottom bars stop working well past ~5 items) — not an arbitrary cut, it's
// grounded in which screens are actually opened daily vs occasionally.
const PRIMARY_MOBILE_NAV: NavItem[] = [
  { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
  { label: "Students", path: "/students", icon: Users },
  { label: "Fees", path: "/fees", icon: DollarSign },
  { label: "Defaulters", path: "/defaulters", icon: AlertTriangle },
];

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const user = getUser();
  const isMobile = useIsMobile();
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => { initOfflineSync(); }, []);

  // Computed server-side at sign-in, not from a client env var — anything in
  // import.meta.env ends up readable in the compiled JS bundle.
  const isOwner = !!user?.isOwner;

  const { data: subscription } = trpc.school.getSubscription.useQuery(undefined, {
    refetchInterval: 5 * 60 * 1000,
    retry: false,
    enabled: !isOwner,
  });

  const isBlocked =
    subscription?.status === "expired" ||
    subscription?.status === "suspended";

  const isTrialExpired =
    subscription?.status === "trial" &&
    subscription?.trialEndsAt &&
    new Date() > new Date(subscription.trialEndsAt);

  const trialDays =
    subscription?.status === "trial" && subscription?.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(subscription.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : null;

  function handleLogout() {
    clearToken();
    navigate("/login");
  }

  // One consistent blocked experience: the dedicated page shows pricing
  // tiers + a pre-filled WhatsApp message. Avoid a weaker duplicate UI here.
  if (isBlocked || isTrialExpired) {
    const reason =
      subscription?.status === "suspended"
        ? "account_suspended"
        : subscription?.status === "trial"
          ? "trial_expired"
          : "subscription_expired";
    return <Redirect to={`/subscription-blocked?reason=${reason}`} />;
  }

  const visibleNavItems = isOwner ? NAV_ITEMS.filter((item) => item.label === "Settings") : NAV_ITEMS;
  // On mobile, "More" holds whatever isn't already a primary tab — for the
  // owner that's just Settings (Admin gets its own dedicated tab instead).
  const secondaryMobileNavItems = isOwner
    ? []
    : NAV_ITEMS.filter((item) => !PRIMARY_MOBILE_NAV.some((p) => p.path === item.path));

  // Desktop sidebar content — dark navy chrome (--sidebar tokens), distinct
  // from the light content area. This colored/dark-shell-around-light-content
  // pairing is the main structural cue that this is an app, not a web page.
  const SidebarContent = () => (
    <div className="flex flex-col h-full bg-sidebar text-sidebar-foreground">
      <div className="p-4 border-b border-sidebar-border">
        <img src={logoWordmarkLight} alt="ScholarBase" className="h-7 w-auto" />
        <p className="text-xs text-sidebar-foreground/60 mt-1 truncate">{isOwner ? "Platform Admin" : (user?.schoolName ?? "")}</p>
      </div>

      {trialDays !== null && trialDays <= 10 && (
        <div className="mx-3 mt-3 px-3 py-2 bg-gold-500/15 border border-gold-500/30 rounded-xl">
          <p className="text-xs text-gold-400 font-medium">
            {trialDays === 0
              ? "Trial ends today"
              : `Trial ends in ${trialDays} day${trialDays !== 1 ? "s" : ""}`}
          </p>
          <a
            href={`https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(`Hi, I'd like to activate ScholarBase for ${user?.schoolName ?? "my school"}.`)}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-gold-500 underline"
          >
            Activate on WhatsApp →
          </a>
        </div>
      )}

      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {isOwner && (
          <button
            onClick={() => navigate("/admin")}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors text-left",
              location === "/admin"
                ? "bg-sidebar-accent text-gold-500 font-medium"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            )}
          >
            <ShieldCheck className="h-4 w-4 shrink-0" />
            Admin
          </button>
        )}

        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          const active = location === item.path;
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors text-left",
                active
                  ? "bg-sidebar-accent text-gold-500 font-medium"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="p-3 border-t border-sidebar-border">
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl">
          <div className="w-7 h-7 rounded-full bg-gold-500/20 flex items-center justify-center">
            <span className="text-xs font-medium text-gold-500">
              {user?.name?.charAt(0).toUpperCase() ?? "?"}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-sidebar-foreground truncate">{user?.name}</p>
            <p className="text-xs text-sidebar-foreground/50 truncate capitalize">{user?.schoolRole}</p>
          </div>
          <button
            onClick={handleLogout}
            className="text-sidebar-foreground/50 hover:text-red-400 transition-colors"
            title="Log out"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );

  // Mobile "More" sheet — secondary nav items plus account/logout. Reuses the
  // same dark chrome treatment so it reads as part of the same app shell
  // rather than a different, lighter surface popping up on top of it.
  const MoreSheetContent = () => (
    <div className="flex flex-col h-full bg-sidebar text-sidebar-foreground">
      <div className="p-4 border-b border-sidebar-border flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-gold-500/20 flex items-center justify-center">
          <span className="text-sm font-medium text-gold-500">
            {user?.name?.charAt(0).toUpperCase() ?? "?"}
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-sidebar-foreground truncate">{user?.name}</p>
          <p className="text-xs text-sidebar-foreground/50 truncate">{user?.schoolName}</p>
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {secondaryMobileNavItems.map((item) => {
          const Icon = item.icon;
          const active = location === item.path;
          return (
            <button
              key={item.path}
              onClick={() => { navigate(item.path); setMoreOpen(false); }}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors text-left",
                active
                  ? "bg-sidebar-accent text-gold-500 font-medium"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="p-3 border-t border-sidebar-border">
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-red-400 hover:bg-sidebar-accent transition-colors text-left"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          Log out
        </button>
      </div>
    </div>
  );

  const mobileTabs: (NavItem | { label: string; path: null; icon: typeof MoreHorizontal })[] = isOwner
    ? [{ label: "Admin", path: "/admin", icon: ShieldCheck }, { label: "Settings", path: "/settings", icon: Settings }]
    : [...PRIMARY_MOBILE_NAV, { label: "More", path: null, icon: MoreHorizontal }];

  return (
    <div className="flex h-screen bg-background">
      {!isMobile && (
        <aside className="w-60 border-r border-sidebar-border flex flex-col shrink-0">
          <SidebarContent />
        </aside>
      )}

      <div className="flex flex-col flex-1 min-w-0">
        {isMobile && (
          <div
            className="sticky top-0 z-10 bg-sidebar text-sidebar-foreground px-4 py-3 flex items-center justify-between shrink-0"
            style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}
          >
            <img src={logoWordmark} alt="ScholarBase" className="h-5 w-auto brightness-0 invert" />
            {/* Tappable everywhere, including for the owner — whose bottom
                tabs (Admin/Settings) don't include a "More" sheet, so this
                is otherwise their only one-tap logout path on mobile. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="w-7 h-7 rounded-full bg-gold-500/20 flex items-center justify-center">
                  <span className="text-xs font-medium text-gold-500">
                    {user?.name?.charAt(0).toUpperCase() ?? "?"}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="text-sm font-medium truncate">{user?.name}</p>
                  <p className="text-xs text-muted-foreground font-normal truncate">
                    {isOwner ? "Platform Admin" : user?.schoolName}
                  </p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate("/settings")}>
                  <Settings className="h-4 w-4 mr-2" /> Settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleLogout} className="text-red-500 focus:text-red-600">
                  <LogOut className="h-4 w-4 mr-2" /> Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {/* Bottom padding on mobile keeps content clear of the fixed tab bar below */}
        <OfflineBanner />
        <main className={cn("flex-1 overflow-y-auto", isMobile && "pb-16")}>
          {children}
        </main>

        {/* Bottom tab bar — the primary "this is an app" structural signal.
            Fixed, dark navy chrome, gold active-state indicator, safe-area
            aware for notched phones. */}
        {isMobile && (
          <nav
            className="fixed bottom-0 left-0 right-0 z-20 bg-sidebar border-t border-sidebar-border flex items-stretch"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          >
            {mobileTabs.map((tab) => {
              const Icon = tab.icon;
              const active = tab.path !== null && location === tab.path;
              return (
                <button
                  key={tab.label}
                  onClick={() => (tab.path ? navigate(tab.path) : setMoreOpen(true))}
                  className={cn(
                    "flex-1 flex flex-col items-center justify-center gap-0.5 py-2 text-[10px] transition-colors",
                    active ? "text-gold-500" : "text-sidebar-foreground/60"
                  )}
                >
                  <Icon className="h-5 w-5" />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        )}

        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetContent side="right" className="p-0 w-64 border-none">
            <MoreSheetContent />
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
