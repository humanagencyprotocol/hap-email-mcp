/**
 * Builds the raw RFC 822 message the Gmail adapter sends. Pure logic, no network.
 *
 * The contract (the same for every email adapter): the message contains exactly
 * the fields the person approved and nothing else the connector made up.
 *   - Subject is the given subject, character for character. No "Re:" is added.
 *   - The body is the given body, character for character. No quote of the
 *     message being replied to is added.
 *   - A reply carries correct In-Reply-To / References headers so the mail
 *     client threads it. Those are headers about the thread, not content.
 *   - Headers are folded at whitespace (RFC 5322 section 2.2.3), never broken
 *     with quoted-printable soft breaks. A subject with non-ASCII characters is
 *     written as RFC 2047 encoded-words, which decode back to the exact text.
 *
 * The header set is closed: To, Cc, Subject, In-Reply-To, References,
 * MIME-Version, Content-Type, Content-Transfer-Encoding. The mail system adds
 * From, Date and Message-ID itself.
 */
import { randomUUID } from "crypto";
import type { ParsedAttachment } from "../../attachments.js";

export interface RawMessageInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  /** Message-ID of the message being replied to, including angle brackets. */
  inReplyToMessageId?: string;
  /** References header of the message being replied to (space-separated ids), if it had one. */
  parentReferences?: string;
  attachments?: ParsedAttachment[];
  /** Fixed boundary for tests; random otherwise. */
  boundary?: string;
}

const CRLF = "\r\n";
const FOLD_AT = 78;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const MSGID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/;

function assertNoControl(value: string, what: string): void {
  if (CONTROL_RE.test(value)) throw new Error(`${what} must not contain line breaks or control characters`);
}

/**
 * Folds one header at whitespace so no line exceeds ~78 characters. A fold puts
 * CRLF in front of an existing whitespace character, so unfolding gives back the
 * value exactly. A fold directly after the colon is legal, so even a long
 * message id gets its own line. A single token longer than the limit by itself
 * stays whole (RFC 5322 only hard-limits at 998).
 */
export function foldHeader(name: string, value: string): string {
  const tokens = value.split(/(?<=\S)(?= )/);
  const lines: string[] = [];
  let line = `${name}:`;
  for (const token of tokens) {
    const piece = token.startsWith(" ") ? token : ` ${token}`;
    if (line.length + piece.length > FOLD_AT) {
      lines.push(line);
      line = piece;
    } else {
      line += piece;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

function isAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(s);
}

/** RFC 2047 B-encoded words, each at most 75 characters, split on character boundaries. */
function encodeWords(text: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(" ");
}

function headerText(value: string): string {
  assertNoControl(value, "subject");
  return isAscii(value) ? value : encodeWords(value);
}

function base64Lines(bytes: Buffer): string {
  const b64 = bytes.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

function contentDisposition(filename: string): string {
  if (/^[\x20-\x7e]*$/.test(filename) && !/["\\]/.test(filename)) {
    return foldHeader("Content-Disposition", `attachment; filename="${filename}"`);
  }
  // RFC 2231 extended parameter: exact bytes of the name, percent-encoded.
  const enc = [...Buffer.from(filename, "utf8")]
    .map((b) => (/[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`))
    .join("");
  return foldHeader("Content-Disposition", `attachment; filename*=UTF-8''${enc}`);
}

export function buildRawMessage(input: RawMessageInput): string {
  const { to, cc = [], subject, body, inReplyToMessageId, parentReferences, attachments = [] } = input;
  for (const a of [...to, ...cc]) assertNoControl(a, "address");

  const headers: string[] = [];
  headers.push(foldHeader("To", to.join(", ")));
  if (cc.length) headers.push(foldHeader("Cc", cc.join(", ")));
  headers.push(foldHeader("Subject", headerText(subject)));

  if (inReplyToMessageId !== undefined) {
    if (!MSGID_RE.test(inReplyToMessageId)) throw new Error(`in_reply_to: the message has no valid Message-ID (${JSON.stringify(inReplyToMessageId)})`);
    const refs = (parentReferences ?? "").split(/\s+/).filter(Boolean);
    for (const r of refs) if (!MSGID_RE.test(r)) throw new Error(`in_reply_to: the message has an invalid References entry (${JSON.stringify(r)})`);
    if (refs[refs.length - 1] !== inReplyToMessageId) refs.push(inReplyToMessageId);
    headers.push(foldHeader("In-Reply-To", inReplyToMessageId));
    headers.push(foldHeader("References", refs.join(" ")));
  }

  headers.push("MIME-Version: 1.0");
  const bodyPart = base64Lines(Buffer.from(body, "utf8"));

  if (attachments.length === 0) {
    headers.push("Content-Type: text/plain; charset=UTF-8");
    headers.push("Content-Transfer-Encoding: base64");
    return headers.join(CRLF) + CRLF + CRLF + bodyPart + CRLF;
  }

  const boundary = input.boundary ?? `=_suveren_${randomUUID()}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts: string[] = [];
  parts.push(
    `--${boundary}${CRLF}Content-Type: text/plain; charset=UTF-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${bodyPart}${CRLF}`,
  );
  for (const a of attachments) {
    assertNoControl(a.contentType, "attachment content type");
    parts.push(
      `--${boundary}${CRLF}Content-Type: ${a.contentType}${CRLF}${contentDisposition(a.filename)}${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64Lines(a.bytes)}${CRLF}`,
    );
  }
  return headers.join(CRLF) + CRLF + CRLF + parts.join("") + `--${boundary}--${CRLF}`;
}
