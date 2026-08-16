import { useState } from "react";
import { trpc } from "../lib/trpc";
import { useCurrentTerm } from "../hooks/useCurrentTerm";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Checkbox } from "../components/ui/checkbox";
import { toast } from "sonner";
import { MessageSquare, ExternalLink } from "lucide-react";
import { getUser } from "../_core/hooks/useAuth";

// Bug 2: WhatsApp requires international format. Uganda numbers start with 0 (local)
// but must be sent as 256... for wa.me links to resolve correctly.
function toIntlPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("256")) return digits;         // already international
  if (digits.startsWith("0")) return "256" + digits.slice(1); // 0772... → 256772...
  if (digits.length === 9) return "256" + digits;     // bare 9-digit → 256...
  return digits;
}

export default function Defaulters() {
  const user = getUser();
  const isBursar = user?.schoolRole === "bursar" || user?.schoolRole === "headTeacher";
  const { term: liveTerm, year: liveYear } = useCurrentTerm();
  // null = "not yet touched by the bursar" → tracks the live current term as
  // it resolves (including correcting itself if the query was still loading
  // or offline on first render). Once they pick a term/year explicitly, it
  // holds their choice and stops following the live value.
  const [termOverride, setTermOverride] = useState<number | null>(null);
  const [yearOverride, setYearOverride] = useState<number | null>(null);
  const term = termOverride ?? liveTerm;
  const year = yearOverride ?? liveYear;

  const { data: classes = [] } = trpc.class.getAll.useQuery();
  const { data: defaulters = [], isLoading } = trpc.fees.getDefaulters.useQuery({
    term,
    year,
    classId: filterClassId,
  });

  const smsMutation = trpc.sms.sendToDefaulters.useMutation({
    onSuccess: (data) => {
      toast.success(`SMS sent to ${data.success} parents. ${data.failed} failed.`);
      setSelected(new Set());
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleSelect = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectAll = () => {
    setSelected(new Set(defaulters.map((d) => d.studentId)));
  };

  const clearAll = () => setSelected(new Set());

  const totalOutstanding = defaulters.reduce((s, d) => s + d.totalOutstanding, 0);
  const currentTermTotal = defaulters.reduce((s, d) => s + d.currentTermBalance, 0);
  const arrearsTotal = defaulters.reduce((s, d) => s + d.arrearsBalance, 0);

  const handleSendSMS = () => {
    if (selected.size === 0) { toast.error("Select at least one student"); return; }
    smsMutation.mutate({ studentIds: Array.from(selected), term, year });
  };

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Defaulters</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Card className="min-w-0">
          <CardContent className="p-3 sm:p-4 text-center">
            <p className="text-2xl sm:text-3xl font-bold text-red-600 break-words">{defaulters.length}</p>
            <p className="text-xs text-muted-foreground mt-1">Total Defaulters</p>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardContent className="p-3 sm:p-4 text-center">
            <p className="text-base sm:text-lg font-bold text-red-600 break-words">{currentTermTotal.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-1">Current Term (UGX)</p>
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardContent className="p-3 sm:p-4 text-center">
            <p className="text-base sm:text-lg font-bold text-amber-600 break-words">{arrearsTotal.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground mt-1">Arrears (UGX)</p>
          </CardContent>
        </Card>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select onValueChange={(v) => setFilterClassId(v === "all" ? undefined : Number(v))}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All classes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All classes</SelectItem>
            {classes.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>

        {/* Term/year now drive the actual current-term/arrears split shown below, not just the SMS text */}
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-gray-400">Term</span>
          <Select value={String(term)} onValueChange={(v) => setTermOverride(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Term 1</SelectItem>
              <SelectItem value="2">Term 2</SelectItem>
              <SelectItem value="3">Term 3</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-gray-400">Year</span>
          <Select value={String(year)} onValueChange={(v) => setYearOverride(Number(v))}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[liveYear - 1, liveYear, liveYear + 1].map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button variant="outline" size="sm" onClick={selectAll}>Select All</Button>
        <Button variant="outline" size="sm" onClick={clearAll}>Clear</Button>

        {isBursar && (
          <Button
            size="sm"
            disabled={selected.size === 0 || smsMutation.isPending}
            onClick={handleSendSMS}
            className="ml-auto"
          >
            <MessageSquare className="h-4 w-4 mr-1" />
            {smsMutation.isPending ? "Sending..." : `Send SMS (${selected.size})`}
          </Button>
        )}
      </div>

      {/* Defaulters table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-center py-10 text-gray-400 text-sm">Loading...</p>
          ) : defaulters.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-green-600 font-medium">No defaulters!</p>
              <p className="text-gray-400 text-sm mt-1">All students are up to date.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted border-b">
                  <tr>
                    <th className="px-4 py-3 w-8" />
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Student</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Class</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Current Term</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Arrears</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Total</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Last Payment</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {defaulters.map((d) => (
                    <tr key={d.studentId} className={selected.has(d.studentId) ? "bg-blue-50" : "hover:bg-muted"}>
                      <td className="px-4 py-3">
                        <Checkbox
                          checked={selected.has(d.studentId)}
                          onCheckedChange={() => toggleSelect(d.studentId)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{d.student?.firstName} {d.student?.lastName}</p>
                        <p className="text-xs text-gray-400">{d.student?.admissionNumber}</p>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{d.className}</td>
                      <td className="px-4 py-3 text-right">
                        {d.currentTermBalance > 0 ? (
                          <span className="text-red-600 font-medium">{d.currentTermBalance.toLocaleString()}</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {d.arrearsBalance > 0 ? (
                          <span className="text-amber-600 font-medium">{d.arrearsBalance.toLocaleString()}</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-red-600">
                        {d.totalOutstanding.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {d.lastPaymentDate ?? "Never"}
                      </td>
                      <td className="px-4 py-3">
                        {d.student?.parentPhone && (
                          <a
                            href={`https://wa.me/${toIntlPhone(d.student.parentPhone)}?text=${encodeURIComponent(`Dear Parent, ${d.student.firstName} ${d.student.lastName} has outstanding fees of ${d.totalOutstanding.toLocaleString()} UGX. Please clear at the bursar's office.`)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-green-500 hover:text-green-700"
                            title="Send WhatsApp"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
