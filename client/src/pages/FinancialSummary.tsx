import { useState } from "react";
import { trpc } from "../lib/trpc";
import { getUser } from "../_core/hooks/useAuth";
import { useCurrentTerm } from "../hooks/useCurrentTerm";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Label } from "../components/ui/label";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { toast } from "sonner";
import { Download, Wallet, Ban } from "lucide-react";
import { downloadCsv } from "../lib/csv";

function fmt(n: number) { return n.toLocaleString("en-UG") + " UGX"; }

const ACTION_LABELS: Record<string, string> = {
  payment_recorded: "Payment recorded",
  payment_voided: "Payment voided",
  waiver_applied: "Waiver applied",
  waiver_removed: "Waiver removed",
  cash_deposited: "Cash deposited",
  cash_deposit_voided: "Cash deposit voided",
};

export default function FinancialSummary() {
  const { term: liveTerm, year: liveYear } = useCurrentTerm();
  const [termOverride, setTermOverride] = useState<number | null>(null);
  const [yearOverride, setYearOverride] = useState<number | null>(null);
  const term = termOverride ?? liveTerm;
  const year = yearOverride ?? liveYear;

  const user = getUser();
  const isBursar = user?.schoolRole === "bursar" || user?.schoolRole === "headTeacher";
  const isHeadTeacher = user?.schoolRole === "headTeacher";
  const [voidDepositTarget, setVoidDepositTarget] = useState<{ id: number; amount: string } | null>(null);
  const [voidDepositReason, setVoidDepositReason] = useState("");
  const voidDepositMutation = trpc.cash.voidDeposit.useMutation({
    onSuccess: () => {
      toast.success("Deposit voided");
      setVoidDepositTarget(null);
      setVoidDepositReason("");
      refetchDeposits();
      refetchCashBalance();
    },
    onError: (e) => toast.error(e.message),
  });

  const { data: summary, isLoading } = trpc.fees.getTermSummary.useQuery({ term, year });
  const { data: auditLog = [] } = trpc.fees.getAuditLog.useQuery({});
  const { data: cashBalance, refetch: refetchCashBalance } = trpc.cash.getUndepositedBalance.useQuery();
  const { data: deposits = [], refetch: refetchDeposits } = trpc.cash.getDeposits.useQuery();

  const [showDepositForm, setShowDepositForm] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositRef, setDepositRef] = useState("");

  const depositMutation = trpc.cash.recordDeposit.useMutation({
    onSuccess: () => {
      toast.success("Deposit recorded");
      setShowDepositForm(false);
      setDepositAmount("");
      setDepositRef("");
      refetchDeposits();
      refetchCashBalance();
    },
    onError: (e) => toast.error(e.message),
  });

  function handleExportSummary() {
    if (!summary) return;
    const rows: (string | number)[][] = [
      ["Total Expected", summary.totalExpected],
      ["Total Collected", summary.totalPaid],
      ["Total Outstanding", summary.totalOutstanding],
      ["Collection Rate (%)", summary.collectionRate],
      [],
      ["By Class", "", "", ""],
      ["Class", "Expected", "Collected", "Outstanding", "Rate (%)"],
      ...summary.byClass.map((c) => [c.name, c.expected, c.paid, c.outstanding, c.rate]),
      [],
      ["By Category", "", "", ""],
      ["Category", "Expected", "Collected", "Outstanding"],
      ...summary.byCategory.map((c) => [c.label, c.expected, c.paid, c.outstanding]),
    ];
    downloadCsv(
      `term-summary-T${term}-${year}.csv`,
      ["", "", "", "", ""],
      rows
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold">Financial Summary</h1>
        <div className="flex gap-3 items-end">
          <div>
            <Label className="text-xs">Term</Label>
            <Select value={String(term)} onValueChange={(v) => setTermOverride(Number(v))}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Term 1</SelectItem>
                <SelectItem value="2">Term 2</SelectItem>
                <SelectItem value="3">Term 3</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Year</Label>
            <Select value={String(year)} onValueChange={(v) => setYearOverride(Number(v))}>
              <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[liveYear, liveYear - 1, liveYear - 2].map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" disabled={!summary} onClick={handleExportSummary}>
            <Download className="h-4 w-4 mr-1" /> Export
          </Button>
        </div>
      </div>

      {isLoading && <p className="text-gray-400 text-sm">Loading...</p>}

      {summary && (
        <>
          {/* Top 3 numbers */}
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            <Card className="min-w-0 border-blue-200 bg-blue-50">
              <CardContent className="p-3 sm:p-5 text-center">
                <p className="text-xs text-blue-500 font-medium uppercase">Expected</p>
                <p className="text-lg sm:text-2xl font-bold text-blue-700 mt-1 break-words">{fmt(summary.totalExpected)}</p>
              </CardContent>
            </Card>
            <Card className="min-w-0 border-green-200 bg-green-50">
              <CardContent className="p-3 sm:p-5 text-center">
                <p className="text-xs text-green-500 font-medium uppercase">Collected</p>
                <p className="text-lg sm:text-2xl font-bold text-green-700 mt-1 break-words">{fmt(summary.totalPaid)}</p>
              </CardContent>
            </Card>
            <Card className="min-w-0 border-red-200 bg-red-50">
              <CardContent className="p-3 sm:p-5 text-center">
                <p className="text-xs text-red-500 font-medium uppercase">Outstanding</p>
                <p className="text-lg sm:text-2xl font-bold text-red-700 mt-1 break-words">{fmt(summary.totalOutstanding)}</p>
              </CardContent>
            </Card>
          </div>

          {/* Collection rate */}
          <Card>
            <CardContent className="p-5 flex items-center gap-4">
              <div className="flex-1">
                <p className="text-sm text-gray-500">Collection Rate</p>
                <p className="text-4xl font-bold text-gray-900">{summary.collectionRate}%</p>
              </div>
              <div className="w-32 h-3 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${summary.collectionRate >= 80 ? "bg-green-500" : summary.collectionRate >= 50 ? "bg-yellow-500" : "bg-red-500"}`}
                  style={{ width: `${Math.min(100, summary.collectionRate)}%` }}
                />
              </div>
            </CardContent>
          </Card>

          {/* Per class */}
          {summary.byClass.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">By Class</CardTitle></CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm min-w-[480px]">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-gray-600">Class</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600">Expected</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600">Collected</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600">Outstanding</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600">Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {summary.byClass.map((c) => (
                      <tr key={c.classId} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-medium">{c.name}</td>
                        <td className="px-4 py-2.5 text-right text-gray-600">{c.expected.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right text-green-600">{c.paid.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right text-red-600">{c.outstanding.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right">
                          <span className={`font-medium ${c.rate >= 80 ? "text-green-600" : c.rate >= 50 ? "text-yellow-600" : "text-red-600"}`}>
                            {c.rate}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Per category */}
          {summary.byCategory.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">By Fee Category</CardTitle></CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm min-w-[420px]">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium text-gray-600">Category</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600">Expected</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600">Collected</th>
                      <th className="text-right px-4 py-2 font-medium text-gray-600">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {summary.byCategory.map((c) => (
                      <tr key={c.category} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 capitalize font-medium">{c.label}</td>
                        <td className="px-4 py-2.5 text-right text-gray-600">{c.expected.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right text-green-600">{c.paid.toLocaleString()}</td>
                        <td className="px-4 py-2.5 text-right text-red-600">{c.outstanding.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* Arrears */}
          {summary.arrears.total > 0 && (
            <Card className="border-amber-200">
              <CardContent className="p-5">
                <p className="text-sm font-semibold text-amber-700">Arrears from Previous Terms</p>
                <div className="flex justify-between mt-2">
                  <span className="text-sm text-gray-600">{summary.arrears.studentCount} students with arrears</span>
                  <span className="font-bold text-amber-700">{fmt(summary.arrears.total)}</span>
                </div>
              </CardContent>
            </Card>
          )}

          {summary.totalExpected === 0 && (
            <p className="text-center text-gray-400 text-sm py-8">No fees assigned for Term {term} {year}.</p>
          )}
        </>
      )}

      {/* Cash reconciliation — there's no API integration to independently verify
          cash collected actually gets banked. This won't catch everything, but
          it gives a head teacher/auditor a concrete number to check the bursar's
          word against. */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle className="text-base flex items-center gap-2">
              <Wallet className="h-4 w-4" /> Cash Reconciliation
            </CardTitle>
            {isBursar && (
              <Button size="sm" variant="outline" onClick={() => setShowDepositForm(true)}>
                Log a deposit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {cashBalance && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="bg-gray-50 rounded px-3 py-2">
                <p className="text-xs text-gray-500">Cash collected (all time)</p>
                <p className="font-semibold">{fmt(cashBalance.totalCashCollected)}</p>
              </div>
              <div className="bg-gray-50 rounded px-3 py-2">
                <p className="text-xs text-gray-500">Total deposited</p>
                <p className="font-semibold">{fmt(cashBalance.totalDeposited)}</p>
              </div>
              <div className={`rounded px-3 py-2 col-span-2 ${cashBalance.undepositedBalance > 0 ? "bg-amber-50" : "bg-green-50"}`}>
                <p className={`text-xs ${cashBalance.undepositedBalance > 0 ? "text-amber-600" : "text-green-600"}`}>
                  Undeposited (collected minus banked, all time)
                </p>
                <p className={`font-bold ${cashBalance.undepositedBalance > 0 ? "text-amber-700" : "text-green-700"}`}>
                  {fmt(cashBalance.undepositedBalance)}
                </p>
                <p className={`text-xs mt-1 ${cashBalance.undepositedBalance > 0 ? "text-amber-500" : "text-green-500"}`}>
                  This is the number to check against what's actually sitting in the bank or the drawer right now.
                  {cashBalance.lastDepositDate && (
                    <> Last deposit logged {new Date(cashBalance.lastDepositDate).toLocaleDateString()}
                    {" "}({fmt(cashBalance.cashSinceLastDeposit)} collected since then).</>
                  )}
                </p>
              </div>
            </div>
          )}

          {deposits.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Deposit History</p>
              <div className="space-y-1">
                {deposits.slice(0, 10).map((d) => (
                  <div key={d.id} className={`flex justify-between items-center text-sm py-1 border-b last:border-0 ${d.isVoided ? "opacity-50" : ""}`}>
                    <span className={`text-gray-700 ${d.isVoided ? "line-through" : ""}`}>
                      {fmt(parseFloat(d.amount))}
                      {d.isVoided && <span className="text-red-500 text-xs ml-1.5 no-underline">(voided)</span>}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 text-xs">
                        {new Date(d.depositedAt).toLocaleDateString()}
                        {d.bankReference ? ` · ${d.bankReference}` : ""}
                      </span>
                      {isHeadTeacher && !d.isVoided && (
                        <button
                          onClick={() => setVoidDepositTarget({ id: d.id, amount: d.amount })}
                          className="text-gray-300 hover:text-red-500 transition-colors"
                          title="Void this deposit (e.g. wrong amount entered)"
                        >
                          <Ban className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Financial audit log — every payment, void, waiver, and cash deposit,
          with who did it and when. Visible to bursar, head teacher, and the
          read-only auditor role alike; this is the oversight trail, not a
          restricted setting. */}
      <Card>
        <CardHeader><CardTitle className="text-base">Financial Audit Log</CardTitle></CardHeader>
        <CardContent className="p-0">
          {auditLog.length === 0 ? (
            <p className="text-center py-8 text-gray-400 text-sm">No financial activity recorded yet.</p>
          ) : (
            <div className="divide-y max-h-96 overflow-y-auto">
              {auditLog.map((entry) => (
                <div key={entry.id} className="flex justify-between px-4 py-2.5 text-sm">
                  <div>
                    <p className="font-medium">{ACTION_LABELS[entry.action] ?? entry.action}</p>
                    {entry.notes && <p className="text-xs text-gray-400">{entry.notes}</p>}
                  </div>
                  <div className="text-right">
                    {entry.amount && (
                      <p className="text-gray-700">{parseFloat(entry.amount).toLocaleString()} UGX</p>
                    )}
                    <p className="text-xs text-gray-400">{new Date(entry.createdAt).toLocaleString()}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showDepositForm} onOpenChange={setShowDepositForm}>
        <DialogContent>
          <DialogHeader><DialogTitle>Log a Cash Deposit</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Amount deposited (UGX)</Label>
              <Input type="number" min="1" step="1" placeholder="0" value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
            </div>
            <div>
              <Label>Bank reference (optional)</Label>
              <Input placeholder="Deposit slip number" value={depositRef} onChange={(e) => setDepositRef(e.target.value)} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowDepositForm(false)}>Cancel</Button>
            <Button
              className="flex-1"
              disabled={!depositAmount || Number(depositAmount) <= 0 || depositMutation.isPending}
              onClick={() => depositMutation.mutate({
                amount: Number(depositAmount),
                depositedAt: new Date().toISOString(),
                bankReference: depositRef || undefined,
              })}
            >
              {depositMutation.isPending ? "Saving..." : "Log Deposit"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!voidDepositTarget} onOpenChange={(open) => !open && setVoidDepositTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void this deposit?</AlertDialogTitle>
            <AlertDialogDescription>
              {voidDepositTarget && `${fmt(parseFloat(voidDepositTarget.amount))} will no longer count toward "total deposited" — use this for a genuine entry mistake (wrong amount), not to hide a real deposit.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div>
            <Label>Reason</Label>
            <Input placeholder="e.g. Typed 500,000 instead of 50,000" value={voidDepositReason} onChange={(e) => setVoidDepositReason(e.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setVoidDepositTarget(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={!voidDepositReason.trim() || voidDepositMutation.isPending}
              onClick={() => {
                if (voidDepositTarget) voidDepositMutation.mutate({ depositId: voidDepositTarget.id, reason: voidDepositReason.trim() });
              }}
            >
              Void Deposit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
