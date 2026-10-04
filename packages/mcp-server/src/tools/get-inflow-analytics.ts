import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EntryRoute } from "@line-harness/sdk";
import { z } from "zod";
import type { ToolContext } from "../context.js";

const SUMMARY_NOTE =
  "友だち数は LINE Harness に登録済みの友だちのみ。Harness の URL（/r/<refCode>）を通らずに追加した人（LINE 内検索・標準 QR など）は経路不明（friendsWithoutRef）に数える。";

interface InflowRouteRow {
  refCode: string;
  name: string | null;
  registered: boolean;
  isActive?: boolean;
  friendCount: number;
  clickCount: number;
  latestAt: string | null;
  inflowUrl: string;
}

export function registerGetInflowAnalytics(server: McpServer, ctx: ToolContext): void {
  const inflowUrl = (refCode: string) => `${ctx.apiUrl}/r/${encodeURIComponent(refCode)}`;

  server.tool(
    "get_inflow_analytics",
    "流入経路（リファラルリンク /r/<refCode>）ごとの友だち数・クリック数・最新の友だち追加日時と、経路不明の友だち数を返す。refCode を指定すると、その経路の友だち一覧とファネル（クリック→友だち追加→フォーム回答→CV）を返す。読み取り専用で、メッセージ送信や設定変更は行わない。",
    {
      refCode: z
        .string()
        .optional()
        .describe("流入経路の refCode。省略で全経路のサマリー、指定でその経路の詳細"),
      accountId: z
        .string()
        .optional()
        .describe("LINE アカウント ID で絞り込み（省略時は既定アカウント、なければ全体）"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("詳細モードで返す友だち一覧の最大件数（1〜500、既定 50）"),
    },
    async ({ refCode, accountId, limit }) => {
      try {
        const client = ctx.client;
        const params = { lineAccountId: accountId };

        if (refCode === undefined) {
          const [summary, entryRoutes] = await Promise.all([
            client.entryRoutes.summary(params),
            client.entryRoutes.list(),
          ]);
          const routeByRef = new Map<string, EntryRoute>();
          for (const route of entryRoutes) {
            if (!routeByRef.has(route.refCode)) routeByRef.set(route.refCode, route);
          }

          const seen = new Set<string>();
          const routes: InflowRouteRow[] = summary.routes.map((row) => {
            seen.add(row.refCode);
            const route = routeByRef.get(row.refCode);
            return {
              refCode: row.refCode,
              name: row.name,
              registered: route !== undefined,
              ...(route ? { isActive: route.isActive } : {}),
              friendCount: row.friendCount,
              clickCount: row.clickCount,
              latestAt: row.latestAt,
              inflowUrl: inflowUrl(row.refCode),
            };
          });
          for (const route of routeByRef.values()) {
            if (seen.has(route.refCode)) continue;
            routes.push({
              refCode: route.refCode,
              name: route.name,
              registered: true,
              isActive: route.isActive,
              friendCount: 0,
              clickCount: 0,
              latestAt: null,
              inflowUrl: inflowUrl(route.refCode),
            });
          }
          routes.sort(
            (a, b) =>
              b.friendCount - a.friendCount ||
              (a.name ?? "").localeCompare(b.name ?? "") ||
              a.refCode.localeCompare(b.refCode),
          );

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    routes,
                    totals: {
                      totalFriends: summary.totalFriends,
                      friendsWithRef: summary.friendsWithRef,
                      friendsWithoutRef: summary.friendsWithoutRef,
                    },
                    note: SUMMARY_NOTE,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const [detail, entryRoutes] = await Promise.all([
          client.entryRoutes.refDetail(refCode, params),
          client.entryRoutes.list(),
        ]);
        const route = entryRoutes.find((r) => r.refCode === refCode);
        const funnel = route ? await client.entryRoutes.funnel(route.id) : null;
        // The detail API joins every ref_tracking row, so a friend who opened
        // the link several times comes back once per click (newest first).
        // Keep the first row per friend so friendCount matches the summary.
        const seenFriends = new Set<string>();
        const friends = detail.friends.filter((f) => {
          if (seenFriends.has(f.id)) return false;
          seenFriends.add(f.id);
          return true;
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  refCode: detail.refCode,
                  name: detail.name ?? route?.name ?? null,
                  registered: route !== undefined,
                  ...(route ? { isActive: route.isActive } : {}),
                  inflowUrl: inflowUrl(refCode),
                  funnel: funnel
                    ? {
                        clicks: funnel.click_count,
                        friendAdds: funnel.friend_add_count,
                        formSubmissions: funnel.form_submission_count,
                        conversions: funnel.cv_count,
                      }
                    : null,
                  friendCount: friends.length,
                  friends: friends.slice(0, limit),
                  truncated: friends.length > limit,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: String(error) }, null, 2),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
