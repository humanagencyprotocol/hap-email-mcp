import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { parsePackage, companyAddress } from "../simulation.js";

const ALREADY_LOADED =
  "Refused: test data already loaded — a simulation can only be created, not edited; start from an empty database.";

export async function load_simulation(db: Db, args: Record<string, any>) {
  const { package: pkg } = args;

  const existingLoad = await db.get(`SELECT id FROM simulation_load WHERE id = 'default'`);
  const { count } = (await db.get<{ count: number }>(`SELECT COUNT(*) as count FROM messages`)) ?? { count: 0 };
  if (existingLoad || count > 0) throw new Error(ALREADY_LOADED);

  const parsed = parsePackage(pkg);
  const address = companyAddress(parsed.name, parsed.email);
  const now = new Date().toISOString();

  for (const c of parsed.cases) {
    const id = uuidv4();
    await db.run(
      `INSERT INTO messages (id, folder, from_name, from_email, to_json, cc_json, subject, body, received_at, in_reply_to, case_id, receipt_id)
       VALUES (?, 'inbox', ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL)`,
      [
        id, c.request.from.name, c.request.from.email, JSON.stringify([address]),
        c.request.subject, c.request.body, c.request.received_at ?? now, c.id,
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
