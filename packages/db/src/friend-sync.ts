import { jstNow } from './utils.js';
import type { Friend } from './friends.js';
import type { Tag } from './tags.js';
import { getScenarios, buildScenarioRestartStatements } from './scenarios.js';

/**
 * 外部システム(店舗システム)から「友だちの今の状態」を同期するための DB 操作。
 * PUT /api/friend-sync/:lineUserId が使う。
 */

/** 名前でタグを引く(存在するものだけ返す)。タグは自動では作らない。 */
export async function getTagsByNames(db: D1Database, names: string[]): Promise<Tag[]> {
  if (names.length === 0) return [];
  const placeholders = names.map(() => '?').join(', ');
  const result = await db
    .prepare(`SELECT * FROM tags WHERE name IN (${placeholders})`)
    .bind(...names)
    .all<Tag>();
  return result.results;
}

export interface CreateFriendForSyncInput {
  lineUserId: string;
  displayName: string | null;
  pictureUrl: string | null;
  statusMessage: string | null;
  isFollowing: boolean;
  lineAccountId: string | null;
}

/**
 * line_user_id の友だちが無ければ作る。作った場合は created=true。
 * 同時に別の経路(webhook の follow 等)が先に作っていたら、その行を返して created=false。
 * upsertFriend と違い is_following を指定できる(友だちでない記録も作れる)。
 */
export async function createFriendForSync(
  db: D1Database,
  input: CreateFriendForSyncInput,
): Promise<{ friend: Friend; created: boolean }> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO friends (id, line_user_id, display_name, picture_url, status_message, is_following, line_account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineUserId,
      input.displayName,
      input.pictureUrl,
      input.statusMessage,
      input.isFollowing ? 1 : 0,
      input.lineAccountId,
      now,
      now,
    )
    .run();
  const created = (result.meta?.changes ?? 0) > 0;
  const friend = (await db
    .prepare(`SELECT * FROM friends WHERE line_user_id = ?`)
    .bind(input.lineUserId)
    .first<Friend>())!;
  return { friend, created };
}

export interface FriendSyncInput {
  /** 最上位のキー → 新しい値。null はそのキーを消す。キーは呼び出し側で検証済みであること。 */
  metadata?: Record<string, unknown>;
  /** タグ → 付いているべきか。 */
  tags?: Array<{ tag: Tag; attached: boolean }>;
  /** そのタグを外して付け直し、tag_added のシナリオを今日から始め直す(key ごとに 1 回)。 */
  reattach?: { tag: Tag; key: string };
}

export interface FriendSyncResult {
  tagsAdded: Tag[];
  tagsRemoved: Tag[];
  /** reattach が実際に行われた(この key で初めて)。 */
  reattached: boolean;
  /** reattach でタグが外れた(付いていた)。tag_change(remove) を撃つかの判断用。 */
  reattachRemoved: boolean;
  /**
   * reattach の対象タグを起点とする有効なシナリオが、cron の送信中('delivering')だったため、
   * 何も書かずに戻った(key も記録していない)。呼び出し側は 503 で送り直してもらう。
   */
  scenarioBusy: boolean;
}

/** friends.metadata の中身。JSON のオブジェクトでなければ(壊れている・配列・null など)空として扱う。SQL 側の基準と揃える。 */
function parseMetadataObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // 壊れている → 空から作り直す
  }
  return {};
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 最上位のキーごとの上書きを、1 本の UPDATE(json_remove / json_set)にする。変化が無ければ null。 */
function buildMetadataStatement(
  db: D1Database,
  friendId: string,
  currentRaw: string,
  patch: Record<string, unknown>,
): D1PreparedStatement | null {
  const current = parseMetadataObject(currentRaw);

  // 壊れている・オブジェクトでない metadata は '{}' から作り直す(JS 側の parseMetadataObject と同じ基準)。
  let expr = `CASE WHEN json_valid(metadata) THEN (CASE WHEN json_type(metadata) = 'object' THEN metadata ELSE '{}' END) ELSE '{}' END`;
  const binds: unknown[] = [];
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    const path = `$."${key}"`;
    if (value === null) {
      if (!Object.hasOwn(current, key)) continue;
      expr = `json_remove(${expr}, ?)`;
      binds.push(path);
    } else {
      if (Object.hasOwn(current, key) && jsonEqual(current[key], value)) continue;
      expr = `json_set(${expr}, ?, json(?))`;
      binds.push(path, JSON.stringify(value));
    }
    changed = true;
  }
  if (!changed) return null;

  return db
    .prepare(`UPDATE friends SET metadata = ${expr}, updated_at = ? WHERE id = ?`)
    .bind(...binds, jstNow(), friendId);
}

type StatementKind =
  | { kind: 'other' }
  | { kind: 'tag-remove'; tag: Tag }
  | { kind: 'tag-add'; tag: Tag }
  | { kind: 'claim' }
  | { kind: 'reattach-remove' }
  | { kind: 'reattach-add' };

/**
 * メタデータ・タグの付け外し・タグの付け直しを、D1 の batch(1 トランザクション)でまとめて書く。
 * 途中で失敗しても「タグだけ外れたまま」にならない。
 *
 * - 今の状態と違うものだけ書く(何度呼んでも同じ結果)。
 * - 新しくタグが付いたときは、手動のタグ付け(POST /api/friends/:id/tags)と同じく、
 *   そのタグを起点とする有効な tag_added シナリオを始め直す(進行中なら起点リセット、無ければ登録)。
 * - reattach は friend_sync_reattach への INSERT OR IGNORE を「最初の 1 回」の判定に使い、
 *   後続の文は claim_id が自分のものか(EXISTS)で守る。同時に 2 つ届いても付け直しは 1 回だけ。
 *
 * 呼び出し側が事前に確かめること: タグが存在すること、reattach.tag が tags と重ならないこと。
 */
export async function applyFriendSync(
  db: D1Database,
  friend: Friend,
  input: FriendSyncInput,
): Promise<FriendSyncResult> {
  const statements: D1PreparedStatement[] = [];
  const kinds: StatementKind[] = [];
  const push = (stmt: D1PreparedStatement, kind: StatementKind) => {
    statements.push(stmt);
    kinds.push(kind);
  };

  // reattach の key が記録済みなら、書き込みを丸ごと省く(送り直しのたびに書かない)。
  let reattachDone = false;
  if (input.reattach) {
    const existing = await db
      .prepare(
        `SELECT 1 AS found FROM friend_sync_reattach WHERE friend_id = ? AND tag_id = ? AND reattach_key = ?`,
      )
      .bind(friend.id, input.reattach.tag.id, input.reattach.key)
      .first<{ found: number }>();
    reattachDone = !!existing;
  }

  // 付け直しの対象タグを起点とする有効なシナリオが cron の送信中('delivering')だと、起点を書き換えられず
  // key だけが消費されて、その来店のシナリオ再開が永久に抜ける。何も書かず(claim もせず)、送り直してもらう。
  // 読んでから batch までの間に cron が送信を始める競合は許容する(発生は稀で、この確認の目的は大半を防ぐこと)。
  if (input.reattach && !reattachDone) {
    const busy = await db
      .prepare(
        `SELECT 1 AS found
         FROM friend_scenarios fs
         INNER JOIN scenarios s ON s.id = fs.scenario_id
         WHERE fs.friend_id = ? AND fs.status = 'delivering'
           AND s.trigger_type = 'tag_added' AND s.is_active = 1 AND s.trigger_tag_id = ?
         LIMIT 1`,
      )
      .bind(friend.id, input.reattach.tag.id)
      .first<{ found: number }>();
    if (busy) {
      return { tagsAdded: [], tagsRemoved: [], reattached: false, reattachRemoved: false, scenarioBusy: true };
    }
  }

  // ── metadata ──
  if (input.metadata && Object.keys(input.metadata).length > 0) {
    const stmt = buildMetadataStatement(db, friend.id, friend.metadata, input.metadata);
    if (stmt) push(stmt, { kind: 'other' });
  }

  let activeTagAddedScenarios: Array<{ id: string; trigger_tag_id: string | null }> = [];
  const needScenarios =
    (input.tags?.some((t) => t.attached) ?? false) || (!!input.reattach && !reattachDone);

  let currentTagIds = new Set<string>();
  if (input.tags && input.tags.length > 0) {
    const rows = await db
      .prepare(`SELECT tag_id FROM friend_tags WHERE friend_id = ?`)
      .bind(friend.id)
      .all<{ tag_id: string }>();
    currentTagIds = new Set(rows.results.map((r) => r.tag_id));
  }
  if (needScenarios) {
    const all = await getScenarios(db);
    activeTagAddedScenarios = all.filter(
      (s) => s.trigger_type === 'tag_added' && s.is_active && s.trigger_tag_id,
    );
  }

  // ── tags ──
  for (const { tag, attached } of input.tags ?? []) {
    const has = currentTagIds.has(tag.id);
    if (attached && !has) {
      // 「まだ付いていないとき」だけシナリオを始め直す。タグの INSERT より前に置くので、
      // 同時に同じ要求が来ても片方だけが条件を満たす。
      const guard = {
        sql: `NOT EXISTS (SELECT 1 FROM friend_tags WHERE friend_id = ? AND tag_id = ?)`,
        binds: [friend.id, tag.id],
      };
      for (const scenario of activeTagAddedScenarios) {
        if (scenario.trigger_tag_id !== tag.id) continue;
        for (const stmt of await buildScenarioRestartStatements(db, friend.id, scenario.id, guard)) {
          push(stmt, { kind: 'other' });
        }
      }
      push(
        db
          .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
          .bind(friend.id, tag.id, jstNow()),
        { kind: 'tag-add', tag },
      );
    } else if (!attached && has) {
      push(
        db
          .prepare(`DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ?`)
          .bind(friend.id, tag.id),
        { kind: 'tag-remove', tag },
      );
    }
  }

  // ── reattach ──
  if (input.reattach && !reattachDone) {
    const { tag, key } = input.reattach;
    const claimId = crypto.randomUUID();
    const guard = {
      sql: `EXISTS (SELECT 1 FROM friend_sync_reattach WHERE friend_id = ? AND tag_id = ? AND reattach_key = ? AND claim_id = ?)`,
      binds: [friend.id, tag.id, key, claimId],
    };
    push(
      db
        .prepare(
          `INSERT OR IGNORE INTO friend_sync_reattach (friend_id, tag_id, reattach_key, claim_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(friend.id, tag.id, key, claimId, jstNow()),
      { kind: 'claim' },
    );
    push(
      db
        .prepare(`DELETE FROM friend_tags WHERE friend_id = ? AND tag_id = ? AND ${guard.sql}`)
        .bind(friend.id, tag.id, ...guard.binds),
      { kind: 'reattach-remove' },
    );
    for (const scenario of activeTagAddedScenarios) {
      if (scenario.trigger_tag_id !== tag.id) continue;
      for (const stmt of await buildScenarioRestartStatements(db, friend.id, scenario.id, guard)) {
        push(stmt, { kind: 'other' });
      }
    }
    push(
      db
        .prepare(
          `INSERT INTO friend_tags (friend_id, tag_id, assigned_at)
           SELECT ?, ?, ? WHERE ${guard.sql}`,
        )
        .bind(friend.id, tag.id, jstNow(), ...guard.binds),
      { kind: 'reattach-add' },
    );
  }

  const result: FriendSyncResult = {
    tagsAdded: [],
    tagsRemoved: [],
    reattached: false,
    reattachRemoved: false,
    scenarioBusy: false,
  };
  if (statements.length === 0) return result;

  const results = await db.batch(statements);
  results.forEach((r, i) => {
    const changed = (r.meta?.changes ?? 0) > 0;
    const k = kinds[i];
    if (!changed) return;
    if (k.kind === 'tag-add') result.tagsAdded.push(k.tag);
    else if (k.kind === 'tag-remove') result.tagsRemoved.push(k.tag);
    else if (k.kind === 'reattach-add') result.reattached = true;
    else if (k.kind === 'reattach-remove') result.reattachRemoved = true;
  });
  return result;
}
