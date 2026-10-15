import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  getFriendByLineUserId,
  getLineAccounts,
  getTagsByNames,
  createFriendForSync,
  applyFriendSync,
} from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { fireEvent } from '../services/event-bus.js';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';

/**
 * PUT /api/friend-sync/:lineUserId
 *
 * 外部システム(店舗システム)が「友だちの今の状態」を送る口。何度送っても結果は同じ。
 * Cloudflare のサービスバインディング経由(Origin なし・任意のホスト)で、Bearer の API キー
 * (staff 権限)を付けて呼ばれる。仕様は Docs/15_store-system-integration.md §10.1。
 *
 * 友だちの記録が無ければ作る(LINE のプロフィール API で友だちかどうかを確かめる)。
 * 作ったことでは、友だち追加のシナリオ・あいさつ・friend_add の自動化・イベントは動かさない。
 */
const friendSync = new Hono<Env>();

const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;
// SQLite の JSON パス($."key")にそのまま埋め込むため、キーは安全な文字に限る。
const METADATA_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
// キー 1 つにつき SQL の bind が 2 個増える。D1 は 1 文あたり bind 100 個までなので、その内に収める。
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_DEPTH = 10;
// Object.prototype の名前は、プロトタイプ汚染・「あるか」の判定のずれの元になるので受け付けない。
const FORBIDDEN_METADATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_TAG_ENTRIES = 50;
const MAX_TAG_NAME_LENGTH = 100;
const MAX_REATTACH_KEY_LENGTH = 200;

function badRequest(c: Context<Env>, error: string) {
  return c.json({ success: false, error }, 400);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 値の入れ子の深さが limit を超えるか。超えた時点で打ち切るので、深い入力でも再帰は limit 段まで。 */
function exceedsDepth(value: unknown, limit: number, depth = 0): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (depth >= limit) return true;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (exceedsDepth(child, limit, depth + 1)) return true;
  }
  return false;
}

friendSync.put('/api/friend-sync/:lineUserId', requireRole('owner', 'admin', 'staff'), async (c) => {
  try {
    const lineUserId = c.req.param('lineUserId')!;
    if (!LINE_USER_ID_PATTERN.test(lineUserId)) {
      return badRequest(c, 'lineUserId must match ^U[0-9a-f]{32}$');
    }

    // ── 本文の形の検証 ──
    // Content-Length が分かるなら、本文を読む前に大きすぎるものを断る(無いときは読んでから測る)。
    const declaredLength = Number.parseInt(c.req.header('Content-Length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return badRequest(c, 'request body is too large');
    }
    const rawBody = await c.req.text();
    if (byteLength(rawBody) > MAX_BODY_BYTES) {
      return badRequest(c, 'request body is too large');
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return badRequest(c, 'request body must be valid JSON');
    }
    if (!isPlainObject(body)) {
      return badRequest(c, 'request body must be a JSON object');
    }

    let metadata: Record<string, unknown> | undefined;
    if (body.metadata !== undefined) {
      if (!isPlainObject(body.metadata)) {
        return badRequest(c, 'metadata must be an object');
      }
      const metadataKeys = Object.keys(body.metadata);
      if (metadataKeys.length > MAX_METADATA_KEYS) {
        return badRequest(c, `metadata must have at most ${MAX_METADATA_KEYS} keys`);
      }
      for (const key of metadataKeys) {
        if (!METADATA_KEY_PATTERN.test(key) || FORBIDDEN_METADATA_KEYS.has(key)) {
          return badRequest(c, `metadata key is invalid: ${key}`);
        }
      }
      if (exceedsDepth(body.metadata, MAX_METADATA_DEPTH + 1)) {
        return badRequest(c, `metadata is nested too deeply (max ${MAX_METADATA_DEPTH})`);
      }
      if (byteLength(JSON.stringify(body.metadata)) > MAX_METADATA_BYTES) {
        return badRequest(c, 'metadata is too large');
      }
      metadata = body.metadata;
    }

    const tagStates: Array<[string, boolean]> = [];
    if (body.tags !== undefined) {
      if (!isPlainObject(body.tags)) {
        return badRequest(c, 'tags must be an object of tag name to boolean');
      }
      const entries = Object.entries(body.tags);
      if (entries.length > MAX_TAG_ENTRIES) {
        return badRequest(c, `tags must have at most ${MAX_TAG_ENTRIES} entries`);
      }
      for (const [name, attached] of entries) {
        if (!name || name.length > MAX_TAG_NAME_LENGTH || typeof attached !== 'boolean') {
          return badRequest(c, 'tags must be an object of tag name to boolean');
        }
        tagStates.push([name, attached]);
      }
    }

    let reattach: { tag: string; key: string } | undefined;
    if (body.reattach !== undefined) {
      const r = body.reattach;
      if (
        !isPlainObject(r) ||
        typeof r.tag !== 'string' ||
        !r.tag ||
        r.tag.length > MAX_TAG_NAME_LENGTH ||
        typeof r.key !== 'string' ||
        !r.key ||
        r.key.length > MAX_REATTACH_KEY_LENGTH
      ) {
        return badRequest(c, 'reattach must be { tag: string, key: string }');
      }
      reattach = { tag: r.tag, key: r.key };
      if (tagStates.some(([name]) => name === reattach!.tag)) {
        return badRequest(c, 'tags and reattach must not refer to the same tag');
      }
    }

    // ── タグの存在確認(1 つでも無ければ、何も変えずに 422) ──
    const db = c.env.DB;
    const wantedNames = [...new Set([...tagStates.map(([name]) => name), ...(reattach ? [reattach.tag] : [])])];
    const foundTags = await getTagsByNames(db, wantedNames);
    const tagByName = new Map(foundTags.map((t) => [t.name, t]));
    const missingTags = wantedNames.filter((name) => !tagByName.has(name));
    if (missingTags.length > 0) {
      return c.json({ success: false, error: 'tag_not_found', missingTags }, 422);
    }

    // ── 友だちの記録(無ければ作る) ──
    let friend = await getFriendByLineUserId(db, lineUserId);
    let created = false;
    if (!friend) {
      // 担当の公式 LINE は webhook と同じ決め方: LINE_CHANNEL_SECRET が一致する有効なアカウント。
      // line_accounts が空(Dev)なら、環境変数のトークンを使い、line_account_id は付けない。
      let lineAccountId: string | null = null;
      let accessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
      const envSecret = c.env.LINE_CHANNEL_SECRET;
      if (envSecret) {
        const accounts = await getLineAccounts(db);
        const main = accounts.find((a) => a.is_active && a.channel_secret === envSecret);
        if (main) {
          lineAccountId = main.id;
          accessToken = main.channel_access_token;
        }
      }

      let displayName: string | null = null;
      let pictureUrl: string | null = null;
      let statusMessage: string | null = null;
      let isFollowing = false;
      try {
        const profile = await new LineClient(accessToken).getProfile(lineUserId);
        isFollowing = true;
        displayName = profile.displayName ?? null;
        pictureUrl = profile.pictureUrl ?? null;
        statusMessage = profile.statusMessage ?? null;
      } catch (err) {
        // 404 = 友だちでない(ブロック中を含む)。それ以外の失敗は友だちを作らず、送り直してもらう。
        const message = err instanceof Error ? err.message : '';
        if (!/^LINE API error: 404\b/.test(message)) {
          return c.json({ success: false, error: 'line_profile_unavailable' }, 503);
        }
      }

      const result = await createFriendForSync(db, {
        lineUserId,
        displayName,
        pictureUrl,
        statusMessage,
        isFollowing,
        lineAccountId,
      });
      friend = result.friend;
      created = result.created;
    }

    // ── メタデータ・タグ・付け直しを batch でまとめて書く ──
    const applied = await applyFriendSync(db, friend, {
      metadata,
      tags: tagStates.map(([name, attached]) => ({ tag: tagByName.get(name)!, attached })),
      reattach: reattach ? { tag: tagByName.get(reattach.tag)!, key: reattach.key } : undefined,
    });
    if (applied.scenarioBusy) {
      // 付け直し先のシナリオが cron の送信中。何も書いていない(key も未記録)ので、送り直してもらう。
      return c.json({ success: false, error: 'scenario_busy' }, 503);
    }

    // 手動の付け外し(POST/DELETE /api/friends/:id/tags)と同じ tag_change イベント
    //(送信 Webhook・スコアリング・自動化)。
    // イベントはベストエフォートで、再送しない: 書き込みは確定済みなので失敗しても応答は失敗にしない。
    // 呼び出し元が同じ key / 同じ状態を送り直しても「変更なし」になるため、落ちたイベントは撃ち直されない。
    // 応答を待たせないよう waitUntil に載せる(ExecutionContext が無いテスト環境では、その場で待つ)。
    const events: Array<{ tagId: string; action: 'add' | 'remove' }> = [];
    for (const tag of applied.tagsRemoved) events.push({ tagId: tag.id, action: 'remove' });
    for (const tag of applied.tagsAdded) events.push({ tagId: tag.id, action: 'add' });
    if (reattach && applied.reattachRemoved) {
      events.push({ tagId: tagByName.get(reattach.tag)!.id, action: 'remove' });
    }
    if (reattach && applied.reattached) {
      events.push({ tagId: tagByName.get(reattach.tag)!.id, action: 'add' });
    }
    const friendId = friend.id;
    const firing = (async () => {
      for (const event of events) {
        try {
          await fireEvent(db, 'tag_change', { friendId, eventData: event });
        } catch {
          // 次のイベントへ進む
        }
      }
    })();
    try {
      c.executionCtx.waitUntil(firing);
    } catch {
      await firing;
    }

    return c.json({
      friendId: friend.id,
      created,
      isFollowing: Boolean(friend.is_following),
      tagsAdded: applied.tagsAdded.map((t) => t.name),
      tagsRemoved: applied.tagsRemoved.map((t) => t.name),
      reattached: applied.reattached,
    });
  } catch {
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { friendSync };
