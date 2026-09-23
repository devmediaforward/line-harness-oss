import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../context.js";

export function registerAllResources(server: McpServer, ctx: ToolContext): void {
  server.resource(
    "Account Summary",
    "line-harness://account/summary",
    async (_uri) => {
      const client = ctx.client;
      const [friendCount, scenarios, tags] = await Promise.all([
        client.friends.count(),
        client.scenarios.list(),
        client.tags.list(),
      ]);

      const summary = {
        friends: friendCount,
        activeScenarios: scenarios.filter(
          (s: { isActive: boolean }) => s.isActive,
        ).length,
        totalScenarios: scenarios.length,
        tags: tags.map((t: { id: string; name: string }) => ({
          id: t.id,
          name: t.name,
        })),
      };

      return {
        contents: [
          {
            uri: "line-harness://account/summary",
            mimeType: "application/json",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    },
  );

  server.resource(
    "Active Scenarios",
    "line-harness://scenarios/active",
    async (_uri) => {
      const client = ctx.client;
      const scenarios = await client.scenarios.list();
      const active = scenarios.filter(
        (s: { isActive: boolean }) => s.isActive,
      );

      return {
        contents: [
          {
            uri: "line-harness://scenarios/active",
            mimeType: "application/json",
            text: JSON.stringify(active, null, 2),
          },
        ],
      };
    },
  );

  server.resource(
    "Tags List",
    "line-harness://tags/list",
    async (_uri) => {
      const client = ctx.client;
      const tags = await client.tags.list();

      return {
        contents: [
          {
            uri: "line-harness://tags/list",
            mimeType: "application/json",
            text: JSON.stringify(tags, null, 2),
          },
        ],
      };
    },
  );
}
