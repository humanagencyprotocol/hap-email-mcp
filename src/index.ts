#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createDb } from "./db.js";
import { callTool } from "./dispatch.js";
import { getMode } from "./mode.js";
import { runCli } from "./cli.js";

const RECEIPT_FIELD = {
  type: "string" as const,
  description: "Suveren authorizing receipt id. Injected by the gateway — agents do not set this.",
};

const TOOL_DEFINITIONS = [
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
      "Send a message. Simulated: nothing is actually sent anywhere — the message is stored in the \"sent\" folder.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses" },
        cc: { type: "array", items: { type: "string" }, description: "CC email addresses (optional)" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Message body" },
        in_reply_to: { type: "string", description: "ID of the message this replies to (optional) — must exist" },
        receipt_id: RECEIPT_FIELD,
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "load_simulation",
    description:
      "Load a simulation package into an empty inbox — one message per case. Simulation mode only, and only into " +
      "an empty system: a load cannot edit or replace existing test data.",
    inputSchema: {
      type: "object",
      properties: {
        package: {
          type: "object",
          description: "The simulation package: { name, cases: [{ id, request: { from, subject, body, received_at? }, reply: { subject, body }, notes? }], ... }",
        },
        receipt_id: RECEIPT_FIELD,
      },
      required: ["package"],
    },
  },
] as const;

async function main() {
  // `email-mcp export` is a local operator command, not an MCP tool.
  if (process.argv.length > 2) {
    process.exit(await runCli(process.argv.slice(2)));
  }

  const mode = getMode();
  const db = await createDb();
  console.error(`[email-mcp] mode: ${mode}`);

  const server = new Server(
    { name: "email", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, any>;

    try {
      const result = await callTool(db, mode, name, safeArgs);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[email-mcp] tool error (${name}):`, message);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  process.on("SIGINT", async () => {
    await db.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[email-mcp] server started");
}

main().catch((err) => {
  console.error("[email-mcp] fatal:", err);
  process.exit(1);
});
