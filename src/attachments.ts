/**
 * Attachments on a sent message. In Suveren the agent never carries file
 * bytes: it names the document it means, and the governing gateway fetches
 * it, shows it sealed on the approval card, and passes the bytes to this
 * connector's `send_message`. This module validates what a call actually
 * gave us — caps on count and size, a sane filename, a real MIME type, base64
 * that actually decodes — and stores it; metadata (never content) is what
 * get_message/send_message hand back, and get_attachment is the one place
 * content comes back out, by explicit selection.
 */
import { createHash } from "crypto";
import type { Db } from "./db.js";

export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB per message

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  bytes: Buffer;
  size: number;
  sha256: string;
}

export interface AttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
}

interface AttachmentRow {
  position: number;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  content_base64: string;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// type/subtype, RFC 2045 token chars (loose but rejects nonsense like "pdf" or "text, html").
const CONTENT_TYPE_RE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]*$/;

function fail(i: number, field: string, msg: string): never {
  throw new Error(`attachments[${i}].${field} ${msg}`);
}

/**
 * No path separators, no "." / ".." as the whole name, no control characters,
 * not empty, not absurdly long. The gateway is expected to name the file;
 * this is the connector's own floor, not a place that silently rewrites a
 * name — a bad one is refused, not "fixed".
 */
function checkFilename(value: unknown, i: number): string {
  if (typeof value !== "string" || value.trim() === "") fail(i, "filename", "is required");
  const name = value;
  if (name.includes("/") || name.includes("\\")) fail(i, "filename", "must not contain a path separator");
  if (name === "." || name === "..") fail(i, "filename", 'must not be "." or ".."');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) fail(i, "filename", "must not contain control characters");
  if (name.length > 255) fail(i, "filename", "must be at most 255 characters");
  return name;
}

function checkContentType(value: unknown, i: number): string {
  if (typeof value !== "string" || !CONTENT_TYPE_RE.test(value)) {
    fail(i, "contentType", `must be a MIME type such as "application/pdf", got ${JSON.stringify(value)}`);
  }
  return value;
}

function decodeBase64(value: unknown, i: number): Buffer {
  if (typeof value !== "string" || value.trim() === "") fail(i, "contentBase64", "is required");
  if (!BASE64_RE.test(value) || value.length % 4 !== 0) {
    fail(i, "contentBase64", "is not valid base64");
  }
  return Buffer.from(value, "base64");
}

/**
 * Validates and decodes the `attachments` argument of send_message. Refuses
 * whole on the first problem, naming the field (e.g. `attachments[1].size`) —
 * same rule the simulation package loader follows, for the same reason: a
 * half-accepted message would make later reads lie about what the agent
 * actually sent. Returns `[]` for `undefined`/`null` — attachments stay
 * optional, so a call without them is unchanged from before this feature.
 */
export function parseAttachments(value: unknown): ParsedAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  if (value.length > MAX_ATTACHMENTS) {
    throw new Error(`attachments: at most ${MAX_ATTACHMENTS} files are allowed, got ${value.length}`);
  }

  let total = 0;
  const parsed = value.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const filename = checkFilename(o.filename, i);
    const contentType = checkContentType(o.contentType, i);
    const bytes = decodeBase64(o.contentBase64, i);
    const size = bytes.length;
    if (size === 0) fail(i, "contentBase64", "decodes to an empty file");
    if (size > MAX_ATTACHMENT_BYTES) {
      fail(i, "contentBase64", `decodes to ${size} bytes — the per-file limit is ${MAX_ATTACHMENT_BYTES} bytes (10 MB)`);
    }
    total += size;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { filename, contentType, bytes, size, sha256 };
  });

  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(
      `attachments: total size is ${total} bytes — the limit per message is ${MAX_TOTAL_ATTACHMENT_BYTES} bytes (25 MB)`,
    );
  }
  return parsed;
}

/** Stores the already-validated attachments for a message, in the order given. */
export async function insertAttachments(db: Db, messageId: string, attachments: ParsedAttachment[]): Promise<void> {
  for (const [position, a] of attachments.entries()) {
    await db.run(
      `INSERT INTO attachments (id, message_id, position, filename, content_type, size, sha256, content_base64)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`${messageId}-${position}`, messageId, position, a.filename, a.contentType, a.size, a.sha256, a.bytes.toString("base64")],
    );
  }
}

/** Metadata only (filename, contentType, size, sha256) — never the bytes. What get_message and send_message return. */
export async function getAttachmentsMeta(db: Db, messageId: string): Promise<AttachmentMeta[]> {
  const rows = await db.all<AttachmentRow>(
    `SELECT position, filename, content_type, size, sha256 FROM attachments WHERE message_id = ? ORDER BY position`,
    [messageId],
  );
  return rows.map((r) => ({ filename: r.filename, contentType: r.content_type, size: r.size, sha256: r.sha256 }));
}

/**
 * The one tool that returns attachment content, and only by explicit
 * selection — either the sha256 shown in get_message's metadata, or the
 * 0-based position among the message's attachments. Never both, never
 * neither.
 */
export async function get_attachment(db: Db, args: Record<string, any>) {
  const { message_id, sha256, index } = args;
  if (typeof message_id !== "string" || !message_id) throw new Error("message_id is required");

  const message = await db.get(`SELECT id FROM messages WHERE id = ?`, [message_id]);
  if (!message) throw new Error(`Unknown message id: ${message_id}`);

  if (sha256 !== undefined && index !== undefined) {
    throw new Error("give either sha256 or index, not both");
  }

  let row: AttachmentRow | undefined;
  if (sha256 !== undefined) {
    if (typeof sha256 !== "string" || !sha256) throw new Error("sha256 must be a string");
    row = await db.get<AttachmentRow>(
      `SELECT position, filename, content_type, size, sha256, content_base64 FROM attachments WHERE message_id = ? AND sha256 = ?`,
      [message_id, sha256],
    );
    if (!row) throw new Error(`No attachment with sha256 ${sha256} on message ${message_id}`);
  } else if (index !== undefined) {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
      throw new Error("index must be a non-negative integer");
    }
    row = await db.get<AttachmentRow>(
      `SELECT position, filename, content_type, size, sha256, content_base64 FROM attachments WHERE message_id = ? AND position = ?`,
      [message_id, index],
    );
    if (!row) throw new Error(`No attachment at index ${index} on message ${message_id}`);
  } else {
    throw new Error("give sha256 or index to select an attachment");
  }

  return {
    message_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    sha256: row.sha256,
    contentBase64: row.content_base64,
  };
}
