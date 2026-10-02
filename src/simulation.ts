/**
 * Simulation package: the test data an empty inbox is created from. Shares its
 * flat-JSON shape with the ERP and CRM connectors (`name`, `currency`,
 * `customers`, `products`, `contacts`, `cases`) so one file can seed all three —
 * this connector only reads `cases` and ignores the rest.
 *
 * Validated strictly and refused whole on the first problem, naming the field
 * (e.g. `cases[2].request.from.email`): a half-loaded or silently "fixed"
 * package would make every later measurement of the agent's replies compare
 * against data nobody wrote.
 */
import { readFileSync } from "fs";
import { createHash } from "crypto";

export interface SimCaseRequest {
  from: { name: string; email: string };
  subject: string;
  body: string;
  received_at: string | null;
}

export interface SimCaseReply {
  subject: string;
  body: string;
}

export interface SimCase {
  id: string;
  request: SimCaseRequest;
  reply: SimCaseReply;
  notes: string | null;
}

export interface SimPackage {
  name: string;
  /** The company's own mailbox the requests arrive in and replies are sent from (optional). */
  email?: string;
  cases: SimCase[];
  /** sha256 of the canonical form (recursively key-sorted JSON) of the whole package as loaded. */
  sha256: string;
}

function fail(path: string, msg: string): never {
  throw new Error(`Package ${path}: ${msg}`);
}

function str(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(v: unknown): v is string {
  return typeof v === "string" && EMAIL_RE.test(v);
}

/** Recursively sorts object keys (arrays keep their order) so equal data always serializes the same way. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function parseCase(raw: unknown, path: string, i: number): SimCase {
  const at = `cases[${i}]`;
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!str(o.id)) fail(path, `${at}.id is required`);

  const req = (o.request ?? null) as Record<string, unknown> | null;
  if (!req || typeof req !== "object") fail(path, `${at}.request is required`);
  const from = (req.from ?? null) as Record<string, unknown> | null;
  if (!from || typeof from !== "object") fail(path, `${at}.request.from is required`);
  if (!str(from.name)) fail(path, `${at}.request.from.name is required`);
  if (!isEmail(from.email)) fail(path, `${at}.request.from.email must be a valid email address`);
  if (!str(req.subject)) fail(path, `${at}.request.subject is required`);
  if (!str(req.body)) fail(path, `${at}.request.body is required`);
  const receivedAt = req.received_at;
  if (receivedAt !== undefined && receivedAt !== null && !str(receivedAt)) {
    fail(path, `${at}.request.received_at must be a string (ISO 8601) when given`);
  }

  const reply = (o.reply ?? null) as Record<string, unknown> | null;
  if (!reply || typeof reply !== "object") fail(path, `${at}.reply is required`);
  if (!str(reply.subject)) fail(path, `${at}.reply.subject is required`);
  if (!str(reply.body)) fail(path, `${at}.reply.body is required`);

  if (o.notes !== undefined && o.notes !== null && !str(o.notes)) {
    fail(path, `${at}.notes must be a string when given`);
  }

  return {
    id: o.id as string,
    request: {
      from: { name: from.name as string, email: from.email as string },
      subject: req.subject as string,
      body: req.body as string,
      received_at: str(receivedAt) ? (receivedAt as string) : null,
    },
    reply: { subject: reply.subject as string, body: reply.body as string },
    notes: str(o.notes) ? (o.notes as string) : null,
  };
}

export function parsePackage(raw: unknown, path = "(inline)"): SimPackage {
  if (!raw || typeof raw !== "object") fail(path, "must be a JSON object");
  const p = raw as Record<string, unknown>;
  if (!str(p.name)) fail(path, "`name` is required");
  if (!Array.isArray(p.cases) || p.cases.length === 0) fail(path, "`cases` must be a non-empty list");

  const ids = new Set<string>();
  const cases = p.cases.map((c, i) => {
    const parsed = parseCase(c, path, i);
    if (ids.has(parsed.id)) fail(path, `cases[${i}].id ${JSON.stringify(parsed.id)} appears twice`);
    ids.add(parsed.id);
    return parsed;
  });

  if (p.email !== undefined && !isEmail(p.email)) fail(path, "`email` must be a valid email address (the company's mailbox)");
  return { name: p.name, ...(isEmail(p.email) ? { email: p.email } : {}), cases, sha256: canonicalJsonSha256(raw) };
}

export function loadPackageFile(path: string): SimPackage {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(path, `cannot be read as JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return parsePackage(raw, path);
}

/**
 * The company's mailbox: the package's `email` if given, else office@<name-slug>.com.
 * Deliberately nothing that says "simulated": the agent under test must not be able
 * to tell the simulated inbox from a real one by looking at addresses (realistic
 * measurement — safety comes from the gateway's simulation mode, not the agent).
 */
export function companyAddress(name: string, email?: string | null): string {
  if (email) return email;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "company";
  return `office@${slug}.com`;
}
