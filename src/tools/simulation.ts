/**
 * `load_simulation` — puts each case's request into the inbox, create only.
 * `clear_simulation` — deletes all test data, so the same cases can run again
 * under a different setup (or other cases under the same setup): clear, then load.
 */
import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { parsePackage, companyAddress } from "../simulation.js";

export const ALREADY_LOADED =
  "Refused: test data already loaded — a simulation can only be created, not edited; clear it first (clear_simulation), then load.";

/**
 * When each of `n` requests arrived: spread evenly over the hour before `now`, in
 * case order (first case oldest), every one strictly inside that hour. A package's
 * own `received_at` is ignored — fixed dates would look stale on every re-run.
 */
export function receivedTimes(now: Date, n: number): string[] {
  const step = 3_600_000 / (n + 1);
  return Array.from({ length: n }, (_, i) => new Date(Math.floor((now.getTime() - (n - i) * step) / 1000) * 1000).toISOString());
}

/** Every table that holds test data. */
const CLEAR_TABLES = ["messages", "reference_replies", "simulation_load", "changes", "refusals"] as const;

export async function load_simulation(db: Db, args: Record<string, any>) {
  const { package: pkg } = args;

  const existingLoad = await db.get(`SELECT id FROM simulation_load WHERE id = 'default'`);
  const { count } = (await db.get<{ count: number }>(`SELECT COUNT(*) as count FROM messages`)) ?? { count: 0 };
  if (existingLoad || count > 0) throw new Error(ALREADY_LOADED);

  const parsed = parsePackage(pkg);
  const address = companyAddress(parsed.name, parsed.email);
  const loadedAt = new Date();
  const now = loadedAt.toISOString();
  const times = receivedTimes(loadedAt, parsed.cases.length);

  for (const [i, c] of parsed.cases.entries()) {
    const id = uuidv4();
    await db.run(
      `INSERT INTO messages (id, folder, from_name, from_email, to_json, cc_json, subject, body, received_at, in_reply_to, case_id, receipt_id)
       VALUES (?, 'inbox', ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL)`,
      [
        id, c.request.from.name, c.request.from.email, JSON.stringify([address]),
        c.request.subject, c.request.body, times[i], c.id,
      ],
    );
    await db.run(`INSERT INTO reference_replies (case_id, subject, body) VALUES (?, ?, ?)`, [
      c.id, c.reply.subject, c.reply.body,
    ]);
  }

  await db.run(
    `INSERT INTO simulation_load (id, name, package_sha256, cases_loaded, loaded_at, email) VALUES ('default', ?, ?, ?, ?, ?)`,
    [parsed.name, parsed.sha256, parsed.cases.length, now, parsed.email ?? null],
  );

  return { name: parsed.name, cases_loaded: parsed.cases.length, package_sha256: parsed.sha256 };
}

export async function clear_simulation(db: Db, _args: Record<string, any>) {
  const deleted: Record<string, number> = {};
  await db.run("BEGIN");
  try {
    for (const table of CLEAR_TABLES) {
      const row = await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM ${table}`);
      deleted[table] = Number(row?.n ?? 0);
      await db.run(`DELETE FROM ${table}`);
    }
    await db.run("COMMIT");
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    throw err;
  }
  return { cleared: true, deleted };
}
