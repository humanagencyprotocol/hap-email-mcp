/**
 * One entry point for every tool call — used by the MCP server and by the tests,
 * so the tests exercise exactly what the server runs.
 */
import { randomUUID } from "crypto";
import type { Db } from "./db.js";
import { LIVE_NOT_AVAILABLE, type EmailMode } from "./mode.js";
import { list_messages, get_message, send_message } from "./tools/messages.js";
import { load_simulation } from "./tools/simulation.js";

/** Tools that change the connector's state — the ones the gateway issues a ticket for. */
export const CHANGE_TOOLS = new Set(["send_message", "load_simulation"]);

async function runTool(db: Db, name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    case "list_messages": return list_messages(db, args);
    case "get_message": return get_message(db, args);
    case "send_message": return send_message(db, args);
    case "load_simulation": return load_simulation(db, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

/** A short summary of the effect, enough to tell what happened without re-reading the record. */
function describeChange(name: string, result: unknown): { documentId: string | null; summary: string } {
  const r = (result ?? {}) as Record<string, unknown>;
  switch (name) {
    case "send_message":
      return { documentId: (r.id as string) ?? null, summary: typeof r.subject === "string" ? r.subject : "" };
    case "load_simulation":
      return {
        documentId: typeof r.package_sha256 === "string" ? r.package_sha256 : null,
        summary: `${r.name ?? "?"}: ${r.cases_loaded ?? 0} cases loaded`,
      };
    default:
      return { documentId: (r.id as string) ?? null, summary: "" };
  }
}

/**
 * Run a tool in the given mode. Every successful change is recorded (`changes`)
 * with the receipt_id the gateway injected; a call the connector refuses AFTER
 * the gateway let it through is recorded in `refusals` with the same receipt_id —
 * that is the trace of a ticket whose action never happened. In live mode
 * nothing runs and nothing is recorded locally: there is no local system to have
 * refused anything. Reads record nothing either way.
 */
export async function callTool(db: Db, mode: EmailMode, name: string, args: Record<string, any>): Promise<unknown> {
  if (mode === "live") throw new Error(LIVE_NOT_AVAILABLE);
  const receiptId = typeof args.receipt_id === "string" ? args.receipt_id : null;
  try {
    const result = await runTool(db, name, args);
    if (CHANGE_TOOLS.has(name)) {
      const { documentId, summary } = describeChange(name, result);
      await db.run(
        `INSERT INTO changes (id, at, tool, receipt_id, document_id, summary) VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), new Date().toISOString(), name, receiptId, documentId, summary],
      );
    }
    return result;
  } catch (err) {
    if (CHANGE_TOOLS.has(name)) {
      const message = err instanceof Error ? err.message : String(err);
      await db.run(`INSERT INTO refusals (id, at, tool, receipt_id, message) VALUES (?, ?, ?, ?, ?)`, [
        randomUUID(), new Date().toISOString(), name, receiptId, message,
      ]);
    }
    throw err;
  }
}
