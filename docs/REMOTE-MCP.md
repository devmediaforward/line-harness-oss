# リモート MCP（Claude カスタムコネクタ）

Worker は MCP サーバーを内蔵しています。Claude の「カスタムコネクタ」に URL を貼るだけで、LINE Harness のツール一式を使えます（ローカルの設定ファイルは不要です）。

接続方式は2つあります。

| 方式 | コネクタに貼る URL | 認証 | 位置づけ |
| --- | --- | --- | --- |
| API キー方式 | `https://<host>/mcp/<APIキー>` | URL に含めた API キー | 既存方式。移行期間中は残す |
| Descope 方式 | `https://<host>/mcp` | Descope でブラウザログイン（OAuth） | 推奨 |

どちらの方式でも、ツールは **その人の staff の権限（role）** で API を呼びます。

---

## API キー方式（`/mcp/<APIキー>`）

- 管理画面のスタッフ管理で発行した API キーを URL の末尾に付けます。
- URL そのものが認証情報です。URL を共有すると、その人の権限を渡すことになります。
- 設定は不要です（常に有効）。

## Descope 方式（`/mcp`）

### 仕組み

1. Claude が `/mcp` にアクセス → Worker が `401` と `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"` を返す
2. Claude がそのメタデータ（RFC 9728）を読み、Descope のログイン画面を開く
3. ログイン後、Descope が発行したアクセストークン（JWT）で `/mcp` を呼ぶ
4. Worker がトークンを検証する（署名・issuer・audience・有効期限）
5. トークンの `email` クレームと **有効な staff の email** を照合する（大文字小文字は区別しない）
   - ちょうど1人に一致 → その staff の権限でツールを実行
   - 一致なし・2人以上一致・`email` クレームなし → `403 Forbidden`

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

GitHub Actions でデプロイしている場合は、GitHub の Environment（`development` / `production`）の **Variables** に同じ名前で登録します。`.github/workflows/deploy-cloudflare-worker.yml` がデプロイ時に Worker の vars へ書き込みます。未登録の環境でもデプロイは成功し、機能が無効になるだけです。

### Descope コンソールでの設定

1. MCP Server を作成し、**MCP Server URL** に `https://<host>/mcp` を設定する
   - パスは必ず `/mcp` ちょうどにする（Claude 側に「`/mcp` 以外のパスだとログイン後に繋がらない」既知の不具合があります: anthropics/claude-ai-mcp#878）
   - この値がアクセストークンの `aud` になり、Worker は `https://<host>/mcp` と一致するかを検証します
2. **セルフサインアップをブロック**する（誰でもアカウントを作れる状態にしない）
3. 使う人を **ユーザーとして招待** する
4. Descope ユーザーの email を、LINE Harness の **staff の email と一致** させる（有効な staff で、同じ email の staff が複数いないこと）
5. アクセストークンに `email` クレームが入っているか確認する。入っていない場合は、Consent Flow の **Custom Claims** で `email` を追加する（無いと必ず `403` になります）

### Claude への接続手順

1. Claude の設定 → コネクタ → **カスタムコネクタを追加**
2. URL に `https://<host>/mcp` を入力して追加
3. 「連携」を押すとブラウザで Descope のログイン画面が開くので、招待されたアカウントでログインする
4. Claude に戻り、ツールが一覧に出ていれば完了

### うまくいかないとき

| 症状 | 確認すること |
| --- | --- |
| `/mcp` が `404` | `DESCOPE_MCP_ISSUER` と `DESCOPE_JWKS_URL` が両方デプロイされているか |
| ログイン後も `401` | MCP Server URL が `https://<host>/mcp` ちょうどか / issuer の値がコンソールの値と一字一句同じか |
| `403` | トークンに `email` があるか / その email の有効な staff がちょうど1人か |
