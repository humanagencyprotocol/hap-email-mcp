/** The MCP tool surface — kept in its own module so tests can read it without starting the server. */
import { SIMULATION_PACKAGE_SCHEMA } from "../simulation-package-schema.js";
import { SIMULATION_PACKAGE_GUIDE } from "../simulation-package-guide.js";
const TICKET_FIELD = {
  type: "string" as const,
  description: "Authorization reference for this call, set by the governing gateway — agents do not set this.",
};

export const TOOL_DEFINITIONS = [
  // --- Reads ---
  {
    name: "list_messages",
    description: "List messages in a folder (inbox or sent), newest first.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", enum: ["inbox", "sent"], description: "Which folder to list (default: inbox)" },
        limit: { type: "number", description: "Maximum results to return (default: 50)" },
      },
      required: [],
    },
  },
  {
    name: "get_message",
    description: "Get a single message, including its full body.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Message ID" },
      },
      required: ["id"],
    },
  },

  // --- Changes ---
  {
    name: "send_message",
    description:
      "Send a message (to, cc, subject, body; optionally in reply to a message). Returns the sent message.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        cc: { type: "array", items: { type: "string" }, description: "CC email addresses (optional)" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Message body" },
        in_reply_to: { type: "string", description: "ID of the message this replies to (optional) — must exist" },
        ticket_id: TICKET_FIELD,
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "load_simulation",
    description:
      "Load a simulation package into an empty inbox — one message per case. Simulation mode only, and only into " +
      "an empty system: a load cannot edit or replace existing test data; clear_simulation empties it first. " +
      "Each message is dated within the hour before the load, in case order. " + SIMULATION_PACKAGE_GUIDE,
    inputSchema: {
      type: "object",
      properties: {
        package: { ...SIMULATION_PACKAGE_SCHEMA, description: `${SIMULATION_PACKAGE_SCHEMA.description} This connector loads \`name\`, optional \`email\` and \`cases\` (one inbox message per case request; replies kept for comparison); \`customers\`, \`products\` and \`contacts\` are used by the CRM and the ERP.` },
        ticket_id: TICKET_FIELD,
      },
      required: ["package"],
    },
  },
  {
    name: "clear_simulation",
    description:
      "Simulation mode only: delete all test data — inbox and sent messages, the kept replies, and the record of " +
      "changes and refusals — so a new package can be loaded with load_simulation. Cannot be undone. " +
      "Not available in live mode.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: TICKET_FIELD,
      },
      required: [],
    },
  },
] as const;
