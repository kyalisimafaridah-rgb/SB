import { useState } from "react";
import { useParams } from "wouter";
import { trpc } from "../lib/trpc";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Search, GraduationCap } from "lucide-react";

export default function ParentPortal() {
  const { schoolCode } = useParams<{ schoolCode: string }>();
  const [admissionNumber, setAdmissionNumber] = useState("");
  const [selectedStudentId, setSelectedStudentId] = useState<number | null>(null);
  const [searched, setSearched] = useState(false);

  const {
    data: searchData,
    isFetching: searching,
    refetch,
    error: searchError,
  } = trpc.portal.searchStudent.useQuery(
    { schoolCode: schoolCode ?? "", admissionNumber },
    { enabled: false, retry: false }
  );

  const { data: feeData, isLoading: feesLoading } = trpc.portal.getStudentFees.useQuery(
    { schoolCode: schoolCode ?? "", studentId: selectedStudentId! },
    { enabled: !!selectedStudentId }
  );

  // Other children at the school sharing a contact number with the one
  // being viewed — lets a parent with multiple kids switch between them
  // without re-searching by admission number each time.
  const { data: relatedStudents = [] } = trpc.portal.getRelatedStudents.useQuery(
    { schoolCode: schoolCode ?? "", studentId: selectedStudentId! },
    { enabled: !!selectedStudentId }
  );

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (admissionNumber.trim().length < 4) return;
    setSearched(true);
    setSelectedStudentId(null);
    refetch();
  }

  const school = searchData?.school;
  const students = searchData?.students ?? [];

  // Compute fee summary for selected student
  const records = feeData?.records ?? [];
  const payments = feeData?.payments ?? [];

  const currentYear = new Date().getFullYear();
  // Unauthenticated page (school-code lookup, no login) — can't call the
  // authenticated school.getCurrentTerm endpoint. Only matters as a fallback
  // when a student has zero fee records at all (see below), which a parent
  // realistically wouldn't be checking. Fixed the 0-indexed vs 1-indexed
  // month mismatch found while consolidating the other 8 files either way.
  const currentMonth = new Date().getMonth();
  const clockTerm = currentMonth <= 2 ? 1 : currentMonth <= 6 ? 2 : 3;

  // Bug 9: use the latest term/year present in actual fee records rather than the client clock.
  // The clock says "Term 3" in October but the school may not have generated Term 3 fees yet,
  // which would wrongly show Term 2 records as "arrears".
  const latestYear = records.length > 0 ? Math.max(...records.map(r => r.year)) : currentYear;
  const latestTermInYear = records.filter(r => r.year === latestYear);
  const latestTerm = latestTermInYear.length > 0
    ? Math.max(...latestTermInYear.map(r => r.term))
    : clockTerm;

  const currentTermRecords = records.filter(r => r.term === latestTerm && r.year === latestYear);
  const arrearRecords = records.filter(r => !(r.term === latestTerm && r.year === latestYear));
  const totalOutstanding = records.reduce((s, r) => {
    if (r.isWaiver) return s;
    return s + Math.max(0, parseFloat(r.amountExpected) - parseFloat(r.amountPaid));
  }, 0);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-indigo-700 text-white px-4 py-5">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          <GraduationCap className="h-7 w-7 shrink-0" />
          <div>
            <h1 className="font-bold text-lg">{school?.name ?? "School Fee Portal"}</h1>
            <p className="text-indigo-200 text-sm">Check your child's fee balance</p>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-4">
        {/* Search form */}
        <Card>
          <CardContent className="pt-5">
            <form onSubmit={handleSearch} className="space-y-3">
              <label className="text-sm font-medium text-gray-700">
                Enter your child's admission number
              </label>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g. KIBIBI-2025-0012"
                  value={admissionNumber}
                  onChange={(e) => { setAdmissionNumber(e.target.value); setSearched(false); setSelectedStudentId(null); }}
                  className="flex-1"
                />
                <Button type="submit" disabled={searching || admissionNumber.trim().length < 4}>
                  <Search className="h-4 w-4" />
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Error state — invalid school code or server error */}
        {searchError && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-600">
            {searchError.message === "School not found"
              ? "This school portal link is invalid. Please ask the school for the correct link."
              : "Something went wrong. Please try again."}
          </div>
        )}

        {/* Search results */}
        {searched && !searching && !searchError && students.length === 0 && (
          <p className="text-center text-gray-500 text-sm py-4">
            No student found. Double-check the admission number or contact the school.
          </p>
        )}

        {students.length > 0 && !selectedStudentId && (
          <Card>
            <CardHeader><CardTitle className="text-sm">Select your child</CardTitle></CardHeader>
            <CardContent className="p-0">
              {students.map((s) => (
                <button
                  key={s.id}
                  className="w-full text-left px-4 py-3 hover:bg-gray-50 border-b last:border-0 flex justify-between items-center"
                  onClick={() => setSelectedStudentId(s.id)}
                >
                  <div>
                    <p className="font-medium text-sm">{s.firstName} {s.lastName}</p>
                    <p className="text-xs text-gray-400">{s.admissionNumber}</p>
                  </div>
                  <span className="text-indigo-500 text-xs">View fees →</span>
                </button>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Fee details */}
        {selectedStudentId && feesLoading && (
          <div className="py-8 text-center text-gray-400 text-sm">Loading fee details...</div>
        )}
        {selectedStudentId && feeData && (
          <>
            <div className="flex items-center gap-2 justify-between">
              <button onClick={() => setSelectedStudentId(null)} className="text-indigo-600 text-sm">← Back</button>
              <button
                type="button"
                onClick={() => window.print()}
                className="text-xs text-gray-500 hover:text-gray-800 border rounded px-2 py-1"
              >
                Print balance
              </button>
            </div>

            {relatedStudents.length > 0 && (
              <div className="bg-white border rounded-lg p-3">
                <p className="text-xs text-gray-400 mb-2">Also linked to this contact number:</p>
                <div className="flex flex-wrap gap-2">
                  {relatedStudents.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSelectedStudentId(s.id)}
                      className="text-xs bg-indigo-50 text-indigo-700 rounded-full px-3 py-1.5 hover:bg-indigo-100 transition-colors"
                    >
                      {s.firstName} {s.lastName}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {feeData.student.firstName} {feeData.student.lastName}
                </CardTitle>
                <p className="text-xs text-gray-400">{feeData.className} · {feeData.student.admissionNumber}</p>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Outstanding summary */}
                <div className={`rounded-lg px-4 py-3 ${totalOutstanding === 0 ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
                  <p className="text-xs text-gray-500">Total Outstanding</p>
                  <p className={`text-2xl font-bold ${totalOutstanding === 0 ? "text-green-600" : "text-red-600"}`}>
                    {totalOutstanding === 0 ? "Fully Paid ✓" : `${totalOutstanding.toLocaleString()} UGX`}
                  </p>
                </div>

                {/* Current term breakdown */}
                {currentTermRecords.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Term {latestTerm} {latestYear}</p>
                    <div className="space-y-1.5">
                      {currentTermRecords.map((r) => {
                        const balance = r.isWaiver ? 0 : Math.max(0, parseFloat(r.amountExpected) - parseFloat(r.amountPaid));
                        return (
                          <div key={r.id} className="flex justify-between text-sm">
                            <span className="text-gray-600">{r.label}</span>
                            <span className={balance === 0 ? "text-green-600 font-medium" : "text-red-600 font-medium"}>
                              {r.isWaiver ? "Waived" : balance === 0 ? "Paid" : `${balance.toLocaleString()} UGX`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Arrears */}
                {arrearRecords.filter(r => !r.isWaiver && parseFloat(r.amountExpected) - parseFloat(r.amountPaid) > 0).length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-amber-600 uppercase mb-2">Arrears from Previous Terms</p>
                    <div className="space-y-1.5">
                      {arrearRecords.map((r) => {
                        const bal = r.isWaiver ? 0 : Math.max(0, parseFloat(r.amountExpected) - parseFloat(r.amountPaid));
                        if (bal === 0) return null;
                        return (
                          <div key={r.id} className="flex justify-between text-sm">
                            <span className="text-gray-600">{r.label} (T{r.term} {r.year})</span>
                            <span className="text-amber-600 font-medium">{bal.toLocaleString()} UGX</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Payment history */}
                {payments.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Payment History</p>
                    <div className="space-y-1.5">
                      {payments.map((p) => (
                        <div key={p.id} className="flex justify-between text-sm">
                          <div>
                            <span className="font-medium">{parseFloat(p.amount).toLocaleString()} UGX</span>
                            <span className="text-gray-400 text-xs ml-2">{p.paymentMethod}</span>
                          </div>
                          <div className="text-right">
                            <p className="text-gray-500 text-xs">{p.paymentDate}</p>
                            <p className="text-gray-300 text-xs">{p.receiptNumber}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {records.length === 0 && (
                  <p className="text-gray-400 text-sm text-center py-2">No fee records found for this student.</p>
                )}
              </CardContent>
            </Card>
          </>
        )}

        <p className="text-center text-xs text-gray-400 mt-6">
          Powered by ScholarBase · For queries contact the school directly
        </p>
      </div>
    </div>
  );
}
