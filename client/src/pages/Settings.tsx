import { useState, useEffect } from "react";
import { trpc } from "../lib/trpc";
import { useCurrentTerm } from "../hooks/useCurrentTerm";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { toast } from "sonner";
import { Plus, Archive, UserPlus, Users, Trash2, Copy, Zap, Calendar } from "lucide-react";
import { getUser, getToken } from "../_core/hooks/useAuth";
import { AccountSettings } from "../components/AccountSettings";
import { OfflineSyncPanel } from "../components/OfflineSyncPanel";
import { isValidUgandaPhone } from "../../../shared/phone";
import { SUPPORT_WHATSAPP } from "../lib/const";

export default function Settings() {
  const user = getUser();
  const isOwner = !!user?.isOwner;
  const isHeadTeacher = user?.schoolRole === "headTeacher";
  const isBursar = user?.schoolRole === "bursar" || isHeadTeacher;
  const { term: currentTerm, year: currentYear, isLoading: termLoading } = useCurrentTerm();

  // ── Term dates — replaces the calendar-month guess that used to be
  // computed independently here (and eight other files) with real dates the
  // head teacher enters once per term, matching the actual Ministry calendar
  // instead of a fixed quarter split that was wrong ~11 weeks a year ──
  const { data: schoolTerms = [], refetch: refetchTerms } = trpc.school.getTerms.useQuery(undefined, { enabled: isHeadTeacher });
  const [termForm, setTermForm] = useState({ term: currentTerm, year: currentYear, startDate: "", endDate: "" });
  const setTermMutation = trpc.school.setTerm.useMutation({
    onSuccess: () => { toast.success("Term dates saved"); refetchTerms(); },
    onError: (e) => toast.error(e.message),
  });
  // Offered only when the saved term/year wasn't in the list before this
  // save — editing an existing term's dates (a correction, e.g. fixing a
  // typo'd end date) should never re-trigger a whole-school action as a
  // side effect. Deliberately NOT automatic even for a genuinely new term —
  // assigning fees for the whole school is exactly the kind of action that
  // already has its own review step (the Transfer to Next Term results
  // dialog below), and coupling it silently to saving two date fields would
  // remove that review, plus risk running before that term's fee structure
  // is actually ready (dates are often entered well ahead of the term
  // actually starting).
  const [showAssignPrompt, setShowAssignPrompt] = useState<{ term: number; year: number } | null>(null);
  async function handleSaveTerm() {
    const isNewTerm = !schoolTerms.some((t) => t.term === termForm.term && t.year === termForm.year);
    try {
      await setTermMutation.mutateAsync(termForm);
      if (isNewTerm) setShowAssignPrompt({ term: termForm.term, year: termForm.year });
    } catch {
      // setTermMutation's own onError above already showed a toast
    }
  }

  // ── Fee Structure (moved here from the Fees page — Record Payment is the
  // day-to-day bursar task and stays there; setting up what a class costs is
  // a setup/config task, and belongs with the rest of school configuration) ──
  const CATEGORIES = ["tuition","lunch","exam","uneb","development","uniform","boarding","transport","library","other"] as const;
  // CSS capitalize() only handles the first letter — fine for "tuition" →
  // "Tuition", wrong for "uneb" → "Uneb" instead of "UNEB". This is the one
  // category that needs a real label instead.
  function categoryLabel(cat: string) { return cat === "uneb" ? "UNEB" : cat; }
  const [feeStructureClassId, setFeeStructureClassId] = useState<number | null>(null);
  const [feeStructureTerm, setFeeStructureTerm] = useState(currentTerm);
  const [feeStructureYear, setFeeStructureYear] = useState(currentYear);
  const [showAddFeeRow, setShowAddFeeRow] = useState(false);
  const [showGenerateFees, setShowGenerateFees] = useState(false);
  const [newFeeRow, setNewFeeRow] = useState({ category: "tuition" as typeof CATEGORIES[number], label: "", amount: "" });
  const [pendingDeleteFeeRowId, setPendingDeleteFeeRowId] = useState<number | null>(null);

  const { data: structure = [], isLoading: structureLoading, refetch: refetchStructure } = trpc.feeStructure.get.useQuery(
    { classId: feeStructureClassId!, term: feeStructureTerm, year: feeStructureYear },
    { enabled: !!feeStructureClassId && !isOwner }
  );
  const structureTotal = structure.reduce((s, r) => s + parseFloat(r.amount), 0);

  const addFeeRowMutation = trpc.feeStructure.addRow.useMutation({
    onSuccess: () => { toast.success("Fee category added"); setShowAddFeeRow(false); refetchStructure(); setNewFeeRow({ category: "tuition", label: "", amount: "" }); },
    onError: (e) => toast.error(e.message),
  });
  const deleteFeeRowMutation = trpc.feeStructure.deleteRow.useMutation({
    onSuccess: () => { toast.success("Removed"); refetchStructure(); },
    onError: (e) => toast.error(e.message),
  });
  const copyFeeStructureMutation = trpc.feeStructure.copyFromLastTerm.useMutation({
    onSuccess: () => { toast.success("Copied from last term"); refetchStructure(); },
    onError: (e) => toast.error(e.message),
  });
  const generateFeesMutation = trpc.fees.generateForClass.useMutation({
    onSuccess: (data) => {
      toast.success(`Assigned fees for ${data.generated} students. ${data.skipped} skipped (already had fees for this term — new students get fees automatically now, this is only for backfilling).`);
      setShowGenerateFees(false);
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Transfer to Next Term — school-wide version of Assign Fees, across
  // every class at once, for whichever term the head teacher is moving into ──
  const nextTermDefault = currentTerm === 3
    ? { term: 1, year: currentYear + 1 }
    : { term: currentTerm + 1, year: currentYear };
  const [showTransferTerm, setShowTransferTerm] = useState(false);
  const [transferTerm, setTransferTerm] = useState(nextTermDefault.term);
  const [transferYear, setTransferYear] = useState(nextTermDefault.year);
  const [transferResult, setTransferResult] = useState<{
    studentsGenerated: number; studentsSkipped: number; term: number; year: number;
    classesWithNoStructure: string[]; classesWithNoStudents: string[];
    classesWithErrors: Array<{ name: string; error: string }>;
  } | null>(null);
  const transferTermMutation = trpc.fees.transferToNextTerm.useMutation({
    onSuccess: (data) => {
      setShowTransferTerm(false);
      // A results dialog the head teacher has to actively close, not a toast
      // that quietly disappears — this affects the whole school at once, and
      // "some students didn't get fees" is exactly the kind of thing that's
      // easy to miss in a toast and only notice weeks later.
      setTransferResult(data);
    },
    onError: (e) => toast.error(e.message),
  });

  // feeStructureTerm/Year and transferTerm/Year were seeded above from
  // whatever useCurrentTerm() returned on first render — which, before the
  // school.getCurrentTerm query resolves, is the same-shape fallback guess.
  // This corrects those defaults once the real value arrives. Only depends
  // on termLoading (true just once, on initial load, not on refetches) so it
  // can't overwrite a term/year the head teacher has since picked manually.
  useEffect(() => {
    if (termLoading) return;
    setFeeStructureTerm(currentTerm);
    setFeeStructureYear(currentYear);
    const next = currentTerm === 3
      ? { term: 1, year: currentYear + 1 }
      : { term: currentTerm + 1, year: currentYear };
    setTransferTerm(next.term);
    setTransferYear(next.year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termLoading]);

  const [rosterClass, setRosterClass] = useState<{ id: number; name: string } | null>(null);
  const { data: roster = [], isLoading: rosterLoading } = trpc.class.getRoster.useQuery(
    { classId: rosterClass?.id ?? 0, term: currentTerm, year: currentYear },
    { enabled: !!rosterClass }
  );

  const ROSTER_STATUS_COLORS: Record<string, string> = {
    cleared: "bg-green-100 text-green-700",
    partial: "bg-yellow-100 text-yellow-700",
    unpaid: "bg-red-100 text-red-700",
    waiver: "bg-gray-100 text-gray-600",
    noRecord: "bg-gray-50 text-gray-400",
  };

  // The owner's account has a dummy "school" row under the hood (created
  // mechanically at signup, same as any customer's), but none of these
  // school-admin queries are meaningful for them — they manage real schools
  // from /admin, not their own settings page. Skip fetching entirely.
  const { data: school, refetch: refetchSchool } = trpc.school.getMySchool.useQuery(undefined, { enabled: !isOwner });
  const { data: classes = [], refetch: refetchClasses } = trpc.class.getAll.useQuery(undefined, { enabled: !isOwner });
  const { data: staff = [], refetch: refetchStaff } = trpc.staff.list.useQuery(undefined, {
    enabled: isHeadTeacher && !isOwner, // only head teachers at a real school can see/manage staff
  });

  const [showAddStaff, setShowAddStaff] = useState(false);
  const [addingStaff, setAddingStaff] = useState(false);
  const EMPTY_STAFF_FORM = { name: "", email: "", password: "", schoolRole: "bursar" as "bursar" | "headTeacher" | "auditor" };
  const [staffForm, setStaffForm] = useState(EMPTY_STAFF_FORM);

  async function handleAddStaff() {
    setAddingStaff(true);
    try {
      const res = await fetch("/api/auth/create-staff", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify(staffForm),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to create staff account.");
        return;
      }
      toast.success(`${staffForm.name} added as ${staffForm.schoolRole === "headTeacher" ? "Head Teacher" : staffForm.schoolRole === "auditor" ? "Auditor" : "Bursar"}`);
      setShowAddStaff(false);
      setStaffForm(EMPTY_STAFF_FORM);
      refetchStaff();
    } catch {
      toast.error("Connection error. Please try again.");
    } finally {
      setAddingStaff(false);
    }
  }

  const [schoolForm, setSchoolForm] = useState({ name: "", district: "", schoolType: "", contactPhone: "" });

  // BUG FIX: Sync form with real school data when it loads
  // Without this, clicking Save with an untouched field sends empty string and overwrites real data
  useEffect(() => {
    if (school) {
      setSchoolForm({
        name: school.name ?? "",
        district: school.district ?? "",
        schoolType: school.schoolType ?? "",
        contactPhone: school.contactPhone ?? "",
      });
    }
  }, [school]);
  const [showCreateClass, setShowCreateClass] = useState(false);
  const [archiveTargetClass, setArchiveTargetClass] = useState<{ id: number; name: string } | null>(null);
  const [classForm, setClassForm] = useState({ level: "", stream: "none", capacity: "50", academicYear: String(currentYear) });

  const updateSchoolMutation = trpc.school.updateDetails.useMutation({
    onSuccess: () => { toast.success("School details updated"); refetchSchool(); },
    onError: (e) => toast.error(e.message),
  });

  const createClassMutation = trpc.class.create.useMutation({
    onSuccess: () => { toast.success("Class created"); setShowCreateClass(false); refetchClasses(); },
    onError: (e) => toast.error(e.message),
  });

  const archiveClassMutation = trpc.class.archive.useMutation({
    onSuccess: () => { toast.success("Class archived"); setArchiveTargetClass(null); refetchClasses(); },
    onError: (e) => toast.error(e.message),
  });

  const [deactivateTarget, setDeactivateTarget] = useState<{ id: number; name: string } | null>(null);
  const deactivateStaffMutation = trpc.staff.deactivate.useMutation({
    onSuccess: () => { toast.success("Staff account deactivated"); setDeactivateTarget(null); refetchStaff(); },
    onError: (e) => toast.error(e.message),
  });
  const reactivateStaffMutation = trpc.staff.reactivate.useMutation({
    onSuccess: () => { toast.success("Staff account reactivated"); refetchStaff(); },
    onError: (e) => toast.error(e.message),
  });

  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const regenerateCodeMutation = trpc.school.regenerateCode.useMutation({
    onSuccess: () => { toast.success("Portal code regenerated — the old link no longer works"); setShowRegenerateConfirm(false); refetchSchool(); },
    onError: (e) => toast.error(e.message),
  });

  const [promoteFromClassId, setPromoteFromClassId] = useState<number | undefined>();
  const [promoteToClassId, setPromoteToClassId] = useState<number | undefined>();
  const [graduateClassId, setGraduateClassId] = useState<number | undefined>();
  const [confirmGraduate, setConfirmGraduate] = useState(false);
  const graduateMutation = trpc.class.graduate.useMutation({
    onSuccess: (result) => {
      toast.success(result.graduated > 0 ? `${result.graduated} student(s) graduated (archived)` : "No active students in that class");
      setGraduateClassId(undefined);
      setConfirmGraduate(false);
      refetchClasses();
    },
    onError: (e) => toast.error(e.message),
  });
  const promoteMutation = trpc.class.promote.useMutation({
    onSuccess: (result) => {
      toast.success(result.moved > 0 ? `${result.moved} student(s) promoted` : "No active students in that class");
      setPromoteFromClassId(undefined);
      setPromoteToClassId(undefined);
      refetchClasses();
    },
    onError: (e) => toast.error(e.message),
  });

  const LEVELS = ["baby","middle","top","P1","P2","P3","P4","P5","P6","P7","S1","S2","S3","S4","S5","S6"];
  const STREAMS = ["none","A","B","C","D","E","W","N","S"];

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <AccountSettings />

      {!isOwner && <OfflineSyncPanel />}

      {isOwner ? null : <>

      {/* School details */}
      {isHeadTeacher && (
        <Card>
          <CardHeader><CardTitle className="text-base">School Details</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label>School Name</Label>
              <Input
                value={schoolForm.name}
                placeholder="School name"
                onChange={(e) => setSchoolForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>District</Label>
                <Input
                  value={schoolForm.district}
                  onChange={(e) => setSchoolForm((f) => ({ ...f, district: e.target.value }))}
                />
              </div>
              <div>
                <Label>School Type</Label>
                <Select value={schoolForm.schoolType} onValueChange={(v) => setSchoolForm((f) => ({ ...f, schoolType: v }))}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select type" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary">Primary</SelectItem>
                    <SelectItem value="secondary">Secondary</SelectItem>
                    <SelectItem value="nursery">Nursery</SelectItem>
                    <SelectItem value="combined">Combined</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Contact Phone</Label>
              <Input
                value={schoolForm.contactPhone}
                onChange={(e) => setSchoolForm((f) => ({ ...f, contactPhone: e.target.value }))}
              />
              <p className="text-xs text-gray-400 mt-1">Password-reset codes go to this number — keep it correct.</p>
              {schoolForm.contactPhone && !isValidUgandaPhone(schoolForm.contactPhone) && (
                <p className="text-xs text-red-500 mt-1">Not a valid Uganda number</p>
              )}
            </div>
            {school && (
              <div className="bg-gray-50 rounded px-3 py-2">
                <p className="text-xs text-gray-500">Parent Portal Code</p>
                <p className="text-lg font-mono font-bold text-indigo-700">{school.schoolCode}</p>
                <p className="text-xs text-gray-400">Share this URL with parents:</p>
                <p className="text-xs text-blue-500 break-all">
                  {window.location.origin}/portal/{school.schoolCode}
                </p>
                {isHeadTeacher && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-gray-500 mt-1"
                    onClick={() => setShowRegenerateConfirm(true)}
                  >
                    Regenerate code
                  </Button>
                )}
              </div>
            )}
            <Button
              disabled={
                updateSchoolMutation.isPending || !schoolForm.name.trim() || !school ||
                (!!schoolForm.contactPhone && !isValidUgandaPhone(schoolForm.contactPhone))
              }
              onClick={() => updateSchoolMutation.mutate({
                name: schoolForm.name,
                // Bug 23: pass undefined for empty optional fields so they don't overwrite real data
                district: schoolForm.district || undefined,
                schoolType: schoolForm.schoolType || undefined,
                contactPhone: schoolForm.contactPhone || undefined,
              })}
            >
              Save Changes
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Term dates — set once per term with real Ministry-calendar dates,
          instead of the system guessing from the calendar month. Only needs
          updating ~3 times a year, whenever a new term actually starts. */}
      {isHeadTeacher && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4" /> Term Dates
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-gray-400">
              Enter the real start and end date for each term as the Ministry publishes them.
              This is what the whole app uses to know what term it currently is — without it,
              the system falls back to a rough guess that's wrong during school holidays.
            </p>
            {schoolTerms.length > 0 && (
              <div className="space-y-1">
                {schoolTerms.map((t) => (
                  <div key={t.id} className="flex items-center justify-between bg-gray-50 rounded px-3 py-2 text-sm">
                    <span className="font-medium">Term {t.term} · {t.year}</span>
                    <span className="text-gray-500 text-xs">{t.startDate} → {t.endDate}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Term</Label>
                <Select value={String(termForm.term)} onValueChange={(v) => setTermForm((f) => ({ ...f, term: Number(v) }))}>
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
                <Input
                  type="number"
                  value={termForm.year}
                  onChange={(e) => setTermForm((f) => ({ ...f, year: Number(e.target.value) }))}
                />
              </div>
              <div>
                <Label>Start Date</Label>
                <Input
                  type="date"
                  value={termForm.startDate}
                  onChange={(e) => setTermForm((f) => ({ ...f, startDate: e.target.value }))}
                />
              </div>
              <div>
                <Label>End Date</Label>
                <Input
                  type="date"
                  value={termForm.endDate}
                  onChange={(e) => setTermForm((f) => ({ ...f, endDate: e.target.value }))}
                />
              </div>
            </div>
            <Button
              disabled={setTermMutation.isPending || !termForm.startDate || !termForm.endDate}
              onClick={handleSaveTerm}
            >
              {setTermMutation.isPending ? "Saving..." : "Save Term Dates"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Staff accounts (Bug 15) */}
      {isHeadTeacher && (
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle className="text-base">Staff Accounts</CardTitle>
              <Button size="sm" onClick={() => setShowAddStaff(true)}>
                <UserPlus className="h-4 w-4 mr-1" /> Add Staff
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {staff.length === 0 ? (
              <div className="py-8 text-center space-y-1">
                <p className="text-gray-500 text-sm">No staff accounts yet.</p>
                <p className="text-gray-400 text-xs">Invite a bursar or auditor so they can sign in with their own email.</p>
              </div>
            ) : (
              <div className="divide-y">
                {staff.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate">
                        {s.name}
                        {s.email === user?.email && <span className="text-gray-400 font-normal"> (you)</span>}
                      </p>
                      <p className="text-xs text-gray-400 truncate">{s.email}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                        s.schoolRole === "headTeacher" ? "bg-indigo-50 text-indigo-700" :
                        s.schoolRole === "auditor" ? "bg-gray-100 text-gray-600" :
                        "bg-emerald-50 text-emerald-700"
                      }`}>
                        {s.schoolRole === "headTeacher" ? "Head Teacher" : s.schoolRole === "auditor" ? "Auditor" : "Bursar"}
                      </span>
                      {!s.isActive && (
                        <span className="text-xs px-2 py-1 rounded-full font-medium bg-gray-100 text-gray-500">
                          Deactivated
                        </span>
                      )}
                      {s.email !== user?.email && (
                        s.isActive ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-500 hover:text-red-600 hover:bg-red-50 h-7 px-2 text-xs"
                            onClick={() => setDeactivateTarget({ id: s.id, name: s.name })}
                          >
                            Deactivate
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={reactivateStaffMutation.isPending}
                            onClick={() => reactivateStaffMutation.mutate({ userId: s.id })}
                          >
                            Reactivate
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Class management */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle className="text-base">Classes</CardTitle>
            {isHeadTeacher && (
              <Button size="sm" onClick={() => setShowCreateClass(true)}>
                <Plus className="h-4 w-4 mr-1" /> New Class
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {classes.length === 0 ? (
            <div className="py-8 text-center space-y-1">
              <p className="text-gray-500 text-sm">No classes yet.</p>
              <p className="text-gray-400 text-xs">Create classes (e.g. P1, S1) before adding students.</p>
            </div>
          ) : (
            <div className="divide-y">
              {classes.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate">{c.name}</p>
                    <p className="text-xs text-gray-400 truncate">{c.academicYear} · Capacity: {c.capacity}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      className="text-gray-400 hover:text-indigo-600 transition-colors"
                      title="View roster"
                      onClick={() => setRosterClass({ id: c.id, name: c.name })}
                    >
                      <Users className="h-4 w-4" />
                    </button>
                    {isHeadTeacher && (
                      <button
                        className="text-gray-400 hover:text-red-500 transition-colors"
                        title="Archive class"
                        onClick={() => setArchiveTargetClass({ id: c.id, name: c.name })}
                      >
                        <Archive className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {isBursar && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div>
              <CardTitle className="text-base">Fee Structure</CardTitle>
              <p className="text-xs text-gray-500">
                What each class costs, per term. New students get their fees assigned automatically using whatever's set here — this only needs updating when prices change or a new term starts.
              </p>
            </div>
            {isHeadTeacher && (
              <Button size="sm" variant="outline" className="shrink-0" onClick={() => setShowTransferTerm(true)}>
                Transfer to Next Term
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="min-w-0">
                <Label>Class</Label>
                <Select onValueChange={(v) => setFeeStructureClassId(Number(v))}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select class" /></SelectTrigger>
                  <SelectContent>
                    {classes.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0">
                <Label>Term</Label>
                <Select defaultValue={String(feeStructureTerm)} onValueChange={(v) => setFeeStructureTerm(Number(v))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Term 1</SelectItem>
                    <SelectItem value="2">Term 2</SelectItem>
                    <SelectItem value="3">Term 3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0">
                <Label>Year</Label>
                <Input
                  type="number"
                  value={feeStructureYear}
                  min={2020}
                  max={2040}
                  onChange={(e) => setFeeStructureYear(Math.min(2040, Math.max(2020, Number(e.target.value))))}
                />
              </div>
            </div>

            {feeStructureClassId && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setShowAddFeeRow(true)}>
                    <Plus className="h-4 w-4 mr-1" /> Add Category
                  </Button>
                  <Button size="sm" variant="outline" disabled={copyFeeStructureMutation.isPending} onClick={() => {
                    const prevTerm = feeStructureTerm === 1 ? 3 : feeStructureTerm - 1;
                    const prevYear = feeStructureTerm === 1 ? feeStructureYear - 1 : feeStructureYear;
                    copyFeeStructureMutation.mutate({ classId: feeStructureClassId, fromTerm: prevTerm, fromYear: prevYear, toTerm: feeStructureTerm, toYear: feeStructureYear });
                  }}>
                    <Copy className="h-4 w-4 mr-1" /> {copyFeeStructureMutation.isPending ? "Copying..." : "Copy from Last Term"}
                  </Button>
                  <Button size="sm" variant="default" className="bg-green-600 hover:bg-green-700" onClick={() => setShowGenerateFees(true)}>
                    <Zap className="h-4 w-4 mr-1" /> Assign Fees for Existing Students
                  </Button>
                </div>

                {structure.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-6">
                    {structureLoading ? "Loading..." : "No fee structure set. Add categories above."}
                  </p>
                ) : (
                  <div className="border rounded-lg overflow-x-auto">
                    <table className="w-full text-sm min-w-[420px]">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium text-gray-600">Category</th>
                          <th className="text-left px-4 py-2 font-medium text-gray-600">Label</th>
                          <th className="text-right px-4 py-2 font-medium text-gray-600">Amount (UGX)</th>
                          <th className="px-4 py-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {structure.map((row) => (
                          <tr key={row.id}>
                            <td className="px-4 py-2 capitalize text-gray-700">{categoryLabel(row.category)}</td>
                            <td className="px-4 py-2 text-gray-600">{row.label}</td>
                            <td className="px-4 py-2 text-right font-medium">{parseFloat(row.amount).toLocaleString()}</td>
                            <td className="px-4 py-2 text-right">
                              <button
                                onClick={() => setPendingDeleteFeeRowId(row.id)}
                                className="text-red-400 hover:text-red-600"
                                disabled={deleteFeeRowMutation.isPending}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                        <tr className="bg-gray-50 font-semibold">
                          <td colSpan={2} className="px-4 py-2 text-gray-700">Total per student</td>
                          <td className="px-4 py-2 text-right">{structureTotal.toLocaleString()} UGX</td>
                          <td />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {isHeadTeacher && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Promote Class</CardTitle>
            <p className="text-xs text-gray-500">
              Move every active student from one class to another at once — e.g. end of year, P3 → P4.
            </p>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[140px]">
              <Label className="text-xs">From</Label>
              <Select value={promoteFromClassId ? String(promoteFromClassId) : undefined} onValueChange={(v) => setPromoteFromClassId(Number(v))}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Source class" /></SelectTrigger>
                <SelectContent>
                  {classes.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <Label className="text-xs">To</Label>
              <Select value={promoteToClassId ? String(promoteToClassId) : undefined} onValueChange={(v) => setPromoteToClassId(Number(v))}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Destination class" /></SelectTrigger>
                <SelectContent>
                  {classes.filter((c) => c.id !== promoteFromClassId).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              disabled={!promoteFromClassId || !promoteToClassId || promoteMutation.isPending}
              onClick={() => {
                if (promoteFromClassId && promoteToClassId) {
                  promoteMutation.mutate({ fromClassId: promoteFromClassId, toClassId: promoteToClassId });
                }
              }}
            >
              {promoteMutation.isPending ? "Promoting..." : "Promote"}
            </Button>
          </CardContent>
        </Card>
      )}

      {isHeadTeacher && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Graduate a Class</CardTitle>
            <p className="text-xs text-gray-500">
              For your final class (e.g. P7) — archives every active student in one go instead of one at a time. This can't be undone from here.
            </p>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-2">
            <div className="flex-1 min-w-[140px]">
              <Label className="text-xs">Class</Label>
              <Select value={graduateClassId ? String(graduateClassId) : undefined} onValueChange={(v) => setGraduateClassId(Number(v))}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Graduating class" /></SelectTrigger>
                <SelectContent>
                  {classes.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="destructive"
              disabled={!graduateClassId || graduateMutation.isPending}
              onClick={() => setConfirmGraduate(true)}
            >
              Graduate
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Subscription info */}
      <Card>
        <CardHeader><CardTitle className="text-base">Subscription</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Status</span>
              <span className="font-medium capitalize">{user?.subscriptionStatus}</span>
            </div>
            {user?.trialEndsAt && (
              <div className="flex justify-between">
                <span className="text-gray-600">Trial ends</span>
                <span>{new Date(user.trialEndsAt).toLocaleDateString()}</span>
              </div>
            )}
            <p className="text-xs text-gray-400 pt-2">
              To upgrade or renew, contact us on{" "}
              <a
                href={`https://wa.me/${SUPPORT_WHATSAPP}?text=Hi, I'd like to activate ScholarBase for ${school?.name ?? "my school"}`}
                className="text-green-600 underline"
                target="_blank"
                rel="noreferrer"
              >
                WhatsApp
              </a>
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Add Staff Dialog (Bug 15) */}
      <Dialog open={showAddStaff} onOpenChange={(open) => { setShowAddStaff(open); if (!open) setStaffForm(EMPTY_STAFF_FORM); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Staff Account</DialogTitle>
            <DialogDescription>They'll sign in with this email and password right away.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Full Name *</Label>
              <Input
                value={staffForm.name}
                placeholder="e.g. Sarah Namutebi"
                onChange={(e) => setStaffForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div>
              <Label>Email *</Label>
              <Input
                type="email"
                value={staffForm.email}
                placeholder="bursar@school.com"
                onChange={(e) => setStaffForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div>
              <Label>Password *</Label>
              <Input
                type="password"
                value={staffForm.password}
                placeholder="At least 8 characters"
                onChange={(e) => setStaffForm((f) => ({ ...f, password: e.target.value }))}
              />
            </div>
            <div>
              <Label>Role</Label>
              <Select
                value={staffForm.schoolRole}
                onValueChange={(v) => setStaffForm((f) => ({ ...f, schoolRole: v as "bursar" | "headTeacher" | "auditor" }))}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bursar">Bursar</SelectItem>
                  <SelectItem value="headTeacher">Head Teacher</SelectItem>
                  <SelectItem value="auditor">Auditor (read-only)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-400 mt-1">
                Bursars manage fees and SMS. Head Teachers have full access including school settings.
                Auditors can view everything — fee status, payments, the audit log — but can't record
                payments, waive fees, or change anything.
              </p>
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => { setShowAddStaff(false); setStaffForm(EMPTY_STAFF_FORM); }}
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={
                addingStaff ||
                staffForm.name.trim().length < 2 ||
                !staffForm.email.includes("@") ||
                staffForm.password.length < 8
              }
              onClick={handleAddStaff}
            >
              {addingStaff ? "Adding..." : "Add Staff"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Class Dialog */}
      <Dialog open={showCreateClass} onOpenChange={setShowCreateClass}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Class</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Level *</Label>
                <Select onValueChange={(v) => setClassForm((f) => ({ ...f, level: v }))}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select level" /></SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Stream</Label>
                <Select defaultValue="none" onValueChange={(v) => setClassForm((f) => ({ ...f, stream: v }))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STREAMS.map((s) => <SelectItem key={s} value={s}>{s === "none" ? "No stream" : s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Capacity</Label>
                <Input type="number" value={classForm.capacity} onChange={(e) => setClassForm((f) => ({ ...f, capacity: e.target.value }))} />
              </div>
              <div>
                <Label>Academic Year</Label>
                <Input type="number" value={classForm.academicYear} onChange={(e) => setClassForm((f) => ({ ...f, academicYear: e.target.value }))} />
              </div>
            </div>
            {classForm.level && (
              <p className="text-sm text-gray-500">
                Class name: <strong>{classForm.stream === "none" ? classForm.level : `${classForm.level}${classForm.stream}`}</strong>
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowCreateClass(false)}>Cancel</Button>
            <Button
              className="flex-1"
              disabled={!classForm.level || createClassMutation.isPending}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onClick={() => createClassMutation.mutate({
                level: classForm.level as any,
                stream: classForm.stream as any,
                capacity: Number(classForm.capacity),
                academicYear: Number(classForm.academicYear),
              })}
            >
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!archiveTargetClass} onOpenChange={() => setArchiveTargetClass(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {archiveTargetClass?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This class will be hidden from all lists, including fee setup and roster views.
              If it still has active students enrolled, transfer them to another class first —
              archiving will be blocked otherwise.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={archiveClassMutation.isPending}
              onClick={() => {
                if (archiveTargetClass) {
                  archiveClassMutation.mutate({ classId: archiveTargetClass.id });
                }
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmGraduate} onOpenChange={setConfirmGraduate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Graduate {classes.find((c) => c.id === graduateClassId)?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every active student in this class will be archived — this is for a school's final class
              (students leaving the school entirely), not a mid-school promotion. This can't be undone
              from here; a school administrator would need to reactivate students individually if reversed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={graduateMutation.isPending}
              onClick={() => {
                if (graduateClassId) {
                  graduateMutation.mutate({ classId: graduateClassId, reason: "Graduated" });
                }
              }}
            >
              {graduateMutation.isPending ? "Graduating..." : "Graduate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deactivateTarget} onOpenChange={() => setDeactivateTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactivateTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They'll be signed out immediately and won't be able to log back in until you
              reactivate them. Their account and history are kept, not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={deactivateStaffMutation.isPending}
              onClick={() => {
                if (deactivateTarget) {
                  deactivateStaffMutation.mutate({ userId: deactivateTarget.id });
                }
              }}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showRegenerateConfirm} onOpenChange={setShowRegenerateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate the parent portal code?</AlertDialogTitle>
            <AlertDialogDescription>
              The current code stops working immediately, including any "/portal/{school?.schoolCode}"
              link already shared with parents. You'll need to share the new link with everyone again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              disabled={regenerateCodeMutation.isPending}
              onClick={() => regenerateCodeMutation.mutate()}
            >
              Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* View Roster Dialog — wired to class.getRoster, scoped to the current term */}
      <Dialog open={!!rosterClass} onOpenChange={(open) => !open && setRosterClass(null)}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{rosterClass?.name} Roster</DialogTitle>
            <DialogDescription>Fee status for Term {currentTerm}, {currentYear}</DialogDescription>
          </DialogHeader>
          {rosterLoading ? (
            <p className="text-sm text-gray-400 py-8 text-center">Loading...</p>
          ) : roster.length === 0 ? (
            <p className="text-sm text-gray-400 py-8 text-center">No active students in this class.</p>
          ) : (
            <div className="divide-y">
              {roster.map((s) => (
                <div key={s.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="text-sm font-medium">{s.firstName} {s.lastName}</p>
                    <p className="text-xs text-gray-400">{s.admissionNumber}</p>
                    {s.billedUnderDifferentClass && (
                      <p className="text-xs text-amber-600 mt-0.5">
                        Billed at previous class's rate (transferred mid-term)
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ROSTER_STATUS_COLORS[s.feeStatus] ?? ""}`}>
                      {s.feeStatus === "noRecord" ? "no fee record" : s.feeStatus}
                    </span>
                    {s.outstandingBalance > 0 && (
                      <p className="text-xs text-gray-400 mt-0.5">{s.outstandingBalance.toLocaleString()} UGX due</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Fee Category Dialog */}
      <Dialog open={showAddFeeRow} onOpenChange={setShowAddFeeRow}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Fee Category</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Category</Label>
              <Select defaultValue="tuition" onValueChange={(v) => setNewFeeRow((r) => ({ ...r, category: v as typeof CATEGORIES[number] }))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => <SelectItem key={c} value={c} className="capitalize">{categoryLabel(c)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Label (display name)</Label>
              <Input placeholder="e.g. Tuition Fees" value={newFeeRow.label} onChange={(e) => setNewFeeRow((r) => ({ ...r, label: e.target.value }))} />
            </div>
            <div>
              <Label>Amount (UGX)</Label>
              <Input type="number" min="1" step="1" placeholder="150000" value={newFeeRow.amount} onChange={(e) => setNewFeeRow((r) => ({ ...r, amount: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowAddFeeRow(false)}>Cancel</Button>
            <Button className="flex-1" disabled={!newFeeRow.label || !newFeeRow.amount || addFeeRowMutation.isPending}
              onClick={() => feeStructureClassId && addFeeRowMutation.mutate({ classId: feeStructureClassId, term: feeStructureTerm, year: feeStructureYear, category: newFeeRow.category, label: newFeeRow.label, amount: Number(newFeeRow.amount) })}>
              Add
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Assign Fees Dialog */}
      <Dialog open={showGenerateFees} onOpenChange={setShowGenerateFees}>
        <DialogContent>
          <DialogHeader><DialogTitle>Assign Fees</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">
            Creates fee records for active students in this class who don't already have them for Term {feeStructureTerm} {feeStructureYear} —
            newly-enrolled students already get this automatically, so this is mainly for backfilling students who existed before the fee
            structure was set, or after a price change.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowGenerateFees(false)}>Cancel</Button>
            <Button className="flex-1 bg-green-600 hover:bg-green-700" disabled={generateFeesMutation.isPending}
              onClick={() => feeStructureClassId && generateFeesMutation.mutate({ classId: feeStructureClassId, term: feeStructureTerm, year: feeStructureYear })}>
              {generateFeesMutation.isPending ? "Assigning..." : "Assign"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Transfer to Next Term Dialog */}
      <Dialog open={showTransferTerm} onOpenChange={setShowTransferTerm}>
        <DialogContent>
          <DialogHeader><DialogTitle>Transfer to Next Term</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">
            Assigns fees for every class that already has a fee structure set for the term below — same as running Assign Fees
            for each class one at a time, done for the whole school at once. Classes without a fee structure yet for that term are
            skipped and listed afterward, not silently missed. Any unpaid balance from the current term stays visible as arrears —
            nothing is deleted or lost.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Term</Label>
              <Select value={String(transferTerm)} onValueChange={(v) => setTransferTerm(Number(v))}>
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
              <Input
                type="number"
                value={transferYear}
                min={2020}
                max={2040}
                onChange={(e) => setTransferYear(Math.min(2040, Math.max(2020, Number(e.target.value))))}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowTransferTerm(false)}>Cancel</Button>
            <Button className="flex-1 bg-green-600 hover:bg-green-700" disabled={transferTermMutation.isPending}
              onClick={() => transferTermMutation.mutate({ term: transferTerm, year: transferYear })}>
              {transferTermMutation.isPending ? "Transferring..." : `Transfer to Term ${transferTerm} ${transferYear}`}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Shown once, right after saving dates for a term that wasn't
          configured before. Declining just closes it — the dates are already
          saved either way, this only offers the next step. */}
      <AlertDialog open={!!showAssignPrompt} onOpenChange={(open) => !open && setShowAssignPrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Assign fees for Term {showAssignPrompt?.term} {showAssignPrompt?.year} now?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This is a new term. Assigning fees now creates fee records for every class that
              already has a fee structure set for it — same whole-school action as Transfer to
              Next Term above. Classes without a fee structure yet are skipped and listed
              afterward, not silently missed. You can also do this later from the button above.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowAssignPrompt(null)}>Not now</AlertDialogCancel>
            <AlertDialogAction
              disabled={transferTermMutation.isPending}
              onClick={() => {
                if (!showAssignPrompt) return;
                transferTermMutation.mutate({ term: showAssignPrompt.term, year: showAssignPrompt.year });
                setShowAssignPrompt(null);
              }}
            >
              {transferTermMutation.isPending ? "Assigning..." : "Assign Fees"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Transfer Results Dialog — stays open until dismissed, unlike a toast */}
      <Dialog open={!!transferResult} onOpenChange={(open) => !open && setTransferResult(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Transfer to Term {transferResult?.term} {transferResult?.year}</DialogTitle></DialogHeader>
          {transferResult && (
            <div className="space-y-3">
              <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-800">
                {transferResult.studentsGenerated} student{transferResult.studentsGenerated === 1 ? "" : "s"} moved into this term
                {transferResult.studentsSkipped > 0 && ` — ${transferResult.studentsSkipped} already had fees for it`}
              </div>

              {transferResult.classesWithNoStructure.length === 0 &&
               transferResult.classesWithNoStudents.length === 0 &&
               transferResult.classesWithErrors.length === 0 && (
                <p className="text-sm text-gray-500">Every class with students was covered.</p>
              )}

              {transferResult.classesWithNoStructure.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  <p className="text-sm font-medium text-amber-800">
                    No fee structure set for this term — nobody in these classes got fees:
                  </p>
                  <p className="text-sm text-amber-700 mt-1">{transferResult.classesWithNoStructure.join(", ")}</p>
                  <p className="text-xs text-amber-600 mt-1">Set up their fee structure above, then run Transfer again.</p>
                </div>
              )}

              {transferResult.classesWithErrors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  <p className="text-sm font-medium text-red-800">These classes hit an error and need another look:</p>
                  {transferResult.classesWithErrors.map((c) => (
                    <p key={c.name} className="text-xs text-red-700 mt-1">{c.name} — {c.error}</p>
                  ))}
                </div>
              )}

              {transferResult.classesWithNoStudents.length > 0 && (
                <p className="text-xs text-gray-400">No active students (so nothing to bill): {transferResult.classesWithNoStudents.join(", ")}</p>
              )}
            </div>
          )}
          <Button className="w-full" onClick={() => setTransferResult(null)}>Done</Button>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!pendingDeleteFeeRowId} onOpenChange={(open) => !open && setPendingDeleteFeeRowId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete fee category?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the category from the fee structure. Existing fee records for students are not deleted.
              If fees have already been assigned, removing this category will create a discrepancy.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingDeleteFeeRowId(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (pendingDeleteFeeRowId) deleteFeeRowMutation.mutate({ id: pendingDeleteFeeRowId });
                setPendingDeleteFeeRowId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      </>}
    </div>
  );
}
