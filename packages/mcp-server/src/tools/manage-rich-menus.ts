import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../context.js";

export function registerManageRichMenus(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "manage_rich_menus",
    "リッチメニューの管理操作。list: 一覧取得、delete: 削除、set_default: デフォルト設定。作成は create_rich_menu ツールを使用。",
    {
      action: z.enum(["list", "delete", "set_default"]).describe("Action to perform"),
      richMenuId: z.string().optional().describe("Rich menu ID (required for delete, set_default)"),
    },
    async ({ action, richMenuId }) => {
      try {
        const client = ctx.client;
        if (action === "list") {
          const menus = await client.richMenus.list();
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, richMenus: menus }, null, 2) }] };
        }
        if (!richMenuId) throw new Error("richMenuId is required for this action");
        if (action === "delete") {
          await client.richMenus.delete(richMenuId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, deleted: richMenuId }, null, 2) }] };
        }
        if (action === "set_default") {
          await client.richMenus.setDefault(richMenuId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, defaultRichMenuId: richMenuId }, null, 2) }] };
        }
        throw new Error(`Unknown action: ${action}`);
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(err) }) }], isError: true };
      }
    },
  );
}
