/**
 * Connector mode: `simulation` answers from the built-in simulated inbox (SQLite);
 * `live` would talk to a real mailbox.
 *
 * The switch exists so a three-week test runs on exactly the connector, tools and
 * profile that go live later — only the system behind the connector changes. Without
 * an adapter, `live` refuses every call loudly instead of silently falling
 * back to the simulation: a test that believes it is live (or a
 * go-live that is secretly still simulated) is the failure this must not hide.
 *
 * `live` requires EMAIL_LIVE_ADAPTER naming an installed adapter. `gmail` is the
 * first: it reads and sends through the person's Gmail account.
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

export type LiveAdapter = "gmail";

export const LIVE_ADAPTERS: readonly LiveAdapter[] = ["gmail"];

/**
 * Reads EMAIL_LIVE_ADAPTER. Unset means "no adapter installed" — the caller
 * falls back to LIVE_NOT_AVAILABLE. An unknown non-empty value stops the
 * server at start, like an unknown EMAIL_MODE.
 */
export function getLiveAdapter(env: NodeJS.ProcessEnv = process.env): LiveAdapter | undefined {
  const raw = (env.EMAIL_LIVE_ADAPTER ?? "").trim().toLowerCase();
  if (raw === "") return undefined;
  if ((LIVE_ADAPTERS as readonly string[]).includes(raw)) return raw as LiveAdapter;
  throw new Error(`EMAIL_LIVE_ADAPTER must be one of ${LIVE_ADAPTERS.join(", ")} — got ${JSON.stringify(env.EMAIL_LIVE_ADAPTER)}.`);
}

export const LIVE_NOT_AVAILABLE =
  "Refused: this email connector is in live mode, but no live mailbox adapter is installed. " +
  "Nothing was read, sent, or changed. Set EMAIL_MODE=simulation, or set EMAIL_LIVE_ADAPTER (e.g. \"gmail\") to install one.";
