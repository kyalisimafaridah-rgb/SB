import { useState } from "react";
import { trpc } from "../lib/trpc";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../components/ui/chart";
import { Bar, BarChart, XAxis, YAxis, CartesianGrid } from "recharts";
import { toast } from "sonner";
import { getUser } from "../_core/hooks/useAuth";
import { MessageCircle, Search, StickyNote, Download, History, Plus, Phone, AlertTriangle } from "lucide-react";
import { downloadCsv } from "../lib/csv";
import { isValidUgandaPhone } from "../../../shared/phone";
import {
  TIER_AMOUNTS,
  TIER_LABELS as _TIER_LABELS,
  TIER_STUDENT_RANGES,
  formatUgx,
  recommendTier,
} from "../../../shared/pricing";

// Bug 24: same fix as Defaulters — WhatsApp requires international format
function toIntlPhone(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("256")) return digits;
  if (digits.startsWith("0")) return "256" + digits.slice(1);
  if (digits.length === 9) return "256" + digits;
  return digits;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  trial: "bg-blue-100 text-blue-700",
  expired: "bg-red-100 text-red-700",
  suspended: "bg-gray-100 text-gray-600",
  free: "bg-gray-100 text-gray-500",
};

const TIER_LABELS: Record<string, string> = {
  small: `${_TIER_LABELS.small} (≤200)`,
  medium: `${_TIER_LABELS.medium} (201-500)`,
  large: `${_TIER_LABELS.large} (500+)`,
};

function formatLastActive(lastLoginAt: string | Date | null | undefined): string {
  if (!lastLoginAt) return "Never logged in";
  const diffMs = Date.now() - new Date(lastLoginAt).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return "Active today";
  if (days === 1) return "Active yesterday";
  return `Active ${days} days ago`;
}

export default function AdminDashboard() {
  const user = getUser();
  const [showPayment, setShowPayment] = useState(false);
  const [selectedSchoolId, setSelectedSchoolId] = useState<number | null>(null);
  const currentYear = new Date().getFullYear();
  // This is a cross-school owner view, not one school's own term — there's no
  // single "current term" to resolve without first picking which school's
  // calendar applies, so this stays a guess (just a payment-form default,
  // always visible and editable, not something that silently drives a real
  // action the way it did in Settings' fee generation). Only fixed to use
  // the correct 0-indexed month boundaries — getMonth() is 0-11, and this
  // previously compared it against the same cutoffs (<=3, <=7) written for
  // the 1-indexed month the server used, so the two never actually agreed
  // with each other on which calendar month started which term.
  const currentMonth = new Date().getMonth();
  const defaultTerm = currentMonth <= 2 ? 1 : currentMonth <= 6 ? 2 : 3;

  const [payForm, setPayForm] = useState({
    amount: "",
    term: String(defaultTerm),
    year: String(currentYear),
    method: "mtnMomo",
    reference: "",
    notes: "",
    endsAt: "",
  });

  const [search, setSearch] = useState("");
  // Status filter tabs — search alone doesn't scale once there are hundreds
  // or thousands of schools; you also need to triage by status at a glance
  // (e.g. jump straight to everyone expired, without typing anything).
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "trial" | "expiredOrSuspended" | "free">("all");
  const [notesEdit, setNotesEdit] = useState<{ schoolId: number; schoolName: string; notes: string } | null>(null);
  const [historySchool, setHistorySchool] = useState<{ schoolId: number; schoolName: string } | null>(null);
  const [showAddSchool, setShowAddSchool] = useState(false);
  const [addSchoolForm, setAddSchoolForm] = useState({
    schoolName: "", district: "", schoolType: "", contactPhone: "",
    headTeacherName: "", email: "", password: "",
  });
  const [contactEdit, setContactEdit] = useState<{ schoolId: number; schoolName: string; contactPhone: string } | null>(null);
  const [voidingPayment, setVoidingPayment] = useState<{ id: number; amount: string } | null>(null);
  const [voidReason, setVoidReason] = useState("");

  // Bugs 20, 24: pending action for confirm dialogs (suspend / activate)
  const [confirmAction, setConfirmAction] = useState<{
    schoolId: number;
    schoolName: string;
    type: "suspend" | "activate";
  } | null>(null);

  const { data: schools = [], refetch } = trpc.admin.getAllSchools.useQuery();
  const { data: revenue } = trpc.admin.getRevenue.useQuery();
  const { data: expiring = [] } = trpc.admin.getExpiringSchools.useQuery({ daysAhead: 7 });
  const { data: revenueTrend = [] } = trpc.admin.getRevenueTrend.useQuery({ months: 6 });
  const { data: paymentHistory = [], isLoading: historyLoading, refetch: refetchHistory } = trpc.admin.getPaymentHistory.useQuery(
    { schoolId: historySchool?.schoolId ?? -1 },
    { enabled: !!historySchool }
  );
  const { data: stuckOnboarding = [] } = trpc.admin.getStuckOnboarding.useQuery();
  const { data: phoneIssues = [] } = trpc.admin.getContactPhoneIssues.useQuery();
  const { data: smsHealth = [] } = trpc.admin.getSmsHealth.useQuery();
  const { data: pendingRenewals = [], refetch: refetchPending } = trpc.admin.getPendingRenewals.useQuery(undefined, {
    refetchInterval: 60_000,
  });

  const updateStatusMutation = trpc.admin.updateSubscription.useMutation({
    onSuccess: () => { toast.success("Subscription updated"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const recordPaymentMutation = trpc.admin.recordPayment.useMutation({
    onSuccess: () => { toast.success("Payment recorded, subscription activated"); setShowPayment(false); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const updateTierMutation = trpc.admin.updateTier.useMutation({
    onSuccess: () => { toast.success("Tier updated"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const confirmRenewalMutation = trpc.admin.confirmRenewal.useMutation({
    onSuccess: () => {
      toast.success("Renewal confirmed — school activated");
      refetchPending();
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateNotesMutation = trpc.admin.updateNotes.useMutation({
    onSuccess: () => { toast.success("Notes saved"); setNotesEdit(null); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const createSchoolMutation = trpc.admin.createSchool.useMutation({
    onSuccess: (result) => {
      toast.success(`${addSchoolForm.schoolName} created — school code ${result.schoolCode}`);
      setShowAddSchool(false);
      setAddSchoolForm({ schoolName: "", district: "", schoolType: "", contactPhone: "", headTeacherName: "", email: "", password: "" });
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateContactMutation = trpc.admin.updateSchoolContact.useMutation({
    onSuccess: () => { toast.success("Contact phone updated"); setContactEdit(null); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const voidPaymentMutation = trpc.admin.voidPayment.useMutation({
    onSuccess: () => {
      toast.success("Payment voided");
      setVoidingPayment(null);
      setVoidReason("");
      refetchHistory();
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  // Only render for owner
  if (!user) return null;

  const activeCount = schools.filter(s => s.subscription?.status === "active").length;
  const trialCount = schools.filter(s => s.subscription?.status === "trial").length;
  const expiredCount = schools.filter(s => s.subscription?.status === "expired" || s.subscription?.status === "suspended").length;
  const freeCount = schools.length - activeCount - trialCount - expiredCount;

  // Tier mix and the recurring revenue it represents — distinct from
  // `revenue` above (which is what's already been paid, historically).
  // This is forward-looking capacity: what active subscriptions commit to
  // collecting next cycle, the number that actually matters when deciding
  // whether the business can support the next 100 schools.
  const tierCounts = { small: 0, medium: 0, large: 0, none: 0 };
  let projectedMrr = 0;
  for (const s of schools) {
    if (s.subscription?.status !== "active") continue;
    const tier = s.subscription?.tier;
    if (tier === "small" || tier === "medium" || tier === "large") {
      tierCounts[tier]++;
      projectedMrr += TIER_AMOUNTS[tier];
    } else {
      tierCounts.none++;
    }
  }

  const visibleSchools = schools
    .filter((s) => {
      if (statusFilter === "all") return true;
      const status = s.subscription?.status ?? "free";
      if (statusFilter === "expiredOrSuspended") return status === "expired" || status === "suspended";
      if (statusFilter === "free") return !s.subscription || status === "free";
      return status === statusFilter;
    })
    .filter((s) =>
      search.trim()
        ? s.name.toLowerCase().includes(search.toLowerCase()) ||
          s.district?.toLowerCase().includes(search.toLowerCase()) ||
          s.schoolCode.toLowerCase().includes(search.toLowerCase())
        : true
    );

  function exportSchoolsCsv() {
    downloadCsv(
      `scholarbase-schools-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Name", "District", "Code", "Status", "Tier", "Contact Phone", "Head Teacher Email", "Trial Ends", "Subscription Ends", "Notes"],
      visibleSchools.map((s) => [
        s.name,
        s.district ?? "",
        s.schoolCode,
        s.subscription?.status ?? "free",
        s.subscription?.tier ?? "",
        s.contactPhone ?? "",
        s.headTeacher?.email ?? "",
        s.subscription?.trialEndsAt ? new Date(s.subscription.trialEndsAt).toLocaleDateString() : "",
        s.subscription?.subscriptionEndsAt ? new Date(s.subscription.subscriptionEndsAt).toLocaleDateString() : "",
        s.subscription?.notes ?? "",
      ])
    );
  }

  function openPaymentDialog(school: (typeof schools)[number]) {
    setSelectedSchoolId(school.id);
    // Pre-fill from the school's tier if one is set, instead of a flat
    // hardcoded number that didn't match any real price — previously this
    // was always "90000" regardless of which school or tier, a number that
    // doesn't correspond to any of the three actual prices.
    const tier = school.subscription?.tier;
    setPayForm((f) => ({ ...f, amount: tier ? String(TIER_AMOUNTS[tier]) : "" }));
    setShowPayment(true);
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Admin Dashboard</h1>

      {/* Revenue overview */}
      {revenue && (
        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          <Card className="min-w-0">
            <CardContent className="p-3 sm:p-4 text-center">
              <p className="text-lg sm:text-2xl font-bold text-green-600 break-words">{revenue.thisMonth.toLocaleString()}</p>
              <p className="text-xs text-gray-500">This Month (UGX)</p>
            </CardContent>
          </Card>
          <Card className="min-w-0">
            <CardContent className="p-3 sm:p-4 text-center">
              <p className="text-lg sm:text-2xl font-bold text-gray-700 break-words">{revenue.lastMonth.toLocaleString()}</p>
              <p className="text-xs text-gray-500">Last Month (UGX)</p>
            </CardContent>
          </Card>
          <Card className="min-w-0">
            <CardContent className="p-3 sm:p-4 text-center">
              <p className="text-lg sm:text-2xl font-bold text-indigo-600 break-words">{schools.length}</p>
              <p className="text-xs text-gray-500">Total Schools</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* School status summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="min-w-0 bg-green-50 rounded-lg p-3 text-center">
          <p className="text-lg sm:text-xl font-bold text-green-700 break-words">{activeCount}</p>
          <p className="text-xs text-green-600">Active</p>
        </div>
        <div className="min-w-0 bg-blue-50 rounded-lg p-3 text-center">
          <p className="text-lg sm:text-xl font-bold text-blue-700 break-words">{trialCount}</p>
          <p className="text-xs text-blue-600">On Trial</p>
        </div>
        <div className="min-w-0 bg-red-50 rounded-lg p-3 text-center">
          <p className="text-lg sm:text-xl font-bold text-red-700 break-words">{expiredCount}</p>
          <p className="text-xs text-red-600">Expired/Suspended</p>
        </div>
      </div>

      {/* Projected MRR & tier mix — forward-looking, not historical. This is
          what active subscriptions commit to next cycle, which is the number
          that actually tells you whether the business can support the next
          100 schools, not just what's already landed in the bank. */}
      <Card>
        <CardHeader><CardTitle className="text-base">Projected Monthly Recurring Revenue</CardTitle></CardHeader>
        <CardContent>
          <p className="text-xl sm:text-2xl font-bold text-indigo-700 break-words">{projectedMrr.toLocaleString()} UGX</p>
          <p className="text-xs text-gray-400 mb-3">From {activeCount} active subscription{activeCount === 1 ? "" : "s"}, by tier next cycle</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
            <div className="min-w-0 bg-gray-50 rounded-lg p-2">
              <p className="text-sm font-semibold break-words">{tierCounts.small}</p>
              <p className="text-[10px] text-gray-500">Small</p>
            </div>
            <div className="min-w-0 bg-gray-50 rounded-lg p-2">
              <p className="text-sm font-semibold break-words">{tierCounts.medium}</p>
              <p className="text-[10px] text-gray-500">Medium</p>
            </div>
            <div className="min-w-0 bg-gray-50 rounded-lg p-2">
              <p className="text-sm font-semibold break-words">{tierCounts.large}</p>
              <p className="text-[10px] text-gray-500">Large</p>
            </div>
            <div className="min-w-0 bg-amber-50 rounded-lg p-2">
              <p className="text-sm font-semibold text-amber-700 break-words">{tierCounts.none}</p>
              <p className="text-[10px] text-amber-600">No tier set</p>
            </div>
          </div>
          {tierCounts.none > 0 && (
            <p className="text-xs text-amber-600 mt-2">
              {tierCounts.none} active school{tierCounts.none === 1 ? "" : "s"} without a tier — their revenue isn't counted above until you set one.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Revenue trend — two static totals (this month / last month) can't
          show whether the business is actually growing; a trend line can. */}
      <Card>
        <CardHeader><CardTitle className="text-base">Revenue, Last 6 Months</CardTitle></CardHeader>
        <CardContent>
          {revenueTrend.every((m) => m.total === 0) ? (
            <p className="text-sm text-gray-400 py-4 text-center">No payments recorded yet.</p>
          ) : (
            <ChartContainer
              config={{ total: { label: "Revenue (UGX)", color: "hsl(243 75% 59%)" } }}
              className="aspect-auto h-[200px] w-full"
            >
              <BarChart data={revenueTrend} margin={{ left: 0, right: 8, top: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="month"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(v: string) => new Date(`${v}-01`).toLocaleDateString(undefined, { month: "short" })}
                />
                <YAxis tickLine={false} axisLine={false} tickMargin={4} width={44} tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
                <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
                <Bar dataKey="total" fill="var(--color-total)" radius={4} />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {/* Needs Attention — operational health signals that don't show up
          anywhere in the subscription/revenue numbers above: a school stuck
          mid-signup, a contact phone that will silently fail to receive a
          password-reset code, or a school whose parent SMS are mostly
          bouncing. All three previously had zero visibility — you'd only
          find out from the school complaining. */}
      {(stuckOnboarding.length > 0 || phoneIssues.length > 0 || smsHealth.length > 0) && (
        <Card className="border-amber-200">
          <CardHeader>
            <CardTitle className="text-base text-amber-700 flex items-center gap-1.5">
              <AlertTriangle className="h-4 w-4" /> Needs Attention
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 divide-y">
            {stuckOnboarding.map((s) => (
              <div key={`onboard-${s.school.id}`} className="px-4 py-3 flex justify-between items-center gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{s.school.name}</p>
                  <p className="text-xs text-gray-400">
                    Registered {new Date(s.school.createdAt).toLocaleDateString()} — never finished onboarding
                    {s.headTeacher?.email ? ` · ${s.headTeacher.email}` : ""}
                  </p>
                </div>
              </div>
            ))}
            {phoneIssues.map((s) => (
              <div key={`phone-${s.id}`} className="px-4 py-3 flex justify-between items-center gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{s.name}</p>
                  <p className="text-xs text-red-500">
                    Invalid contact phone{s.contactPhone ? `: "${s.contactPhone}"` : " (none on file)"} — password-reset codes can't reach them
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-xs h-7 shrink-0"
                  onClick={() => setContactEdit({ schoolId: s.id, schoolName: s.name, contactPhone: s.contactPhone ?? "" })}
                >
                  Fix
                </Button>
              </div>
            ))}
            {smsHealth.map((s) => (
              <div key={`sms-${s.schoolId}`} className="px-4 py-3">
                <p className="text-sm font-medium">{s.schoolName}</p>
                <p className="text-xs text-amber-600">
                  {s.failureRate}% of {s.recipients} SMS failed in the last 30 days — likely bad numbers on file for several parents
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Pending school-submitted renewals */}
      {pendingRenewals.length > 0 && (
        <Card className="border-indigo-200 bg-indigo-50/40">
          <CardHeader>
            <CardTitle className="text-base text-indigo-800">
              Pending renewal requests ({pendingRenewals.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingRenewals.map((r) => {
              const ends = new Date();
              ends.setDate(ends.getDate() + 120); // ~1 term default
              const endsIso = ends.toISOString().slice(0, 10);
              return (
                <div key={r.id} className="rounded-lg border bg-white p-3 flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium truncate">{r.schoolName}</p>
                    <p className="text-xs text-gray-500">
                      {Number(r.amount).toLocaleString()} UGX · {r.paymentMethod}
                      {r.referenceNumber ? ` · Ref ${r.referenceNumber}` : ""}
                    </p>
                    {r.notes && <p className="text-xs text-gray-400 mt-0.5 truncate">{r.notes}</p>}
                  </div>
                  <Button
                    size="sm"
                    className="bg-indigo-600 hover:bg-indigo-700 shrink-0"
                    disabled={confirmRenewalMutation.isPending}
                    onClick={() =>
                      confirmRenewalMutation.mutate({
                        paymentId: r.id,
                        subscriptionEndsAt: new Date(endsIso).toISOString(),
                      })
                    }
                  >
                    Confirm & activate (~term)
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Expiring soon */}
      {expiring.length > 0 && (
        <Card className="border-amber-200">
          <CardHeader><CardTitle className="text-base text-amber-700">⚠ Expiring in 7 Days</CardTitle></CardHeader>
          <CardContent className="p-0">
            {expiring.map((e) => (
              <div key={e.subscription.schoolId} className="px-4 py-3 border-b last:border-0 flex justify-between items-center">
                <div>
                  <p className="font-medium text-sm">{e.school?.name}</p>
                  <p className="text-xs text-gray-400">
                    Expires: {e.subscription.subscriptionEndsAt ? new Date(e.subscription.subscriptionEndsAt).toLocaleDateString() : "—"}
                  </p>
                </div>
                {e.school?.contactPhone && (
                  <a
                    href={`https://wa.me/${toIntlPhone(e.school?.contactPhone)}?text=Hi, your ScholarBase subscription expires soon. Please renew to continue.`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-green-600 underline"
                  >
                    WhatsApp
                  </a>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* All schools */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">All Schools ({visibleSchools.length})</CardTitle>
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={exportSchoolsCsv} disabled={visibleSchools.length === 0}>
                <Download className="h-3.5 w-3.5 mr-1" /> Export CSV
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={() => setShowAddSchool(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add School
              </Button>
            </div>
          </div>
          <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)} className="mt-2">
            <TabsList className="h-8 w-full sm:w-auto overflow-x-auto justify-start">
              <TabsTrigger value="all" className="text-xs h-6 px-2.5 shrink-0">All ({schools.length})</TabsTrigger>
              <TabsTrigger value="active" className="text-xs h-6 px-2.5 shrink-0">Active ({activeCount})</TabsTrigger>
              <TabsTrigger value="trial" className="text-xs h-6 px-2.5 shrink-0">Trial ({trialCount})</TabsTrigger>
              <TabsTrigger value="expiredOrSuspended" className="text-xs h-6 px-2.5 shrink-0">Expired ({expiredCount})</TabsTrigger>
              <TabsTrigger value="free" className="text-xs h-6 px-2.5 shrink-0">Free ({freeCount})</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative mt-2">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
            <Input
              placeholder="Search by name, district, or code..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
            />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {schools.length === 0 ? (
            <p className="text-center py-8 text-gray-400 text-sm">No schools registered yet.</p>
          ) : visibleSchools.length === 0 ? (
            <p className="text-center py-8 text-gray-400 text-sm">No schools match this filter{search.trim() ? ` and "${search}"` : ""}.</p>
          ) : (
            <div className="divide-y">
              {visibleSchools.map((school) => {
                const status = school.subscription?.status ?? "free";
                const tier = school.subscription?.tier ?? null;
                const hasNotes = !!school.subscription?.notes;
                return (
                  <div key={school.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm truncate">{school.name}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[status]}`}>
                          {status}
                        </span>
                        {school.contactPhone && (
                          <a
                            href={`https://wa.me/${toIntlPhone(school.contactPhone)}`}
                            target="_blank"
                            rel="noreferrer"
                            title="WhatsApp this school"
                            className="text-green-600"
                          >
                            <MessageCircle className="h-3.5 w-3.5" />
                          </a>
                        )}
                        <button
                          onClick={() => setNotesEdit({ schoolId: school.id, schoolName: school.name, notes: school.subscription?.notes ?? "" })}
                          title={hasNotes ? "View/edit notes" : "Add a note"}
                          className={hasNotes ? "text-amber-500" : "text-gray-300 hover:text-gray-500"}
                        >
                          <StickyNote className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setHistorySchool({ schoolId: school.id, schoolName: school.name })}
                          title="Payment history"
                          className="text-gray-300 hover:text-gray-500"
                        >
                          <History className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setContactEdit({ schoolId: school.id, schoolName: school.name, contactPhone: school.contactPhone ?? "" })}
                          title="Fix contact phone — where password-reset codes go"
                          className="text-gray-300 hover:text-gray-500"
                        >
                          <Phone className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="text-xs text-gray-400">
                        {school.district} · Code: {school.schoolCode}
                        <SchoolStudentCount schoolId={school.id} />
                        {typeof school.activeStudentCount === "number" && school.activeStudentCount >= 0 && (
                          <span className="text-xs text-indigo-600">
                            {" "}· {school.activeStudentCount} students · Suggested: {recommendTier(school.activeStudentCount)}
                          </span>
                        )}
                      </p>
                      {school.headTeacher?.email && (
                        <p className="text-xs text-gray-400 truncate">{school.headTeacher.email}</p>
                      )}
                      {school.onboarded && (
                        <p className="text-xs text-gray-400">{formatLastActive(school.headTeacher?.lastLoginAt)}</p>
                      )}
                      {school.subscription?.trialEndsAt && status === "trial" && (
                        <p className="text-xs text-blue-400">
                          Trial ends: {new Date(school.subscription.trialEndsAt).toLocaleDateString()}
                        </p>
                      )}
                      {school.subscription?.subscriptionEndsAt && status === "active" && (
                        <p className="text-xs text-gray-400">
                          Expires: {new Date(school.subscription.subscriptionEndsAt).toLocaleDateString()}
                        </p>
                      )}
                      <div className="mt-1">
                        <Select
                          value={tier ?? "__none"}
                          onValueChange={(v) => updateTierMutation.mutate({ schoolId: school.id, tier: v === "__none" ? null : v as "small" | "medium" | "large" })}
                        >
                          <SelectTrigger className="h-6 text-xs w-auto gap-1 border-none bg-gray-50 px-2">
                            <SelectValue placeholder="Set tier..." />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none">No tier set</SelectItem>
                            <SelectItem value="small">{TIER_LABELS.small} — 50,000 UGX</SelectItem>
                            <SelectItem value="medium">{TIER_LABELS.medium} — 75,000 UGX</SelectItem>
                            <SelectItem value="large">{TIER_LABELS.large} — 120,000 UGX</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0 sm:w-auto">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs h-7 flex-1 sm:flex-none"
                        onClick={() => openPaymentDialog(school)}
                      >
                        Record Payment
                      </Button>
                      {status !== "suspended" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 flex-1 sm:flex-none text-red-500 border-red-200"
                          onClick={() => setConfirmAction({ schoolId: school.id, schoolName: school.name, type: "suspend" })}
                        >
                          Suspend
                        </Button>
                      ) : (
                        // Bug 20: Activate without a payment keeps the stale (past) subscriptionEndsAt,
                        // causing the nightly job to immediately re-expire them.
                        // The correct flow is always Record Payment which sets a new end date.
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 flex-1 sm:flex-none text-green-600 border-green-200"
                          title="Record a payment to reactivate — this sets a new subscription end date"
                          onClick={() => openPaymentDialog(school)}
                        >
                          Record Payment
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Record Payment Dialog */}
      <Dialog open={showPayment} onOpenChange={setShowPayment}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record Subscription Payment</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Amount (UGX)</Label>
                <Input type="number" min="1" step="1" value={payForm.amount} onChange={(e) => setPayForm(f => ({ ...f, amount: e.target.value }))} />
              </div>
              <div>
                <Label>Method</Label>
                <Select defaultValue="mtnMomo" onValueChange={(v) => setPayForm(f => ({ ...f, method: v }))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mtnMomo">MTN MoMo</SelectItem>
                    <SelectItem value="airtelMoney">Airtel Money</SelectItem>
                    <SelectItem value="bankTransfer">Bank Transfer</SelectItem>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Term</Label>
                <Select defaultValue={String(defaultTerm)} onValueChange={(v) => setPayForm(f => ({ ...f, term: v }))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Term 1</SelectItem>
                    <SelectItem value="2">Term 2</SelectItem>
                    <SelectItem value="3">Term 3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Year</Label>
                <Input type="number" value={payForm.year} onChange={(e) => setPayForm(f => ({ ...f, year: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label>Subscription Active Until *</Label>
              <Input type="date" value={payForm.endsAt} onChange={(e) => setPayForm(f => ({ ...f, endsAt: e.target.value }))} />
            </div>
            <div>
              <Label>Reference Number</Label>
              <Input placeholder="MoMo transaction ID..." value={payForm.reference} onChange={(e) => setPayForm(f => ({ ...f, reference: e.target.value }))} />
            </div>
            <div>
              <Label>Notes</Label>
              <Input placeholder="Optional" value={payForm.notes} onChange={(e) => setPayForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowPayment(false)}>Cancel</Button>
            <Button
              className="flex-1"
              disabled={!payForm.endsAt || !payForm.amount || recordPaymentMutation.isPending}
              onClick={() => selectedSchoolId && recordPaymentMutation.mutate({
                schoolId: selectedSchoolId,
                amount: Number(payForm.amount),
                term: Number(payForm.term),
                year: Number(payForm.year),
                paymentMethod: payForm.method as "mtnMomo" | "airtelMoney" | "bankTransfer" | "cash" | "manual",
                referenceNumber: payForm.reference || undefined,
                notes: payForm.notes || undefined,
                subscriptionEndsAt: payForm.endsAt,
              })}
            >
              {recordPaymentMutation.isPending ? "Recording..." : "Record & Activate"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Bug 24: Confirm suspend action */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend {confirmAction?.schoolName}?</AlertDialogTitle>
            <AlertDialogDescription>
              All users at this school will be immediately locked out. You can reactivate by recording a payment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmAction(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (!confirmAction) return;
                updateStatusMutation.mutate({ schoolId: confirmAction.schoolId, status: "suspended" });
                setConfirmAction(null);
              }}
            >
              Suspend
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Notes — the field already existed in the database, nothing ever showed it */}
      <Dialog open={!!notesEdit} onOpenChange={(open) => !open && setNotesEdit(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Notes — {notesEdit?.schoolName}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <textarea
              className="w-full min-h-[120px] rounded-md border p-3 text-sm"
              placeholder="e.g. Promised payment by Friday, asked for a 3-day extension..."
              value={notesEdit?.notes ?? ""}
              onChange={(e) => setNotesEdit((n) => n ? { ...n, notes: e.target.value } : n)}
              maxLength={2000}
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setNotesEdit(null)}>Cancel</Button>
            <Button
              className="flex-1"
              disabled={updateNotesMutation.isPending}
              onClick={() => notesEdit && updateNotesMutation.mutate({ schoolId: notesEdit.schoolId, notes: notesEdit.notes })}
            >
              {updateNotesMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Payment history — subscriptionPayments was written to and aggregated
          into totals, but there was no way to see the individual payments
          behind those totals for any one school. */}
      <Dialog open={!!historySchool} onOpenChange={(open) => !open && setHistorySchool(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Payment History — {historySchool?.schoolName}</DialogTitle></DialogHeader>
          {historyLoading ? (
            <p className="text-sm text-gray-400 text-center py-6">Loading...</p>
          ) : paymentHistory.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">No payments recorded for this school yet.</p>
          ) : (
            <div className="divide-y">
              {paymentHistory.map((p) => (
                <div key={p.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-sm font-medium ${p.isVoided ? "line-through text-gray-400" : ""}`}>
                      {Number(p.amount).toLocaleString()} UGX
                    </p>
                    <p className="text-xs text-gray-400">
                      Term {p.term}, {p.year} · {p.paymentMethod} {p.referenceNumber ? `· Ref: ${p.referenceNumber}` : ""}
                    </p>
                    {p.notes && <p className="text-xs text-gray-500 mt-0.5 truncate">{p.notes}</p>}
                    {p.isVoided && (
                      <p className="text-xs text-red-500 mt-0.5">Voided{p.voidReason ? `: ${p.voidReason}` : ""}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-gray-400">{new Date(p.paidAt).toLocaleDateString()}</p>
                    {!p.isVoided && (
                      <button
                        onClick={() => setVoidingPayment({ id: p.id, amount: Number(p.amount).toLocaleString() })}
                        className="text-xs text-red-500 hover:underline mt-0.5"
                      >
                        Void
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Void a mistaken subscription payment — corrects revenue totals and
          the trend chart going forward without deleting the audit trail. */}
      <Dialog open={!!voidingPayment} onOpenChange={(open) => !open && setVoidingPayment(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Void Payment — {voidingPayment?.amount} UGX</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Reason (required)</Label>
              <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder="e.g. Wrong amount entered" />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setVoidingPayment(null)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={!voidReason.trim() || voidPaymentMutation.isPending}
                onClick={() => voidingPayment && voidPaymentMutation.mutate({ paymentId: voidingPayment.id, reason: voidReason })}
              >
                {voidPaymentMutation.isPending ? "Voiding..." : "Void Payment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Manually onboard a school (e.g. closing a deal on a call) instead of
          walking them through public self-registration. */}
      <Dialog open={showAddSchool} onOpenChange={setShowAddSchool}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Add a School</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>School Name</Label>
              <Input value={addSchoolForm.schoolName} onChange={(e) => setAddSchoolForm((f) => ({ ...f, schoolName: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>District</Label>
                <Input value={addSchoolForm.district} onChange={(e) => setAddSchoolForm((f) => ({ ...f, district: e.target.value }))} />
              </div>
              <div>
                <Label>Contact Phone *</Label>
                <Input value={addSchoolForm.contactPhone} onChange={(e) => setAddSchoolForm((f) => ({ ...f, contactPhone: e.target.value }))} placeholder="07XXXXXXXX" />
                {addSchoolForm.contactPhone && !isValidUgandaPhone(addSchoolForm.contactPhone) && (
                  <p className="text-xs text-red-500 mt-1">Not a valid Uganda number</p>
                )}
              </div>
            </div>
            <div>
              <Label>Head Teacher Name</Label>
              <Input value={addSchoolForm.headTeacherName} onChange={(e) => setAddSchoolForm((f) => ({ ...f, headTeacherName: e.target.value }))} />
            </div>
            <div>
              <Label>Login Email</Label>
              <Input type="email" value={addSchoolForm.email} onChange={(e) => setAddSchoolForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div>
              <Label>Temporary Password</Label>
              <Input type="text" value={addSchoolForm.password} onChange={(e) => setAddSchoolForm((f) => ({ ...f, password: e.target.value }))} placeholder="At least 8 characters — share this with them directly" />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setShowAddSchool(false)}>Cancel</Button>
              <Button
                disabled={
                  createSchoolMutation.isPending ||
                  !addSchoolForm.schoolName || !addSchoolForm.headTeacherName ||
                  !addSchoolForm.email || addSchoolForm.password.length < 8 ||
                  !isValidUgandaPhone(addSchoolForm.contactPhone)
                }
                onClick={() => createSchoolMutation.mutate(addSchoolForm)}
              >
                {createSchoolMutation.isPending ? "Creating..." : "Create School"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Fix a wrong contact phone — this is where password-reset OTPs go,
          so a wrong number here was previously an unrecoverable lockout. */}
      <Dialog open={!!contactEdit} onOpenChange={(open) => !open && setContactEdit(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Contact Phone — {contactEdit?.schoolName}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Contact Phone</Label>
              <Input
                value={contactEdit?.contactPhone ?? ""}
                onChange={(e) => setContactEdit((c) => c && { ...c, contactPhone: e.target.value })}
                placeholder="07XXXXXXXX"
              />
              <p className="text-xs text-gray-400 mt-1">Password-reset codes and renewal reminders go to this number.</p>
              {contactEdit?.contactPhone && !isValidUgandaPhone(contactEdit.contactPhone) && (
                <p className="text-xs text-red-500 mt-1">Not a valid Uganda number</p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setContactEdit(null)}>Cancel</Button>
              <Button
                disabled={updateContactMutation.isPending || !contactEdit?.contactPhone.trim() || !isValidUgandaPhone(contactEdit?.contactPhone ?? "")}
                onClick={() => contactEdit && updateContactMutation.mutate({ schoolId: contactEdit.schoolId, contactPhone: contactEdit.contactPhone })}
              >
                {updateContactMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// One query per row, in its own component, so each row's hook call is independent —
// admin.getAllSchools doesn't include a per-school student count, and this was the
// procedure built for that but never actually called from anywhere.
function SchoolStudentCount({ schoolId }: { schoolId: number }) {
  const { data } = trpc.admin.getSchoolStudentCount.useQuery({ schoolId });
  if (data === undefined) return null;
  return <span> · {data.count} student{data.count === 1 ? "" : "s"}</span>;
}
