# Dev / Prod 2環境セットアップガイド（Cloudflare + GitHub Environments）

fork した LINE Harness を、**開発（dev）と本番（prod）の2環境**に分けて運用するための初期構築手順です。エンジニアでなくても進められるよう、コピペできるコマンドと設定表を用意しています。

---

## 全体像

```text
develop ブランチに push  ──▶  GitHub Actions  ──▶  Cloudflare（dev 環境）
main    ブランチに push  ──▶  GitHub Actions  ──▶  Cloudflare（prod 環境）
```

- 1つの Cloudflare アカウントの中に、**dev 用リソース**と **prod 用リソース**を分けて作ります。
- GitHub の **Environments**（`development` / `production`）に、**同じ名前の Secrets / Variables を別々の値**で登録します。
- ワークフローは push 先ブランチを見て、自動で環境を選びます（`main` → `production`、それ以外＝`develop` → `development`）。ワークフロー側の設定名は dev/prod で共通なので、値だけを環境ごとに変えれば動きます。

対象ワークフロー:

| ファイル | 役割 | 環境 |
| --- | --- | --- |
| `.github/workflows/deploy-cloudflare-worker.yml` | Worker + LIFF のデプロイ、D1 マイグレーション適用 | `main`→production / `develop`→development |
| `.github/workflows/deploy-cloudflare-admin.yml` | 管理画面（Cloudflare Pages）のデプロイ | `main`→production / `develop`→development |
| `.github/workflows/worker-ci.yml` | PR / push 時の lint・型・テスト・ビルド検証 | 環境なし（検証のみ） |

---

## 事前に必要なもの

- fork 済みの GitHub リポジトリ（`your-name/line-harness-oss`）
- Cloudflare アカウント（1つでOK）
- ローカルに Node.js 22 以上と `pnpm`、`npx wrangler`（`pnpm install` 済みなら使えます）

---

## Step 1. GitHub に Environments を2つ作る

1. GitHub でリポジトリを開く
2. **Settings → Environments** を開く
3. **New environment** をクリックし、名前を `production` にして作成
4. 同じ手順でもう1つ `development` を作成

> 名前は **`production` と `development`**（小文字）で作ってください。ワークフローがこの名前で環境を選びます。

（任意）`production` 環境には **Required reviewers**（承認者）や **Deployment branches**（`main` のみ許可）などの保護ルールを付けると、本番への誤デプロイを防げます。設定しなくても動きます。

---

## Step 2. デプロイ有効化フラグをリポジトリ変数に登録する（重要）

デプロイを動かすためのスイッチ `LINE_HARNESS_CLOUDFLARE_DEPLOY` は、**Environment ではなくリポジトリ全体の Variable** として登録します。

1. **Settings → Secrets and variables → Actions → Variables** タブ
2. **New repository variable**
3. 名前 `LINE_HARNESS_CLOUDFLARE_DEPLOY`、値 `true`

> **なぜリポジトリ変数なのか**
> ワークフローの `if:` 判定（デプロイ可否のガード）は、ジョブがランナーで動き始める**前**に評価されます。Environment に紐づく変数はジョブ開始**後**に読み込まれるため、`if:` の中では読めません。ガード用のこの変数だけはリポジトリ全体に置く必要があります。dev/prod で値を変える他の設定は、次の Step で Environment 側に入れます。

---

## Step 3. Cloudflare 側のリソースを作る

`npx wrangler login` でログインしてから、dev/prod 用のリソースを作ります。作成時に表示される **ID や名前を控えておいてください**（後で GitHub に登録します）。

### D1 データベース（×2：dev と prod）

```bash
# dev 用
npx wrangler d1 create line-harness-dev
# prod 用
npx wrangler d1 create line-harness
```

実行すると `database_name` と `database_id` が表示されます。両方の値をメモします。

- Worker は D1 を `DB` バインディングで参照します（`apps/worker/wrangler.toml`）。
- GitHub Actions のデプロイは、この `database_name` / `database_id` を Environment の Secrets から読み込んで、デプロイ設定に反映します。dev の push は dev の D1 に、prod の push は prod の D1 にマイグレーションを適用します。

### R2 バケット（×1 または ×2）

Worker は画像などを R2 の `IMAGES` バインディング（バケット名 `line-harness-images`）で扱います。

- **おすすめ（シンプル）: 1バケット共用**
  ```bash
  npx wrangler r2 bucket create line-harness-images
  ```
  デプロイワークフローは R2 バケット名を書き換えないため、dev/prod は既定でこの同じバケットを使います。画像キーは UUID を含むので取り違えは起きにくく、まずはこの構成で十分です。

- **（任意・上級）dev/prod で完全分離したい場合: 2バケット**
  dev 用に別バケット（例 `line-harness-images-dev`）を作り、`apps/worker/wrangler.toml` の `bucket_name` を環境ごとに変える改修が必要です。現状のワークフローはバケット名を環境変数で差し替えないため、ソース側の対応が前提になります。まずは 1バケット共用で始めることを推奨します。

### Cloudflare Pages（×2：管理画面 dev と prod）

管理画面（`apps/web`）は Cloudflare Pages にデプロイします。dev/prod で別プロジェクトにします。

```bash
# dev 用
npx wrangler pages project create line-harness-admin-dev --production-branch main
# prod 用
npx wrangler pages project create line-harness-admin --production-branch main
```

作成したプロジェクト名を控えます（GitHub の `PAGES_PROJECT_NAME` に使います）。

> セットアップ CLI `npx create-line-harness@latest` を使うと、D1 / R2 / Worker / Pages をまとめて作れます（`docs/FORK_CLOUDFLARE_WORKFLOW.md` 参照）。その場合も、できたリソースを dev / prod のどちらに割り当てるかを決めて、以下の GitHub 設定に反映してください。

---

## Step 4. 各 Environment に Secrets を登録する

**Settings → Environments → `development`（または `production`）→ Environment secrets → Add secret** から、下の表の名前で登録します。**同じ名前**を両方の環境に作り、**値だけ**を dev/prod で変えます。

| Secret 名 | 用途 | dev の値（例） | prod の値（例） |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions が Cloudflare にデプロイするための API トークン | （同一アカウントなら dev/prod 同じ値で可） | （同上） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID | 同一アカウントなので dev/prod 同じ | 同じ |
| `D1_DATABASE_NAME` | 使う D1 の名前 | `line-harness-dev` | `line-harness` |
| `D1_DATABASE_ID` | 使う D1 の ID | （dev D1 の id） | （prod D1 の id） |
| `NEXT_PUBLIC_API_URL` | 管理画面から呼ぶ Worker API の URL | `https://line-harness-dev.<subdomain>.workers.dev` | `https://line-harness.<subdomain>.workers.dev` |

> `NEXT_PUBLIC_API_URL` と `D1_DATABASE_NAME` / `D1_DATABASE_ID` は秘密の値ではありませんが、ワークフローが Secrets から読み込む作りのため Secrets に入れます。
> `D1_DATABASE_NAME` / `D1_DATABASE_ID` は **dev には dev の D1、prod には prod の D1** を必ず指定してください。取り違えると、マイグレーションが意図しない DB に適用されます。

---

## Step 5. 各 Environment に Variables を登録する

**Settings → Environments → `development` / `production` → Environment variables → Add variable** から登録します。こちらも**同じ名前で値だけ**を変えます。

| Variable 名 | 用途 | dev の値（例） | prod の値（例） |
| --- | --- | --- | --- |
| `WORKER_NAME` | デプロイする Worker 名 | `line-harness-dev` | `line-harness` |
| `PAGES_PROJECT_NAME` | 管理画面 Pages のプロジェクト名 | `line-harness-admin-dev` | `line-harness-admin` |
| `VITE_LIFF_ID` | LIFF ID | （dev の LIFF ID） | （prod の LIFF ID） |
| `VITE_BOT_BASIC_ID` | LINE bot basic ID（`@` 付き） | （dev の bot） | （prod の bot） |
| `ADMIN_ORIGIN` | 管理画面のオリジン（CORS 用） | `https://line-harness-admin-dev.pages.dev` | `https://line-harness-admin.pages.dev` |
| `WORKER_URL` | Worker の公開 URL（共有ページの base、デプロイ設定への反映に使用） | `https://line-harness-dev.<subdomain>.workers.dev` | `https://line-harness.<subdomain>.workers.dev` |
| `VITE_CALENDAR_CONNECTION_ID` | （任意）Google カレンダー連携を使う場合のみ | （必要なら設定） | （必要なら設定） |
| `ADMIN_ALLOW_CROSS_SITE` | （任意）管理画面と API が別オリジンのときの cookie 設定。未設定なら `true` 扱い | `true` | `true` |

> **CI（worker-ci.yml）について**: このワークフローは環境を使わない（検証専用）ため、上の Environment 変数は読み込みません。CI のビルドでは `VITE_*` が空のままビルドされますが、CI はデプロイしないので問題ありません。CI でも実際の値でビルド検証したい場合は、同名の変数を**リポジトリ変数**にも登録すると CI がそちらを参照します（デプロイ時は Environment 側の値が優先されます）。

---

## Step 6. Worker の Secrets を dev/prod 両方に登録する

LINE のトークンなどは GitHub ではなく Cloudflare 側（Worker）に `wrangler secret put` で設定します。dev/prod は別の Worker（`--name` で区別）なので、**両方に同じ名前で、それぞれの値**を登録します。

登録する Secret 一覧:

| Secret 名 | 内容 |
| --- | --- |
| `API_KEY` | 管理 API 用のオーナートークン（シード投入スクリプトでも使用） |
| `LINE_CHANNEL_SECRET` | Messaging API チャネルシークレット |
| `LINE_CHANNEL_ACCESS_TOKEN` | Messaging API チャネルアクセストークン |
| `LINE_CHANNEL_ID` | Messaging API チャネル ID |
| `LINE_LOGIN_CHANNEL_ID` | LINE ログインチャネル ID |
| `LINE_LOGIN_CHANNEL_SECRET` | LINE ログインチャネルシークレット |
| `LIFF_URL` | LIFF の URL |

コマンド例（`--name` でデプロイ先 Worker と揃えます。名前は Step 5 の `WORKER_NAME` と同じにします）:

```bash
# dev 用（Worker 名 = line-harness-dev）
npx wrangler secret put API_KEY --name line-harness-dev
npx wrangler secret put LINE_CHANNEL_SECRET --name line-harness-dev
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --name line-harness-dev
npx wrangler secret put LINE_CHANNEL_ID --name line-harness-dev
npx wrangler secret put LINE_LOGIN_CHANNEL_ID --name line-harness-dev
npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET --name line-harness-dev
npx wrangler secret put LIFF_URL --name line-harness-dev

# prod 用（Worker 名 = line-harness）
npx wrangler secret put API_KEY --name line-harness
npx wrangler secret put LINE_CHANNEL_SECRET --name line-harness
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --name line-harness
npx wrangler secret put LINE_CHANNEL_ID --name line-harness
npx wrangler secret put LINE_LOGIN_CHANNEL_ID --name line-harness
npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET --name line-harness
npx wrangler secret put LIFF_URL --name line-harness
```

> `wrangler secret put` は対象 Worker が Cloudflare 上に存在してから実行できます。先に一度デプロイ（Step 7）してから Secrets を入れ、もう一度デプロイすると確実です。

---

## Step 7. デプロイと動作確認

1. `develop` ブランチに push すると、dev 環境へデプロイされます（初回は D1 マイグレーションも走ります）。
2. 問題なければ `main` に反映すると、prod 環境へデプロイされます。
3. GitHub の **Actions** タブでワークフローの成否を確認できます。

---

## Step 8. 診断シードを投入する

診断（例：Re'Dent 清潔感診断）の定義を、管理 API 経由で Worker に登録するスクリプトです。**リポジトリのルート**で実行します。

必要な環境変数:

- `WORKER_URL` … 対象 Worker の URL（dev なら dev の URL、prod なら prod の URL）
- `API_KEY` … Step 6 で設定した `API_KEY` と同じ値

新規作成（同じ slug がまだ無ければ作成、あれば何もしません）:

```bash
# dev に投入する例
WORKER_URL="https://line-harness-dev.<subdomain>.workers.dev" \
API_KEY="（dev の API_KEY）" \
node scripts/seed-diagnosis.mjs
```

既存の診断の定義を更新したいとき（`--update` を付ける）:

```bash
WORKER_URL="https://line-harness-dev.<subdomain>.workers.dev" \
API_KEY="（dev の API_KEY）" \
node scripts/seed-diagnosis.mjs --update
```

オプション:

| オプション | 説明 | 既定値 |
| --- | --- | --- |
| `--file <path>` | 投入する定義 JSON | `packages/db/seeds/redent-diagnosis.json` |
| `--name <name>` | 診断名 | `Re'Dent 清潔感診断` |
| `--slug <slug>` | スラッグ | `redent-cleanliness` |
| `--update` | 既存があれば `definition` を更新 | （無指定なら作成のみ） |
| `--help`, `-h` | ヘルプ表示 | — |

- 成功すると、作成された診断の `id` などが表示されます。
- 失敗（環境変数の未設定、API エラーなど）のときは終了コードが 0 以外になります。

---

## 補足：安全対策のしくみ

- **同時デプロイの防止**: 各デプロイワークフローに `concurrency`（`deploy-worker-${{ github.ref }}` / `deploy-admin-${{ github.ref }}`）を設定しています。同じブランチ（＝同じ環境）へのデプロイが重ならないよう直列化されます。dev と prod は別ブランチなので互いをブロックしません。
- **本番の取り違え防止**: D1 の `DATABASE_NAME` / `DATABASE_ID` は Environment ごとに設定します。dev の push が prod DB に触れることはありません。
- **デプロイの停止**: `LINE_HARNESS_CLOUDFLARE_DEPLOY` を `false` にすると、両環境のデプロイを止められます。

---

## 参考

- fork とアップストリーム取り込みの運用は `docs/FORK_CLOUDFLARE_WORKFLOW.md` を参照してください（本ドキュメントはその dev/prod 2環境版です）。
