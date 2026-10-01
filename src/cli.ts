/**
 * Local operator commands. Deliberately NOT MCP tools: the agent under test must
 * be able neither to read nor to change the record its work is measured by, and
 * the reference replies (the people's actual answers) must never be reachable
 * through any tool call — only through this export, run by a human.
 *
 *   email-mcp export   everything needed to line up inbox -> reply -> reference answer
 */
import { createDb } from "./db.js";
import { getMode } from "./mode.js";

export async function exportRecord(db: Awaited<ReturnType<typeof createDb>>, mode = getMode()) {
  return {
    mode,
    exported_at: new Date().toISOString(),
    simulation_load: await db.get<any>(`SELECT * FROM simulation_load WHERE id = 'default'`),
    inbox: await db.all<any>(`SELECT id, from_name, from_email, to_json, subject, body, received_at, case_id FROM messages WHERE folder = 'inbox' ORDER BY received_at`),
    sent: await db.all<any>(`SELECT id, from_name, from_email, to_json, cc_json, subject, body, received_at, in_reply_to, receipt_id FROM messages WHERE folder = 'sent' ORDER BY received_at`),
    changes: await db.all<any>(`SELECT * FROM changes ORDER BY at`),
    refusals: await db.all<any>(`SELECT * FROM refusals ORDER BY at`),
    reference_replies: await db.all<any>(`SELECT * FROM reference_replies ORDER BY case_id`),
  };
}

const USAGE = `usage: email-mcp export`;

export async function runCli(argv: string[]): Promise<number> {
  const [cmd] = argv;
  try {
    if (cmd === "export") {
      const db = await createDb();
      process.stdout.write(JSON.stringify(await exportRecord(db), null, 2) + "\n");
      await db.close();
      return 0;
    }
    process.stderr.write(USAGE + "\n");
    return 2;
  } catch (err) {
    process.stderr.write(`[email-mcp] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
