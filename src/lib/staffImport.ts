/**
 * Bulk import of staff and house helps from a spreadsheet.
 *
 * Accepts CSV and TSV. Excel users choose "Save As → CSV UTF-8"; adding
 * a real .xlsx parser would mean pulling in SheetJS, which is a sizeable
 * dependency and, on npm, a version behind the vendor's own distribution.
 *
 * The existing CsvUpload splits rows on "," with no quote handling. That
 * breaks the moment a field contains a comma — and this importer has an
 * address column, where commas are the norm — so this parser handles
 * RFC 4180 quoting, escaped quotes and embedded newlines.
 */

export const GOV_ID_TYPES = [
  "aadhaar", "passport", "pan", "voter_id", "driving_license", "ration_card",
] as const;
export type GovIdType = (typeof GOV_ID_TYPES)[number];

export const GENDERS = ["male", "female", "other", "undisclosed"] as const;
export type Gender = (typeof GENDERS)[number];

/** Spreadsheet headings people actually type, mapped to our columns. */
const HEADER_ALIASES: Record<string, string> = {
  name: "name", full_name: "name", staff_name: "name", employee_name: "name",
  phone: "phone", mobile: "phone", phone_number: "phone", contact: "phone", mobile_number: "phone",
  type: "role_type", staff_type: "role_type", help_type: "role_type", role: "role_type",
  designation: "role_type", work: "role_type",
  gender: "gender", sex: "gender",
  dob: "date_of_birth", date_of_birth: "date_of_birth", birth_date: "date_of_birth",
  address: "address", residential_address: "address", home_address: "address",
  id_type: "id_type", idtype: "id_type", document_type: "id_type", proof_type: "id_type",
  id_number: "id_number", idnumber: "id_number", document_number: "id_number",
  id_no: "id_number", proof_number: "id_number",
  emergency_contact: "emergency_contact", emergency_name: "emergency_contact",
  emergency_phone: "emergency_phone", emergency_number: "emergency_phone",
};

const ID_TYPE_ALIASES: Record<string, GovIdType> = {
  aadhaar: "aadhaar", aadhar: "aadhaar", adhaar: "aadhaar", adhar: "aadhaar",
  aadhaar_card: "aadhaar", uid: "aadhaar",
  passport: "passport",
  pan: "pan", pan_card: "pan",
  voter_id: "voter_id", voter: "voter_id", voterid: "voter_id", epic: "voter_id",
  election_card: "voter_id",
  driving_license: "driving_license", driving_licence: "driving_license",
  dl: "driving_license", licence: "driving_license", license: "driving_license",
  ration_card: "ration_card", ration: "ration_card",
};

const GENDER_ALIASES: Record<string, Gender> = {
  m: "male", male: "male", man: "male",
  f: "female", female: "female", woman: "female",
  o: "other", other: "other",
  "": "undisclosed", na: "undisclosed", undisclosed: "undisclosed",
};

export interface ImportRow {
  name: string;
  phone: string | null;
  role_type: string;
  gender: Gender | null;
  date_of_birth: string | null;
  address: string | null;
  id_type: GovIdType | null;
  id_number: string | null;
  emergency_contact: string | null;
  emergency_phone: string | null;
}

export interface RowError {
  /** 1-based line number as shown in the spreadsheet, header included. */
  line: number;
  message: string;
}

export interface ParseOutcome {
  rows: ImportRow[];
  errors: RowError[];
  /** Headers we did not recognise — surfaced so typos are visible. */
  ignoredColumns: string[];
}

/** RFC 4180 parser: quotes, "" escapes and newlines inside fields. */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM, which Excel writes and which otherwise corrupts
  // the first header name.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }

    field += ch; i++;
  }

  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Guess the delimiter from the header line. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  if (tabs > commas && tabs > semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

export function normaliseHeader(h: string): string | null {
  const key = h.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^\w]/g, "");
  return HEADER_ALIASES[key] ?? null;
}

/** Indian mobile numbers, tolerant of +91, 0 prefixes and spacing. */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return local.length === 10 ? local : null;
}

/** Accepts dd/mm/yyyy, dd-mm-yyyy and yyyy-mm-dd; returns ISO yyyy-mm-dd. */
export function normaliseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  let y: number, m: number, d: number;
  const iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);

  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (dmy) { d = +dmy[1]; m = +dmy[2]; y = +dmy[3]; }
  else return null;

  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  if (dt.getTime() > Date.now()) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function normaliseIdType(raw: string): GovIdType | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/[^\w]/g, "");
  return ID_TYPE_ALIASES[key] ?? null;
}

export function normaliseGender(raw: string): Gender | null {
  const key = raw.trim().toLowerCase();
  return GENDER_ALIASES[key] ?? null;
}

/**
 * Per-ID-type format checks. Deliberately shape-only: we are not
 * validating against any issuing authority, just catching transcription
 * slips before they reach the database.
 */
export function validateIdNumber(type: GovIdType, value: string): string | null {
  const v = value.replace(/\s+/g, "").toUpperCase();
  switch (type) {
    case "aadhaar":
      return /^\d{12}$/.test(v) ? null : "Aadhaar must be 12 digits";
    case "pan":
      return /^[A-Z]{5}\d{4}[A-Z]$/.test(v) ? null : "PAN must look like ABCDE1234F";
    case "passport":
      return /^[A-Z]\d{7}$/.test(v) ? null : "Passport must be a letter followed by 7 digits";
    case "voter_id":
      return /^[A-Z]{3}\d{7}$/.test(v) ? null : "Voter ID must be 3 letters followed by 7 digits";
    case "driving_license":
      return v.length >= 8 && v.length <= 20 ? null : "Driving licence looks too short or too long";
    case "ration_card":
      return v.length >= 6 && v.length <= 20 ? null : "Ration card number looks invalid";
    default:
      return null;
  }
}

/** Store Aadhaar masked. The full number is never needed at a gate. */
export function maskIdNumber(type: GovIdType | null, value: string | null): string | null {
  if (!value) return null;
  const v = value.replace(/\s+/g, "");
  if (type === "aadhaar" && v.length === 12) return `XXXXXXXX${v.slice(-4)}`;
  return v.toUpperCase();
}

export interface ParseOptions {
  /** Role used when a row leaves the type column blank. */
  defaultRoleType: string;
  /** Mask Aadhaar before it is stored. On by default. */
  maskAadhaar?: boolean;
}

export function parseStaffSheet(text: string, opts: ParseOptions): ParseOutcome {
  const errors: RowError[] = [];
  const rows: ImportRow[] = [];

  const table = parseDelimited(text, detectDelimiter(text));
  if (table.length < 2) {
    return { rows, errors: [{ line: 1, message: "File needs a header row and at least one data row." }], ignoredColumns: [] };
  }

  const rawHeaders = table[0];
  const headers = rawHeaders.map(normaliseHeader);
  const ignoredColumns = rawHeaders.filter((h, i) => headers[i] === null && h.trim() !== "");

  if (!headers.includes("name")) {
    return {
      rows,
      errors: [{ line: 1, message: `No "name" column found. Columns seen: ${rawHeaders.join(", ")}` }],
      ignoredColumns,
    };
  }

  const seenIds = new Set<string>();

  for (let r = 1; r < table.length; r++) {
    const line = r + 1;
    const cells = table[r];
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) obj[h] = (cells[i] ?? "").trim(); });

    const name = (obj.name ?? "").trim();
    if (!name) { errors.push({ line, message: "Name is required" }); continue; }

    const phone = obj.phone ? normalisePhone(obj.phone) : null;
    if (obj.phone && !phone) {
      errors.push({ line, message: `"${obj.phone}" is not a valid 10-digit phone number` });
      continue;
    }

    const dob = obj.date_of_birth ? normaliseDate(obj.date_of_birth) : null;
    if (obj.date_of_birth && !dob) {
      errors.push({ line, message: `"${obj.date_of_birth}" is not a valid date (use dd/mm/yyyy)` });
      continue;
    }

    let gender: Gender | null = null;
    if (obj.gender) {
      gender = normaliseGender(obj.gender);
      if (!gender) { errors.push({ line, message: `Unknown gender "${obj.gender}"` }); continue; }
    }

    let idType: GovIdType | null = null;
    if (obj.id_type) {
      idType = normaliseIdType(obj.id_type);
      if (!idType) {
        errors.push({ line, message: `Unknown ID type "${obj.id_type}". Use Aadhaar, Passport, PAN, Voter ID, Driving License or Ration Card` });
        continue;
      }
    }

    let idNumber: string | null = null;
    if (obj.id_number) {
      if (!idType) { errors.push({ line, message: "ID number given without an ID type" }); continue; }
      const problem = validateIdNumber(idType, obj.id_number);
      if (problem) { errors.push({ line, message: problem }); continue; }
      const key = `${idType}:${obj.id_number.replace(/\s+/g, "").toUpperCase()}`;
      if (seenIds.has(key)) {
        errors.push({ line, message: `Duplicate ID number within this file (${obj.id_number})` });
        continue;
      }
      seenIds.add(key);
      idNumber = opts.maskAadhaar === false
        ? obj.id_number.replace(/\s+/g, "").toUpperCase()
        : maskIdNumber(idType, obj.id_number);
    }
    if (idType && !idNumber) { errors.push({ line, message: "ID type given without an ID number" }); continue; }

    rows.push({
      name,
      phone,
      role_type: obj.role_type || opts.defaultRoleType,
      gender,
      date_of_birth: dob,
      address: obj.address || null,
      id_type: idType,
      id_number: idNumber,
      emergency_contact: obj.emergency_contact || null,
      emergency_phone: obj.emergency_phone ? normalisePhone(obj.emergency_phone) : null,
    });
  }

  return { rows, errors, ignoredColumns };
}

/** Template handed to admins so they start from the right columns. */
export function buildTemplateCsv(kind: "staff" | "house_help"): string {
  const header = [
    "name", "phone", kind === "staff" ? "staff_type" : "help_type", "gender",
    "date_of_birth", "address", "id_type", "id_number",
    "emergency_contact", "emergency_phone",
  ].join(",");
  const example = kind === "staff"
    ? ['Ramesh Kumar', '9876543210', 'Security', 'male', '15/08/1985',
       '"12, Shivaji Nagar, Pune"', 'aadhaar', '123412341234', 'Sunita Kumar', '9876543211']
    : ['Lakshmi Devi', '9823456780', 'Maid', 'female', '02/03/1990',
       '"Flat 4, Anand Chawl, Mumbai"', 'voter_id', 'ABC1234567', 'Ravi Devi', '9823456781'];
  return `${header}\n${example.join(",")}\n`;
}
