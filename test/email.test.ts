/**
 * send_message / list_messages / get_message behaviour. Per doc/engineering.md
 * rule 4 ("test refusals harder than successes"), most of this file is refusal
 * cases — the connector's own validation IS the enforcement boundary for the
 * email profile's recipient/content-binding fields, since the gateway only sees
 * what this connector declares.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { callTool } from "../src/dispatch.js";

let dbPath: string;
let db: Db;

beforeEach(async () => {
  dbPath = join(tmpdir(), `email-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  rmSync(dbPath, { force: true });
  process.env.DATABASE_URL = dbPath;
  db = await createDb();
});

afterEach(async () => {
  await db.close();
  rmSync(dbPath, { force: true });
  delete process.env.DATABASE_URL;
});

describe("list_messages", () => {
  it("defaults to the inbox folder and an empty inbox returns an empty list", async () => {
    expect(await callTool(db, "simulation", "list_messages", {})).toEqual([]);
  });

  it("refuses an invalid folder", async () => {
    await expect(callTool(db, "simulation", "list_messages", { folder: "drafts" })).rejects.toThrow(/folder/);
  });
});

describe("send_message", () => {
  it("stores the message in the sent folder and records the change with its ticket_id", async () => {
    const sent = (await callTool(db, "simulation", "send_message", {
      to: ["customer@example.com"], subject: "Hello", body: "Hi there", ticket_id: "t-send-1",
    })) as any;

    expect(sent.folder).toBe("sent");
    expect(sent.to).toEqual(["customer@example.com"]);
    expect(sent.subject).toBe("Hello");

    const list = (await callTool(db, "simulation", "list_messages", { folder: "sent" })) as any[];
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(sent.id);

    expect(await db.all<any>(`SELECT tool, receipt_id, document_id FROM changes`)).toEqual([
      { tool: "send_message", receipt_id: "t-send-1", document_id: sent.id },
    ]);
    expect(await db.all(`SELECT * FROM refusals`)).toHaveLength(0);
  });

  it("supports cc and in_reply_to when the parent message exists", async () => {
    const first = (await callTool(db, "simulation", "send_message", { to: ["a@example.com"], subject: "First", body: "One" })) as any;
    const reply = (await callTool(db, "simulation", "send_message", {
      to: ["a@example.com"], cc: ["b@example.com"], subject: "Re: First", body: "Two", in_reply_to: first.id,
    })) as any;
    expect(reply.in_reply_to).toBe(first.id);
    expect(reply.cc).toEqual(["b@example.com"]);
  });

  it.each([
    ["an empty recipient list", { to: [], subject: "s", body: "b" }, /to must be a non-empty array/],
    ["a missing to field", { subject: "s", body: "b" }, /to must be a non-empty array/],
    ["an invalid recipient email", { to: ["not-an-email"], subject: "s", body: "b" }, /to contains an invalid email/],
    ["an invalid cc email", { to: ["a@example.com"], cc: ["nope"], subject: "s", body: "b" }, /cc contains an invalid email/],
    ["a missing subject", { to: ["a@example.com"], body: "b" }, /subject is required/],
    ["a missing body", { to: ["a@example.com"], subject: "s" }, /body is required/],
    ["an unknown in_reply_to", { to: ["a@example.com"], subject: "s", body: "b", in_reply_to: "nope" }, /Unknown in_reply_to message id/],
  ])("refuses %s and records the refusal with its ticket_id", async (_label, args, msg) => {
    await expect(callTool(db, "simulation", "send_message", { ...args, ticket_id: "t-bad" })).rejects.toThrow(msg);
    expect(await db.all(`SELECT * FROM messages`)).toHaveLength(0);
    expect(await db.all<any>(`SELECT tool, receipt_id FROM refusals`)).toEqual([
      expect.objectContaining({ tool: "send_message", receipt_id: "t-bad" }),
    ]);
  });

  it("records the ticket_id argument from a call (v0.7 wire rename — stored in the receipt_id column)", async () => {
    await callTool(db, "simulation", "send_message", { to: ["customer@example.com"], subject: "Wire", body: "Hi", ticket_id: "t-wire" });
    const rows = await db.all<any>(`SELECT receipt_id FROM changes WHERE tool = 'send_message'`);
    expect(rows).toEqual([{ receipt_id: "t-wire" }]);
  });
});

describe("get_message", () => {
  it("refuses an unknown id instead of returning undefined", async () => {
    await expect(callTool(db, "simulation", "get_message", { id: "nope" })).rejects.toThrow(/Unknown message id/);
  });

  it("returns the full body for a known message", async () => {
    const sent = (await callTool(db, "simulation", "send_message", { to: ["a@example.com"], subject: "s", body: "full body text" })) as any;
    const fetched = (await callTool(db, "simulation", "get_message", { id: sent.id })) as any;
    expect(fetched.body).toBe("full body text");
  });
});
