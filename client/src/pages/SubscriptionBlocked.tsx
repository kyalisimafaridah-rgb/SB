import { useState } from "react";
import { useSearch, useLocation } from "wouter";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { AlertCircle, Ban, Clock, LogOut, MessageCircle, CheckCircle2 } from "lucide-react";
import { getUser, clearToken } from "../_core/hooks/useAuth";
import { SUPPORT_WHATSAPP } from "../lib/const";
import { trpc } from "../lib/trpc";
import {
  TIER_AMOUNTS,
  TIER_LABELS,
  TIER_STUDENT_RANGES,
  formatUgx,
  BILLING_PERIOD,
  type SchoolTier,
} from "../../../shared/pricing";

const COPY: Record<
  string,
  { icon: typeof Clock; title: string; body: (u: ReturnType<typeof getUser>) => string }
> = {
  trial_expired: {
    icon: Clock,
    title: "Your free trial has ended",
    body: (u) =>
      u?.trialEndsAt
        ? `${u.schoolName ?? "Your school"}'s trial ended on ${new Date(u.trialEndsAt).toLocaleDateString()}. Choose a plan and submit your payment reference, or message us on WhatsApp.`
        : `${u?.schoolName ?? "Your school"}'s trial has ended. Choose a plan and submit payment proof below.`,
  },
  subscription_expired: {
    icon: AlertCircle,
    title: "Subscription expired",
    body: (u) =>
      u?.subscriptionEndsAt
        ? `${u.schoolName ?? "Your school"}'s subscription lapsed on ${new Date(u.subscriptionEndsAt).toLocaleDateString()} (including the 3-day grace period). Renew below to restore access.`
        : `${u?.schoolName ?? "Your school"}'s subscription has lapsed. Renew below to restore access.`,
  },
  account_suspended: {
    icon: Ban,
    title: "Account suspended",
    body: (u) =>
      `${u?.schoolName ?? "Your school"}'s access has been suspended. Contact us on WhatsApp for details.`,
  },
};

const TIERS: SchoolTier[] = ["small", "medium", "large"];

export default function SubscriptionBlocked() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const reason = new URLSearchParams(search).get("reason") ?? "subscription_expired";
  const user = getUser();
  const info = COPY[reason] ?? COPY.subscription_expired;
  const Icon = info.icon;
  const isSuspended = reason === "account_suspended";

  const [tier, setTier] = useState<SchoolTier>("medium");
  const [method, setMethod] = useState<"mtnMomo" | "airtelMoney" | "bankTransfer" | "cash">("mtnMomo");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const term = month <= 3 ? 1 : month <= 7 ? 2 : 3;

  const requestRenewal = trpc.school.requestRenewal.useMutation({
    onSuccess: () => {
      setSubmitted(true);
      setError("");
    },
    onError: (e) => setError(e.message),
  });

  function whatsappHref(selectedTier?: SchoolTier) {
    const school = user?.schoolName ?? "my school";
    const t = selectedTier ?? tier;
    return `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(
      `Hi, I'd like to reactivate ScholarBase for ${school}. I'd like the ${TIER_LABELS[t]} plan (${formatUgx(TIER_AMOUNTS[t])} ${BILLING_PERIOD}).`
    )}`;
  }

  function handleLogout() {
    clearToken();
    navigate("/login");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (reference.trim().length < 3) {
      setError("Enter the MoMo / bank reference from your payment.");
      return;
    }
    requestRenewal.mutate({
      amount: TIER_AMOUNTS[tier],
      term,
      year,
      paymentMethod: method,
      referenceNumber: reference.trim(),
      notes: notes.trim() || undefined,
      requestedTier: tier,
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted p-4 sm:p-6">
      <div className="max-w-lg w-full space-y-5">
        <div className="text-center space-y-2">
          <Icon className="h-10 w-10 text-amber-500 mx-auto" />
          <h1 className="text-xl font-bold text-foreground">{info.title}</h1>
          <p className="text-sm text-muted-foreground">{info.body(user)}</p>
        </div>

        {!isSuspended && !submitted && (
          <form onSubmit={handleSubmit} className="rounded-xl border bg-card p-4 space-y-4 shadow-sm">
            <p className="text-sm font-semibold text-foreground">Submit payment proof</p>
            <p className="text-xs text-muted-foreground">
              Pay via MoMo/Airtel/bank, then enter the reference here. We activate after confirming — usually same day.
            </p>

            <div className="grid gap-2">
              {TIERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTier(t)}
                  className={`text-left rounded-lg border p-3 transition-all ${
                    tier === t ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500" : "border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <div className="flex justify-between items-baseline">
                    <span className="font-semibold text-foreground">{TIER_LABELS[t]}</span>
                    <span className="text-indigo-600 font-bold text-sm">
                      {formatUgx(TIER_AMOUNTS[t])}
                      <span className="text-xs font-normal text-muted-foreground ml-1">{BILLING_PERIOD}</span>
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{TIER_STUDENT_RANGES[t]}</p>
                </button>
              ))}
            </div>

            <div className="space-y-1">
              <Label>Payment method</Label>
              <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mtnMomo">MTN MoMo</SelectItem>
                  <SelectItem value="airtelMoney">Airtel Money</SelectItem>
                  <SelectItem value="bankTransfer">Bank transfer</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Transaction reference *</Label>
              <Input
                placeholder="e.g. MoMo transaction ID"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1">
              <Label>Notes (optional)</Label>
              <Input
                placeholder="Anything we should know"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>}

            <Button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-700" disabled={requestRenewal.isPending}>
              {requestRenewal.isPending ? "Submitting..." : `Submit ${formatUgx(TIER_AMOUNTS[tier])} proof`}
            </Button>
          </form>
        )}

        {submitted && (
          <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-center space-y-2">
            <CheckCircle2 className="h-8 w-8 text-green-600 mx-auto" />
            <p className="font-semibold text-green-900">Payment proof received</p>
            <p className="text-sm text-green-800">
              We will confirm and activate {user?.schoolName ?? "your school"} shortly. Message us on WhatsApp if urgent.
            </p>
          </div>
        )}

        <a href={whatsappHref()} target="_blank" rel="noreferrer" className="block">
          <Button className="w-full bg-green-600 hover:bg-green-700">
            <MessageCircle className="h-4 w-4 mr-1.5" /> Message Us on WhatsApp
          </Button>
        </a>
        <Button variant="outline" onClick={handleLogout} className="w-full">
          <LogOut className="h-4 w-4 mr-1.5" /> Log Out
        </Button>
      </div>
    </div>
  );
}
