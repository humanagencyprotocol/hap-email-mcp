/**
 * Contract for an email adapter: given the bound fields, the message that goes
 * out contains exactly them. Checked on the raw RFC 822 message — headers and
 * body — not on the tool's answer.
 *
 * This file is the pure part (the message builder, no network). The proof
 * against the real Gmail test account is test/gmail-live.test.ts.
 */
import { describe, it, expect } from "vitest";
import { buildRawMessage, foldHeader } from "../src/live/gmail/mime.js";
import { decodeWords } from "../src/live/gmail/dispatch.js";
import { parseRaw, getHeader, decodeBody } from "./helpers/raw.js";

const PARENT_ID = "<CAF+abc123def456ghi789jkl012mno345pqr678stu901vwx234@mail.gmail.com>";
const PARENT_REFS = "<one-1111111111111111111111111111@mail.example.com> <two-2222222222222222222222222222@mail.example.com> <three-33333333333333333333333333@mail.example.com>";
const ALLOWED = new Set(["to", "cc", "subject", "in-reply-to", "references", "mime-version", "content-type", "content-transfer-encoding"]);

describe("buildRawMessage — the contract", () => {
  it("a plain mail: exactly to, cc, subject, body; nothing else", () => {
    const body = "Dear Ms Berger,\n\nyour order ships Monday.\n\n-- \nSent by an AI";
    const p = parseRaw(buildRawMessage({ to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], subject: "Your order", body }));
    expect(getHeader(p, "To")).toBe("a@example.com, b@example.com");
    expect(getHeader(p, "Cc")).toBe("c@example.com");
    expect(getHeader(p, "Subject")).toBe("Your order");
    expect(decodeBody(p)).toBe(body);
    expect(getHeader(p, "In-Reply-To")).toBeUndefined();
    expect(getHeader(p, "References")).toBeUndefined();
    for (const h of p.headers) expect(ALLOWED.has(h.name.toLowerCase()), h.name).toBe(true);
  });

  it("a reply: subject as given (no Re:), no quote, valid In-Reply-To / References", () => {
    const body = "Yes, Monday works.";
    const p = parseRaw(buildRawMessage({
      to: ["a@example.com"], subject: "Delivery date", body,
      inReplyToMessageId: PARENT_ID, parentReferences: PARENT_REFS,
    }));
    expect(getHeader(p, "Subject")).toBe("Delivery date"); // not "Re: Delivery date"
    expect(decodeBody(p)).toBe(body); // no "On ... wrote:", no ">" lines
    expect(getHeader(p, "In-Reply-To")).toBe(PARENT_ID);
    expect(getHeader(p, "References")).toBe(`${PARENT_REFS} ${PARENT_ID}`);
    for (const h of p.headers) expect(ALLOWED.has(h.name.toLowerCase()), h.name).toBe(true);
  });

  it("a reply to a message without References: References is just the parent id", () => {
    const p = parseRaw(buildRawMessage({ to: ["a@example.com"], subject: "S", body: "b", inReplyToMessageId: PARENT_ID }));
    expect(getHeader(p, "References")).toBe(PARENT_ID);
  });

  it("does not repeat the parent id when References already ends with it", () => {
    const p = parseRaw(buildRawMessage({ to: ["a@example.com"], subject: "S", body: "b", inReplyToMessageId: PARENT_ID, parentReferences: PARENT_ID }));
    expect(getHeader(p, "References")).toBe(PARENT_ID);
  });

  it("headers are folded at whitespace, never with quoted-printable soft breaks, no line over 78 (long values)", () => {
    const subject = "A very long subject line that goes on and on and on, well past the seventy-eight character limit of a header";
    const to = Array.from({ length: 6 }, (_, i) => `recipient-number-${i}@a-long-company-domain.example.com`);
    const raw = buildRawMessage({ to, subject, body: "b", inReplyToMessageId: PARENT_ID, parentReferences: PARENT_REFS });
    const p = parseRaw(raw);
    for (const line of p.rawHeaderBlock.split("\r\n")) {
      expect(line.length, line).toBeLessThanOrEqual(78);
      expect(line.endsWith("="), line).toBe(false); // QP soft break
    }
    expect(p.rawHeaderBlock).not.toMatch(/[^?]=\r\n/);
    expect(p.rawHeaderBlock).not.toMatch(/=[0-9A-F]{2}/);
    expect(getHeader(p, "Subject")).toBe(subject);
    expect(getHeader(p, "To")).toBe(to.join(", "));
    expect(getHeader(p, "References")).toBe(`${PARENT_REFS} ${PARENT_ID}`);
    // Every folded line starts with whitespace and no message id is cut in two.
    for (const id of `${PARENT_REFS} ${PARENT_ID}`.split(" ")) expect(raw.replace(/\r\n /g, " ")).toContain(id);
    expect(p.rawHeaderBlock).not.toMatch(/<[^>\r\n]*\r\n/);
  });

  it("a non-ASCII subject is RFC 2047 encoded-words that decode to the exact text, each at most 75 chars", () => {
    const subject = "Rückfrage zu Rechnung 2026-117 — Zahlungsziel verlängern? 日本語のテスト and more text to force several words";
    const p = parseRaw(buildRawMessage({ to: ["a@example.com"], subject, body: "b" }));
    const value = getHeader(p, "Subject")!;
    for (const w of value.split(" ")) expect(w.length).toBeLessThanOrEqual(75);
    expect(decodeWords(value)).toBe(subject);
    expect(p.rawHeaderBlock).not.toMatch(/[^?]=\r\n/);
  });

  it("the body survives byte for byte: unicode, trailing newline, long lines, a quote-like text the person wrote", () => {
    const body = `Grüße — 日本語 ✓\n> this line is the person's own text, not a quote added by us\n${"x".repeat(500)}\n`;
    const p = parseRaw(buildRawMessage({ to: ["a@example.com"], subject: "S", body }));
    expect(decodeBody(p)).toBe(body);
  });

  it("attachments: multipart/mixed, the text part unchanged, attachment bytes unchanged, no extra text part", () => {
    const bytes = Buffer.from("%PDF-1.4 test \u0000\u0001 bytes", "latin1");
    const raw = buildRawMessage({
      to: ["a@example.com"], subject: "Invoice", body: "Attached.", boundary: "BOUNDARY",
      attachments: [{ filename: "Rechnung März.pdf", contentType: "application/pdf", bytes, size: bytes.length, sha256: "x" }],
    });
    const p = parseRaw(raw);
    expect(getHeader(p, "Content-Type")).toBe('multipart/mixed; boundary="BOUNDARY"');
    const parts = p.rawBody.split("--BOUNDARY").slice(1, -1);
    expect(parts).toHaveLength(2);
    const text = parseRaw(parts[0].replace(/^\r\n/, ""));
    expect(decodeBody(text)).toBe("Attached.");
    const att = parseRaw(parts[1].replace(/^\r\n/, ""));
    expect(getHeader(att, "Content-Type")).toBe("application/pdf");
    expect(getHeader(att, "Content-Disposition")).toBe("attachment; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf");
    expect(Buffer.from(att.rawBody.replace(/\s+/g, ""), "base64").equals(bytes)).toBe(true);
  });

  it("refuses header injection and an unusable parent id", () => {
    expect(() => buildRawMessage({ to: ["a@example.com"], subject: "S\r\nBcc: evil@example.com", body: "b" })).toThrow(/line breaks/);
    expect(() => buildRawMessage({ to: ["a@example.com\r\nBcc: x@y.z"], subject: "S", body: "b" })).toThrow(/line breaks/);
    expect(() => buildRawMessage({ to: ["a@example.com"], subject: "S", body: "b", inReplyToMessageId: "not an id" })).toThrow(/Message-ID/);
    expect(() => buildRawMessage({ to: ["a@example.com"], subject: "S", body: "b", inReplyToMessageId: PARENT_ID, parentReferences: "<ok@x.y> junk" })).toThrow(/References/);
  });
});

describe("foldHeader", () => {
  it("unfolding gives back the value exactly, including double spaces", () => {
    const value = "word  with  double spaces " + "long ".repeat(30) + "end";
    const folded = foldHeader("Subject", value);
    expect(folded.replace(/\r\n(?=[ \t])/g, "")).toBe(`Subject: ${value}`);
  });
});

describe("live mode wiring", () => {
  it("EMAIL_LIVE_ADAPTER=gmail without a Google sign-in refuses and changes nothing; unknown adapter stops the server", async () => {
    const { callTool } = await import("../src/dispatch.js");
    const { getLiveAdapter } = await import("../src/mode.js");
    await expect(callTool(undefined as never, "live", "send_message", { to: ["a@example.com"], subject: "S", body: "b" }, { EMAIL_LIVE_ADAPTER: "gmail" }))
      .rejects.toThrow(/no Google sign-in/);
    await expect(callTool(undefined as never, "live", "list_messages", {}, {})).rejects.toThrow(/no live mailbox adapter/);
    expect(() => getLiveAdapter({ EMAIL_LIVE_ADAPTER: "outlook" })).toThrow(/must be one of gmail/);
  });
});

describe("list_messages received_after (Gmail adapter)", () => {
  function fakeClient(msgs: { id: string; internalDate: string }[]) {
    const calls: { label: string; limit: number; q?: string }[] = [];
    const client = {
      listIds: async (label: string, limit: number, q?: string) => { calls.push({ label, limit, q }); return { messages: msgs.map((m) => ({ id: m.id, threadId: "t" })) }; },
      getMetadata: async (id: string) => ({ id, threadId: "t", internalDate: msgs.find((m) => m.id === id)!.internalDate, labelIds: ["INBOX"], payload: { headers: [] }, snippet: "" }),
    };
    return { client: client as any, calls };
  }
  const T = Date.parse("2026-06-01T12:00:00.500Z");

  it("sends after:<unix seconds> and drops anything older, even if Gmail returned it", async () => {
    const { client, calls } = fakeClient([{ id: "new", internalDate: String(T + 1000) }, { id: "edge", internalDate: String(T) }, { id: "old", internalDate: String(T - 1) }]);
    const { callGmailTool } = await import("../src/live/gmail/dispatch.js");
    const out = (await callGmailTool("list_messages", { received_after: "2026-06-01T12:00:00.500Z" }, {} as NodeJS.ProcessEnv, client)) as any[];
    expect(calls[0].q).toBe(`after:${Math.floor(T / 1000)}`);
    expect(out.map((m) => m.id)).toEqual(["new", "edge"]);
  });

  it("without received_after no query is sent; a bad value is refused before any request", async () => {
    const { client, calls } = fakeClient([{ id: "a", internalDate: String(T) }]);
    const { callGmailTool } = await import("../src/live/gmail/dispatch.js");
    expect(((await callGmailTool("list_messages", {}, {} as NodeJS.ProcessEnv, client)) as any[]).length).toBe(1);
    expect(calls[0].q).toBeUndefined();
    await expect(callGmailTool("list_messages", { received_after: "last week" }, {} as NodeJS.ProcessEnv, client)).rejects.toThrow(/received_after/);
    expect(calls).toHaveLength(1);
  });
});
