#!/usr/bin/env node
// =============================================================================
// 診断シード投入スクリプト (P7a)
//
// packages/db/seeds/redent-diagnosis.json などの診断定義を、Worker の管理 API
// 経由で投入する運用者向け CLI。
//
//   - 依存追加なし。Node 22 の組み込み fetch / node:util parseArgs を使う。
//   - 認証は Bearer トークン。apps/worker/src/middleware/auth.ts の
//     authenticateApiToken が、Authorization: Bearer <token> の token を staff
//     API キー → env API_KEY(owner) の順で照合する。ここでは env の API_KEY を
//     送る。Bearer 認証は CSRF 対象外(同 middleware)なので追加ヘッダは不要。
//
// これは手動で叩く CLI であり、Vercel/Supabase のログ面ではないため console
// 出力を行う(委譲プロンプトで明示的に許可された例外)。
//
// 使い方:
//   WORKER_URL=https://your-worker.example.workers.dev \
//   API_KEY=xxxxxxxx \
//   node scripts/seed-diagnosis.mjs [options]
//
// options:
//   --file <path>   投入する定義 JSON (default: packages/db/seeds/redent-diagnosis.json)
//   --name <name>   診断名               (default: "Re'Dent 清潔感診断")
//   --slug <slug>   スラッグ             (default: "redent-cleanliness")
//   --update        既存の診断があれば definition を更新する(無指定なら作成のみ)
//   --help, -h      このヘルプを表示
//
// 挙動:
//   GET /api/diagnoses で同 slug の存在を確認し、
//     - 無ければ POST /api/diagnoses で作成
//     - 有れば(--update 無し)何もせず終了
//     - 有れば(--update 有り)PUT /api/diagnoses/:id で definition のみ更新
//
// リポジトリのルートで実行してください(--file の既定パスが相対のため)。
// =============================================================================

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { parseArgs } from 'node:util';

const DEFAULT_FILE = 'packages/db/seeds/redent-diagnosis.json';
const DEFAULT_NAME = "Re'Dent 清潔感診断";
const DEFAULT_SLUG = 'redent-cleanliness';

function fail(message) {
  stderr.write(`error: ${message}\n`);
  exit(1);
}

function printHelp() {
  stdout.write(
    [
      '診断シード投入スクリプト',
      '',
      '使い方:',
      '  WORKER_URL=<worker url> API_KEY=<api key> \\',
      '    node scripts/seed-diagnosis.mjs [options]',
      '',
      'options:',
      `  --file <path>   投入する定義 JSON (default: ${DEFAULT_FILE})`,
      `  --name <name>   診断名           (default: "${DEFAULT_NAME}")`,
      `  --slug <slug>   スラッグ         (default: "${DEFAULT_SLUG}")`,
      '  --update        既存があれば definition を更新する',
      '  --help, -h      このヘルプを表示',
      '',
    ].join('\n'),
  );
}

// ── 引数 ─────────────────────────────────────────────────────────────────────
let parsed;
try {
  parsed = parseArgs({
    args: argv.slice(2),
    options: {
      file: { type: 'string' },
      name: { type: 'string' },
      slug: { type: 'string' },
      update: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
} catch (e) {
  fail(e.message);
}

const opts = parsed.values;

if (opts.help) {
  printHelp();
  exit(0);
}

const filePath = resolve(opts.file ?? DEFAULT_FILE);
const name = opts.name ?? DEFAULT_NAME;
const slug = opts.slug ?? DEFAULT_SLUG;

// ── 環境変数 ─────────────────────────────────────────────────────────────────
const workerUrl = (env.WORKER_URL ?? '').trim().replace(/\/+$/, '');
const apiKey = (env.API_KEY ?? '').trim();
if (!workerUrl) fail('WORKER_URL 環境変数が未設定です');
if (!apiKey) fail('API_KEY 環境変数が未設定です');

// ── 定義 JSON 読み込み ───────────────────────────────────────────────────────
let definition;
try {
  definition = JSON.parse(readFileSync(filePath, 'utf8'));
} catch (e) {
  fail(`定義ファイルを読み込めません (${filePath}): ${e.message}`);
}

// ── API ヘルパー ─────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${workerUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`リクエストに失敗しました (${method} ${path}): ${e.message}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { res, payload };
}

function reportApiError(label, res, payload) {
  const parts = [`${label}に失敗しました (HTTP ${res.status})`];
  if (payload && typeof payload.error === 'string') parts.push(payload.error);
  if (payload && Array.isArray(payload.errors) && payload.errors.length > 0) {
    parts.push(JSON.stringify(payload.errors));
  }
  if (payload && typeof payload.raw === 'string' && payload.raw.trim()) {
    parts.push(payload.raw.trim());
  }
  fail(parts.join(' — '));
}

// ── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  // 既存確認: GET /api/diagnoses は一覧(id, name, slug, ...)を返す(definition は含まない)。
  const list = await api('GET', '/api/diagnoses');
  if (!list.res.ok || list.payload?.success !== true) {
    reportApiError('診断一覧の取得', list.res, list.payload);
  }
  const items = Array.isArray(list.payload.data) ? list.payload.data : [];
  const existing = items.find((it) => it && it.slug === slug);

  if (!existing) {
    // 新規作成
    const created = await api('POST', '/api/diagnoses', { name, slug, definition });
    if (!created.res.ok || created.payload?.success !== true) {
      reportApiError('診断の作成', created.res, created.payload);
    }
    const id = created.payload.data?.id ?? '(unknown)';
    stdout.write(`created: id=${id} slug=${slug} name=${name}\n`);
    return;
  }

  if (!opts.update) {
    stdout.write(
      `既存あり (id=${existing.id}, slug=${slug})。` +
        `--update を付けると definition を更新できます。\n`,
    );
    return;
  }

  // 更新(definition のみ)
  const updated = await api('PUT', `/api/diagnoses/${existing.id}`, { definition });
  if (!updated.res.ok || updated.payload?.success !== true) {
    reportApiError('診断の更新', updated.res, updated.payload);
  }
  stdout.write(`updated: id=${existing.id} slug=${slug}\n`);
}

main().catch((e) => fail(e.message));
