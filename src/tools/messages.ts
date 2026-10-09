import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { companyAddress } from "../simulation.js";

export interface MessageRow {
  id: string;
  folder: "inbox" | "sent";
  from_name: string;
  from_email: string;
  to_json: string;
  cc_json: string | null;
  subject: string;
  body: string;
  received_at: string;
  in_reply_to: string | null;
  case_id: string | null;
  receipt_id: string | null;
}

const SNIPPET_LENGTH = 140;

function snippet(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, " ");
  return trimmed.length > SNIPPET_LENGTH ? `${trimmed.slice(0, SNIPPET_LENGTH)}…` : trimmed;
}

/** Public shape of a list_messages entry — never includes the body or reference reply. */
function toListEntry(row: MessageRow) {
  return {
    id: row.id,
    folder: row.folder,
    from: { name: row.from_name, email: row.from_email },
    to: JSON.parse(row.to_json) as string[],
    subject: row.subject,
    received_at: row.received_at,
    snippet: snippet(row.body),
  };
}

/** Public shape of a get_message result — the body is included, the reference reply never is. */
function toFullMessage(row: MessageRow) {
  return {
    id: row.id,
    folder: row.folder,
    from: { name: row.from_name, email: row.from_email },
    to: JSON.parse(row.to_json) as string[],
    cc: row.cc_json ? (JSON.parse(row.cc_json) as string[]) : [],
    subject: row.subject,
    body: row.body,
    received_at: row.received_at,
    in_reply_to: row.in_reply_to,
  };
}

export async function list_messages(db: Db, args: Record<string, any>) {
  const folder = args.folder ?? "inbox";
  if (folder !== "inbox" && folder !== "sent") {
    throw new Error(`Invalid folder: ${JSON.stringify(args.folder)} (must be "inbox" or "sent")`);
  }
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 50;
  const rows = await db.all<MessageRow>(
    `SELECT * FROM messages WHERE folder = ? ORDER BY received_at DESC, rowid DESC LIMIT ?`,
    [folder, limit],
  );
  return rows.map(toListEntry);
}

export async function get_message(db: Db, args: Record<string, any>) {
  const { id } = args;
  if (!id) throw new Error("id is required");
  const row = await db.get<MessageRow>(`SELECT * FROM messages WHERE id = ?`, [id]);
  if (!row) throw new Error(`Unknown message id: ${id}`);
  return toFullMessage(row);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireEmailList(value: unknown, field: string, { allowEmpty = false } = {}): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${field} must be a non-empty array of email addresses`);
  }
  for (const v of value) {
    if (typeof v !== "string" || !EMAIL_RE.test(v)) {
      throw new Error(`${field} contains an invalid email address: ${JSON.stringify(v)}`);
    }
  }
  return value as string[];
}

/** The address/name this connector sends as — the simulated company if a package was loaded, else a generic default. */
async function resolveSelf(db: Db): Promise<{ name: string; email: string }> {
  const load = await db.get<{ name: string; email: string | null }>(`SELECT name, email FROM simulation_load WHERE id = 'default'`);
  if (load) return { name: load.name, email: companyAddress(load.name, load.email) };
  return { name: "Office", email: "office@company.com" };
}

export async function send_message(db: Db, args: Record<string, any>) {
  // ticket_id: stored on the existing receipt_id column (internal storage
  // name, unchanged by the v0.7 wire rename of the tool argument).
  const { to, cc, subject, body, in_reply_to, ticket_id } = args;

  const toList = requireEmailList(to, "to");
  const ccList = cc === undefined ? [] : requireEmailList(cc, "cc", { allowEmpty: true });
  if (typeof subject !== "string" || !subject.trim()) throw new Error("subject is required");
  if (typeof body !== "string" || !body.trim()) throw new Error("body is required");

  if (in_reply_to !== undefined && in_reply_to !== null) {
    if (typeof in_reply_to !== "string") throw new Error("in_reply_to must be a message id (string)");
    const parent = await db.get(`SELECT id FROM messages WHERE id = ?`, [in_reply_to]);
    if (!parent) throw new Error(`Unknown in_reply_to message id: ${in_reply_to}`);
  }

  const self = await resolveSelf(db);
  const id = uuidv4();
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO messages (id, folder, from_name, from_email, to_json, cc_json, subject, body, received_at, in_reply_to, case_id, receipt_id)
     VALUES (?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      id, self.name, self.email, JSON.stringify(toList), ccList.length ? JSON.stringify(ccList) : null,
      subject, body, now, in_reply_to ?? null, ticket_id ?? null,
    ],
  );

  const row = await db.get<MessageRow>(`SELECT * FROM messages WHERE id = ?`, [id]);
  return toFullMessage(row!);
}
