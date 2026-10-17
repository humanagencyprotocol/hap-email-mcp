/** The MCP tool surface — kept in its own module so tests can read it without starting the server. */
import { SIMULATION_PACKAGE_SCHEMA } from "../simulation-package-schema.js";
import { SIMULATION_PACKAGE_GUIDE } from "../simulation-package-guide.js";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES } from "../attachments.js";
const TICKET_FIELD = {
  type: "string" as const,
  description: "Authorization reference for this call, set by the governing gateway — agents do not set this.",
};
const MB = 1024 * 1024;

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
    description:
      "Get a single message, including its full body and, if any files are attached, their metadata " +
      "(filename, content type, size, sha256) — never the file content itself.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Message ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_attachment",
    description:
      "Get the file content of one attachment on a message, as base64. Select it by the sha256 shown in " +
      "get_message's attachment metadata, or by its 0-based position among the message's attachments — give " +
      "exactly one of the two.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "Message ID" },
        sha256: { type: "string", description: "The attachment's sha256, from get_message — alternative to index" },
        index: { type: "number", description: "0-based position among the message's attachments — alternative to sha256" },
      },
      required: ["message_id"],
    },
  },

  // --- Changes ---
  {
    name: "send_message",
    description:
      "Send a message (to, cc, subject, body; optionally in reply to a message, optionally with attachments). " +
      "Attachments are supplied by the governing gateway, not by the agent: the agent refers to the document it " +
      "means, it does not attach file content itself. Returns the sent message.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        cc: { type: "array", items: { type: "string" }, description: "CC email addresses (optional)" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Message body" },
        in_reply_to: { type: "string", description: "ID of the message this replies to (optional) — must exist" },
        attachments: {
          type: "array",
          maxItems: MAX_ATTACHMENTS,
          description:
            `Files to attach, supplied by the governing gateway — agents do not set this directly. At most ` +
            `${MAX_ATTACHMENTS} files, ${MAX_ATTACHMENT_BYTES / MB} MB each, ${MAX_TOTAL_ATTACHMENT_BYTES / MB} MB total.`,
          items: {
            type: "object",
            required: ["filename", "contentType", "contentBase64"],
            properties: {
              filename: { type: "string", description: "File name — no path separators." },
              contentType: { type: "string", description: "MIME type, e.g. \"application/pdf\"." },
              contentBase64: { type: "string", description: "File content, base64-encoded." },
            },
          },
        },
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
