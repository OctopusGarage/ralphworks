import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    { name: "wait", inputSchema: { type: "object" } },
    { name: "media", inputSchema: { type: "object" } },
    { name: "throws", inputSchema: { type: "object" } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name === "throws") throw new Error(process.env.FIXTURE_TOKEN);
  if (request.params.name === "media")
    return {
      isError: true,
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "resource", resource: { uri: "test://result", text: "result" } },
      ],
    };
  if (request.params.name === "wait") await new Promise((resolve) => extra.signal.addEventListener("abort", resolve, { once: true }));
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          text: request.params.arguments?.text,
          token: process.env.FIXTURE_TOKEN,
          leaked: process.env.SHOULD_NOT_INHERIT,
          pid: process.pid,
        }),
      },
    ],
  };
});
await server.connect(new StdioServerTransport());
