/**
 * Simulation mode: the three-week test runs real (renamed) customer requests
 * through this connector's simulated inbox — only the system behind it is
 * simulated. These tests pin what makes that test trustworthy:
 *
 * - live mode refuses loudly (no adapter in 0.x) and touches nothing, reads
 *   included — a go-live that is secretly still simulated, or a test that
 *   believes it is live, must not be silent;
 * - the simulation package is loaded whole or refused whole, naming the field;
 * - a load can only CREATE test data, never edit it — a second load, or a
 *   first load into a non-empty inbox, is refused;
 * - the people's actual reply (the reference answer the agent is measured
 *   against) is never reachable through any tool;
 * - a call refused after the gateway let it through is recorded with its
 *   receipt_id — the only trace that a ticket exists for an action that never
 *   happened.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { parsePackage, loadPackageFile, canonicalJsonSha256 } from "../src/simulation.js";
import { getMode, LIVE_NOT_AVAILABLE } from "../src/mode.js";
import { callTool } from "../src/dispatch.js";

const tmp = (ext: string) => join(tmpdir(), `email-sim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

let dbPath: string;
let db: Db;

async function freshDb() {
  dbPath = tmp("db");
  process.env.DATABASE_URL = dbPath;
  db = await createDb();
}

afterEach(async () => {
  if (db) await db.close();
  if (dbPath) rmSync(dbPath, { force: true });
  db = undefined as unknown as Db;
  dbPath = "";
});

const validPackage = () => ({
  name: "Bergmann Ersatzteile GmbH",
  cases: [
    {
      id: "c1",
      request: { from: { name: "Markus Huber", email: "einkauf@huber.example" }, subject: "Quote please", body: "10x SP-100 please." },
      reply: { subject: "Re: Quote please", body: "Here is your quote." },
    },
    {
      id: "c2",
      request: { from: { name: "Lena Steiner", email: "office@steiner.example" }, subject: "Order", body: "15x SP-200 please.", received_at: "2026-09-03T10:00:00.000Z" },
      reply: { subject: "Re: Order", body: "Only 10 in stock, split shipment?" },
    },
  ],
});

describe("mode switch", () => {
  it("defaults to simulation", () => {
    expect(getMode({})).toBe("simulation");
    expect(getMode({ EMAIL_MODE: "Simulation " })).toBe("simulation");
  });

  it("refuses an unknown mode at start instead of guessing", () => {
    expect(() => getMode({ EMAIL_MODE: "production" })).toThrow(/EMAIL_MODE must be one of simulation, live/);
  });

  it("live mode refuses every tool, reads included, and changes nothing", async () => {
    await freshDb();
    await expect(callTool(db, "live", "list_messages", {})).rejects.toThrow(LIVE_NOT_AVAILABLE);
    await expect(callTool(db, "live", "get_message", { id: "x" })).rejects.toThrow(LIVE_NOT_AVAILABLE);
    await expect(callTool(db, "live", "send_message", { to: ["a@b.example"], subject: "s", body: "b", receipt_id: "t-1" }))
      .rejects.toThrow(/live mode/);
    await expect(callTool(db, "live", "load_simulation", { package: validPackage(), receipt_id: "t-2" }))
      .rejects.toThrow(/live mode/);
    expect(await db.all(`SELECT * FROM messages`)).toHaveLength(0);
    // Nothing local refused it — there is no local system in live mode — so nothing is recorded.
    expect(await db.all(`SELECT * FROM refusals`)).toHaveLength(0);
    expect(await db.all(`SELECT * FROM changes`)).toHaveLength(0);
  });
});

describe("package validation — refused whole, field named", () => {
  it.each([
    ["an empty cases list", { name: "X", cases: [] }, /`cases` must be a non-empty list/],
    ["a missing case id", { name: "X", cases: [{ request: validPackage().cases[0].request, reply: validPackage().cases[0].reply }] }, /cases\[0\]\.id is required/],
    ["a duplicate case id", { name: "X", cases: [validPackage().cases[0], { ...validPackage().cases[1], id: "c1" }] }, /cases\[1\]\.id "c1" appears twice/],
    ["a bad request email", { name: "X", cases: [{ ...validPackage().cases[0], request: { ...validPackage().cases[0].request, from: { name: "Markus", email: "not-an-email" } } }] }, /cases\[0\]\.request\.from\.email/],
    ["a missing reply body", { name: "X", cases: [{ ...validPackage().cases[0], reply: { subject: "Re" } }] }, /cases\[0\]\.reply\.body is required/],
    ["a missing name", { cases: validPackage().cases }, /`name` is required/],
  ])("refuses on %s", (_label, bad, msg) => {
    expect(() => parsePackage(bad)).toThrow(msg);
  });

  it("the shipped example package is valid", () => {
    const pkg = loadPackageFile(join(__dirname, "..", "examples", "package.example.json"));
    expect(pkg.cases.length).toBe(3);
    expect(pkg.name).toBe("Bergmann Ersatzteile GmbH");
  });

  it("the sha256 is stable under key order and ignores nothing — it is the canonical whole package", () => {
    const a = { name: "X", cases: validPackage().cases, extra: { b: 1, a: 2 } };
    const b = { extra: { a: 2, b: 1 }, cases: validPackage().cases, name: "X" };
    expect(canonicalJsonSha256(a)).toBe(canonicalJsonSha256(b));
  });
});

describe("load_simulation", () => {
  it("creates one inbox message per case, and records the package", async () => {
    await freshDb();
    const result = (await callTool(db, "simulation", "load_simulation", { package: validPackage(), receipt_id: "t-load" })) as any;
    expect(result).toMatchObject({ name: "Bergmann Ersatzteile GmbH", cases_loaded: 2 });
    expect(typeof result.package_sha256).toBe("string");

    const inbox = await db.all<any>(`SELECT * FROM messages WHERE folder = 'inbox'`);
    expect(inbox).toHaveLength(2);
    expect(inbox.map((m) => m.from_email).sort()).toEqual(["einkauf@huber.example", "office@steiner.example"]);

    const load = await db.get<any>(`SELECT * FROM simulation_load WHERE id = 'default'`);
    expect(load).toMatchObject({ name: "Bergmann Ersatzteile GmbH", cases_loaded: 2 });

    expect(await db.all<any>(`SELECT tool, receipt_id FROM changes`)).toEqual([
      { tool: "load_simulation", receipt_id: "t-load" },
    ]);
  });

  it("refuses a second load (create only) and records the refusal", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: validPackage(), receipt_id: "t-first" });
    await expect(callTool(db, "simulation", "load_simulation", { package: validPackage(), receipt_id: "t-second" }))
      .rejects.toThrow(/test data already loaded/);

    expect(await db.all(`SELECT * FROM messages`)).toHaveLength(2); // unchanged by the refused second load
    expect(await db.all<any>(`SELECT tool, receipt_id, message FROM refusals`)).toEqual([
      expect.objectContaining({ tool: "load_simulation", receipt_id: "t-second" }),
    ]);
  });

  it("refuses a load when messages already exist, even without a prior simulation_load row", async () => {
    await freshDb();
    await callTool(db, "simulation", "send_message", { to: ["someone@example.com"], subject: "hi", body: "hi" });
    await expect(callTool(db, "simulation", "load_simulation", { package: validPackage(), receipt_id: "t-x" }))
      .rejects.toThrow(/test data already loaded/);
    expect(await db.all<any>(`SELECT tool FROM refusals`)).toEqual([expect.objectContaining({ tool: "load_simulation" })]);
  });

  it("refuses an invalid package and records nothing", async () => {
    await freshDb();
    await expect(callTool(db, "simulation", "load_simulation", { package: { name: "X", cases: [] }, receipt_id: "t-bad" }))
      .rejects.toThrow(/cases.*non-empty/);
    expect(await db.all(`SELECT * FROM messages`)).toHaveLength(0);
    expect(await db.all<any>(`SELECT tool, receipt_id FROM refusals`)).toEqual([
      expect.objectContaining({ tool: "load_simulation", receipt_id: "t-bad" }),
    ]);
  });
});

describe("reference replies are never reachable through a tool", () => {
  it("list_messages and get_message never surface the reply text", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: validPackage() });

    const list = (await callTool(db, "simulation", "list_messages", { folder: "inbox" })) as any[];
    const listText = JSON.stringify(list);
    expect(listText).not.toContain("Here is your quote");
    expect(listText).not.toContain("Only 10 in stock");

    for (const m of list) {
      const full = (await callTool(db, "simulation", "get_message", { id: m.id })) as any;
      const fullText = JSON.stringify(full);
      expect(fullText).not.toContain("Here is your quote");
      expect(fullText).not.toContain("Only 10 in stock");
      expect(Object.keys(full)).not.toContain("reply");
      expect(Object.keys(full)).not.toContain("case_id");
    }

    // The reply text only exists in the reference_replies table, and only the (non-tool) export reaches it.
    const refs = await db.all<any>(`SELECT * FROM reference_replies`);
    expect(refs.map((r) => r.body).sort()).toEqual(["Here is your quote.", "Only 10 in stock, split shipment?"]);
  });
});

describe("reads record nothing", () => {
  it("list_messages and get_message leave changes and refusals empty, even on a failed read", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: validPackage() });
    await callTool(db, "simulation", "list_messages", {});
    await expect(callTool(db, "simulation", "get_message", { id: "does-not-exist" })).rejects.toThrow();
    expect(await db.all(`SELECT * FROM refusals`)).toHaveLength(0);
    expect(await db.all<any>(`SELECT tool FROM changes`)).toEqual([expect.objectContaining({ tool: "load_simulation" })]);
  });
});
