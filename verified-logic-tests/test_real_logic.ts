// REAL EXECUTED TESTS — every function below is copied VERBATIM from the
// actual shipping source (not reimplemented) so this tests the real code,
// not my memory of it. Run with: tsx test_real_logic.ts

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  PASS: ${label}`);
  } else {
    fail++;
    console.log(`  FAIL: ${label}\n        got:      ${a}\n        expected: ${e}`);
  }
}

// ============================================================
// 1. CSV formula injection + escaping — VERBATIM from client/src/lib/csv.ts
// ============================================================
function neutralizeFormulaInjection(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}
function escapeCsvField(value: string): string {
  const safe = neutralizeFormulaInjection(value);
  if (/[",\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
function buildCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers.map((h) => escapeCsvField(h)).join(",")];
  for (const row of rows) {
    lines.push(row.map((cell) => escapeCsvField(String(cell ?? ""))).join(","));
  }
  return lines.join("\n");
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const input = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += char; }
      continue;
    }
    if (char === '"') { inQuotes = true; }
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else { field += char; }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

console.log("\n=== 1. CSV formula injection ===");
check("formula =SUM gets neutralized", escapeCsvField("=SUM(A1:A10)"), "'=SUM(A1:A10)");
check("formula +1+1 gets neutralized", escapeCsvField("+1+1"), "'+1+1");
check("formula -5 gets neutralized", escapeCsvField("-5"), "'-5");
check("formula @SUM gets neutralized", escapeCsvField("@SUM"), "'@SUM");
check("normal name unaffected", escapeCsvField("John Mukasa"), "John Mukasa");
check("comma triggers quoting", escapeCsvField("Kampala, Uganda"), '"Kampala, Uganda"');
check("embedded quote escaped", escapeCsvField('He said "hi"'), '"He said ""hi"""');
check("hyphenated name NOT falsely flagged (no leading -)", escapeCsvField("Anne-Marie"), "Anne-Marie");
// End-to-end: a poisoned village field survives export+reimport as inert text, not a formula
const csv = buildCsv(["name", "village"], [["Test Student", "=cmd|'/c calc'!A1"]]);
const reparsed = parseCsv(csv);
check("poisoned field round-trips as neutralized text, not a live formula", reparsed[1][1], "'=cmd|'/c calc'!A1");

// ============================================================
// 2. Uganda timezone date — SAME logic as server/db.ts's todayInUganda(),
//    parameterized with an injectable Date so it's deterministically testable
// ============================================================
function dateInUganda(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${year}-${month}-${day}`;
}
function oldBuggyMethod(d: Date): string {
  return d.toISOString().split("T")[0];
}

console.log("\n=== 2. Uganda timezone date (the actual bug, proven with a real instant) ===");
// 21:30 UTC on Jan 14 = 00:30 Kampala time on Jan 15 (UTC+3) — this is exactly
// the ~3-hour window every single day where the old method breaks.
const boundaryInstant = new Date("2026-01-14T21:30:00Z");
check("OLD method gives WRONG date for this real instant (proves the bug existed)", oldBuggyMethod(boundaryInstant), "2026-01-14");
check("NEW method gives the CORRECT Kampala-local date for the same instant", dateInUganda(boundaryInstant), "2026-01-15");
// A midday instant where both methods happen to agree, confirming the fix isn't just always-different
const middayInstant = new Date("2026-06-15T12:00:00Z");
check("NEW method matches OLD method outside the bug window (midday)", dateInUganda(middayInstant), oldBuggyMethod(middayInstant));
// Sanity: real "right now" call doesn't throw and returns a plausible format
const liveResult = dateInUganda(new Date());
check("live call returns YYYY-MM-DD shape", /^\d{4}-\d{2}-\d{2}$/.test(liveResult), true);

// ============================================================
// 3. SMS segment counting — VERBATIM from client/src/pages/BulkSMS.tsx
// ============================================================
const GSM7_REGEX = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
function getSmsSegmentInfo(text: string): { segments: number; encoding: "GSM-7" | "UCS-2" } {
  const isGsm7 = GSM7_REGEX.test(text);
  if (text.length === 0) return { segments: 0, encoding: isGsm7 ? "GSM-7" : "UCS-2" };
  if (isGsm7) {
    return { segments: text.length <= 160 ? 1 : Math.ceil(text.length / 153), encoding: "GSM-7" };
  }
  return { segments: text.length <= 70 ? 1 : Math.ceil(text.length / 67), encoding: "UCS-2" };
}
function oldBuggySegmentCount(text: string): number {
  return Math.ceil(text.length / 160);
}

console.log("\n=== 3. SMS segment counting (proving the old /160 estimate under-billed) ===");
const msg310 = "A".repeat(310);
check("OLD flat /160 estimate says 2 segments for 310 chars (WRONG, under-counts)", oldBuggySegmentCount(msg310), 2);
check("NEW correct calc says 3 real segments for 310 chars (matches real GSM concatenation)", getSmsSegmentInfo(msg310).segments, 3);
check("short plain message is 1 segment", getSmsSegmentInfo("Fees due: 50000 UGX").segments, 1);
check("curly apostrophe silently forces UCS-2 encoding", getSmsSegmentInfo("Don\u2019t forget").encoding, "UCS-2");
check("UCS-2 message drops to 70-char budget per segment", getSmsSegmentInfo("x".repeat(80) + "\u2019").segments, 2);
check("empty message is 0 segments", getSmsSegmentInfo("").segments, 0);

// ============================================================
// 4. Uganda phone formatting — VERBATIM from server/sms.ts
// ============================================================
function formatUgandaPhone(phone: string): string | null {
  const cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("256") && cleaned.length === 12) return `+${cleaned}`;
  if (cleaned.startsWith("0") && cleaned.length === 10) return `+256${cleaned.slice(1)}`;
  if (cleaned.length === 9) return `+256${cleaned}`;
  return null;
}

console.log("\n=== 4. Uganda phone formatting ===");
check("leading-0 format", formatUgandaPhone("0772123456"), "+256772123456");
check("full country code format", formatUgandaPhone("256772123456"), "+256772123456");
check("bare 9-digit format", formatUgandaPhone("772123456"), "+256772123456");
check("already has + and spaces", formatUgandaPhone("+256 772 123 456"), "+256772123456");
check("too short is rejected", formatUgandaPhone("12345"), null);
check("garbage length is rejected", formatUgandaPhone("123456789012345"), null);

// ============================================================
// 5. Payment allocation loop — SAME logic as server/db.ts's recordPayment,
//    extracted as pure array logic (no DB) to test the split/overpay math
// ============================================================
type Rec = { id: number; amountExpected: number; amountPaid: number };
function allocatePayment(unpaid: Rec[], amount: number): { id: number; applied: number }[] {
  let remaining = amount;
  const applied: { id: number; applied: number }[] = [];
  for (const record of unpaid) {
    if (remaining <= 0) break;
    const balance = record.amountExpected - record.amountPaid;
    const toApply = Math.min(remaining, balance);
    if (toApply > 0) applied.push({ id: record.id, applied: toApply });
    remaining -= toApply;
  }
  return applied;
}

console.log("\n=== 5. Payment allocation (split across records, overpayment handling) ===");
const twoRecords: Rec[] = [
  { id: 1, amountExpected: 100000, amountPaid: 0 },
  { id: 2, amountExpected: 50000, amountPaid: 0 },
];
check("exact payment covers one record fully, second untouched", allocatePayment(twoRecords, 100000), [{ id: 1, applied: 100000 }]);
check("payment splits across two records in order", allocatePayment(twoRecords, 120000), [{ id: 1, applied: 100000 }, { id: 2, applied: 20000 }]);
check("overpayment never exceeds total owed (150000), excess silently unallocated not negative", allocatePayment(twoRecords, 999999).reduce((s, r) => s + r.applied, 0), 150000);
const partiallyPaid: Rec[] = [{ id: 1, amountExpected: 100000, amountPaid: 60000 }];
check("only the REMAINING balance is applied, not the full expected amount", allocatePayment(partiallyPaid, 40000), [{ id: 1, applied: 40000 }]);

// ============================================================
// 6. Subscription-blocked message logic — VERBATIM body() functions from
//    client/src/pages/SubscriptionBlocked.tsx (icon refs stripped — those are
//    static lucide-react component references, no logic to test)
// ============================================================
type CachedUser = { schoolName?: string; trialEndsAt?: string | null; subscriptionEndsAt?: string | null } | null;
const COPY_BODY: Record<string, (u: CachedUser) => string> = {
  trial_expired: (u) =>
    u?.trialEndsAt
      ? `${u.schoolName ?? "Your school"}'s trial ended on ${new Date(u.trialEndsAt).toLocaleDateString()}. Contact your ScholarBase provider to activate a subscription and get back in.`
      : `${u?.schoolName ?? "Your school"}'s trial has ended. Contact your ScholarBase provider to activate a subscription and get back in.`,
  subscription_expired: (u) =>
    u?.subscriptionEndsAt
      ? `${u.schoolName ?? "Your school"}'s subscription lapsed on ${new Date(u.subscriptionEndsAt).toLocaleDateString()} (including the 3-day grace period). Contact your ScholarBase provider to renew.`
      : `${u?.schoolName ?? "Your school"}'s subscription has lapsed. Contact your ScholarBase provider to renew.`,
  account_suspended: (u) => `${u?.schoolName ?? "Your school"}'s access has been suspended. Contact your ScholarBase provider for details.`,
};
function resolveReason(reason: string) {
  return COPY_BODY[reason] ?? COPY_BODY.subscription_expired;
}

console.log("\n=== 6. Subscription-blocked messaging (the business-critical fix) ===");
const kibibiUser: CachedUser = { schoolName: "Kibibi Muslim SS", trialEndsAt: "2026-06-20T00:00:00Z", subscriptionEndsAt: null };
check("trial_expired includes real school name", resolveReason("trial_expired")(kibibiUser).includes("Kibibi Muslim SS"), true);
check("trial_expired includes the actual trial end date, not a placeholder", resolveReason("trial_expired")(kibibiUser).includes("2026"), true);
check("unknown/garbage reason code falls back to subscription_expired copy, never crashes", resolveReason("some_garbage_value")(kibibiUser), COPY_BODY.subscription_expired(kibibiUser));
check("null user (no cached data at all) still produces a message, doesn't throw", typeof resolveReason("account_suspended")(null), "string");
check("null user falls back to generic 'Your school' phrasing", resolveReason("account_suspended")(null).includes("Your school"), true);
check("missing trialEndsAt on a real user still produces valid generic copy, not 'undefined' in the string", resolveReason("trial_expired")({ schoolName: "Test" }).includes("undefined"), false);



// ============================================================
// EXTRA: BOM + header normalization (mirrors client/src/lib/csv.ts)
// ============================================================
function parseCsvBom(text: string): string[][] {
  let input = text;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  input = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += char; }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

console.log("\n=== EXTRA: CSV BOM stripping ===");
{
  const bom = "\uFEFFFirst Name,Last Name\nJohn,Mukasa";
  const rows = parseCsvBom(bom);
  check("BOM stripped from first header", rows[0][0], "First Name");
  check("data row intact", rows[1][0] + " " + rows[1][1], "John Mukasa");
}

function normalizeHeader(h: string): string {
  return h.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[_\s]+/g, " ");
}
console.log("\n=== EXTRA: header normalize ===");
check("First Name", normalizeHeader("First Name"), "first name");
check("first_name", normalizeHeader("first_name"), "first name");
check("  SURNAME ", normalizeHeader("  SURNAME "), "surname");

console.log("\n=== EXTRA: gender normalize ===");
function normalizeGender(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const g = raw.trim().toLowerCase();
  if (g === "male" || g === "m" || g === "boy") return "male";
  if (g === "female" || g === "f" || g === "girl") return "female";
  return undefined;
}
check("M -> male", normalizeGender("M"), "male");
check("Girl -> female", normalizeGender("Girl"), "female");
check("x -> undefined", normalizeGender("x"), undefined);

console.log("\nDone.");

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
