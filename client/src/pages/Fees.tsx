import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { trpc } from "../lib/trpc";
import { getUser } from "../_core/hooks/useAuth";
import { useCurrentTerm } from "../hooks/useCurrentTerm";
import { useOfflineMutation } from "../hooks/useOfflineMutation";
import { useOfflineData } from "../hooks/useOfflineData";
import { STORES } from "../lib/offlineDb";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { CreditCard, ShieldOff, Shield, Ban, Wallet, Layers } from "lucide-react";
import { PaymentReceipt, type ReceiptPayment } from "../components/PaymentReceipt";

// new Date().toISOString().split("T")[0] always normalizes to UTC, which is
// 3 hours behind Uganda (EAT, UTC+3, no DST). For the first ~3 hours of every
// calendar day here, that pattern silently defaults the payment date to
// YESTERDAY instead of today. This runs in the bursar's own browser, so
// local Date getters are already correct — no explicit timezone needed,
// unlike the equivalent server-side fix in db.ts.
function todayLocalDate(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function Fees() {
  const { term: defaultTerm, year: currentYear } = useCurrentTerm();
  const search = useSearch();

  const [showPayment, setShowPayment] = useState(false);
  const [showWaiver, setShowWaiver] = useState(false);
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(null);
  const [selectedFeeRecordId, setSelectedFeeRecordId] = useState<number | null>(null);
  const [waiverNote, setWaiverNote] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Deep-link support: Students' "Record Payment" action lands here as
  // /fees?studentId=123 instead of dropping the bursar on an empty search
  // box to re-type a name they were just looking at. Runs once on arrival —
  // doesn't re-fire and fight a search the bursar starts afterward.
  useEffect(() => {
    const params = new URLSearchParams(search);
    const studentId = params.get("studentId");
    if (studentId) setSelectedStudentId(Number(studentId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [payment, setPayment] = useState({ amount: "", method: "cash" as string, date: todayLocalDate(), notes: "", reference: "" });
  const user = getUser();
  const isHeadTeacher = user?.schoolRole === "headTeacher";
  const isBursar = user?.schoolRole === "bursar" || isHeadTeacher;
  const [voidTarget, setVoidTarget] = useState<{ id: number; receiptNumber: string } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [receiptPayments, setReceiptPayments] = useState<ReceiptPayment[]>([]);
  const [showReceipt, setShowReceipt] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [generateClassId, setGenerateClassId] = useState<number | null>(null);


  // Cash deposit quick-action — recording a payment and banking that cash are
  // the two halves of the same routine, but logging the deposit previously
  // lived only on Financial Summary (More → Financial Summary → scroll to
  // Cash Reconciliation). Same trpc.cash.recordDeposit mutation, just
  // reachable from the page a bursar is already on after taking cash.
  const { data: cashBalance, refetch: refetchCashBalance } = trpc.cash.getUndepositedBalance.useQuery(undefined, { enabled: isBursar });
  const [showDepositForm, setShowDepositForm] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositRef, setDepositRef] = useState("");
  const depositMutation = trpc.cash.recordDeposit.useMutation({
    onSuccess: () => {
      toast.success("Deposit recorded");
      setShowDepositForm(false);
      setDepositAmount("");
      setDepositRef("");
      refetchCashBalance();
    },
    onError: (e) => toast.error(e.message),
  });

  const generateFeesMutation = trpc.fees.generateForClass.useMutation({
    onSuccess: (data) => {
      toast.success(
        `Assigned fees for ${data.generated} student${data.generated === 1 ? "" : "s"}` +
        (data.skipped ? ` (${data.skipped} already had fees this term)` : "")
      );
      setShowGenerate(false);
      if (selectedStudentId) refetchRecords();
    },
    onError: (e) => toast.error(e.message),
  });

  const schoolId = user?.schoolId;
  const { data: classes = [] } = trpc.class.getAll.useQuery(undefined, { enabled: isBursar });


  // Same cache store Students.tsx populates — if that page's been opened this
  // session, its list is already here. Also fetched directly so Fees.tsx
  // isn't dependent on the other page having loaded first.
  const allStudentsLive = trpc.student.getAll.useQuery();
  const { data: allStudentsCached = [] } = useOfflineData(STORES.students, schoolId, allStudentsLive);

  const { data: liveSearchResults = [], isError: searchIsError } = trpc.student.search.useQuery(
    { query: searchQuery },
    { enabled: searchQuery.length >= 2 }
  );
  const searchResults = searchIsError
    ? allStudentsCached.filter((s) =>
        `${s.firstName} ${s.lastName}`.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.admissionNumber.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : liveSearchResults;

  // BUG FIX: Get selected student directly so name stays visible even after search is cleared
  const selectedStudentLive = trpc.student.getById.useQuery(
    { studentId: selectedStudentId! },
    { enabled: !!selectedStudentId }
  );
  const { data: selectedStudent } = useOfflineData(
    STORES.students, selectedStudentId != null ? `${schoolId}-student-${selectedStudentId}` : undefined, selectedStudentLive
  );

  const studentRecordsLive = trpc.fees.getStudentRecords.useQuery(
    { studentId: selectedStudentId! },
    { enabled: !!selectedStudentId }
  );
  const { data: studentRecords = [], refetch: refetchRecords, isOffline: recordsOffline, cachedAt: recordsCachedAt, isLoading: recordsLoading } =
    useOfflineData(
      STORES.feeRecords, selectedStudentId != null ? `${schoolId}-student-${selectedStudentId}-records` : undefined, studentRecordsLive
    );

  const studentPaymentsLive = trpc.fees.getStudentPayments.useQuery(
    { studentId: selectedStudentId! },
    { enabled: !!selectedStudentId }
  );
  const { data: studentPayments = [], refetch: refetchPayments } = useOfflineData(
    STORES.feeRecords, selectedStudentId != null ? `${schoolId}-student-${selectedStudentId}-payments` : undefined, studentPaymentsLive
  );

  const paymentMutation = useOfflineMutation<Record<string, unknown>>({
    procedure: "fees.recordPayment",
    summary: (input) => `Payment: ${Number(input.amount).toLocaleString()} UGX for ${selectedStudent?.firstName ?? ""} ${selectedStudent?.lastName ?? ""}`,
    onSuccess: (result, queued) => {
      toast.success(queued ? "Payment saved — will sync when back online" : "Payment recorded");
      setShowPayment(false);
      if (!queued) { refetchRecords(); refetchPayments(); }
      // Online payments return the created rows with receipt numbers — offer print.
      if (!queued && Array.isArray(result) && result.length > 0) {
        setReceiptPayments(result as ReceiptPayment[]);
        setShowReceipt(true);
      }
      setPayment({ amount: "", method: "cash", date: todayLocalDate(), notes: "", reference: "" });
    },
    onError: (e) => toast.error(e.message),
  });

  const voidMutation = trpc.fees.voidPayment.useMutation({
    onSuccess: (result) => {
      if (result.examClearanceRevoked) {
        toast.warning("Payment voided — exam clearance for that term was also revoked, since nothing justifies it anymore");
      } else {
        toast.success("Payment voided");
      }
      setVoidTarget(null);
      setVoidReason("");
      refetchRecords();
      refetchPayments();
    },
    onError: (e) => toast.error(e.message),
  });

  const waiverMutation = useOfflineMutation<Record<string, unknown>>({
    procedure: "fees.applyWaiver",
    summary: () => `Waiver: ${waiverNote || "fee record"}`,
    onSuccess: (_result, queued) => {
      toast.success(queued ? "Waiver saved — will sync when back online" : "Waiver applied");
      setShowWaiver(false);
      if (!queued) refetchRecords();
      setWaiverNote("");
    },
    onError: (e) => toast.error(e.message),
  });

  const removeWaiverMutation = trpc.fees.removeWaiver.useMutation({
    onSuccess: (result) => {
      if (result.examClearanceRevoked) {
        toast.warning("Waiver removed — exam clearance for that term was also revoked, since nothing justifies it anymore");
      } else {
        toast.success("Waiver removed");
      }
      refetchRecords();
    },
    onError: (e) => toast.error(e.message),
  });

  const outstanding = studentRecords.filter(r => !r.isWaiver).reduce((s, r) => s + Math.max(0, parseFloat(r.amountExpected) - parseFloat(r.amountPaid)), 0);

  // Bug 14: compute maxYear and maxTerm once — not inside the filter callback (was O(n²))
  // Also guard against empty array so Math.max(...[]) never returns -Infinity
  const maxYear = studentRecords.length > 0
    ? Math.max(...studentRecords.map(r => r.year))
    : currentYear;
  const maxTerm = studentRecords.filter(r => r.year === maxYear).length > 0
    ? Math.max(...studentRecords.filter(r => r.year === maxYear).map(r => r.term))
    : defaultTerm;

  // Unified list: current term first, then everything older (previous term OR
  // previous year — same mechanism either way, a fee record not in the most
  // recent term/year the student has). Sorted so the newest is on top and
  // arrears trail below it, but all in ONE list with a clear tag on each row
  // rather than tucked into a separate section that's easy to miss.
  const unpaidRecordsSorted = [...studentRecords]
    .filter(r => !r.isWaiver)
    .sort((a, b) => (b.year - a.year) || (b.term - a.term));

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-2xl font-bold">Record Payment</h1>
        <div className="flex gap-2 flex-wrap">
          {isBursar && (
            <Button size="sm" variant="outline" onClick={() => setShowGenerate(true)} className="gap-1.5">
              <Layers className="h-3.5 w-3.5" /> Assign class fees
            </Button>
          )}
          {isBursar && cashBalance && (
            <Button size="sm" variant="outline" onClick={() => setShowDepositForm(true)} className="gap-1.5">
              <Wallet className="h-3.5 w-3.5" />
              {cashBalance.undepositedBalance > 0
                ? `${cashBalance.undepositedBalance.toLocaleString()} UGX to deposit`
                : "Log deposit"}
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Find Student</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="Search by name or admission number..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSelectedStudentId(null); }}
          />
          {searchQuery.length >= 2 && searchResults.length > 0 && !selectedStudentId && (
            <div className="border rounded-lg divide-y">
              {searchResults.slice(0, 8).map((s) => (
                <button
                  key={s.id}
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-50 flex items-center justify-between gap-2"
                  onClick={() => setSelectedStudentId(s.id)}
                >
                  <span className="text-sm font-medium min-w-0 truncate">{s.firstName} {s.lastName}</span>
                  <span className="text-xs text-gray-400 shrink-0">{s.admissionNumber}</span>
                </button>
              ))}
            </div>
          )}
          {searchQuery.length >= 2 && searchResults.length === 0 && !selectedStudentId && (
            <p className="text-sm text-gray-400 py-2">
              No student matches “{searchQuery}”. Check spelling or add them under Students first.
            </p>
          )}
          {searchQuery.length < 2 && !selectedStudentId && (
            <p className="text-xs text-gray-400">
              Type at least 2 characters of a name or admission number to find a student.
            </p>
          )}
        </CardContent>
      </Card>

      {selectedStudentId && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base min-w-0 truncate">
                {selectedStudent?.firstName ?? ""} {selectedStudent?.lastName ?? ""}
              </CardTitle>
              <div className="flex gap-2 shrink-0">
                {isBursar && (
                  <Button size="sm" onClick={() => setShowPayment(true)}>
                    <CreditCard className="h-4 w-4 mr-1" /> Record Payment
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {recordsOffline && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
                Showing saved balance from {recordsCachedAt ? new Date(recordsCachedAt).toLocaleString() : "earlier"} — may not reflect payments made elsewhere since then.
              </div>
            )}
            {recordsLoading ? (
              <p className="text-sm text-gray-400">Loading fee records…</p>
            ) : studentRecords.length === 0 ? (
              <div className="text-sm text-gray-500 space-y-1 py-2">
                <p>No fee records for this student yet.</p>
                <p className="text-xs text-gray-400">
                  Assign fees from Settings → Fee Structure (set amounts), then use “Generate fees” or add fees when enrolling the student.
                </p>
              </div>
            ) : (
              <>
                {/* What they owe — current term and any arrears together, each
                    row clearly tagged with which term/year it's from, so a
                    balance carried over from last term or last year is
                    impossible to mistake for a current charge. */}
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-2">What's Owed</p>
                  <div className="space-y-2">
                    {unpaidRecordsSorted.map((r) => {
                      const balance = Math.max(0, parseFloat(r.amountExpected) - parseFloat(r.amountPaid));
                      const isCurrent = r.year === maxYear && r.term === maxTerm;
                      return (
                        <div key={r.id} className={`flex items-center justify-between gap-2 rounded px-3 py-2 ${isCurrent ? "bg-gray-50" : "bg-amber-50"}`}>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-medium truncate">{r.label}</p>
                              {!isCurrent && (
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-100 rounded px-1.5 py-0.5 shrink-0">
                                  Term {r.term} {r.year} arrears
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="text-right flex items-center gap-2 shrink-0">
                            <span className={`text-sm font-medium ${balance === 0 ? "text-green-600" : isCurrent ? "text-red-600" : "text-amber-600"}`}>
                              {balance === 0 ? "Cleared" : `${balance.toLocaleString()} UGX`}
                            </span>
                            {balance > 0 && isHeadTeacher && (
                              <button
                                className="text-gray-400 hover:text-green-600"
                                title="Apply waiver (head teacher only)"
                                onClick={() => { setSelectedFeeRecordId(r.id); setShowWaiver(true); }}
                              >
                                <Shield className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {studentRecords.filter(r => r.isWaiver).map((r) => (
                      <div key={r.id} className="flex items-center justify-between gap-2 bg-gray-50 rounded px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{r.label}</p>
                          <p className="text-xs text-gray-400 truncate">Waived: {r.waiverNote}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-gray-400">Waived</span>
                          {isHeadTeacher ? (
                            <button
                              className="text-gray-400 hover:text-red-500"
                              title="Remove waiver (head teacher only)"
                              onClick={() => removeWaiverMutation.mutate({ feeRecordId: r.id })}
                            >
                              <ShieldOff className="h-4 w-4" />
                            </button>
                          ) : (
                            <span className="text-xs text-gray-400">Head teacher only</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Outstanding total */}
                <div className="flex justify-between pt-2 border-t font-semibold">
                  <span>Total Outstanding</span>
                  <span className={outstanding === 0 ? "text-green-600" : "text-red-600"}>
                    {outstanding.toLocaleString()} UGX
                  </span>
                </div>

                {/* Payment history */}
                {studentPayments.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Payment History</p>
                    <div className="space-y-1">
                      {studentPayments.map((p) => (
                        <div key={p.id} className={`flex justify-between gap-2 text-sm py-1 ${p.isVoided ? "opacity-50" : ""}`}>
                          <div className="min-w-0 truncate">
                            <span className={p.isVoided ? "text-gray-400 line-through" : "text-gray-700"}>
                              {parseFloat(p.amount).toLocaleString()} UGX
                            </span>
                            <span className="text-gray-400 text-xs ml-2">{p.paymentMethod}</span>
                            {p.isVoided && (
                              <span className="text-red-400 text-xs ml-2" title={p.voidReason ?? undefined}>Voided</span>
                            )}
                          </div>
                          <div className="text-right flex items-center gap-2 shrink-0">
                            <div>
                              <p className="text-xs text-gray-400">{p.paymentDate}</p>
                              <p className="text-xs text-gray-500">{p.receiptNumber}</p>
                            </div>
                            {isHeadTeacher && !p.isVoided && (
                              <button
                                className="text-gray-400 hover:text-red-500 transition-colors"
                                title="Void this payment"
                                onClick={() => setVoidTarget({ id: p.id, receiptNumber: p.receiptNumber })}
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
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Payment Dialog */}
      <Dialog open={showPayment} onOpenChange={setShowPayment}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">Total outstanding: <strong>{outstanding.toLocaleString()} UGX</strong></p>
          <div className="space-y-3">
            <div>
              <Label>Amount Received (UGX) *</Label>
              <Input type="number" min="1" step="1" placeholder="0" value={payment.amount} onChange={(e) => setPayment((p) => ({ ...p, amount: e.target.value }))} />
            </div>
            <div>
              <Label>Payment Method</Label>
              <Select defaultValue="cash" onValueChange={(v) => setPayment((p) => ({ ...p, method: v }))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="mtnMomo">MTN MoMo</SelectItem>
                  <SelectItem value="airtelMoney">Airtel Money</SelectItem>
                  <SelectItem value="bankTransfer">Bank Transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Payment Date</Label>
              <Input type="date" value={payment.date} onChange={(e) => setPayment((p) => ({ ...p, date: e.target.value }))} />
            </div>
            <div>
              <Label>Transaction reference {payment.method === "cash" ? "(optional)" : "(recommended)"}</Label>
              <Input
                placeholder={payment.method === "cash" ? "N/A for cash" : "Mobile money transaction ID"}
                value={payment.reference}
                onChange={(e) => setPayment((p) => ({ ...p, reference: e.target.value }))}
              />
              <p className="text-xs text-gray-400 mt-1">
                If given, this is checked against past payments so the same transaction can't be entered twice.
              </p>
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Input placeholder="Remarks..." value={payment.notes} onChange={(e) => setPayment((p) => ({ ...p, notes: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowPayment(false)}>Cancel</Button>
            <Button className="flex-1" disabled={!payment.amount || paymentMutation.isPending}
              onClick={() => selectedStudentId && paymentMutation.mutate({
                studentId: selectedStudentId,
                amount: Number(payment.amount),
                paymentMethod: payment.method as "cash" | "mtnMomo" | "airtelMoney" | "bankTransfer",
                paymentDate: payment.date,
                notes: payment.notes || undefined,
                referenceNumber: payment.reference || undefined,
              })}>
              {paymentMutation.isPending ? "Recording..." : "Record Payment"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Waiver Dialog */}
      <Dialog open={showWaiver} onOpenChange={setShowWaiver}>
        <DialogContent>
          <DialogHeader><DialogTitle>Apply Waiver</DialogTitle></DialogHeader>
          <div>
            <Label>Reason for waiver *</Label>
            <Input placeholder="Staff child, bursary, scholarship..." value={waiverNote} onChange={(e) => setWaiverNote(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowWaiver(false)}>Cancel</Button>
            <Button className="flex-1" disabled={!waiverNote || waiverMutation.isPending}
              onClick={() => selectedFeeRecordId && waiverMutation.mutate({ feeRecordId: selectedFeeRecordId, waiverNote })}>
              Apply Waiver
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!voidTarget} onOpenChange={(open) => { if (!open) { setVoidTarget(null); setVoidReason(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void receipt {voidTarget?.receiptNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              This reverses the amount from the student's balance and marks the payment voided — it stays
              visible in the history, struck through, rather than disappearing. Use this to correct a
              mistaken entry, then record a new payment with the right details if needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div>
            <Label>Reason *</Label>
            <Input placeholder="e.g. Entered wrong amount" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setVoidReason("")}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={!voidReason.trim() || voidMutation.isPending}
              onClick={() => {
                if (voidTarget) voidMutation.mutate({ paymentId: voidTarget.id, reason: voidReason.trim() });
              }}
            >
              Void Payment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

      {/* Assign fees for a whole class (same as Settings → Assign Fees) */}
      <Dialog open={showGenerate} onOpenChange={setShowGenerate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Assign class fees</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">
            Creates fee records for active students in the class who do not already have them for Term {defaultTerm} {currentYear}.
            New students already get fees on enrollment — use this to backfill.
          </p>
          <div className="space-y-2">
            <Label>Class</Label>
            <Select
              value={generateClassId != null ? String(generateClassId) : undefined}
              onValueChange={(v) => setGenerateClassId(Number(v))}
            >
              <SelectTrigger><SelectValue placeholder="Select class" /></SelectTrigger>
              <SelectContent>
                {classes.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowGenerate(false)}>Cancel</Button>
            <Button
              className="flex-1 bg-green-600 hover:bg-green-700"
              disabled={!generateClassId || generateFeesMutation.isPending}
              onClick={() => generateClassId && generateFeesMutation.mutate({
                classId: generateClassId,
                term: defaultTerm,
                year: currentYear,
              })}
            >
              {generateFeesMutation.isPending ? "Assigning..." : "Assign fees"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <PaymentReceipt
        open={showReceipt}
        onClose={() => setShowReceipt(false)}
        schoolName={user?.schoolName ?? "School"}
        studentName={`${selectedStudent?.firstName ?? ""} ${selectedStudent?.lastName ?? ""}`.trim()}
        admissionNumber={selectedStudent?.admissionNumber}
        payments={receiptPayments}
      />
    </div>
  );
}
