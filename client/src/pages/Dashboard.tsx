import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "../lib/trpc";
import { getUser, setUser } from "../_core/hooks/useAuth";
import { useCurrentTerm } from "../hooks/useCurrentTerm";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { DollarSign, Users, AlertTriangle, TrendingUp, UserPlus, Wallet, MessageSquare } from "lucide-react";
import OnboardingWizard from "../components/OnboardingWizard";

export default function Dashboard() {
  const user = getUser();
  const [onboarded, setOnboarded] = useState(user?.onboarded ?? false);
  const [, navigate] = useLocation();

  const { term: currentTerm, year: currentYear, status: termStatus } = useCurrentTerm();

  const { data: summary, isLoading: summaryLoading } = trpc.fees.getTermSummary.useQuery(
    { term: currentTerm, year: currentYear },
    { enabled: onboarded }
  );
  const { data: defaulters, isLoading: defaultersLoading } = trpc.fees.getDefaulters.useQuery(
    { term: currentTerm, year: currentYear },
    { enabled: onboarded }
  );
  const { data: students } = trpc.student.getAll.useQuery(undefined, { enabled: onboarded });

  if (!onboarded) {
    return (
      <OnboardingWizard
        onComplete={() => {
          const u = getUser();
          if (u) setUser({ ...u, onboarded: true });
          setOnboarded(true);
        }}
      />
    );
  }

  const totalStudents = students?.length ?? 0;
  const totalDefaulters = defaulters?.length ?? 0;
  const collectionRate = summary?.collectionRate ?? 0;
  const totalOutstanding = summary?.totalOutstanding ?? 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Good {getGreeting()}, {user?.name?.split(" ")[0]}
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Term {currentTerm} · {currentYear}{termStatus === "ended" ? " (ended)" : ""} · {user?.schoolName}
        </p>
      </div>

      {/* Quick actions — the dashboard is the first screen every day, but
          previously had zero shortcuts: every action meant finding the
          right bottom tab first. */}
      <div className="grid grid-cols-3 gap-3">
        <QuickAction icon={UserPlus} label="Add Student" onClick={() => navigate("/students")} />
        <QuickAction icon={Wallet} label="Record Payment" onClick={() => navigate("/fees")} />
        <QuickAction icon={MessageSquare} label="Remind" onClick={() => navigate("/sms")} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard title="Collection Rate" value={summaryLoading ? "..." : `${collectionRate}%`} icon={TrendingUp}
          color={collectionRate >= 80 ? "green" : collectionRate >= 50 ? "yellow" : "red"} />
        <MetricCard title="Outstanding" value={summaryLoading ? "..." : `${totalOutstanding.toLocaleString()} UGX`} icon={DollarSign} color="blue" />
        <MetricCard title="Defaulters" value={defaultersLoading ? "..." : String(totalDefaulters)} icon={AlertTriangle}
          color={totalDefaulters === 0 ? "green" : "red"} />
        <MetricCard title="Students" value={String(totalStudents)} icon={Users} color="blue" />
      </div>

      {totalStudents === 0 && (
        <Card>
          <CardContent className="py-8 text-center space-y-2">
            <p className="text-gray-700 text-sm font-medium">Add your first students to get started</p>
            <p className="text-gray-400 text-xs">You can add them one by one or import a CSV from the Students page.</p>
            <button
              onClick={() => navigate("/students")}
              className="mt-2 inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Go to Students
            </button>
          </CardContent>
        </Card>
      )}

      {summary && summary.totalExpected > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Term {currentTerm} {currentYear} Summary</CardTitle></CardHeader>
          <CardContent className="space-y-2.5">
            <Row label="Expected" value={`${summary.totalExpected.toLocaleString()} UGX`} />
            <Row label="Collected" value={`${summary.totalPaid.toLocaleString()} UGX`} highlight />
            <Row label="Outstanding" value={`${summary.totalOutstanding.toLocaleString()} UGX`} />
            {summary.arrears.total > 0 && (
              <Row label={`Arrears (${summary.arrears.studentCount} students)`} value={`${summary.arrears.total.toLocaleString()} UGX`} warning />
            )}
          </CardContent>
        </Card>
      )}

      {defaulters && defaulters.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Top Defaulters</CardTitle>
            <button
              onClick={() => navigate("/defaulters")}
              className="text-xs text-indigo-600 font-medium hover:underline"
            >
              View all
            </button>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {defaulters.slice(0, 5).map((d) => (
              <button
                key={d.studentId}
                type="button"
                onClick={() => navigate(`/fees?studentId=${d.studentId}`)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-left"
              >
                <div>
                  <p className="text-sm font-medium">{d.student?.firstName} {d.student?.lastName}</p>
                  <p className="text-xs text-gray-400">{d.className}</p>
                </div>
                <span className="text-sm font-semibold text-red-600">{d.totalOutstanding.toLocaleString()} UGX</span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {!summaryLoading && summary && summary.totalExpected === 0 && (
        <Card>
          <CardContent className="py-10 text-center space-y-3">
            <p className="text-gray-500 text-sm">No fees assigned yet for Term {currentTerm} {currentYear}.</p>
            <p className="text-gray-400 text-xs">
              Set amounts in Settings → Fee Structure, then assign fees from the Fees page or when adding students.
            </p>
            <div className="flex gap-2 justify-center pt-1">
              <button
                onClick={() => navigate("/settings")}
                className="text-sm text-indigo-600 font-medium hover:underline"
              >
                Open Settings
              </button>
              <span className="text-gray-300">·</span>
              <button
                onClick={() => navigate("/fees")}
                className="text-sm text-indigo-600 font-medium hover:underline"
              >
                Go to Fees
              </button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function QuickAction({ icon: Icon, label, onClick }: {
  icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1.5 py-3 rounded-lg border bg-white hover:bg-gray-50 transition-colors">
      <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600"><Icon className="h-4 w-4" /></div>
      <span className="text-xs font-medium text-gray-700">{label}</span>
    </button>
  );
}

function MetricCard({ title, value, icon: Icon, color }: {
  title: string; value: string; icon: React.ComponentType<{ className?: string }>;
  color: "green" | "red" | "blue" | "yellow";
}) {
  const colors = {
    green: "text-green-600 bg-green-50", red: "text-red-600 bg-red-50",
    blue: "text-blue-600 bg-blue-50", yellow: "text-yellow-600 bg-yellow-50",
  };
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${colors[color]} shrink-0`}><Icon className="h-4 w-4" /></div>
          <div className="min-w-0">
            <p className="text-xs text-gray-500">{title}</p>
            <p className="text-lg font-bold text-gray-900 break-words">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, value, highlight, warning }: { label: string; value: string; highlight?: boolean; warning?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className={`text-sm ${warning ? "text-amber-600" : "text-gray-600"}`}>{label}</span>
      <span className={`font-semibold ${highlight ? "text-green-600" : warning ? "text-amber-600" : "text-gray-900"}`}>{value}</span>
    </div>
  );
}

function getGreeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}
