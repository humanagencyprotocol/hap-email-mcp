/**
 * The agent under test must not be able to tell the simulated inbox from a real
 * one (decision 2026-10-02): realistic measurement, and safety comes from the
 * gateway's simulation mode — not from what the agent believes. So nothing the
 * working agent sees may say "simulated": not the tool descriptions, not the
 * addresses, not the tool results. load_simulation and clear_simulation are exempt —
 * the gateway hides them from agents without a setup mandate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync, rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { callTool } from "../src/dispatch.js";
import { TOOL_DEFINITIONS } from "../src/tools/definitions.js";

const LEAK = /simulat/i;
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "examples", "package.example.json"), "utf8"));
let db: Db;
let dbPath: string;

beforeEach(async () => {
  dbPath = join(tmpdir(), `email-neutral-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_URL = dbPath;
  db = await createDb();
});
afterEach(async () => { await db.close(); rmSync(dbPath, { force: true }); });

describe("nothing the working agent sees reveals the simulation", () => {
  const working = TOOL_DEFINITIONS.filter((t) => t.name !== "load_simulation" && t.name !== "clear_simulation");

  it("tool names, descriptions and argument descriptions", () => {
    expect(working.length).toBeGreaterThan(0);
    expect(JSON.stringify(working)).not.toMatch(LEAK);
  });

  it("tool results: inbox, message, sent reply — including the company address", async () => {
    await callTool(db, "simulation", "load_simulation", { package: pkg });
    const outputs: unknown[] = [];
    const inbox = (await callTool(db, "simulation", "list_messages", {})) as any[];
    outputs.push(inbox);
    const msg = (await callTool(db, "simulation", "get_message", { id: inbox[0].id })) as any;
    outputs.push(msg);
    outputs.push(await callTool(db, "simulation", "send_message", {
      to: [msg.from.email ?? msg.from], subject: "Re: " + msg.subject, body: "Danke", in_reply_to: msg.id,
    }));
    outputs.push(await callTool(db, "simulation", "list_messages", { folder: "sent" }));
    expect(JSON.stringify(outputs)).not.toMatch(LEAK);
    expect(JSON.stringify(outputs)).toContain(pkg.email);
  });

  it("without a company mailbox in the package, the default address is neutral too", async () => {
    const { email: _omit, ...noEmail } = pkg;
    await callTool(db, "simulation", "load_simulation", { package: noEmail });
    const inbox = (await callTool(db, "simulation", "list_messages", {})) as any[];
    expect(JSON.stringify(inbox)).not.toMatch(LEAK);
  });

  it("refuses an invalid company mailbox", async () => {
    await expect(callTool(db, "simulation", "load_simulation", { package: { ...pkg, email: "not-an-email" } }))
      .rejects.toThrow(/email/);
  });
});
