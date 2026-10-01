/**
 * Connector mode: `simulation` answers from the built-in simulated inbox (SQLite);
 * `live` would talk to a real mailbox.
 *
 * The switch exists so a three-week test runs on exactly the connector, tools and
 * profile that go live later — only the system behind the connector changes. No
 * live adapter ships in 0.x, so `live` refuses every call loudly instead of
 * silently falling back to the simulation: a test that believes it is live (or a
 * go-live that is secretly still simulated) is the failure this must not hide.
 */

export type EmailMode = "simulation" | "live";

export const MODES: readonly EmailMode[] = ["simulation", "live"];

/** Reads EMAIL_MODE (default `simulation`). An unknown value stops the server at start. */
export function getMode(env: NodeJS.ProcessEnv = process.env): EmailMode {
  const raw = (env.EMAIL_MODE ?? "").trim().toLowerCase();
  if (raw === "") return "simulation";
  if ((MODES as readonly string[]).includes(raw)) return raw as EmailMode;
  throw new Error(`EMAIL_MODE must be one of ${MODES.join(", ")} — got ${JSON.stringify(env.EMAIL_MODE)}.`);
}

export const LIVE_NOT_AVAILABLE =
  "Refused: this email connector is in live mode, but no live mailbox adapter is installed (0.x ships the simulation only). " +
  "Nothing was read, sent, or changed. Set EMAIL_MODE=simulation, or install the adapter for your mailbox.";
