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
import { TOOL_DEFINITIONS } from "./tools/definitions.js";



async function main() {
  // `email-mcp export` is a local operator command, not an MCP tool.
  if (process.argv.length > 2) {
    process.exit(await runCli(process.argv.slice(2)));
  }

  const mode = getMode();
  const db = await createDb();
  console.error(`[email-mcp] mode: ${mode}`);

  const server = new Server(
    { name: "email", version: "0.1.1" },
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
