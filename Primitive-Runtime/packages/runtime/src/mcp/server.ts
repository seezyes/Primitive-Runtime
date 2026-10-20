import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { requestLocal, loadClientConfig } from "../control/client.js";
import { actionSchema } from "./schema.js";
import { CONTRACT_VERSION, MCP_BASELINE } from "../contracts.js";
import { VERSION } from "../version.js";
import { safeError } from "../errors.js";
export async function runMcp(configFile: string): Promise<void> {
  const config = loadClientConfig(configFile);
  const server = new Server(
    { name: "primitive-runtime", version: VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Delegate a task to a configured workspace. Runs persist independently of this connection. Poll status with the suggested delay, then inspect the staged diff and verification evidence. This tool never applies source changes.",
    },
  );
  // Explicitly negotiate the only protocol version covered by this release's wire tests.
  server.setRequestHandler(InitializeRequestSchema, async () => ({
    protocolVersion: MCP_BASELINE,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "primitive-runtime", version: VERSION },
  }));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "primitive_runtime",
        title: "Primitive Runtime",
        description:
          "Run and inspect artifact-owned coding agents in a bound workspace. Use capabilities to discover permitted profile IDs. All changes remain staged.",
        inputSchema: { ...actionSchema, type: "object" },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    let business: Record<string, unknown>;
    if (req.params.name !== "primitive_runtime")
      business = {
        contract_version: CONTRACT_VERSION,
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          message: "Unknown tool.",
          retryable: false,
        },
      };
    else
      try {
        business = await requestLocal(
          config,
          "/tool",
          req.params.arguments ?? {},
        );
      } catch (error) {
        business = {
          contract_version: CONTRACT_VERSION,
          ok: false,
          error: safeError(error),
        };
      }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(business) }],
      structuredContent: business,
      isError: business.ok !== true,
    };
  });
  await server.connect(new StdioServerTransport());
}
