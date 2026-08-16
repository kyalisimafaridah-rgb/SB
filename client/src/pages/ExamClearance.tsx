import { useState } from "react";
import { trpc } from "../lib/trpc";
import { useCurrentTerm } from "../hooks/useCurrentTerm";
import { Card, CardContent } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { toast } from "sonner";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../components/ui/alert-dialog";
import { getUser } from "../_core/hooks/useAuth";

export default function ExamClearance() {
  const user = getUser();
  const isBursar = user?.schoolRole === "bursar" || user?.schoolRole === "headTeacher";
  const { term: liveTerm, year: liveYear } = useCurrentTerm();
  const [termOverride, setTermOverride] = useState<number | null>(null);
  const [yearOverride, setYearOverride] = useState<number | null>(null);
  const term = termOverride ?? liveTerm;
  const year = yearOverride ?? liveYear;
  const [filterClassId, setFilterClassId] = useState<number | null>(null);
  const [pendingToggle, setPendingToggle] = useState<{ studentId: number; name: string; cleared: boolean } | null>(null);
  // Bug 14: track which specific student is being toggled so only that row shows a spinner
  const [togglingStudentId, setTogglingStudentId] = useState<number | null>(null);

  const { data: clearanceList = [], isLoading, refetch } = trpc.fees.getExamClearanceList.useQuery({ term, year });
  const { data: classes = [] } = trpc.class.getAll.useQuery();

  const clearanceMutation = trpc.fees.setExamClearance.useMutation({
    onSuccess: () => {
      refetch();
      setTogglingStudentId(null);
    },
    onError: (e) => {
      toast.error(e.message);
      setTogglingStudentId(null);
    },
  });

  const filtered = filterClassId === null
    ? clearanceList
    : clearanceList.filter((s) => s.student.classId === filterClassId);

  const clearedCount = filtered.filter((s) => s.examCleared).length;
  const totalCount = filtered.length;

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Exam Clearance</h1>

      <div className="flex gap-3 flex-wrap items-end">
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
              {[liveYear, liveYear - 1, liveYear - 2, liveYear - 3].map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Class</Label>
          <Select defaultValue="all" onValueChange={(v) => setFilterClassId(v === "all" ? null : Number(v))}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All classes</SelectItem>
              {classes.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="ml-auto text-sm text-muted-foreground">
          {clearedCount} / {totalCount} cleared
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-center py-10 text-gray-400 text-sm">Loading...</p>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center space-y-1 px-4">
              <p className="text-muted-foreground text-sm">No students found for the selected term.</p>
              <p className="text-gray-400 text-xs">Add students and assign fee records for this term first (Students + Fees / Settings).</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Student</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Class</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Outstanding</th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">Status</th>
                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">Toggle</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((s) => {
                    const isToggling = togglingStudentId === s.student.id;
                    // Bug 27: students with no fee records have nothing to clear — disable their toggle
                    const canToggle = s.hasFeeRecords;
                    return (
                      <tr key={s.student.id} className="hover:bg-muted">
                        <td className="px-4 py-3">
                          <p className="font-medium">{s.student.firstName} {s.student.lastName}</p>
                          <p className="text-xs text-gray-400">{s.student.admissionNumber}</p>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{s.className}</td>
                        <td className="px-4 py-3 text-right">
                          {s.outstandingBalance > 0 ? (
                            <span className="text-red-600 font-medium">{s.outstandingBalance.toLocaleString()} UGX</span>
                          ) : (
                            <span className="text-green-600">Paid</span>
                          )}
                          {s.hasWaiver && <span className="text-xs text-gray-400 ml-1">(waiver)</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {s.examCleared ? (
                            <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium">
                              <CheckCircle className="h-4 w-4" /> Cleared
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-red-500 text-xs font-medium">
                              <XCircle className="h-4 w-4" /> Not cleared
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {/* Bug 14: show spinner only for the row being toggled, not the whole table */}
                          {isToggling ? (
                            <Loader2 className="h-4 w-4 animate-spin mx-auto text-gray-400" />
                          ) : (
                            <Switch
                              checked={s.examCleared}
                              disabled={!canToggle || !isBursar || clearanceMutation.isPending}
                              title={
                                !isBursar
                                  ? "Bursar or head teacher access required"
                                  : !canToggle
                                    ? "Assign fees for this student first"
                                    : undefined
                              }
                              onCheckedChange={(checked) => {
                                setPendingToggle({
                                  studentId: s.student.id,
                                  name: `${s.student.firstName} ${s.student.lastName}`,
                                  cleared: checked,
                                });
                              }}
                            />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={!!pendingToggle} onOpenChange={(open) => !open && setPendingToggle(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingToggle?.cleared ? "Grant Exam Clearance" : "Revoke Exam Clearance"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingToggle?.cleared
                ? `Mark ${pendingToggle?.name} as cleared to sit exams?`
                : `Revoke exam clearance for ${pendingToggle?.name}? They will not be allowed to sit exams.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingToggle(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!pendingToggle) return;
                setTogglingStudentId(pendingToggle.studentId); // Bug 14: track which row
                clearanceMutation.mutate({
                  studentId: pendingToggle.studentId,
                  term,
                  year,
                  cleared: pendingToggle.cleared,
                });
                setPendingToggle(null);
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
