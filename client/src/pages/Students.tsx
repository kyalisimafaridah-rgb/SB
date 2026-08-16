import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "../lib/trpc";
import { getUser } from "../_core/hooks/useAuth";
import { useDebounce } from "../hooks/useDebounce";
import { useOfflineMutation } from "../hooks/useOfflineMutation";
import { useCurrentTerm } from "../hooks/useCurrentTerm";
import { useOfflineData } from "../hooks/useOfflineData";
import { STORES } from "../lib/offlineDb";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent } from "../components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Badge } from "../components/ui/badge";
import { toast } from "sonner";
import { Plus, Search, UserX, UserCheck, ArrowRightLeft, Upload, Download, Pencil, History, MoreVertical, CreditCard } from "lucide-react";
import { parseCsvToObjects, downloadCsv, normalizeDateOfBirth, normalizeGender, normalizeSpecialStatus } from "../lib/csv";
import { isValidUgandaPhone } from "../../../shared/phone";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "../components/ui/dropdown-menu";

const FEE_STATUS_COLORS: Record<string, string> = {
  cleared: "bg-green-100 text-green-700",
  partial: "bg-yellow-100 text-yellow-700",
  unpaid: "bg-red-100 text-red-700",
  waiver: "bg-gray-100 text-gray-600",
};

const AUDIT_FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  parentName: "Parent name",
  parentPhone: "Parent phone",
  parentPhone2: "Parent phone 2",
  classId: "Class",
  specialStatus: "Special status",
  gender: "Gender",
};

export default function Students() {
  const [, navigate] = useLocation();
  const user = getUser();
  const isBursar = user?.schoolRole === "bursar" || user?.schoolRole === "headTeacher";
  const isHeadTeacher = user?.schoolRole === "headTeacher";

  const { term: currentTerm, year: currentYear } = useCurrentTerm();

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300); // Bug 32: debounce to avoid API call on every keystroke
  const [selectedClassId, setSelectedClassId] = useState<number | undefined>();
  const [showAdd, setShowAdd] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [historyStudentId, setHistoryStudentId] = useState<number | null>(null);
  const [selectedStudent, setSelectedStudent] = useState<number | null>(null);
  // Bug 12: track current class of the student being transferred so we can exclude it
  const [selectedStudentClassId, setSelectedStudentClassId] = useState<number | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [transferClassId, setTransferClassId] = useState<number | undefined>();
  const [transferReason, setTransferReason] = useState("");
  const [importing, setImporting] = useState(false);
  // Off by default — existing search behavior (active students only) is
  // unchanged unless a head teacher deliberately opts in, e.g. to find and
  // undo a mistaken archive.
  const [includeArchived, setIncludeArchived] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const schoolId = user?.schoolId;

  const classesLive = trpc.class.getAll.useQuery();
  const { data: classes = [] } = useOfflineData(STORES.classes, schoolId, classesLive);

  const { data: searchResults = [], refetch: refetchSearch, isError: searchIsError } = trpc.student.search.useQuery(
    { query: debouncedSearch, classId: selectedClassId, includeArchived: isHeadTeacher && includeArchived },
    { enabled: debouncedSearch.length >= 2 }
  );
  const studentsLive = trpc.student.getAll.useQuery(undefined, { enabled: debouncedSearch.length < 2 });
  const { data: allStudents = [], refetch, isOffline: studentsOffline, cachedAt: studentsCachedAt } =
    useOfflineData(STORES.students, schoolId, studentsLive);

  // Bug 1: filter allStudents client-side when class filter is active but no search is running.
  // Also the offline fallback for search itself — when search.useQuery can't reach the server,
  // filter the cached full list the same way instead of showing nothing.
  const displayStudents = debouncedSearch.length >= 2
    ? (searchIsError ? allStudents.filter((s) =>
        `${s.firstName} ${s.lastName}`.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
        s.admissionNumber.toLowerCase().includes(debouncedSearch.toLowerCase())
      ) : searchResults)
    : selectedClassId
      ? allStudents.filter((s) => s.classId === selectedClassId)
      : allStudents;

  // Fetch fee statuses for the current term to show badges in the student list
  const { data: feeStatuses = {} } = trpc.student.getFeeStatuses.useQuery({
    term: currentTerm,
    year: currentYear,
  });

  const EMPTY_ADD_FORM = {
    classId: 0, firstName: "", lastName: "", dateOfBirth: "",
    gender: "" as "male" | "female" | "",
    parentName: "", parentPhone: "", parentPhone2: "", village: "",
    specialStatus: "none" as "none" | "orphan" | "staffChild" | "bursary",
    customTotalFee: "",
  };

  const [addForm, setAddForm] = useState(EMPTY_ADD_FORM);

  const EMPTY_EDIT_FORM = {
    studentId: 0, firstName: "", lastName: "", dateOfBirth: "",
    gender: "" as "male" | "female" | "",
    parentName: "", parentPhone: "", parentPhone2: "", village: "",
    specialStatus: "none" as "none" | "orphan" | "staffChild" | "bursary",
    customTotalFee: "",
  };

  const [editForm, setEditForm] = useState(EMPTY_EDIT_FORM);

  // History dialog: per-student audit log, available to every role (incl. auditors) —
  // staff.list is head-teacher-only, so we only attempt name lookup for that role and
  // fall back to "Staff #ID" for everyone else rather than erroring the query out.
  const { data: auditLog = [], isLoading: historyLoading } = trpc.student.getAuditLog.useQuery(
    { studentId: historyStudentId ?? 0 },
    { enabled: showHistory && historyStudentId !== null }
  );
  const { data: staffForNames = [] } = trpc.staff.list.useQuery(undefined, {
    enabled: showHistory && isHeadTeacher,
  });
  const staffNameById = new Map(staffForNames.map((s) => [s.id, s.name]));

  const addMutation = useOfflineMutation<Record<string, unknown>, { capacityWarning?: string | null; feesAutoGenerated?: boolean }>({
    procedure: "student.add",
    summary: (input) => `New student: ${input.firstName} ${input.lastName}`,
    onSuccess: (data, queued) => {
      if (queued) {
        toast.success("Student saved — will sync when back online");
      } else if (data.capacityWarning) {
        toast.warning(data.capacityWarning);
      } else if (data.feesAutoGenerated) {
        toast.success("Student added — fees assigned automatically for this term");
      } else {
        toast.success("Student added");
      }
      setShowAdd(false);
      setAddForm(EMPTY_ADD_FORM); // Bug 5: reset form so next student starts clean
      if (!queued) { refetch(); refetchSearch(); }
    },
    onError: (e) => toast.error(e.message),
  });
  const bulkImportMutation = trpc.student.bulkImport.useMutation({
    onSuccess: (result) => {
      const parts = [`${result.created} student(s) imported`];
      if (result.skipped.length > 0) parts.push(`${result.skipped.length} row(s) skipped`);
      if (result.duplicateWarnings.length > 0) parts.push(`${result.duplicateWarnings.length} possible duplicate name(s) — review these`);
      if (result.phoneWarnings.length > 0) parts.push(`${result.phoneWarnings.length} invalid phone number(s) — dropped, review these`);
      toast.success(parts.join(". "));
      if (result.skipped.length > 0) {
        console.warn("Import: skipped rows", result.skipped);
        toast.warning(
          `Skipped: ${result.skipped.slice(0, 5).map((s) => `row ${s.row} (${s.reason})`).join(", ")}` +
          (result.skipped.length > 5 ? ` and ${result.skipped.length - 5} more` : "")
        );
      }
      if (result.phoneWarnings.length > 0) {
        console.warn("Import: invalid phone numbers", result.phoneWarnings);
        toast.warning(
          `Invalid phone, dropped: ${result.phoneWarnings.slice(0, 5).map((w) => `row ${w.row} (${w.name}, ${w.field})`).join(", ")}` +
          (result.phoneWarnings.length > 5 ? ` and ${result.phoneWarnings.length - 5} more` : "")
        );
      }
      refetch();
      refetchSearch();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setImporting(false),
  });

  // Expected columns: First Name, Last Name, Class, Parent Name, Parent Phone,
  // Parent Phone 2, Gender, Date of Birth, Special Status, Village. Class is
  // matched by name (e.g. "P3B") against the school's existing classes — rows
  // with an unrecognized class name are skipped server-side, with the reason
  // reported back so they can be fixed and re-uploaded.
  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file after a fix
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      toast.error("File is too large (max 5 MB). Split the list and import in batches.");
      return;
    }
    if (!/\.(csv|txt)$/i.test(file.name) && file.type && !file.type.includes("csv") && !file.type.includes("text")) {
      toast.error("Please upload a CSV file (export from Excel as CSV).");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      if (text.includes(";") && (text.split("
")[0]?.split(";").length ?? 0) > (text.split("
")[0]?.split(",").length ?? 0)) {
        toast.error("This looks like a semicolon-separated file. In Excel: Save As → CSV (Comma delimited).");
        return;
      }

      const records = parseCsvToObjects(text);
      if (records.length === 0) {
        toast.error("That CSV has no data rows. Download the template and fill it in.");
        return;
      }
      if (records.length > 2000) {
        toast.error(`Too many rows (${records.length}). Import at most 2000 at a time.`);
        return;
      }

      // Support both canonical keys (from alias mapper) and legacy exact headers
      const classByName = new Map(classes.map((c) => [c.name.toLowerCase().trim(), c.id]));
      // Also match "p1 a" style loosely to "P1A"
      for (const c of classes) {
        const compact = c.name.toLowerCase().replace(/\s+/g, "");
        if (!classByName.has(compact)) classByName.set(compact, c.id);
      }

      const clientSkipped: Array<{ row: number; reason: string }> = [];
      const rows = records.map((r, idx) => {
        const rowNum = idx + 2; // 1-based file row including header
        const firstName = (r.firstName ?? r["First Name"] ?? "").trim();
        const lastName = (r.lastName ?? r["Last Name"] ?? "").trim();
        const classRaw = (r.className ?? r["Class"] ?? "").trim();
        const classKey = classRaw.toLowerCase();
        const classCompact = classKey.replace(/\s+/g, "");
        const classId = classByName.get(classKey) ?? classByName.get(classCompact) ?? 0;

        if (!firstName || !lastName) {
          clientSkipped.push({ row: rowNum, reason: "Missing first or last name" });
        } else if (!classRaw) {
          clientSkipped.push({ row: rowNum, reason: "Missing class" });
        } else if (!classId) {
          clientSkipped.push({
            row: rowNum,
            reason: `Unknown class "${classRaw}" — create it in Settings first or fix the name`,
          });
        }

        const customFeeRaw = (r.customTotalFee ?? r["Custom Total Fee (UGX)"] ?? "").trim().replace(/,/g, "");
        const dobRaw = r.dateOfBirth ?? r["Date of Birth"] ?? "";
        const dob = normalizeDateOfBirth(dobRaw);
        if (dobRaw.trim() && !dob) {
          clientSkipped.push({ row: rowNum, reason: `Unrecognised date of birth "${dobRaw}" (use YYYY-MM-DD or DD/MM/YYYY)` });
        }

        return {
          firstName,
          lastName,
          classId,
          parentName: (r.parentName ?? r["Parent Name"] ?? "") || undefined,
          parentPhone: (r.parentPhone ?? r["Parent Phone"] ?? "") || undefined,
          parentPhone2: (r.parentPhone2 ?? r["Parent Phone 2"] ?? "") || undefined,
          gender: normalizeGender(r.gender ?? r["Gender"]),
          dateOfBirth: dob,
          specialStatus: normalizeSpecialStatus(r.specialStatus ?? r["Special Status"]),
          customTotalFee:
            customFeeRaw && !isNaN(Number(customFeeRaw)) && Number(customFeeRaw) > 0
              ? Number(customFeeRaw)
              : undefined,
          village: (r.village ?? r["Village"] ?? "") || undefined,
        };
      });

      // Only send rows that have names + a resolved class — avoids flooding
      // the server with classId: 0 skips the bursar already understands.
      const validRows = rows.filter((r) => r.firstName && r.lastName && r.classId > 0);
      if (validRows.length === 0) {
        toast.error(
          clientSkipped.length
            ? `No valid rows. ${clientSkipped.slice(0, 3).map((s) => `Row ${s.row}: ${s.reason}`).join("; ")}`
            : "No valid student rows found. Check the template columns."
        );
        if (clientSkipped.length) console.warn("Import client skips", clientSkipped);
        return;
      }

      if (clientSkipped.length > 0) {
        toast.warning(
          `${clientSkipped.length} row(s) will be skipped: ` +
            clientSkipped.slice(0, 4).map((s) => `row ${s.row} (${s.reason})`).join("; ") +
            (clientSkipped.length > 4 ? ` +${clientSkipped.length - 4} more` : "")
        );
        console.warn("Import client skips", clientSkipped);
      }

      setImporting(true);
      bulkImportMutation.mutate({ rows: validRows });
    };
    reader.onerror = () => {
      toast.error("Couldn't read that file. Please try selecting it again.");
    };
    reader.readAsText(file);
  }

  function handleExportCsv() {
    const classById = new Map(classes.map((c) => [c.id, c.name]));
    downloadCsv(
      `students-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Admission Number", "First Name", "Last Name", "Class", "Parent Name", "Parent Phone", "Parent Phone 2", "Gender", "Date of Birth", "Special Status", "Custom Total Fee (UGX)", "Village"],
      allStudents.map((s) => [
        s.admissionNumber,
        s.firstName,
        s.lastName,
        classById.get(s.classId) ?? "",
        s.parentName ?? "",
        s.parentPhone ?? "",
        s.parentPhone2 ?? "",
        s.gender ?? "",
        s.dateOfBirth ?? "",
        s.specialStatus,
        s.customTotalFee ?? "",
        s.village ?? "",
      ])
    );
  }

  function handleDownloadTemplate() {
    downloadCsv(
      "student-import-template.csv",
      ["First Name", "Last Name", "Class", "Parent Name", "Parent Phone", "Parent Phone 2", "Gender", "Date of Birth", "Special Status", "Custom Total Fee (UGX)", "Village"],
      [["John", "Mukasa", classes[0]?.name ?? "P1", "Jane Mukasa", "0700000000", "", "male", "2015-04-12", "none", "", "Kireka"]]
    );
  }

  const archiveMutation = trpc.student.archive.useMutation({
    onSuccess: (data) => {
      if (data.outstandingBalance > 0) {
        toast.warning(`Student archived. Note: they still have ${data.outstandingBalance.toLocaleString()} UGX outstanding.`);
      } else {
        toast.success("Student archived");
      }
      setShowArchive(false);
      setArchiveReason("");
      refetch();
      refetchSearch();
    },
    onError: (e) => toast.error(e.message),
  });
  const reactivateMutation = trpc.student.reactivate.useMutation({
    onSuccess: () => {
      toast.success("Student reactivated");
      refetch();
      refetchSearch();
    },
    onError: (e) => toast.error(e.message),
  });
  const transferMutation = trpc.student.transfer.useMutation({
    onSuccess: (data) => {
      const warnings: string[] = [];
      if (data.outstandingBalance > 0) {
        warnings.push(`Note: student has ${data.outstandingBalance.toLocaleString()} UGX outstanding.`);
      }
      if (data.capacityWarning) {
        warnings.push(data.capacityWarning);
      }
      if (warnings.length > 0) {
        toast.warning(`Transferred. ${warnings.join(" ")}`);
      } else {
        toast.success("Student transferred");
      }
      setShowTransfer(false);
      setTransferReason("");
      setTransferClassId(undefined);
      setSelectedStudentClassId(null);
      refetch();
      refetchSearch();
    },
    onError: (e) => toast.error(e.message),
  });

  const editMutation = useOfflineMutation<Record<string, unknown>, { feeRecordsUpdated?: number }>({
    procedure: "student.update",
    summary: (input) => `Update student #${input.studentId}`,
    onSuccess: (result, queued) => {
      if (queued) {
        toast.success("Update saved — will sync when back online. Fee record adjustments (if any) will apply then too.");
      } else if (result.feeRecordsUpdated && result.feeRecordsUpdated > 0) {
        toast.success(`Student updated — ${result.feeRecordsUpdated} fee record${result.feeRecordsUpdated === 1 ? "" : "s"} adjusted to match the new fee`);
      } else {
        toast.success("Student updated");
      }
      setShowEdit(false);
      if (!queued) { refetch(); refetchSearch(); }
    },
    onError: (e) => toast.error(e.message),
  });

  function openEdit(student: (typeof displayStudents)[number]) {
    setEditForm({
      studentId: student.id,
      firstName: student.firstName,
      lastName: student.lastName,
      dateOfBirth: student.dateOfBirth ?? "",
      gender: (student.gender ?? "") as "male" | "female" | "",
      parentName: student.parentName ?? "",
      parentPhone: student.parentPhone ?? "",
      parentPhone2: student.parentPhone2 ?? "",
      village: student.village ?? "",
      specialStatus: student.specialStatus,
      customTotalFee: student.customTotalFee ?? "",
    });
    setShowEdit(true);
  }

  function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    editMutation.mutate({
      studentId: editForm.studentId,
      firstName: editForm.firstName,
      lastName: editForm.lastName,
      dateOfBirth: editForm.dateOfBirth || undefined,
      gender: editForm.gender || undefined,
      parentName: editForm.parentName || undefined,
      parentPhone: editForm.parentPhone || undefined,
      parentPhone2: editForm.parentPhone2 || undefined,
      village: editForm.village || undefined,
      specialStatus: editForm.specialStatus,
      customTotalFee: editForm.customTotalFee ? Number(editForm.customTotalFee) : null,
    });
  }

  const { data: dupeCheck } = trpc.student.checkDuplicate.useQuery(
    { firstName: addForm.firstName, lastName: addForm.lastName },
    { enabled: addForm.firstName.length >= 2 && addForm.lastName.length >= 2 }
  );

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!addForm.classId) { toast.error("Select a class"); return; }
    addMutation.mutate({
      classId: addForm.classId,
      firstName: addForm.firstName,
      lastName: addForm.lastName,
      dateOfBirth: addForm.dateOfBirth || undefined,
      gender: addForm.gender || undefined,
      parentName: addForm.parentName || undefined,
      parentPhone: addForm.parentPhone || undefined,
      parentPhone2: addForm.parentPhone2 || undefined,
      village: addForm.village || undefined,
      specialStatus: addForm.specialStatus,
      customTotalFee: addForm.customTotalFee ? Number(addForm.customTotalFee) : undefined,
    });
  }

  return (
    <div className="p-6 space-y-4">
      {studentsOffline && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
          Showing saved data from {studentsCachedAt ? new Date(studentsCachedAt).toLocaleString() : "earlier"} — fee status badges may be out of date until you're back online.
        </div>
      )}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Students</h1>
        {isBursar && (
          <div className="flex items-center flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              className="hidden"
              onChange={handleImportFile}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4 mr-1" /> {importing ? "Importing..." : "Import CSV"}
            </Button>
            <Button variant="outline" size="sm" onClick={handleExportCsv}>
              <Download className="h-4 w-4 mr-1" /> Export
            </Button>
            <Button onClick={() => setShowAdd(true)} size="sm">
              <Plus className="h-4 w-4 mr-1" /> Add Student
            </Button>
          </div>
        )}
      </div>
      {isBursar && (
        <button
          type="button"
          onClick={handleDownloadTemplate}
          className="text-xs text-indigo-600 hover:underline -mt-2"
        >
          Download import template
        </button>
      )}

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Search by name or admission number..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select onValueChange={(v) => setSelectedClassId(v === "all" ? undefined : Number(v))}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="All classes" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All classes</SelectItem>
            {classes.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isHeadTeacher && (
        <label className="flex items-center gap-2 text-xs text-gray-500 mt-1.5 cursor-pointer w-fit">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Include archived students (to undo a mistaken archive)
        </label>
      )}

      <Card>
        <CardContent className="p-0">
          {displayStudents.length === 0 ? (
            <div className="py-12 text-center space-y-3">
              {debouncedSearch.length >= 2 ? (
                <p className="text-gray-400 text-sm">No students match “{debouncedSearch}”. Try a different name or admission number.</p>
              ) : (
                <>
                  <p className="text-gray-600 text-sm font-medium">No students yet</p>
                  <p className="text-gray-400 text-xs">Add one student or import a class list from CSV.</p>
                  <button
                    type="button"
                    onClick={() => setShowAdd(true)}
                    className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
                  >
                    <Plus className="h-4 w-4" /> Add first student
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {displayStudents.map((student) => {
                const cls = classes.find((c) => c.id === student.classId);
                // Bug 2: feeStatus now correctly populated from dedicated getFeeStatuses query
                const feeStatus = feeStatuses[student.id];
                return (
                  <div key={student.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                      <span className="text-xs font-medium text-indigo-700">
                        {student.firstName.charAt(0)}{student.lastName.charAt(0)}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {student.firstName} {student.lastName}
                      </p>
                      <div className="flex items-center flex-wrap gap-x-1.5 gap-y-1 mt-0.5">
                        <p className="text-xs text-gray-400 truncate">
                          {student.admissionNumber} · {cls?.name ?? "No class"}
                        </p>
                        {feeStatus && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${FEE_STATUS_COLORS[feeStatus] ?? ""}`}>
                            {feeStatus}
                          </span>
                        )}
                        {student.specialStatus !== "none" && (
                          <Badge variant="outline" className="text-xs shrink-0">{student.specialStatus}</Badge>
                        )}
                        {student.status === "archived" && (
                          <Badge variant="outline" className="text-xs shrink-0 border-gray-300 text-gray-500 bg-gray-50">
                            Archived
                          </Badge>
                        )}
                        {student.customTotalFee != null && (
                          <Badge variant="outline" className="text-xs shrink-0 border-amber-300 text-amber-700 bg-amber-50">
                            Pays {parseFloat(student.customTotalFee).toLocaleString()} UGX
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {isBursar && (
                        <button
                          className="p-1.5 text-gray-400 hover:text-indigo-600 transition-colors"
                          title="Edit student"
                          onClick={() => openEdit(student)}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors" title="More actions">
                            <MoreVertical className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {isBursar && student.status !== "archived" && (
                            <DropdownMenuItem onClick={() => navigate(`/fees?studentId=${student.id}`)}>
                              <CreditCard className="h-4 w-4 mr-2" /> Record payment
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => { setHistoryStudentId(student.id); setShowHistory(true); }}>
                            <History className="h-4 w-4 mr-2" /> View edit history
                          </DropdownMenuItem>
                          {isBursar && student.status !== "archived" && (
                            <>
                              <DropdownMenuItem
                                onClick={() => {
                                  setSelectedStudent(student.id);
                                  setSelectedStudentClassId(student.classId);
                                  setShowTransfer(true);
                                }}
                              >
                                <ArrowRightLeft className="h-4 w-4 mr-2" /> Transfer class
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-red-500 focus:text-red-600"
                                onClick={() => { setSelectedStudent(student.id); setShowArchive(true); }}
                              >
                                <UserX className="h-4 w-4 mr-2" /> Archive student
                              </DropdownMenuItem>
                            </>
                          )}
                          {isHeadTeacher && student.status === "archived" && (
                            <DropdownMenuItem
                              onClick={() => reactivateMutation.mutate({ studentId: student.id })}
                            >
                              <UserCheck className="h-4 w-4 mr-2" /> Reactivate student
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Student Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Add Student</DialogTitle></DialogHeader>
          <form onSubmit={handleAdd} className="space-y-3">
            {dupeCheck?.isDuplicate && (
              <div className="bg-amber-50 border border-amber-200 px-3 py-2 rounded text-sm text-amber-700">
                ⚠️ A student with this name already exists. You can still proceed if they are different students.
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>First Name *</Label>
                <Input value={addForm.firstName} onChange={(e) => setAddForm((f) => ({ ...f, firstName: e.target.value }))} required />
              </div>
              <div>
                <Label>Last Name *</Label>
                <Input value={addForm.lastName} onChange={(e) => setAddForm((f) => ({ ...f, lastName: e.target.value }))} required />
              </div>
            </div>
            <div>
              <Label>Class *</Label>
              <Select onValueChange={(v) => setAddForm((f) => ({ ...f, classId: Number(v) }))}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select class" /></SelectTrigger>
                <SelectContent>
                  {classes.map((c) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date of Birth</Label>
                <Input type="date" value={addForm.dateOfBirth} onChange={(e) => setAddForm((f) => ({ ...f, dateOfBirth: e.target.value }))} />
              </div>
              <div>
                <Label>Gender</Label>
                <Select onValueChange={(v) => setAddForm((f) => ({ ...f, gender: v as "male" | "female" }))}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="male">Male</SelectItem>
                    <SelectItem value="female">Female</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Parent/Guardian Name</Label>
              <Input value={addForm.parentName} onChange={(e) => setAddForm((f) => ({ ...f, parentName: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Parent Phone 1</Label>
                <Input placeholder="0772 000 000" value={addForm.parentPhone} onChange={(e) => setAddForm((f) => ({ ...f, parentPhone: e.target.value }))} />
                {addForm.parentPhone && !isValidUgandaPhone(addForm.parentPhone) && (
                  <p className="text-xs text-red-500 mt-1">Incomplete number</p>
                )}
              </div>
              <div>
                <Label>Parent Phone 2</Label>
                <Input placeholder="Optional" value={addForm.parentPhone2} onChange={(e) => setAddForm((f) => ({ ...f, parentPhone2: e.target.value }))} />
                {addForm.parentPhone2 && !isValidUgandaPhone(addForm.parentPhone2) && (
                  <p className="text-xs text-red-500 mt-1">Incomplete number</p>
                )}
              </div>
            </div>
            <div>
              <Label>Village / Area</Label>
              <Input placeholder="e.g. Kawempe, Makindye" value={addForm.village} onChange={(e) => setAddForm((f) => ({ ...f, village: e.target.value }))} />
            </div>
            <div>
              <Label>Special Status</Label>
              <Select defaultValue="none" onValueChange={(v) => setAddForm((f) => ({ ...f, specialStatus: v as "none" | "orphan" | "staffChild" | "bursary" }))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="orphan">Orphan</SelectItem>
                  <SelectItem value="staffChild">Staff Child</SelectItem>
                  <SelectItem value="bursary">Bursary</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Custom Total Fee (UGX)</Label>
              <Input
                type="number" min="0" step="1000" placeholder="Leave blank for normal class fee"
                value={addForm.customTotalFee}
                onChange={(e) => setAddForm((f) => ({ ...f, customTotalFee: e.target.value }))}
              />
              <p className="text-xs text-gray-400 mt-1">
                The actual total amount this student pays per term, e.g. bursary or scholarship. Leave blank for the normal class fee.
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => { setShowAdd(false); setAddForm(EMPTY_ADD_FORM); }}>Cancel</Button>
              <Button type="submit" className="flex-1" disabled={
                addMutation.isPending ||
                (!!addForm.parentPhone && !isValidUgandaPhone(addForm.parentPhone)) ||
                (!!addForm.parentPhone2 && !isValidUgandaPhone(addForm.parentPhone2))
              }>
                {addMutation.isPending ? "Adding..." : "Add Student"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Archive Dialog */}
      <Dialog open={showArchive} onOpenChange={setShowArchive}>
        <DialogContent>
          <DialogHeader><DialogTitle>Archive Student</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">This student will be removed from active lists but their fee history is preserved.</p>
          <div className="space-y-2">
            <Label>Reason *</Label>
            <Input
              placeholder="Transferred, dropped out, completed..."
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowArchive(false)}>Cancel</Button>
            <Button
              variant="destructive"
              className="flex-1"
              disabled={!archiveReason || archiveMutation.isPending}
              onClick={() => selectedStudent && archiveMutation.mutate({ studentId: selectedStudent, reason: archiveReason })}
            >
              Archive
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Transfer Dialog */}
      <Dialog open={showTransfer} onOpenChange={setShowTransfer}>
        <DialogContent>
          <DialogHeader><DialogTitle>Transfer to Another Class</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>New Class *</Label>
              <Select onValueChange={(v) => setTransferClassId(Number(v))}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select new class" /></SelectTrigger>
                <SelectContent>
                  {/* Bug 12: exclude the student's current class from the transfer list */}
                  {classes
                    .filter((c) => c.id !== selectedStudentClassId)
                    .map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Reason *</Label>
              <Input
                placeholder="Promoted, repeated, reclassified..."
                value={transferReason}
                onChange={(e) => setTransferReason(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowTransfer(false)}>Cancel</Button>
            <Button
              className="flex-1"
              disabled={!transferClassId || !transferReason || transferMutation.isPending}
              onClick={() =>
                selectedStudent && transferClassId &&
                transferMutation.mutate({ studentId: selectedStudent, toClassId: transferClassId, reason: transferReason })
              }
            >
              Transfer
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Student Dialog */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit Student</DialogTitle></DialogHeader>
          <form onSubmit={handleEdit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>First Name *</Label>
                <Input value={editForm.firstName} onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))} required />
              </div>
              <div>
                <Label>Last Name *</Label>
                <Input value={editForm.lastName} onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))} required />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Date of Birth</Label>
                <Input type="date" value={editForm.dateOfBirth} onChange={(e) => setEditForm((f) => ({ ...f, dateOfBirth: e.target.value }))} />
              </div>
              <div>
                <Label>Gender</Label>
                <Select value={editForm.gender} onValueChange={(v) => setEditForm((f) => ({ ...f, gender: v as "male" | "female" }))}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="male">Male</SelectItem>
                    <SelectItem value="female">Female</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Parent/Guardian Name</Label>
              <Input value={editForm.parentName} onChange={(e) => setEditForm((f) => ({ ...f, parentName: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Parent Phone 1</Label>
                <Input placeholder="0772 000 000" value={editForm.parentPhone} onChange={(e) => setEditForm((f) => ({ ...f, parentPhone: e.target.value }))} />
                {editForm.parentPhone && !isValidUgandaPhone(editForm.parentPhone) && (
                  <p className="text-xs text-red-500 mt-1">Incomplete number</p>
                )}
              </div>
              <div>
                <Label>Parent Phone 2</Label>
                <Input placeholder="Optional" value={editForm.parentPhone2} onChange={(e) => setEditForm((f) => ({ ...f, parentPhone2: e.target.value }))} />
                {editForm.parentPhone2 && !isValidUgandaPhone(editForm.parentPhone2) && (
                  <p className="text-xs text-red-500 mt-1">Incomplete number</p>
                )}
              </div>
            </div>
            <div>
              <Label>Village / Area</Label>
              <Input value={editForm.village} onChange={(e) => setEditForm((f) => ({ ...f, village: e.target.value }))} />
            </div>
            <div>
              <Label>Special Status</Label>
              <Select value={editForm.specialStatus} onValueChange={(v) => setEditForm((f) => ({ ...f, specialStatus: v as "none" | "orphan" | "staffChild" | "bursary" }))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="orphan">Orphan</SelectItem>
                  <SelectItem value="staffChild">Staff Child</SelectItem>
                  <SelectItem value="bursary">Bursary</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Custom Total Fee (UGX)</Label>
              <Input
                type="number" min="0" step="1000" placeholder="Leave blank for normal class fee"
                value={editForm.customTotalFee}
                onChange={(e) => setEditForm((f) => ({ ...f, customTotalFee: e.target.value }))}
              />
              <p className="text-xs text-gray-400 mt-1">
                Only affects fees assigned after this is changed — it won't retroactively change fee records already created for this student.
              </p>
            </div>
            <p className="text-xs text-gray-400">
              To move this student to a different class, use Transfer instead — it keeps a reason on record.
            </p>
            <div className="flex gap-2 pt-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setShowEdit(false)}>Cancel</Button>
              <Button type="submit" className="flex-1" disabled={
                editMutation.isPending ||
                (!!editForm.parentPhone && !isValidUgandaPhone(editForm.parentPhone)) ||
                (!!editForm.parentPhone2 && !isValidUgandaPhone(editForm.parentPhone2))
              }>
                {editMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit History Dialog — available to every role, including read-only auditors */}
      <Dialog open={showHistory} onOpenChange={(open) => { setShowHistory(open); if (!open) setHistoryStudentId(null); }}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit History</DialogTitle></DialogHeader>
          {historyLoading ? (
            <p className="text-sm text-gray-400 py-8 text-center">Loading...</p>
          ) : auditLog.length === 0 ? (
            <p className="text-sm text-gray-400 py-8 text-center">No changes have been recorded for this student yet.</p>
          ) : (
            <div className="divide-y">
              {[...auditLog]
                .sort((a, b) => new Date(b.changedAt).getTime() - new Date(a.changedAt).getTime())
                .map((entry) => (
                  <div key={entry.id} className="py-2.5">
                    <p className="text-sm">
                      <span className="font-medium">{AUDIT_FIELD_LABELS[entry.field] ?? entry.field}</span>
                      {" changed from "}
                      <span className="text-gray-500">"{entry.oldValue || "—"}"</span>
                      {" to "}
                      <span className="text-gray-900">"{entry.newValue || "—"}"</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {new Date(entry.changedAt).toLocaleString()} · {staffNameById.get(entry.userId) ?? `Staff #${entry.userId}`}
                    </p>
                  </div>
                ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
