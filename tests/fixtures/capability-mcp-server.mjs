import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const names = [
  "resolve-library-id",
  "query-docs",
  "codegraph_explore",
  "read_wiki_structure",
  "read_wiki_contents",
  "ask_wiki_question",
  "mutate_repository",
];
const server = new Server({ name: "capability-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map((name) => ({ name, inputSchema: { type: "object" } })) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{ type: "text", text: JSON.stringify({ name: request.params.name, arguments: request.params.arguments }) }],
}));
await server.connect(new StdioServerTransport());
