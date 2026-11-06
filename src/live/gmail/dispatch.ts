/**
 * Gmail live adapter: EMAIL_MODE=live, EMAIL_LIVE_ADAPTER=gmail. Same tools and
 * output shapes as the simulation, so the AI and the gateway's previews see one
 * connector. Simulation-only tools are refused.
 */
import { createHash } from "crypto";
import { GmailClient, header, type GmailMessage, type GmailPart } from "./client.js";
import { buildRawMessage } from "./mime.js";
import { parseAttachments } from "../../attachments.js";

const SNIPPET_LENGTH = 140;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const META = ["From", "To", "Cc", "Subject", "Message-ID", "In-Reply-To", "References"];

let defaultClient: GmailClient | undefined;
function clientFor(env: NodeJS.ProcessEnv): GmailClient {
  if (env === process.env) return (defaultClient ??= GmailClient.fromEnv(env));
  return GmailClient.fromEnv(env);
}

/** Splits an address header into {name, email} entries, honouring quotes. */
export function parseAddresses(value: string | undefined): { name: string; email: string }[] {
  if (!value) return [];
  const parts: string[] = [];
  let cur = "", quoted = false, angle = false;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle = true;
    else if (!quoted && ch === ">") angle = false;
    if (ch === "," && !quoted && !angle) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.flatMap((p) => {
    const m = p.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
    const email = (m ? m[2] : p).trim();
    if (!email) return [];
    const name = m ? m[1].replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1").trim() : "";
    return [{ name, email }];
  });
}

/** Decodes RFC 2047 encoded-words in a header value (display names, subjects). */
export function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, text: string) => {
      try {
        const bytes = enc.toLowerCase() === "b"
          ? Buffer.from(text, "base64")
          : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
        return new TextDecoder(cs.toLowerCase() === "utf-8" ? "utf-8" : cs).decode(bytes);
      } catch { return _m; }
    });
}

function decodeEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function snippet(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > SNIPPET_LENGTH ? `${t.slice(0, SNIPPET_LENGTH)}…` : t;
}

function walk(part: GmailPart | undefined, fn: (p: GmailPart) => void): void {
  if (!part) return;
  fn(part);
  for (const p of part.parts ?? []) walk(p, fn);
}

function bodyText(msg: GmailMessage): string {
  let plain: string | undefined, html: string | undefined;
  walk(msg.payload, (p) => {
    if (p.filename || !p.body?.data) return;
    const text = Buffer.from(p.body.data, "base64url").toString("utf8");
    if (p.mimeType === "text/plain" && plain === undefined) plain = text;
    if (p.mimeType === "text/html" && html === undefined) html = text;
  });
  if (plain !== undefined) return plain;
  if (html !== undefined) return decodeEntities(html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, ""));
  return "";
}

function attachmentParts(msg: GmailMessage): GmailPart[] {
  const out: GmailPart[] = [];
  walk(msg.payload, (p) => { if (p.filename && p.body?.attachmentId) out.push(p); });
  return out;
}

const iso = (ms?: string) => new Date(Number(ms ?? 0)).toISOString();

function folderOf(msg: GmailMessage): "inbox" | "sent" {
  return msg.labelIds?.includes("SENT") && !msg.labelIds.includes("INBOX") ? "sent" : "inbox";
}

function fromOf(h: GmailMessage["payload"]) {
  const f = parseAddresses(decodeWords(header(h?.headers, "From") ?? ""))[0];
  return { name: f?.name ?? "", email: f?.email ?? "" };
}

async function list_messages(c: GmailClient, args: Record<string, any>) {
  const folder = args.folder ?? "inbox";
  if (folder !== "inbox" && folder !== "sent") {
    throw new Error(`Invalid folder: ${JSON.stringify(args.folder)} (must be "inbox" or "sent")`);
  }
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 500) : 50;
  const ids = (await c.listIds(folder === "inbox" ? "INBOX" : "SENT", limit)).messages ?? [];
  const msgs = await Promise.all(ids.map((m) => c.getMetadata(m.id, META)));
  return msgs.map((m) => ({
    id: m.id,
    folder,
    from: fromOf(m.payload),
    to: parseAddresses(decodeWords(header(m.payload?.headers, "To") ?? "")).map((a) => a.email),
    subject: decodeWords(header(m.payload?.headers, "Subject") ?? ""),
    received_at: iso(m.internalDate),
    snippet: snippet(decodeEntities(m.snippet ?? "")),
  }));
}

async function attachmentsMeta(c: GmailClient, msg: GmailMessage) {
  return Promise.all(
    attachmentParts(msg).map(async (p) => {
      const bytes = await c.getAttachmentData(msg.id, p.body!.attachmentId!);
      return {
        filename: p.filename!, contentType: p.mimeType ?? "application/octet-stream",
        size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bytes,
      };
    }),
  );
}

/** The id of the message in the same thread whose Message-ID is this message's In-Reply-To, else null. */
async function resolveInReplyTo(c: GmailClient, msg: GmailMessage): Promise<string | null> {
  const irt = header(msg.payload?.headers, "In-Reply-To")?.trim();
  if (!irt) return null;
  const thread = await c.getThreadMetadata(msg.threadId, ["Message-ID"]);
  const parent = thread.messages?.find((m) => header(m.payload?.headers, "Message-ID")?.trim().toLowerCase() === irt.toLowerCase());
  return parent?.id ?? null;
}

async function toFullMessage(c: GmailClient, msg: GmailMessage) {
  const h = msg.payload?.headers;
  const atts = await attachmentsMeta(c, msg);
  return {
    id: msg.id,
    folder: folderOf(msg),
    from: fromOf(msg.payload),
    to: parseAddresses(decodeWords(header(h, "To") ?? "")).map((a) => a.email),
    cc: parseAddresses(decodeWords(header(h, "Cc") ?? "")).map((a) => a.email),
    subject: decodeWords(header(h, "Subject") ?? ""),
    body: bodyText(msg),
    received_at: iso(msg.internalDate),
    in_reply_to: await resolveInReplyTo(c, msg),
    attachments: atts.map(({ bytes: _b, ...meta }) => meta),
  };
}

async function get_message(c: GmailClient, args: Record<string, any>) {
  if (!args.id) throw new Error("id is required");
  return toFullMessage(c, await c.getFull(String(args.id)));
}

async function get_attachment(c: GmailClient, args: Record<string, any>) {
  const { message_id, sha256, index } = args;
  if (typeof message_id !== "string" || !message_id) throw new Error("message_id is required");
  if (sha256 !== undefined && index !== undefined) throw new Error("give either sha256 or index, not both");
  if (sha256 === undefined && index === undefined) throw new Error("give sha256 or index to select an attachment");
  const atts = await attachmentsMeta(c, await c.getFull(message_id));
  let a;
  if (sha256 !== undefined) {
    if (typeof sha256 !== "string" || !sha256) throw new Error("sha256 must be a string");
    a = atts.find((x) => x.sha256 === sha256);
    if (!a) throw new Error(`No attachment with sha256 ${sha256} on message ${message_id}`);
  } else {
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw new Error("index must be a non-negative integer");
    a = atts[index];
    if (!a) throw new Error(`No attachment at index ${index} on message ${message_id}`);
  }
  return { message_id, filename: a.filename, contentType: a.contentType, size: a.size, sha256: a.sha256, contentBase64: a.bytes.toString("base64") };
}

function emailList(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${field} must be a non-empty array of email addresses`);
  for (const v of value) if (typeof v !== "string" || !EMAIL_RE.test(v)) throw new Error(`${field} contains an invalid email address: ${JSON.stringify(v)}`);
  return value as string[];
}

async function send_message(c: GmailClient, args: Record<string, any>) {
  const { to, cc, subject, body, in_reply_to, attachments } = args;
  const toList = emailList(to, "to");
  const ccList = cc === undefined ? [] : emailList(cc, "cc", true);
  if (typeof subject !== "string" || !subject.trim()) throw new Error("subject is required");
  if (typeof body !== "string" || !body.trim()) throw new Error("body is required");
  const parsed = parseAttachments(attachments);

  let threadId: string | undefined, parentId: string | undefined, parentRefs: string | undefined;
  if (in_reply_to !== undefined && in_reply_to !== null) {
    if (typeof in_reply_to !== "string") throw new Error("in_reply_to must be a message id (string)");
    const parent = await c.getMetadata(in_reply_to, ["Message-ID", "References"]).catch(() => {
      throw new Error(`Unknown in_reply_to message id: ${in_reply_to}`);
    });
    threadId = parent.threadId;
    parentId = header(parent.payload?.headers, "Message-ID")?.trim();
    parentRefs = header(parent.payload?.headers, "References")?.trim();
  }

  const raw = buildRawMessage({
    to: toList, cc: ccList, subject, body, attachments: parsed,
    ...(parentId !== undefined ? { inReplyToMessageId: parentId, parentReferences: parentRefs } : {}),
  });
  const sent = await c.send(raw, threadId);
  return toFullMessage(c, await c.getFull(sent.id));
}

export async function callGmailTool(name: string, args: Record<string, any>, env: NodeJS.ProcessEnv = process.env, client?: GmailClient): Promise<unknown> {
  switch (name) {
    case "list_messages": case "get_message": case "get_attachment": case "send_message": break;
    case "load_simulation": case "clear_simulation":
      throw new Error(`Refused: "${name}" is not available in live mode (it only exists for the simulated inbox). Nothing was read or changed.`);
    default: throw new Error(`Unknown tool: ${name}`);
  }
  const c = client ?? clientFor(env);
  switch (name) {
    case "list_messages": return list_messages(c, args);
    case "get_message": return get_message(c, args);
    case "get_attachment": return get_attachment(c, args);
    default: return send_message(c, args);
  }
}
