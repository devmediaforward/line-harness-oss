# リモート MCP（Claude カスタムコネクタ）

Worker は MCP サーバーを内蔵しています。Claude の「カスタムコネクタ」に URL を貼るだけで、LINE Harness のツール一式を使えます（ローカルの設定ファイルは不要です）。

接続方式は2つあります。

| 方式 | コネクタに貼る URL | 認証 | 位置づけ |
| --- | --- | --- | --- |
| API キー方式 | `https://<host>/mcp/<APIキー>` | URL に含めた API キー | 既存方式。移行期間中は残す |
| Descope 方式 | `https://<host>/mcp` | Descope でブラウザログイン（OAuth） | 推奨 |

どちらの方式でも、ツールは **その人の staff の権限（role）** で API を呼びます（例外: Dev で `DESCOPE_MCP_ALLOW_ANY_USER` を有効にしている場合、Descope 方式で staff と一致しなかった人は owner 権限になります。下記参照）。

---

## API キー方式（`/mcp/<APIキー>`）

- 管理画面のスタッフ管理で発行した API キーを URL の末尾に付けます。
- URL そのものが認証情報です。URL を共有すると、その人の権限を渡すことになります。
- 設定は不要です（常に有効）。

## Descope 方式（`/mcp`）

### 仕組み

1. Claude が `/mcp` にアクセス → Worker が `401` と `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp", scope="openid"` を返す
2. Claude がそのメタデータ（RFC 9728）を読み、Descope のログイン画面を開く
   - 要求するスコープは Worker が `scope="openid"`（メタデータの `scopes_supported` も同じ）で指定します。指定していなかった頃は、claude.ai が Descope のログイン画面に届く前に「認証に失敗しました」で戻されていました。Descope のメタデータにあるスコープ（`profile` / `email` / `phone` など）を要求していたと見られ、Descope はこれらを `invalid_scope` で拒否します（MCP Server に独自スコープが無い Descope が受け付けるのは `openid` と `offline_access` だけ。`offline_access` は Claude が自分で足します）
3. ログイン後、Descope が発行したアクセストークン（JWT）で `/mcp` を呼ぶ
4. Worker がトークンを検証する（署名・issuer・audience・有効期限）
   - 受け付ける `iss`: `DESCOPE_MCP_ISSUER` そのもの、またはそのプロジェクトの issuer（`DESCOPE_MCP_ISSUER` と同じドメインの `/v1/apps/<ProjectID>`。例: `https://api.descope.com/v1/apps/<ProjectID>`）のどちらか。どちらも一字一句一致したときだけ通します（この2つと表記が違う `iss`、たとえば別の MCP Server ID・テナント形式・別ドメイン・末尾スラッシュ付きは不可）
   - 受け付ける `aud`: `https://<host>/mcp`、または Descope の **ProjectID** のどちらかを含むこと
   - 理由: Descope のアクセストークンは `aud` に ProjectID が入り、`iss` も MCP Server の issuer とプロジェクトの issuer のどちらで発行されるかが発行経路によって変わります（どちらも同じプロジェクトの鍵で署名されます）。`https://<host>/mcp` だけを `aud` として求めていた頃は、Descope でのログインと同意が成功しても接続できませんでした（Descope 公式の接続例 FastMCP `DescopeProvider` も `aud` = ProjectID で検証しています）
   - ProjectID は `DESCOPE_MCP_ISSUER` から読み取ります（`/v1/apps/agentic/<ProjectID>/<MCPServerID>` か `/v1/apps/<ProjectID>` の形のときだけ）。読み取れない形なら、これまでどおり `DESCOPE_MCP_ISSUER` ちょうどの `iss` と `https://<host>/mcp` の `aud` だけを受け付けます
   - **注意（トレードオフ）**: 同じ Descope プロジェクトの鍵で署名され `aud` が ProjectID のトークンなら、この MCP Server 以外の用途（そのプロジェクトの別アプリなど）で発行されたものでも通ります。**この MCP Server 専用の Descope プロジェクトを使ってください**（他のアプリと同じプロジェクトを共用しない）
5. トークンの `email` クレームと **有効な staff の email** を照合する（大文字小文字は区別しない）
   - ちょうど1人に一致 → その staff の権限でツールを実行
   - 一致なし・2人以上一致・`email` クレームなし → `403 Forbidden`（Dev で `DESCOPE_MCP_ALLOW_ANY_USER` を有効にしている場合だけ、owner 権限で実行。下記参照）

メタデータは次の3か所で同じ内容を返します。

- `/.well-known/oauth-protected-resource/mcp`（RFC 9728 の正規の位置）
- `/.well-known/oauth-protected-resource`
- `/mcp/.well-known/oauth-protected-resource`（Descope ドキュメント記載の位置）

### 必要な Worker vars

どちらも公開値です（シークレットではありません）。**2つとも設定したときだけ有効**になり、未設定なら `/mcp` とメタデータは `404` を返します。

| 名前 | 値 |
| --- | --- |
| `DESCOPE_MCP_ISSUER` | `https://api.descope.com/v1/apps/agentic/<ProjectID>/<MCPServerID>` |
| `DESCOPE_JWKS_URL` | `https://api.descope.com/<ProjectID>/.well-known/jwks.json` |
| `DESCOPE_MCP_ALLOW_ANY_USER` | 任意・**Dev 専用**。`true` のときだけ有効（下記参照）。本番では設定しない |
| `DEPLOY_ENVIRONMENT` | 登録不要。ワークフローがデプロイのたびに `development` / `production` を自動で書き込みます |

GitHub Actions でデプロイしている場合は、GitHub の Environment（`development` / `production`）の **Variables** に同じ名前で登録します。`.github/workflows/deploy-cloudflare-worker.yml` がデプロイ時に Worker の vars へ書き込みます。未登録の環境でもデプロイは成功し、機能が無効になるだけです。

#### `DESCOPE_MCP_ALLOW_ANY_USER`（Dev 専用）

値がちょうど `true` で（`TRUE` や `1` は無効扱い）、かつ `DEPLOY_ENVIRONMENT` がちょうど `development` のとき、トークンの検証に成功したのに staff とちょうど1人に一致しなかった人（`email` クレームなし・一致なし・2人以上一致・`email_verified` が `false` を含む）を、`403` ではなく **Worker の `API_KEY`（owner）の権限** で通します。staff と一致した人は、これまでどおりその staff の権限で動きます。トークンが無い・不正なときの `401` は変わりません。`API_KEY` が未設定なら `403` のままです。

- **リスク**: Descope のセルフサインアップを許可していると、URL を知っていれば誰でも Descope に登録してログインでき、Dev の LINE アカウントから友だちへのメッセージ送信・一斉配信まで owner 権限で実行できます。テスト用の Dev 環境だけで使ってください。
- **本番では使えません**: `production` 環境（`main` ブランチ）のデプロイでこの Variable が設定されていると、ワークフローはエラーで停止します（Repository の Variables に登録した場合も同じです）。さらに実行時にも Worker 自身が `DEPLOY_ENVIRONMENT` を確認し、`development` 以外（`production`・未設定・その他の値）では、Cloudflare の Secret などで誤って `true` が入っていても `403` を返します。
- `DEPLOY_ENVIRONMENT` は `.github/workflows/deploy-cloudflare-worker.yml` がデプロイのたびに書き込みます（`main` なら `production`、それ以外は `development`）。有効になるのは `development` のときだけです。
- `wrangler dev` などでローカルで試す場合は、`.dev.vars` に `DESCOPE_MCP_ALLOW_ANY_USER=true` と一緒に `DEPLOY_ENVIRONMENT=development` も書いてください（無いと `403` になります）。
- 既定は無効です。Variable を削除して再デプロイすると無効に戻ります。

### Descope コンソールでの設定

1. MCP Server を作成し、**MCP Server URL** に `https://<host>/mcp` を設定する
   - パスは必ず `/mcp` ちょうどにする（Claude 側に「`/mcp` 以外のパスだとログイン後に繋がらない」既知の不具合があります: anthropics/claude-ai-mcp#878）
   - Worker はアクセストークンの `aud` に `https://<host>/mcp` か ProjectID のどちらかが入っているかを検証します（上の「仕組み」の 4. 参照）
2. **セルフサインアップをブロック**する（誰でもアカウントを作れる状態にしない）
3. 使う人を **ユーザーとして招待** する
4. Descope ユーザーの email を、LINE Harness の **staff の email と一致** させる（有効な staff で、同じ email の staff が複数いないこと）
5. アクセストークンに `email` クレームが入っているか確認する。入っていない場合は、Consent Flow の **Custom Claims** で `email` を追加する（無いと `403` になります。Dev で `DESCOPE_MCP_ALLOW_ANY_USER` を有効にしている場合だけは owner 権限で通ります）

### Claude への接続手順

1. Claude の設定 → コネクタ → **カスタムコネクタを追加**
2. URL に `https://<host>/mcp` を入力して追加
3. 「連携」を押すとブラウザで Descope のログイン画面が開くので、招待されたアカウントでログインする
4. Claude に戻り、ツールが一覧に出ていれば完了

### うまくいかないとき

| 症状 | 確認すること |
| --- | --- |
| `/mcp` が `404` | `DESCOPE_MCP_ISSUER` と `DESCOPE_JWKS_URL` が両方デプロイされているか |
| 「連携」を押すとログイン画面が出ずにすぐ「認証に失敗しました」 | `401` の `WWW-Authenticate` に `scope="openid"` があるか。Descope の MCP Server にフロー `inbound-apps-user-consent` があるか |
| ログイン後も `401` | MCP Server URL が `https://<host>/mcp` ちょうどか / issuer の値がコンソールの値と一字一句同じか（`/v1/apps/agentic/<ProjectID>/<MCPServerID>` の形で、末尾スラッシュなし） |
| `403` | トークンに `email` があるか / その email の有効な staff がちょうど1人か |
