import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "../lib/trpc";
import { useCurrentTerm } from "../hooks/useCurrentTerm";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./ui/card";
import { toast } from "sonner";
import { GraduationCap, CheckCircle } from "lucide-react";
import { getUser, setUser } from "../_core/hooks/useAuth";
import { isValidUgandaPhone } from "../../../shared/phone";

const LEVELS = ["baby","middle","top","P1","P2","P3","P4","P5","P6","P7","S1","S2","S3","S4","S5","S6"];
const STREAMS = ["none","A","B","C","D","E","W","N","S"];
const CATEGORIES = ["tuition","lunch","exam","uneb","development","uniform","boarding","transport","library","other"] as const;
// Same fix as Settings.tsx — CSS capitalize() only handles the first letter.
function categoryLabel(cat: string) { return cat === "uneb" ? "UNEB" : cat; }

export default function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const [, navigate] = useLocation();
  const user = getUser();
  // A brand-new school has never had the chance to enter real term dates yet
  // (that happens in Settings, after onboarding) — so this always hits
  // useCurrentTerm's "unconfigured" fallback by design, same guess as
  // before, just no longer duplicated with its own independent (and
  // previously slightly-off) copy of the calendar-month logic.
  const { term: defaultTerm, year: currentYear } = useCurrentTerm();

  const [step, setStep] = useState(1);
  const [createdClassId, setCreatedClassId] = useState<number | null>(null);
  // Surfaced when completeOnboarding genuinely fails, so the user sees an
  // honest error and a retry button instead of the wizard silently vanishing
  // as if setup succeeded while the server still thinks it didn't.
  const [finishError, setFinishError] = useState<string | null>(null);

  // Bug 5: Load existing school data from server to pre-fill Step 1 (avoid overwriting with empty strings)
  // onSuccess was removed in React Query v5 — use useEffect on the data instead
  const { data: existingSchool } = trpc.school.getMySchool.useQuery(undefined);

  // Used to recover if this wizard instance re-runs step 2 against a class
  // that a PRIOR wizard attempt already created — see the catch block in
  // handleStep2. That situation is only possible for schools already
  // affected by the completeOnboarding-silent-failure bug (fixed below in
  // handleFinish), where the server was left thinking onboarding wasn't
  // done even though the class/fee setup had actually gone through.
  const { data: existingClasses = [] } = trpc.class.getAll.useQuery();

  useEffect(() => {
    if (existingSchool) {
      setSchoolForm({
        name: existingSchool.name ?? user?.schoolName ?? "",
        district: existingSchool.district ?? "",
        schoolType: existingSchool.schoolType ?? "",
        contactPhone: existingSchool.contactPhone ?? "",
      });
    }
  }, [existingSchool]);

  const [schoolForm, setSchoolForm] = useState({
    name: user?.schoolName ?? "",
    district: "",
    schoolType: "",
    contactPhone: "",
  });

  const [classForm, setClassForm] = useState({
    level: "",
    stream: "none",
    capacity: "50",
    academicYear: String(currentYear),
  });

  const [feeRows, setFeeRows] = useState([
    { category: "tuition" as typeof CATEGORIES[number], label: "Tuition Fees", amount: "" },
  ]);

  const updateSchoolMutation = trpc.school.updateDetails.useMutation();
  const completeOnboardingMutation = trpc.school.completeOnboarding.useMutation();
  const createClassMutation = trpc.class.create.useMutation();
  const updateClassMutation = trpc.class.update.useMutation();
  const addFeeRowMutation = trpc.feeStructure.addRow.useMutation();

  // Snapshot of the classForm values at the moment we last created/updated the
  // class, so we can tell "user went Back then resubmitted unchanged" (skip)
  // apart from "user went Back and actually edited it" (needs an update call).
  const [lastSubmittedClassForm, setLastSubmittedClassForm] = useState<string | null>(null);

  async function handleStep1(e: React.FormEvent) {
    e.preventDefault();
    if (schoolForm.contactPhone && !isValidUgandaPhone(schoolForm.contactPhone)) {
      toast.error("Enter a valid Uganda phone number (e.g. 0772000000)");
      return;
    }
    try {
      await updateSchoolMutation.mutateAsync(schoolForm);
      setStep(2);
    } catch (err: unknown) {
      toast.error((err as Error).message ?? "Failed to save");
    }
  }

  async function handleStep2(e: React.FormEvent) {
    e.preventDefault();
    if (!classForm.level) { toast.error("Select a class level"); return; }

    const currentSnapshot = JSON.stringify(classForm);

    // Already created this exact class (e.g. user went Back then re-submitted
    // unchanged) — don't create a duplicate, just advance.
    if (createdClassId && currentSnapshot === lastSubmittedClassForm) {
      setStep(3);
      return;
    }

    try {
      if (createdClassId) {
        // User went Back and actually changed level/stream/year — update the
        // class we already created instead of silently keeping the stale one
        // (which would create a mismatch: the wizard shows the new class name
        // in step 3, but fee rows would attach to the old class).
        await updateClassMutation.mutateAsync({
          classId: createdClassId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          level: classForm.level as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stream: classForm.stream as any,
          capacity: Number(classForm.capacity),
          academicYear: Number(classForm.academicYear),
        });
      } else {
        const cls = await createClassMutation.mutateAsync({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          level: classForm.level as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stream: classForm.stream as any,
          capacity: Number(classForm.capacity),
          academicYear: Number(classForm.academicYear),
        });
        setCreatedClassId(cls.id);
      }
      setLastSubmittedClassForm(currentSnapshot);
      setStep(3);
    } catch (err: unknown) {
      const message = (err as Error).message ?? "Failed to save class";
      // "Class already exists" here doesn't necessarily mean the user made a
      // mistake — a prior wizard attempt (before this session) may have
      // already created it and then failed to record onboarding completion.
      // Adopt the existing class and continue instead of stopping the user
      // with no way forward.
      const computedName = classForm.stream === "none" ? classForm.level : `${classForm.level}${classForm.stream}`;
      if (/already exists/i.test(message)) {
        const match = existingClasses.find(
          (c) => c.name === computedName && c.academicYear === Number(classForm.academicYear)
        );
        if (match) {
          setCreatedClassId(match.id);
          setLastSubmittedClassForm(currentSnapshot);
          toast.message(`Using your existing "${computedName}" class from a previous setup attempt.`);
          setStep(3);
          return;
        }
      }
      toast.error(message);
    }
  }

  async function handleStep3(e: React.FormEvent) {
    e.preventDefault();
    const validRows = feeRows.filter(r => r.label && r.amount && Number(r.amount) > 0);
    if (validRows.length === 0) { toast.error("Add at least one fee category"); return; }
    if (!createdClassId) { toast.error("No class found"); return; }

    try {
      for (const row of validRows) {
        await addFeeRowMutation.mutateAsync({
          classId: createdClassId,
          term: defaultTerm,
          year: currentYear,
          category: row.category,
          label: row.label,
          amount: Number(row.amount),
        });
      }
      setStep(4);
    } catch (err: unknown) {
      toast.error((err as Error).message ?? "Failed to save fee structure");
    }
  }

  // Extracted so the checklist buttons below can complete onboarding AND land
  // somewhere specific (Settings, Students) instead of always Dashboard —
  // same completeOnboarding call, same error handling, just reusable.
  async function finishOnboarding(): Promise<boolean> {
    setFinishError(null);
    try {
      await completeOnboardingMutation.mutateAsync();
      const currentUser = getUser();
      if (currentUser) setUser({ ...currentUser, onboarded: true });
      return true;
    } catch (err: unknown) {
      // Previously this caught the failure and marked onboarded:true locally
      // anyway "so the wizard doesn't reappear" — but that meant the DEVICE
      // thought setup was done while the SERVER still didn't. The wizard
      // would then resurface on any fresh login (new device, cleared cache,
      // reinstalled PWA) with no way to get past step 2, since the class it
      // tries to create already exists. Showing the real error and letting
      // the user retry (safe — completeOnboarding just flips a flag) is what
      // actually gets them to a consistent state, and the step-2 recovery
      // above is a safety net for anyone already affected before this fix.
      setFinishError((err as Error).message ?? "Something went wrong saving your setup.");
      return false;
    }
  }

  async function handleFinish() {
    if (await finishOnboarding()) onComplete();
  }

  async function handleFinishAndGoTo(path: string) {
    if (await finishOnboarding()) { onComplete(); navigate(path); }
  }

  const classPreviewName = classForm.level
    ? classForm.stream === "none" ? classForm.level : `${classForm.level}${classForm.stream}`
    : "";


  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 to-blue-100 flex items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-4">
        <div className="text-center">
          <GraduationCap className="h-10 w-10 text-indigo-600 mx-auto" />
          <h1 className="text-2xl font-bold text-foreground mt-2">Welcome to ScholarBase</h1>
          <p className="text-muted-foreground text-sm mt-1">Let's set up your school in 4 quick steps</p>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center justify-center gap-2">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="flex items-center gap-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold
                ${s < step ? "bg-green-500 text-white" : s === step ? "bg-indigo-600 text-white" : "bg-gray-200 text-gray-400"}`}>
                {s < step ? "✓" : s}
              </div>
              {s < 4 && <div className={`w-6 h-0.5 ${s < step ? "bg-green-400" : "bg-gray-200"}`} />}
            </div>
          ))}
        </div>

        {/* Step 1: School Details */}
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>Step 1: School Details</CardTitle>
              <CardDescription>Tell us about your school</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleStep1} className="space-y-3">
                <div>
                  <Label>School Name *</Label>
                  <Input value={schoolForm.name} onChange={(e) => setSchoolForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <Label>District</Label>
                    <Input placeholder="Kampala" value={schoolForm.district} onChange={(e) => setSchoolForm(f => ({ ...f, district: e.target.value }))} />
                  </div>
                  <div className="min-w-0">
                    <Label>School Type</Label>
                    <Select value={schoolForm.schoolType || undefined} onValueChange={(v) => setSchoolForm(f => ({ ...f, schoolType: v }))}>
                      <SelectTrigger className="w-full"><SelectValue placeholder="Select..." /></SelectTrigger>
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
                  <Label>School Phone</Label>
                  <Input placeholder="0772 000 000" value={schoolForm.contactPhone} onChange={(e) => setSchoolForm(f => ({ ...f, contactPhone: e.target.value }))} />
                </div>
                <Button type="submit" className="w-full" disabled={updateSchoolMutation.isPending}>
                  {updateSchoolMutation.isPending ? "Saving..." : "Continue →"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Step 2: Create First Class */}
        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Step 2: Create Your First Class</CardTitle>
              <CardDescription>You can add more classes in Settings later</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleStep2} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="min-w-0">
                    <Label>Level *</Label>
                    <Select value={classForm.level || undefined} onValueChange={(v) => setClassForm(f => ({ ...f, level: v }))}>
                      <SelectTrigger className="w-full"><SelectValue placeholder="Select level" /></SelectTrigger>
                      <SelectContent>
                        {LEVELS.map(l => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-0">
                    <Label>Stream</Label>
                    <Select defaultValue="none" onValueChange={(v) => setClassForm(f => ({ ...f, stream: v }))}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {STREAMS.map(s => <SelectItem key={s} value={s}>{s === "none" ? "No stream" : s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label>Capacity</Label>
                  <Input type="number" value={classForm.capacity} onChange={(e) => setClassForm(f => ({ ...f, capacity: e.target.value }))} />
                </div>
                {classPreviewName && (
                  <p className="text-sm text-indigo-600">Class will be named: <strong>{classPreviewName}</strong></p>
                )}
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setStep(1)}>← Back</Button>
                  <Button type="submit" className="flex-1" disabled={createClassMutation.isPending || updateClassMutation.isPending}>
                    {createClassMutation.isPending || updateClassMutation.isPending ? "Saving..." : "Continue →"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Fee Structure */}
        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle>Step 3: Fee Structure for {classPreviewName}</CardTitle>
              <CardDescription>How much does a student in this class owe per term?</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleStep3} className="space-y-3">
                {feeRows.map((row, i) => (
                  <div key={i} className="grid grid-cols-3 gap-2 items-end">
                    <div className="min-w-0">
                      <Label className="text-xs">Category</Label>
                      <Select
                        defaultValue={row.category}
                        onValueChange={(v) => {
                          const updated = [...feeRows];
                          updated[i] = { ...updated[i], category: v as typeof CATEGORIES[number] };
                          setFeeRows(updated);
                        }}
                      >
                        <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CATEGORIES.map(c => <SelectItem key={c} value={c} className="capitalize">{categoryLabel(c)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Label</Label>
                      <Input
                        className="h-9"
                        placeholder="Tuition Fees"
                        value={row.label}
                        onChange={(e) => {
                          const updated = [...feeRows];
                          updated[i] = { ...updated[i], label: e.target.value };
                          setFeeRows(updated);
                        }}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Amount (UGX)</Label>
                      <Input
                        className="h-9"
                        type="number"
                        placeholder="150000"
                        value={row.amount}
                        onChange={(e) => {
                          const updated = [...feeRows];
                          updated[i] = { ...updated[i], amount: e.target.value };
                          setFeeRows(updated);
                        }}
                      />
                    </div>
                  </div>
                ))}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setFeeRows([...feeRows, { category: "lunch", label: "", amount: "" }])}
                >
                  + Add Category
                </Button>

                {feeRows.some(r => r.amount) && (
                  <p className="text-sm text-muted-foreground">
                    Total per student:{" "}
                    <strong>
                      {feeRows.reduce((s, r) => s + (Number(r.amount) || 0), 0).toLocaleString()} UGX
                    </strong>
                  </p>
                )}

                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setStep(2)}>← Back</Button>
                  <Button type="submit" className="flex-1" disabled={addFeeRowMutation.isPending}>
                    {addFeeRowMutation.isPending ? "Saving..." : "Continue →"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Step 4: Done */}
        {step === 4 && (
          <Card>
            <CardContent className="py-8 text-center space-y-4">
              <CheckCircle className="h-14 w-14 text-green-500 mx-auto" />
              <h2 className="text-xl font-bold">You're all set!</h2>
              <div className="text-sm text-muted-foreground space-y-1 text-left bg-muted rounded-lg p-4">
                <p>✓ School details saved</p>
                <p>✓ Class <strong>{classPreviewName}</strong> created</p>
                <p>✓ Fee structure set up</p>
              </div>

              {existingSchool?.schoolCode && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 text-left space-y-1">
                  <p className="text-xs text-indigo-600 font-semibold uppercase">Your School Code</p>
                  <p className="text-lg font-mono font-bold text-indigo-700">{existingSchool.schoolCode}</p>
                  <p className="text-xs text-muted-foreground">
                    Share this with parents — with their child's admission number, it's how they check fees at{" "}
                    <span className="font-mono break-all">{window.location.origin}/portal/{existingSchool.schoolCode}</span>.
                    You can always find it again in Settings.
                  </p>
                </div>
              )}

              <div className="text-left space-y-2">
                <p className="text-sm font-semibold text-muted-foreground">A few more things worth doing before day one:</p>

                <button
                  type="button"
                  onClick={() => handleFinishAndGoTo("/settings")}
                  disabled={completeOnboardingMutation.isPending}
                  className="w-full text-left text-sm bg-card border rounded-lg p-3 hover:border-indigo-300 transition-colors flex justify-between items-center gap-2"
                >
                  <span>
                    <strong>Add your other classes</strong>
                    <br />
                    <span className="text-muted-foreground text-xs">Only {classPreviewName || "one class"} exists so far — most schools need several.</span>
                  </span>
                  <span className="text-indigo-600 shrink-0">→</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleFinishAndGoTo("/settings")}
                  disabled={completeOnboardingMutation.isPending}
                  className="w-full text-left text-sm bg-card border rounded-lg p-3 hover:border-indigo-300 transition-colors flex justify-between items-center gap-2"
                >
                  <span>
                    <strong>Set your real term dates</strong>
                    <br />
                    <span className="text-muted-foreground text-xs">Without this, the app guesses the current term from the calendar month — usually close, sometimes wrong.</span>
                  </span>
                  <span className="text-indigo-600 shrink-0">→</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleFinishAndGoTo("/settings")}
                  disabled={completeOnboardingMutation.isPending}
                  className="w-full text-left text-sm bg-card border rounded-lg p-3 hover:border-indigo-300 transition-colors flex justify-between items-center gap-2"
                >
                  <span>
                    <strong>Add your bursar as their own account</strong>
                    <br />
                    <span className="text-muted-foreground text-xs">Sharing your own login instead means every payment they record looks like it was you.</span>
                  </span>
                  <span className="text-indigo-600 shrink-0">→</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleFinishAndGoTo("/students")}
                  disabled={completeOnboardingMutation.isPending}
                  className="w-full text-left text-sm bg-card border rounded-lg p-3 hover:border-indigo-300 transition-colors flex justify-between items-center gap-2"
                >
                  <span>
                    <strong>Add your students</strong>
                    <br />
                    <span className="text-muted-foreground text-xs">One at a time, or import a whole class at once from a CSV file.</span>
                  </span>
                  <span className="text-indigo-600 shrink-0">→</span>
                </button>
              </div>

              {finishError && (
                <p className="text-sm text-red-600 bg-red-50 rounded-lg p-3 text-left">
                  {finishError} Your class and fee setup are already saved — just retry this last step.
                </p>
              )}
              <Button className="w-full" onClick={handleFinish} disabled={completeOnboardingMutation.isPending}>
                {completeOnboardingMutation.isPending
                  ? "Saving..."
                  : finishError
                    ? "Retry →"
                    : "Skip for now — Go to Dashboard →"}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
