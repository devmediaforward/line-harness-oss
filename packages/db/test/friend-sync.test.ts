import { describe, expect, test, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyFriendSync,
  createFriendForSync,
  getTagsByNames,
} from '../src/friend-sync.js';
import { upsertFriend } from '../src/friends.js';
import { enrollFriendInScenario } from '../src/scenarios.js';
import type { Friend } from '../src/friends.js';
import type { Tag } from '../src/tags.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');

const BENIGN = /duplicate column name|already exists/i;

function execSafe(db: Database.Database, sql: string): void {
  for (const stmt of sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!BENIGN.test(msg)) throw err;
    }
  }
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  execSafe(db, readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    execSafe(db, readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return db;
}

/**
 * D1 の最小アダプタ。batch は D1 と同じく 1 トランザクション(途中で失敗したら全部巻き戻す)で、
 * 文ごとの meta.changes を返す。
 */
function asD1(sqlite: Database.Database): D1Database {
  type Bound = { run(): Promise<unknown>; _exec(): { changes: number } };
  const makeStatement = (query: string, params: unknown[]): Bound & Record<string, unknown> => ({
    _exec() {
      const info = sqlite.prepare(query).run(...params);
      return { changes: info.changes };
    },
    async run() {
      const info = sqlite.prepare(query).run(...params);
      return { results: [], success: true, meta: { changes: info.changes } };
    },
    async first<T>() {
      return (sqlite.prepare(query).get(...params) as T) ?? null;
    },
    async all<T>() {
      return { results: sqlite.prepare(query).all(...params) as T[], success: true, meta: {} };
    },
  });
  return {
    prepare(query: string) {
      const base = makeStatement(query, []);
      return Object.assign(base, {
        bind(...params: unknown[]) {
          return makeStatement(query, params);
        },
      });
    },
    async batch(statements: Array<{ _exec(): { changes: number } }>) {
      const run = sqlite.transaction(() =>
        statements.map((s) => ({ results: [], success: true, meta: { changes: s._exec().changes } })),
      );
      return run();
    },
  } as unknown as D1Database;
}

const OLD = '2020-01-01T00:00:00.000+09:00';
const USER_ID = 'U0123456789abcdef0123456789abcdef';

let sqlite: Database.Database;
let db: D1Database;
let friend: Friend;
let tagMember: Tag;
let tagNextBooking: Tag;
let tagVisit: Tag;

function seedTag(id: string, name: string): Tag {
  sqlite.prepare(`INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)`).run(id, name, OLD);
  return { id, name, color: '#3B82F6', created_at: OLD };
}

function seedFriend(metadata = '{}'): Friend {
  sqlite
    .prepare(
      `INSERT INTO friends (id, line_user_id, display_name, is_following, metadata, created_at, updated_at)
       VALUES ('friend-1', ?, 'Alice', 1, ?, ?, ?)`,
    )
    .run(USER_ID, metadata, OLD, OLD);
  return sqlite.prepare(`SELECT * FROM friends WHERE id = 'friend-1'`).get() as Friend;
}

function seedScenario(
  id: string,
  opts: { trigger?: 'tag_added' | 'friend_add'; tagId?: string | null; steps?: boolean; active?: number } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO scenarios (id, name, trigger_type, trigger_tag_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, id, opts.trigger ?? 'tag_added', opts.tagId ?? null, opts.active ?? 1, OLD, OLD);
  if (opts.steps ?? true) {
    sqlite
      .prepare(
        `INSERT INTO scenario_steps (id, scenario_id, step_order, delay_minutes, message_type, message_content, created_at)
         VALUES (?, ?, 0, 20160, 'text', 'hello', ?)`,
      )
      .run(`${id}-step-0`, id, OLD);
  }
}

function seedEnrollment(id: string, scenarioId: string, status: string) {
  sqlite
    .prepare(
      `INSERT INTO friend_scenarios (id, friend_id, scenario_id, current_step_order, status, started_at, next_delivery_at, updated_at)
       VALUES (?, 'friend-1', ?, 3, ?, ?, ?, ?)`,
    )
    .run(id, scenarioId, status, OLD, OLD, OLD);
}

function enrollments(scenarioId: string) {
  return sqlite
    .prepare(`SELECT * FROM friend_scenarios WHERE friend_id = 'friend-1' AND scenario_id = ? ORDER BY rowid`)
    .all(scenarioId) as Array<{
    id: string;
    current_step_order: number;
    status: string;
    started_at: string;
    next_delivery_at: string | null;
  }>;
}

function attachedTagIds(): string[] {
  return (
    sqlite.prepare(`SELECT tag_id FROM friend_tags WHERE friend_id = 'friend-1' ORDER BY tag_id`).all() as Array<{
      tag_id: string;
    }>
  ).map((r) => r.tag_id);
}

function metadataOf(): Record<string, unknown> {
  const row = sqlite.prepare(`SELECT metadata FROM friends WHERE id = 'friend-1'`).get() as { metadata: string };
  return JSON.parse(row.metadata);
}

function currentFriend(): Friend {
  return sqlite.prepare(`SELECT * FROM friends WHERE id = 'friend-1'`).get() as Friend;
}


/**
 * 事前読み取り(タグの現在地・reattach の記録・送信中の確認)だけが「古い」D1。
 * 同時に届いた 2 つ目の要求が、1 つ目の確定前に読んだ状態を再現する(書き込みは本物のまま)。
 */
function staleReads(base: D1Database, opts: { tags?: boolean; reattach?: boolean } = {}): D1Database {
  return {
    ...base,
    prepare(query: string) {
      if (opts.reattach && query.startsWith('SELECT 1 AS found FROM friend_sync_reattach')) {
        return { bind: () => ({ first: async () => null }) };
      }
      if (opts.tags && query.startsWith('SELECT tag_id FROM friend_tags')) {
        return { bind: () => ({ all: async () => ({ results: [] }) }) };
      }
      return base.prepare(query);
    },
    batch: (stmts: unknown) => (base as unknown as { batch: (s: unknown) => Promise<unknown> }).batch(stmts),
  } as unknown as D1Database;
}

beforeEach(() => {
  sqlite = setupDb();
  db = asD1(sqlite);
  tagMember = seedTag('tag-member', '会員');
  tagNextBooking = seedTag('tag-next', '次回予約あり');
  tagVisit = seedTag('tag-visit', '【来店】');
  friend = seedFriend();
});

describe('getTagsByNames', () => {
  test('存在する名前だけ返す(自動では作らない)', async () => {
    const found = await getTagsByNames(db, ['会員', '無い', '【来店】']);
    expect(found.map((t) => t.name).sort()).toEqual(['【来店】', '会員']);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM tags`).get() as { n: number }).n).toBe(3);
  });

  test('空なら DB を引かず空配列', async () => {
    expect(await getTagsByNames(db, [])).toEqual([]);
  });
});

describe('createFriendForSync', () => {
  const base = {
    lineUserId: 'Uffffffffffffffffffffffffffffffff',
    displayName: 'Bob',
    pictureUrl: 'https://p/b.png',
    statusMessage: null,
    lineAccountId: null,
  };

  test('友だち(is_following=1)として作る。シナリオ登録・メッセージ記録は作らない', async () => {
    seedScenario('sc-friend-add', { trigger: 'friend_add' });
    const { friend: f, created } = await createFriendForSync(db, { ...base, isFollowing: true });
    expect(created).toBe(true);
    expect(f.is_following).toBe(1);
    expect(f.display_name).toBe('Bob');
    expect(f.metadata).toBe('{}');
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM friend_scenarios`).get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM messages_log`).get() as { n: number }).n).toBe(0);
  });

  test('友だちでない記録(is_following=0・表示名なし)も作れる', async () => {
    const { friend: f, created } = await createFriendForSync(db, {
      ...base,
      displayName: null,
      pictureUrl: null,
      isFollowing: false,
    });
    expect(created).toBe(true);
    expect(f.is_following).toBe(0);
    expect(f.display_name).toBeNull();
  });

  test('既にあれば作らず、既存の行を返す(上書きしない)', async () => {
    const first = await createFriendForSync(db, { ...base, isFollowing: true });
    const second = await createFriendForSync(db, { ...base, displayName: 'Other', isFollowing: false });
    expect(second.created).toBe(false);
    expect(second.friend.id).toBe(first.friend.id);
    expect(second.friend.display_name).toBe('Bob');
    expect(second.friend.is_following).toBe(1);
  });

  test('line_account_id を付けられる', async () => {
    sqlite
      .prepare(
        `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, created_at, updated_at)
         VALUES ('acc-1', 'ch', 'main', 't', 's', ?, ?)`,
      )
      .run(OLD, OLD);
    const { friend: f } = await createFriendForSync(db, { ...base, isFollowing: true, lineAccountId: 'acc-1' });
    expect(f.line_account_id).toBe('acc-1');
  });
});

describe('同期で作った「友だちでない」記録の人が、後で実際に友だち追加したとき', () => {
  test('webhook の follow と同じ upsertFriend → friend_add の登録で、あいさつのシナリオが普通に始まる', async () => {
    seedScenario('sc-friend-add', { trigger: 'friend_add' });
    const { friend: f } = await createFriendForSync(db, {
      lineUserId: 'Uffffffffffffffffffffffffffffffff',
      displayName: null,
      pictureUrl: null,
      statusMessage: null,
      isFollowing: false,
      lineAccountId: null,
    });
    expect(f.is_following).toBe(0);

    // webhook.ts の follow ハンドラと同じ順序: upsertFriend(is_following=1 に戻す) → enrollFriendInScenario
    const followed = await upsertFriend(db, {
      lineUserId: f.line_user_id,
      displayName: 'Bob',
      pictureUrl: null,
      statusMessage: null,
    });
    expect(followed.id).toBe(f.id);
    expect(followed.is_following).toBe(1);
    const enrollment = await enrollFriendInScenario(db, f.id, 'sc-friend-add');
    // null なら「登録済み」としてあいさつが飛ばされる。同期は friend_add に登録しないので null にならない。
    expect(enrollment).not.toBeNull();
    expect(enrollment).toMatchObject({ status: 'active', current_step_order: -1 });
  });
});

describe('applyFriendSync — metadata', () => {
  test('最上位のキーごとに上書き(中身は丸ごと置き換え)・他のキーは触らない', async () => {
    friend = { ...friend, metadata: JSON.stringify({ keep: 'yes', redentStore: { customerId: 'old', stale: 1 } }) };
    sqlite.prepare(`UPDATE friends SET metadata = ? WHERE id = 'friend-1'`).run(friend.metadata);
    await applyFriendSync(db, friend, {
      metadata: { redentStore: { customerId: 'c1', memberNo: 'A1B2C3' } },
    });
    expect(metadataOf()).toEqual({
      keep: 'yes',
      redentStore: { customerId: 'c1', memberNo: 'A1B2C3' },
    });
  });

  test('null でそのキーを消す・無いキーの null は何もしない', async () => {
    sqlite.prepare(`UPDATE friends SET metadata = ? WHERE id = 'friend-1'`).run('{"keep":1,"redentStore":{"a":1}}');
    friend = currentFriend();
    await applyFriendSync(db, friend, { metadata: { redentStore: null, nothing: null } });
    expect(metadataOf()).toEqual({ keep: 1 });
  });

  test('日本語・数値・真偽値・配列もそのまま入る', async () => {
    await applyFriendSync(db, friend, {
      metadata: { note: 'こんにちは"引用"', n: 3, ok: false, list: [1, { a: null }] },
    });
    expect(metadataOf()).toEqual({ note: 'こんにちは"引用"', n: 3, ok: false, list: [1, { a: null }] });
  });

  test('同じ内容を送り直しても書き込まない(updated_at が変わらない)', async () => {
    await applyFriendSync(db, friend, { metadata: { redentStore: { customerId: 'c1' } } });
    sqlite.prepare(`UPDATE friends SET updated_at = ? WHERE id = 'friend-1'`).run(OLD);
    await applyFriendSync(db, currentFriend(), { metadata: { redentStore: { customerId: 'c1' } } });
    expect(currentFriend().updated_at).toBe(OLD);
    expect(metadataOf()).toEqual({ redentStore: { customerId: 'c1' } });
  });

  test('batch の途中の文が失敗したら(SQLite が受け付けない深さの値)、同じ batch のタグの変更も巻き戻る', async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 3000; i++) deep = [deep];
    await expect(
      applyFriendSync(db, currentFriend(), {
        metadata: { redentStore: deep },
        tags: [{ tag: tagMember, attached: true }],
      }),
    ).rejects.toThrow();
    expect(attachedTagIds()).toEqual([]);
    expect(metadataOf()).toEqual({});
  });
});

describe('applyFriendSync — tags', () => {
  test('今の状態と違うものだけ付け外しする', async () => {
    sqlite
      .prepare(`INSERT INTO friend_tags (friend_id, tag_id, assigned_at) VALUES ('friend-1', 'tag-next', ?)`)
      .run(OLD);
    const result = await applyFriendSync(db, friend, {
      tags: [
        { tag: tagMember, attached: true },
        { tag: tagNextBooking, attached: false },
      ],
    });
    expect(result.tagsAdded.map((t) => t.name)).toEqual(['会員']);
    expect(result.tagsRemoved.map((t) => t.name)).toEqual(['次回予約あり']);
    expect(attachedTagIds()).toEqual(['tag-member']);
  });

  test('2 回目は何も変わらない(結果が空・行も変わらない)', async () => {
    const input = {
      tags: [
        { tag: tagMember, attached: true },
        { tag: tagNextBooking, attached: false },
      ],
    };
    await applyFriendSync(db, friend, input);
    const before = sqlite.prepare(`SELECT * FROM friend_tags`).all();
    const second = await applyFriendSync(db, friend, input);
    expect(second).toEqual({ tagsAdded: [], tagsRemoved: [], reattached: false, reattachRemoved: false, scenarioBusy: false });
    expect(sqlite.prepare(`SELECT * FROM friend_tags`).all()).toEqual(before);
  });

  test('付いていないタグを false にしても、付いているタグを true にしても何も起きない', async () => {
    sqlite
      .prepare(`INSERT INTO friend_tags (friend_id, tag_id, assigned_at) VALUES ('friend-1', 'tag-member', ?)`)
      .run(OLD);
    const result = await applyFriendSync(db, friend, {
      tags: [
        { tag: tagMember, attached: true },
        { tag: tagNextBooking, attached: false },
      ],
    });
    expect(result.tagsAdded).toEqual([]);
    expect(result.tagsRemoved).toEqual([]);
    expect(
      (sqlite.prepare(`SELECT assigned_at FROM friend_tags WHERE tag_id = 'tag-member'`).get() as { assigned_at: string })
        .assigned_at,
    ).toBe(OLD);
  });

  test('新しくタグが付いたとき、そのタグを起点とする有効な tag_added シナリオが始まる', async () => {
    seedScenario('sc-member', { tagId: 'tag-member' });
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    seedScenario('sc-off', { tagId: 'tag-member', active: 0 });
    await applyFriendSync(db, friend, { tags: [{ tag: tagMember, attached: true }] });
    expect(enrollments('sc-member')).toHaveLength(1);
    expect(enrollments('sc-member')[0]).toMatchObject({ status: 'active', current_step_order: -1 });
    expect(enrollments('sc-visit')).toHaveLength(0);
    expect(enrollments('sc-off')).toHaveLength(0);
  });

  test('既に付いているタグを true で送り直しても、進行中のシナリオの起点はリセットしない', async () => {
    seedScenario('sc-member', { tagId: 'tag-member' });
    sqlite
      .prepare(`INSERT INTO friend_tags (friend_id, tag_id, assigned_at) VALUES ('friend-1', 'tag-member', ?)`)
      .run(OLD);
    seedEnrollment('fs-1', 'sc-member', 'active');
    await applyFriendSync(db, friend, { tags: [{ tag: tagMember, attached: true }] });
    expect(enrollments('sc-member')[0]).toMatchObject({ started_at: OLD, current_step_order: 3 });
  });

  test('タグを外してもシナリオには触らない', async () => {
    seedScenario('sc-member', { tagId: 'tag-member' });
    sqlite
      .prepare(`INSERT INTO friend_tags (friend_id, tag_id, assigned_at) VALUES ('friend-1', 'tag-member', ?)`)
      .run(OLD);
    seedEnrollment('fs-1', 'sc-member', 'active');
    await applyFriendSync(db, friend, { tags: [{ tag: tagMember, attached: false }] });
    expect(enrollments('sc-member')[0]).toMatchObject({ status: 'active', started_at: OLD });
  });
});

describe('applyFriendSync — reattach', () => {
  const reattach = () => ({ tag: tagVisit, key: 'visit-1' });

  test('タグを外して付け直し、進行中のシナリオを今日から始め直す', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    sqlite
      .prepare(`INSERT INTO friend_tags (friend_id, tag_id, assigned_at) VALUES ('friend-1', 'tag-visit', ?)`)
      .run(OLD);
    seedEnrollment('fs-1', 'sc-visit', 'active');

    const result = await applyFriendSync(db, friend, { reattach: reattach() });

    expect(result.reattached).toBe(true);
    expect(result.reattachRemoved).toBe(true);
    expect(attachedTagIds()).toEqual(['tag-visit']);
    expect(
      (sqlite.prepare(`SELECT assigned_at FROM friend_tags WHERE tag_id = 'tag-visit'`).get() as { assigned_at: string })
        .assigned_at,
    ).not.toBe(OLD);
    const rows = enrollments('sc-visit');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'fs-1', status: 'active', current_step_order: -1 });
    expect(rows[0].started_at).not.toBe(OLD);
    // 20160 分(14 日)後に最初のステップ
    expect(new Date(rows[0].next_delivery_at!).getTime() - new Date(rows[0].started_at).getTime()).toBeGreaterThan(
      13 * 24 * 60 * 60_000,
    );
  });

  test('同じ (友だち, タグ, key) の 2 回目は何もしない', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    seedEnrollment('fs-1', 'sc-visit', 'active');
    const first = await applyFriendSync(db, friend, { reattach: reattach() });
    expect(first.reattached).toBe(true);

    const tagRow = sqlite.prepare(`SELECT * FROM friend_tags WHERE tag_id = 'tag-visit'`).get();
    const enrollRow = enrollments('sc-visit')[0];
    // 付け直しの後でスタッフがタグを外しても、同じ key の送り直しは付け直さない
    const second = await applyFriendSync(db, friend, { reattach: reattach() });
    expect(second).toEqual({ tagsAdded: [], tagsRemoved: [], reattached: false, reattachRemoved: false, scenarioBusy: false });
    expect(sqlite.prepare(`SELECT * FROM friend_tags WHERE tag_id = 'tag-visit'`).get()).toEqual(tagRow);
    expect(enrollments('sc-visit')[0]).toEqual(enrollRow);
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM friend_sync_reattach`).get() as { n: number }).n,
    ).toBe(1);
  });

  test('key が違えば、また付け直す', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    seedEnrollment('fs-1', 'sc-visit', 'active');
    await applyFriendSync(db, friend, { reattach: { tag: tagVisit, key: 'visit-1' } });
    const startedAt1 = enrollments('sc-visit')[0].started_at;
    await new Promise((r) => setTimeout(r, 5));
    const second = await applyFriendSync(db, friend, { reattach: { tag: tagVisit, key: 'visit-2' } });
    expect(second.reattached).toBe(true);
    expect(enrollments('sc-visit')[0].started_at).not.toBe(startedAt1);
  });

  test('同時に同じ key が 2 つ届いても、付け直しは 1 回だけ(batch の変更行数で判定)', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    seedEnrollment('fs-1', 'sc-visit', 'active');
    const results = await Promise.all([
      applyFriendSync(db, friend, { reattach: reattach() }),
      applyFriendSync(db, friend, { reattach: reattach() }),
      applyFriendSync(db, friend, { reattach: reattach() }),
    ]);
    expect(results.filter((r) => r.reattached)).toHaveLength(1);
    expect(attachedTagIds()).toEqual(['tag-visit']);
    expect(enrollments('sc-visit')).toHaveLength(1);
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM friend_sync_reattach`).get() as { n: number }).n,
    ).toBe(1);
  });

  test('同時に届いた負けの要求は、タグもシナリオも書き換えない', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    // 勝ちの要求が先に確定した状態を作る(負けの要求は事前チェックを通り過ぎた後に batch へ進む想定)
    const winner = await applyFriendSync(db, friend, { reattach: reattach() });
    expect(winner.reattached).toBe(true);
    const enrollBefore = enrollments('sc-visit');
    const tagBefore = sqlite.prepare(`SELECT * FROM friend_tags`).all();

    // 事前チェックの SELECT だけを「まだ無い」に見せかけた DB で、負けの要求を流す
    const base = asD1(sqlite);
    const racing = {
      ...base,
      prepare(query: string) {
        if (query.startsWith('SELECT 1 AS found')) {
          return { bind: () => ({ first: async () => null }) };
        }
        return base.prepare(query);
      },
      batch: (stmts: unknown) => (base as unknown as { batch: (s: unknown) => Promise<unknown> }).batch(stmts),
    } as unknown as D1Database;
    const loser = await applyFriendSync(racing, friend, { reattach: reattach() });

    expect(loser).toEqual({ tagsAdded: [], tagsRemoved: [], reattached: false, reattachRemoved: false, scenarioBusy: false });
    expect(enrollments('sc-visit')).toEqual(enrollBefore);
    expect(sqlite.prepare(`SELECT * FROM friend_tags`).all()).toEqual(tagBefore);
  });

  test('完了済みの登録しか無ければ、新しい登録を作る(来店ごとに配信し直す)', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    seedEnrollment('fs-done', 'sc-visit', 'completed');
    await applyFriendSync(db, friend, { reattach: reattach() });
    const rows = enrollments('sc-visit');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === 'fs-done')!.status).toBe('completed');
    expect(rows.find((r) => r.id !== 'fs-done')).toMatchObject({ status: 'active', current_step_order: -1 });
  });

  test('登録が無ければ新しく登録する', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    await applyFriendSync(db, friend, { reattach: reattach() });
    expect(enrollments('sc-visit')).toHaveLength(1);
    expect(enrollments('sc-visit')[0]).toMatchObject({ status: 'active', current_step_order: -1 });
  });

  test('cron が送信中(delivering)の登録は書き換えず、二重にもしない', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    seedEnrollment('fs-1', 'sc-visit', 'delivering');
    await applyFriendSync(db, friend, { reattach: reattach() });
    const rows = enrollments('sc-visit');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'fs-1', status: 'delivering', started_at: OLD, current_step_order: 3 });
  });

  test('ステップが 0 本のシナリオは進行中の登録を完了にし、孤児の行を増やさない', async () => {
    seedScenario('sc-empty', { tagId: 'tag-visit', steps: false });
    seedEnrollment('fs-1', 'sc-empty', 'active');
    await applyFriendSync(db, friend, { reattach: reattach() });
    const rows = enrollments('sc-empty');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'fs-1', status: 'completed', next_delivery_at: null });
  });

  test('関係の無いシナリオ(別のタグ・friend_add・無効)には触らない', async () => {
    seedScenario('sc-other', { tagId: 'tag-member' });
    seedScenario('sc-add', { trigger: 'friend_add' });
    seedScenario('sc-off', { tagId: 'tag-visit', active: 0 });
    seedEnrollment('fs-other', 'sc-other', 'active');
    await applyFriendSync(db, friend, { reattach: reattach() });
    expect(enrollments('sc-other')[0]).toMatchObject({ started_at: OLD, current_step_order: 3 });
    expect(enrollments('sc-add')).toHaveLength(0);
    expect(enrollments('sc-off')).toHaveLength(0);
  });

  test('tags・metadata と同じ batch で書く(まとめて反映される)', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    const result = await applyFriendSync(db, friend, {
      metadata: { redentStore: { customerId: 'c1' } },
      tags: [
        { tag: tagMember, attached: true },
        { tag: tagNextBooking, attached: false },
      ],
      reattach: reattach(),
    });
    expect(result.tagsAdded.map((t) => t.name)).toEqual(['会員']);
    expect(result.reattached).toBe(true);
    expect(attachedTagIds()).toEqual(['tag-member', 'tag-visit']);
    expect(metadataOf()).toEqual({ redentStore: { customerId: 'c1' } });
  });

  test('友だちを消すと reattach の記録も消える(外部キーの連動)', async () => {
    await applyFriendSync(db, friend, { reattach: reattach() });
    sqlite.prepare(`DELETE FROM friends WHERE id = 'friend-1'`).run();
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM friend_sync_reattach`).get() as { n: number }).n,
    ).toBe(0);
  });
});

const reattach = () => ({ tag: tagVisit, key: 'visit-1' });

describe('applyFriendSync — 守りを外すと落ちる同時実行の確認(古い事前読み取りで 2 つ目の要求を流す)', () => {
  test('tags 経路: 同時に届いた 2 つ目の要求は、進行中のシナリオの起点を二重にリセットしない', async () => {
    seedScenario('sc-member', { tagId: 'tag-member' });
    seedEnrollment('fs-1', 'sc-member', 'active');
    const first = await applyFriendSync(db, friend, { tags: [{ tag: tagMember, attached: true }] });
    expect(first.tagsAdded.map((t) => t.name)).toEqual(['会員']);
    const afterFirst = enrollments('sc-member');
    expect(afterFirst[0].started_at).not.toBe(OLD);

    await new Promise((r) => setTimeout(r, 5)); // 2 つ目の起点時刻が確実に違うように
    const second = await applyFriendSync(staleReads(db, { tags: true }), friend, {
      tags: [{ tag: tagMember, attached: true }],
    });

    expect(second.tagsAdded).toEqual([]);
    expect(enrollments('sc-member')).toEqual(afterFirst);
  });

  test('tags 経路: 3 つを同時に流しても、タグが新しく付いたと報告されるのは 1 つだけで、登録は 1 行', async () => {
    seedScenario('sc-member', { tagId: 'tag-member' });
    const results = await Promise.all(
      [0, 1, 2].map(() => applyFriendSync(db, friend, { tags: [{ tag: tagMember, attached: true }] })),
    );
    expect(results.flatMap((r) => r.tagsAdded)).toHaveLength(1);
    expect(attachedTagIds()).toEqual(['tag-member']);
    expect(enrollments('sc-member')).toHaveLength(1);
  });

  test('reattach: 負けの要求は、スタッフが外したタグを付け直さない(タグ INSERT の守り)', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    const winner = await applyFriendSync(db, friend, { reattach: reattach() });
    expect(winner.reattached).toBe(true);
    // 勝ちの確定後に、スタッフが管理画面でタグを外した
    sqlite.prepare(`DELETE FROM friend_tags WHERE friend_id = 'friend-1' AND tag_id = 'tag-visit'`).run();

    const loser = await applyFriendSync(staleReads(db, { reattach: true }), friend, { reattach: reattach() });

    expect(loser.reattached).toBe(false);
    expect(attachedTagIds()).toEqual([]);
  });

  test('reattach: 負けの要求は、完了した登録の代わりに新しい登録を作らない(ステップありの INSERT の守り)', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    await applyFriendSync(db, friend, { reattach: reattach() });
    // 勝ちの登録が、その後すべてのステップを配り終えて完了した
    sqlite.prepare(`UPDATE friend_scenarios SET status = 'completed' WHERE scenario_id = 'sc-visit'`).run();
    const before = enrollments('sc-visit');

    await applyFriendSync(staleReads(db, { reattach: true }), friend, { reattach: reattach() });

    expect(enrollments('sc-visit')).toEqual(before);
  });

  test('reattach: 負けの要求は、ステップ 0 本のシナリオの進行中の登録を完了にしない(UPDATE の守り)', async () => {
    seedScenario('sc-empty', { tagId: 'tag-visit', steps: false });
    await applyFriendSync(db, friend, { reattach: reattach() });
    // 勝ちの後に、別の経路でこの友だちが進行中の登録を持った
    sqlite
      .prepare(`UPDATE friend_scenarios SET status = 'active' WHERE scenario_id = 'sc-empty'`)
      .run();
    const before = enrollments('sc-empty');
    expect(before[0].status).toBe('active');

    await applyFriendSync(staleReads(db, { reattach: true }), friend, { reattach: reattach() });

    expect(enrollments('sc-empty')).toEqual(before);
  });

  test('reattach: 負けの要求は、ステップ 0 本のシナリオに完了済みの行を足さない(INSERT の守り)', async () => {
    seedScenario('sc-empty', { tagId: 'tag-visit', steps: false });
    await applyFriendSync(db, friend, { reattach: reattach() });
    sqlite.prepare(`DELETE FROM friend_scenarios WHERE scenario_id = 'sc-empty'`).run();

    await applyFriendSync(staleReads(db, { reattach: true }), friend, { reattach: reattach() });

    expect(enrollments('sc-empty')).toHaveLength(0);
  });
});

describe('applyFriendSync — 付け直し先のシナリオが送信中(delivering)', () => {
  test('何も書かず(claim も、タグも、metadata も)scenarioBusy を返す', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    seedEnrollment('fs-1', 'sc-visit', 'delivering');
    const result = await applyFriendSync(db, friend, {
      metadata: { redentStore: { customerId: 'c1' } },
      tags: [{ tag: tagMember, attached: true }],
      reattach: reattach(),
    });
    expect(result).toEqual({
      tagsAdded: [],
      tagsRemoved: [],
      reattached: false,
      reattachRemoved: false,
      scenarioBusy: true,
    });
    expect(attachedTagIds()).toEqual([]);
    expect(metadataOf()).toEqual({});
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM friend_sync_reattach`).get() as { n: number }).n).toBe(0);
    expect(enrollments('sc-visit')[0]).toMatchObject({ status: 'delivering', started_at: OLD });
  });

  test('cron が戻した後(active)に同じ key を送り直すと、付け直され起点がリセットされる', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    seedEnrollment('fs-1', 'sc-visit', 'delivering');
    expect((await applyFriendSync(db, friend, { reattach: reattach() })).scenarioBusy).toBe(true);
    sqlite.prepare(`UPDATE friend_scenarios SET status = 'active' WHERE id = 'fs-1'`).run();

    const retry = await applyFriendSync(db, friend, { reattach: reattach() });

    expect(retry.scenarioBusy).toBe(false);
    expect(retry.reattached).toBe(true);
    expect(enrollments('sc-visit')[0]).toMatchObject({ status: 'active', current_step_order: -1 });
    expect(enrollments('sc-visit')[0].started_at).not.toBe(OLD);
  });

  test('対象外の送信中(無効なシナリオ・別のタグのシナリオ・friend_add)では止めない', async () => {
    seedScenario('sc-off', { tagId: 'tag-visit', active: 0 });
    seedScenario('sc-other', { tagId: 'tag-member' });
    seedScenario('sc-add', { trigger: 'friend_add' });
    seedEnrollment('fs-off', 'sc-off', 'delivering');
    seedEnrollment('fs-other', 'sc-other', 'delivering');
    seedEnrollment('fs-add', 'sc-add', 'delivering');
    const result = await applyFriendSync(db, friend, { reattach: reattach() });
    expect(result.scenarioBusy).toBe(false);
    expect(result.reattached).toBe(true);
  });

  test('key が記録済みなら、送信中でも何もせず scenarioBusy でもない(2 回目は変更なし)', async () => {
    seedScenario('sc-visit', { tagId: 'tag-visit' });
    await applyFriendSync(db, friend, { reattach: reattach() });
    sqlite.prepare(`UPDATE friend_scenarios SET status = 'delivering' WHERE scenario_id = 'sc-visit'`).run();
    const again = await applyFriendSync(db, friend, { reattach: reattach() });
    expect(again.scenarioBusy).toBe(false);
    expect(again.reattached).toBe(false);
  });
});

describe('applyFriendSync — 壊れた・オブジェクトでない metadata', () => {
  test.each([
    ['壊れた JSON', 'not json'],
    ['配列', '[1,2]'],
    ['null', 'null'],
    ['文字列', '"x"'],
    ['数値', '5'],
    ['空文字', ''],
  ])('%s → {} から作り直して書く(batch が失敗せず、タグも同じ batch で反映される)', async (_label, raw) => {
    sqlite.prepare(`UPDATE friends SET metadata = ? WHERE id = 'friend-1'`).run(raw);
    const result = await applyFriendSync(db, currentFriend(), {
      metadata: { redentStore: { customerId: 'c1' } },
      tags: [{ tag: tagMember, attached: true }],
    });
    expect(result.tagsAdded.map((t) => t.name)).toEqual(['会員']);
    expect(metadataOf()).toEqual({ redentStore: { customerId: 'c1' } });
  });

  test('オブジェクトの metadata は、他のキーを保ったまま(従来どおり)', async () => {
    sqlite.prepare(`UPDATE friends SET metadata = '{"keep":1}' WHERE id = 'friend-1'`).run();
    await applyFriendSync(db, currentFriend(), { metadata: { redentStore: { a: 1 } } });
    expect(metadataOf()).toEqual({ keep: 1, redentStore: { a: 1 } });
  });
});

describe('applyFriendSync — Object.prototype の名前のキー', () => {
  test('constructor: null は「無いキーの削除」なので何も書かない(冪等・updated_at が進まない)', async () => {
    await applyFriendSync(db, friend, { metadata: { constructor: null } });
    expect(currentFriend().updated_at).toBe(OLD);
    expect(metadataOf()).toEqual({});
  });

  test('toString など継承された名前のキーも、自分のキーとして扱わない', async () => {
    await applyFriendSync(db, friend, { metadata: { toString: null, hasOwnProperty: null } });
    expect(currentFriend().updated_at).toBe(OLD);
  });
});
