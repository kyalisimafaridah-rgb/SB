// Minimal CSV parsing/generation — no extra dependency.
// Handles quoted fields, BOM, formula injection on export.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip UTF-8 BOM (Excel on Windows often writes this). Without this, the
  // first header becomes "\uFEFFFirst Name" and every column mapping fails.
  let input = text;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  input = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

/** Normalize header for matching: lower-case, collapse spaces/underscores. */
export function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ");
}

/**
 * Map a header row to canonical student-import keys.
 * Accepts common aliases so Excel renames / slightly different templates still work.
 */
const HEADER_ALIASES: Record<string, string> = {
  "first name": "firstName",
  "firstname": "firstName",
  "given name": "firstName",
  "last name": "lastName",
  "lastname": "lastName",
  "surname": "lastName",
  "class": "className",
  "class name": "className",
  "parent name": "parentName",
  "parent": "parentName",
  "guardian name": "parentName",
  "parent phone": "parentPhone",
  "parent phone 1": "parentPhone",
  "phone": "parentPhone",
  "mobile": "parentPhone",
  "parent phone 2": "parentPhone2",
  "phone 2": "parentPhone2",
  "gender": "gender",
  "sex": "gender",
  "date of birth": "dateOfBirth",
  "dob": "dateOfBirth",
  "birth date": "dateOfBirth",
  "special status": "specialStatus",
  "status": "specialStatus",
  "custom total fee (ugx)": "customTotalFee",
  "custom total fee": "customTotalFee",
  "custom fee": "customTotalFee",
  "fee": "customTotalFee",
  "village": "village",
  "admission number": "admissionNumber",
  "admission no": "admissionNumber",
  "admission no.": "admissionNumber",
};

export function parseCsvToObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const rawHeaders = rows[0].map((h) => h.replace(/^\uFEFF/, "").trim());
  const canonical = rawHeaders.map((h) => {
    const key = normalizeHeader(h);
    return HEADER_ALIASES[key] ?? HEADER_ALIASES[key.replace(/ /g, "")] ?? h;
  });

  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    canonical.forEach((h, i) => {
      // Prefer first occurrence if duplicate headers
      if (obj[h] === undefined) {
        obj[h] = (row[i] ?? "").trim();
      }
    });
    return obj;
  });
}

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

export function buildCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers.map((h) => escapeCsvField(h)).join(",")];
  for (const row of rows) {
    lines.push(row.map((cell) => escapeCsvField(String(cell ?? ""))).join(","));
  }
  return lines.join("\n");
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const csv = buildCsv(headers, rows);
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Parse DOB from common spreadsheet formats into YYYY-MM-DD or null. */
export function normalizeDateOfBirth(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const s = raw.trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD-MM-YYYY (common in UG schools)
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, "0");
    const mo = m[2].padStart(2, "0");
    const y = m[3];
    // Prefer DMY for Uganda; if month > 12, treat as MDY
    if (Number(mo) > 12 && Number(d) <= 12) {
      return `${y}-${d}-${mo}`;
    }
    return `${y}-${mo}-${d}`;
  }
  // Excel serial date (rough): days since 1899-12-30
  if (/^\d{5}$/.test(s)) {
    const serial = Number(s);
    const epoch = Date.UTC(1899, 11, 30);
    const dt = new Date(epoch + serial * 86400000);
    const y = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    if (y >= 1990 && y <= 2020) return `${y}-${mo}-${d}`;
  }
  return undefined; // unparseable — leave blank rather than corrupt
}

export function normalizeGender(raw: string | undefined): "male" | "female" | undefined {
  if (!raw?.trim()) return undefined;
  const g = raw.trim().toLowerCase();
  if (g === "male" || g === "m" || g === "boy" || g === "b") return "male";
  if (g === "female" || g === "f" || g === "girl" || g === "g") return "female";
  return undefined;
}

export function normalizeSpecialStatus(
  raw: string | undefined
): "none" | "orphan" | "staffChild" | "bursary" | undefined {
  if (!raw?.trim()) return undefined;
  const s = raw.trim().toLowerCase().replace(/[_\s]+/g, "");
  if (s === "none" || s === "n/a" || s === "na" || s === "-") return "none";
  if (s === "orphan") return "orphan";
  if (s === "staffchild" || s === "staff" || s === "teacherchild") return "staffChild";
  if (s === "bursary" || s === "bursar" || s === "scholarship") return "bursary";
  return undefined;
}
