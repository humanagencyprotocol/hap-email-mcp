/**
 * Attachments on send_message. In Suveren the agent never carries file
 * bytes — it references a document and the governing gateway supplies the
 * bytes — so these tests exercise what the connector actually enforces on
 * the `attachments` argument: caps, refusals (named per field, like the
 * simulation package loader), metadata-only exposure on get_message, exact
 * content round-trip through get_attachment, and that a call without
 * attachments is unchanged from before this feature existed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { callTool } from "../src/dispatch.js";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from "../src/attachments.js";

let dbPath: string;
let db: Db;

beforeEach(async () => {
  dbPath = join(tmpdir(), `email-attach-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(dbPath, { force: true });
  process.env.DATABASE_URL = dbPath;
  db = await createDb();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { force: true });
  delete process.env.DATABASE_URL;
});

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const sha256Of = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

const PDF_BYTES = "%PDF-1.4 fake invoice content";
const pdfAttachment = (filename = "invoice.pdf") => ({
  filename,
  contentType: "application/pdf",
  contentBase64: b64(PDF_BYTES),
});

describe("send_message without attachments", () => {
  it("is unchanged — attachments is an empty array", async () => {
    const sent = (await callTool(db, "simulation", "send_message", {
      to: ["customer@example.com"], subject: "Hello", body: "Hi there",
    })) as any;
    expect(sent.attachments).toEqual([]);
  });
});

describe("send_message with attachments", () => {
  it("stores the file and returns metadata only — no content field", async () => {
    const sent = (await callTool(db, "simulation", "send_message", {
      to: ["customer@example.com"], subject: "Invoice", body: "See attached.",
      attachments: [pdfAttachment()],
    })) as any;

    expect(sent.attachments).toEqual([
      { filename: "invoice.pdf", contentType: "application/pdf", size: PDF_BYTES.length, sha256: sha256Of(PDF_BYTES) },
    ]);
    expect(JSON.stringify(sent)).not.toContain(b64(PDF_BYTES));
  });

  it("accepts up to the maximum attachment count, in order", async () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => pdfAttachment(`file-${i}.pdf`));
    const sent = (await callTool(db, "simulation", "send_message", {
      to: ["a@example.com"], subject: "s", body: "b", attachments,
    })) as any;
    expect(sent.attachments.map((a: any) => a.filename)).toEqual(attachments.map((a) => a.filename));
  });

  it("refuses more than the maximum attachment count and stores nothing", async () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => pdfAttachment(`file-${i}.pdf`));
    await expect(
      callTool(db, "simulation", "send_message", { to: ["a@example.com"], subject: "s", body: "b", attachments }),
    ).rejects.toThrow(new RegExp(`at most ${MAX_ATTACHMENTS} files`));
    expect(await db.all(`SELECT * FROM messages`)).toHaveLength(0);
    expect(await db.all(`SELECT * FROM attachments`)).toHaveLength(0);
  });

  it("refuses a single file over the per-file size limit", async () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1).toString("base64");
    await expect(
      callTool(db, "simulation", "send_message", {
        to: ["a@example.com"], subject: "s", body: "b",
        attachments: [{ filename: "big.bin", contentType: "application/octet-stream", contentBase64: big }],
      }),
    ).rejects.toThrow(/per-file limit is 10485760 bytes/);
    expect(await db.all(`SELECT * FROM messages`)).toHaveLength(0);
  });

  it("refuses attachments whose combined size exceeds the total limit, even if each file is under the per-file cap", async () => {
    // 3 files just under the per-file cap, well over the 25 MB total cap.
    const perFile = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 2.5);
    const chunk = Buffer.alloc(perFile, 2).toString("base64");
    const attachments = [0, 1, 2].map((i) => ({
      filename: `part-${i}.bin`, contentType: "application/octet-stream", contentBase64: chunk,
    }));
    await expect(
      callTool(db, "simulation", "send_message", { to: ["a@example.com"], subject: "s", body: "b", attachments }),
    ).rejects.toThrow(/total size is .* limit per message is 26214400 bytes/);
    expect(await db.all(`SELECT * FROM messages`)).toHaveLength(0);
    expect(await db.all(`SELECT * FROM attachments`)).toHaveLength(0);
  });

  it.each([
    ["a missing filename", { contentType: "application/pdf", contentBase64: b64("x") }, /attachments\[0\]\.filename is required/],
    ["a filename with a forward-slash path separator", { filename: "../secrets.pdf", contentType: "application/pdf", contentBase64: b64("x") }, /attachments\[0\]\.filename must not contain a path separator/],
    ["a filename with a backslash path separator", { filename: "a\\b.pdf", contentType: "application/pdf", contentBase64: b64("x") }, /attachments\[0\]\.filename must not contain a path separator/],
    ["a filename that is just \"..\"", { filename: "..", contentType: "application/pdf", contentBase64: b64("x") }, /attachments\[0\]\.filename must not be/],
    ["a missing contentType", { filename: "a.pdf", contentBase64: b64("x") }, /attachments\[0\]\.contentType must be a MIME type/],
    ["a contentType with no subtype", { filename: "a.pdf", contentType: "pdf", contentBase64: b64("x") }, /attachments\[0\]\.contentType must be a MIME type/],
    ["a missing contentBase64", { filename: "a.pdf", contentType: "application/pdf" }, /attachments\[0\]\.contentBase64 is required/],
    ["contentBase64 that is not valid base64", { filename: "a.pdf", contentType: "application/pdf", contentBase64: "not base64!!" }, /attachments\[0\]\.contentBase64 is not valid base64/],
    ["an empty contentBase64 string", { filename: "a.pdf", contentType: "application/pdf", contentBase64: "" }, /attachments\[0\]\.contentBase64 is required/],
  ])("refuses %s and stores nothing", async (_label, bad, msg) => {
    await expect(
      callTool(db, "simulation", "send_message", { to: ["a@example.com"], subject: "s", body: "b", attachments: [bad] }),
    ).rejects.toThrow(msg);
    expect(await db.all(`SELECT * FROM messages`)).toHaveLength(0);
    expect(await db.all(`SELECT * FROM attachments`)).toHaveLength(0);
  });

  it("refuses a non-array attachments argument", async () => {
    await expect(
      callTool(db, "simulation", "send_message", { to: ["a@example.com"], subject: "s", body: "b", attachments: "nope" }),
    ).rejects.toThrow(/attachments must be an array/);
  });

  it("records the refusal with its ticket_id, same as any other send_message refusal", async () => {
    await expect(
      callTool(db, "simulation", "send_message", {
        to: ["a@example.com"], subject: "s", body: "b", ticket_id: "t-bad-attach",
        attachments: [{ filename: "../x.pdf", contentType: "application/pdf", contentBase64: b64("x") }],
      }),
    ).rejects.toThrow();
    expect(await db.all<any>(`SELECT tool, receipt_id FROM refusals`)).toEqual([
      expect.objectContaining({ tool: "send_message", receipt_id: "t-bad-attach" }),
    ]);
  });
});

describe("get_message shows attachment metadata only", () => {
  it("never includes contentBase64", async () => {
    const sent = (await callTool(db, "simulation", "send_message", {
      to: ["a@example.com"], subject: "Invoice", body: "See attached.", attachments: [pdfAttachment()],
    })) as any;
    const fetched = (await callTool(db, "simulation", "get_message", { id: sent.id })) as any;
    expect(fetched.attachments).toEqual([
      { filename: "invoice.pdf", contentType: "application/pdf", size: PDF_BYTES.length, sha256: sha256Of(PDF_BYTES) },
    ]);
    expect(JSON.stringify(fetched)).not.toContain(b64(PDF_BYTES));
  });

  it("is an empty array for a message without attachments", async () => {
    const sent = (await callTool(db, "simulation", "send_message", { to: ["a@example.com"], subject: "s", body: "b" })) as any;
    const fetched = (await callTool(db, "simulation", "get_message", { id: sent.id })) as any;
    expect(fetched.attachments).toEqual([]);
  });
});

describe("get_attachment", () => {
  async function sendWithTwoAttachments() {
    return (await callTool(db, "simulation", "send_message", {
      to: ["a@example.com"], subject: "Two files", body: "b",
      attachments: [pdfAttachment("first.pdf"), { filename: "second.txt", contentType: "text/plain", contentBase64: b64("second content") }],
    })) as any;
  }

  it("returns the exact bytes by sha256 — sha256 of the returned content matches", async () => {
    const sent = await sendWithTwoAttachments();
    const meta = sent.attachments[0];
    const result = (await callTool(db, "simulation", "get_attachment", { message_id: sent.id, sha256: meta.sha256 })) as any;
    expect(result.filename).toBe("first.pdf");
    expect(result.contentType).toBe("application/pdf");
    const decoded = Buffer.from(result.contentBase64, "base64");
    expect(createHash("sha256").update(decoded).digest("hex")).toBe(meta.sha256);
    expect(decoded.toString("utf8")).toBe(PDF_BYTES);
  });

  it("returns the exact bytes by index", async () => {
    const sent = await sendWithTwoAttachments();
    const result = (await callTool(db, "simulation", "get_attachment", { message_id: sent.id, index: 1 })) as any;
    expect(result.filename).toBe("second.txt");
    expect(Buffer.from(result.contentBase64, "base64").toString("utf8")).toBe("second content");
  });

  it("refuses an unknown message id", async () => {
    await expect(callTool(db, "simulation", "get_attachment", { message_id: "nope", index: 0 })).rejects.toThrow(/Unknown message id/);
  });

  it("refuses an unknown sha256 on a known message", async () => {
    const sent = await sendWithTwoAttachments();
    await expect(callTool(db, "simulation", "get_attachment", { message_id: sent.id, sha256: "0".repeat(64) }))
      .rejects.toThrow(/No attachment with sha256/);
  });

  it("refuses an out-of-range index", async () => {
    const sent = await sendWithTwoAttachments();
    await expect(callTool(db, "simulation", "get_attachment", { message_id: sent.id, index: 5 }))
      .rejects.toThrow(/No attachment at index 5/);
  });

  it("refuses when both sha256 and index are given", async () => {
    const sent = await sendWithTwoAttachments();
    await expect(callTool(db, "simulation", "get_attachment", { message_id: sent.id, sha256: "x", index: 0 }))
      .rejects.toThrow(/give either sha256 or index, not both/);
  });

  it("refuses when neither sha256 nor index is given", async () => {
    const sent = await sendWithTwoAttachments();
    await expect(callTool(db, "simulation", "get_attachment", { message_id: sent.id }))
      .rejects.toThrow(/give sha256 or index/);
  });

  it("live mode refuses it like every other tool", async () => {
    await expect(callTool(db, "live", "get_attachment", { message_id: "x", index: 0 })).rejects.toThrow(/live mode/);
  });

  it("is a read — leaves changes and refusals untouched on success", async () => {
    const sent = await sendWithTwoAttachments();
    const before = await db.all(`SELECT * FROM changes`);
    await callTool(db, "simulation", "get_attachment", { message_id: sent.id, index: 0 });
    expect(await db.all(`SELECT * FROM changes`)).toEqual(before);
    expect(await db.all(`SELECT * FROM refusals`)).toHaveLength(0);
  });
});

describe("clear_simulation deletes attachments too", () => {
  it("removes attachment rows along with the message", async () => {
    await callTool(db, "simulation", "send_message", {
      to: ["a@example.com"], subject: "s", body: "b", attachments: [pdfAttachment()],
    });
    expect(await db.all(`SELECT * FROM attachments`)).toHaveLength(1);
    await callTool(db, "simulation", "clear_simulation", {});
    expect(await db.all(`SELECT * FROM attachments`)).toHaveLength(0);
  });
});
