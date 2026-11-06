# oura-remote-mcp（日本語版）

[English](README.md) | 日本語

> この日本語版は、英語版 [README.md](README.md) をわかりやすく書き直したものです。
> 内容が食い違っていたら英語版が正です。

## これは何？

**Oura リングのデータを Claude から読めるようにする、自分専用のサーバー**です。

Claude（ブラウザ版・スマホアプリ・デスクトップアプリ・Claude Code）に
「昨夜の睡眠はどうだった？」「今週の回復度の推移は？」と聞くと、
Claude がこのサーバー経由で Oura の公式 API（v2）からデータを取ってきて答えます。

- **自分 1 人だけ**が使えます。他人は接続できません。
- **読み取り専用**です。Oura のデータを書き換えることはできません。
- Oura 社とは無関係の個人プロジェクトです。医療機器ではありません。

## できること

Claude が使える道具（ツール）は 5 つです。すべて読み取りだけです。

| ツール | 何がわかるか | Oura の権限 |
|---|---|---|
| `oura_status` | Oura と連携済みか、鍵の有効期限、許可されている権限 | なし |
| `get_sleep` | 夜ごとの就寝・起床時刻、睡眠時間、睡眠効率、寝つくまでの時間、睡眠段階、平均 HRV、最低・平均心拍 | `daily` |
| `get_sleep_scores` | 毎日の睡眠スコアと、その内訳 | `daily` |
| `get_readiness` | 毎日の回復度（Readiness）スコアと内訳（安静時心拍、HRV バランス、体温など） | `daily` |
| `get_heart_rate` | 1 時間ごとの最低・平均・最高心拍（一度に最大 3 日分） | `heartrate` |

**Oura の API のクセはサーバー側で吸収しています。**
- 睡眠データの終了日は「その日を含まない」扱いです。1 日広げて取得し、指定範囲に絞り直しています。
- 1 日に複数の睡眠（本睡眠・昼寝・休息）が返ってきます。通常は本睡眠だけを返し、
  `include_all_periods: true` を付けたときだけ全部返します。

## 仕組み

```
Claude ──(鍵 1: Claude → このサーバー)──▶ このサーバー ──(鍵 2: サーバー → Oura)──▶ Oura API
                                              │
                          GitHub ログイン = 本人確認（許可した 1 アカウントだけ）
                                              │
                               鍵 2 の保管庫（暗号化して保存）
```

鍵は 2 種類あります。
- **鍵 1（Claude → このサーバー）:** あなたの Claude だけが接続できるようにするための鍵。
  接続するときに GitHub でログインし、許可したアカウントだったときだけ発行されます。
- **鍵 2（このサーバー → Oura）:** サーバーがあなたの Oura データを読むための鍵。
  最初に 1 回だけ Oura で「許可」を押すと発行され、暗号化して保管されます。

動いている場所は Cloudflare Workers です（自宅の PC を起動しておく必要はありません）。

## 安全のための設計（要点）

詳しくは [SECURITY.md](SECURITY.md)（英語）にまとめています。各項目にテストがあります。

- **健康データは保存しません。** 保存するのは Oura の鍵だけで、それも暗号化しています。
- **ログに秘密や健康データを残しません。** トークン・秘密鍵・睡眠データなどはログに出ないようにしています。
- **本人確認は 2 重です。** GitHub の数字の ID（変更できない）と、ユーザー名の両方が一致したときだけ通します。
- **Oura への権限は最小限です。** `daily` と `heartrate` だけで、書き込みの権限はありません。
- **乱用を防ぎます。** 同じ IP アドレスからは 1 分に 60 回まで。別のドメイン名や、
  他のサイトのページからの呼び出しは拒否します。
- **緊急停止スイッチがあります。** 1 つのコマンドで全リクエストを止められます（下の「困ったとき」参照）。

## セットアップ（最初の 1 回だけ）

Windows の PowerShell でもそのまま動くように書いています。
`<base>` は手順 2 で決める公開 URL（例: `https://oura-remote-mcp.xxxx.workers.dev`）に置き換えてください。

### 0. 必要なもの
- **Node.js:** 22.18 以上、または 24.11 以上（23 と 25 は使えません）
- **アカウント:** Cloudflare、GitHub、Oura（API の利用にはメンバーシップが必要です）

### 1. 取得とインストール
```bash
git clone https://github.com/bosatsu25/oura-remote-mcp.git
cd oura-remote-mcp
npm ci
```
`npm install` ではなく `npm ci` を使ってください（記録済みのバージョンをそのまま入れます）。

### 2. 公開 URL を決める
`https://oura-remote-mcp.<あなたのサブドメイン>.workers.dev`（または独自ドメイン）。
決めた URL を `wrangler.jsonc` の `vars.PUBLIC_BASE_URL` に書きます。末尾に `/` は付けません。

### 3. GitHub OAuth App を作る（本人確認用）
GitHub → Settings → Developer settings → OAuth Apps → New OAuth App。
- **Homepage URL:** `<base>`
- **Authorization callback URL:** `<base>/callback`
- **Client ID:** 控えておきます。
- **Client secret:** 「Generate a new client secret」で作って控えます。

自分の GitHub の**数字の ID**を調べて、`wrangler.jsonc` の `vars.ALLOWED_GITHUB_USER_ID` に書きます。
```powershell
# PowerShell
(Invoke-RestMethod https://api.github.com/users/<GitHubのユーザー名>).id
```
```bash
# bash / macOS（jq が必要）
curl https://api.github.com/users/<GitHubのユーザー名> | jq .id
```
`vars.ALLOWED_GITHUB_LOGIN` には GitHub のユーザー名を書きます。

### 4. Oura のアプリを登録する
https://developer.ouraring.com/applications → New application。
- **Redirect URI:** `<base>/oura/callback`
- **Client ID と Client Secret:** 控えておきます。
- **権限（scope）:** このサーバーが使うのは `daily` と `heartrate` だけです。

### 5. Cloudflare の準備と、秘密情報の登録
`wrangler`（Cloudflare のコマンド）はこのプロジェクトに入っているので、`npx` を付けて使います。
```bash
npx wrangler login
npx wrangler kv namespace create OAUTH_KV
```
2 行目で表示された `id` を、`wrangler.jsonc` の `kv_namespaces` の `id` に貼り付けます。

次に、暗号化用の鍵を作ってから、秘密情報を 1 つずつ登録します（それぞれ値を聞かれるので貼り付けます）。
```bash
npm run keygen
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put OURA_CLIENT_ID
npx wrangler secret put OURA_CLIENT_SECRET
```
- **`TOKEN_ENCRYPTION_KEY`:** `npm run keygen` で表示された文字列を貼ります。
- **GitHub と Oura の 4 つ:** 手順 3・4 で控えた値を貼ります。
- **取り扱い:** これらの値はファイルに保存したりチャットに貼ったりしないでください。

### 6. デプロイと動作確認、Oura との連携
```bash
npm run typecheck
npm test
npm run deploy
```
デプロイできたら、Claude をつなぐ前に動作を確認します。
PowerShell では `curl` が別のコマンドになるので `curl.exe` と打ちます（bash / macOS では `curl`）。
```powershell
curl.exe -i <base>/healthz
curl.exe <base>/.well-known/oauth-protected-resource/mcp
curl.exe -i -X POST <base>/mcp
```
| コマンド | 正常なら |
|---|---|
| 1 行目 | `200` と `ok` |
| 2 行目 | `"resource": "<base>/mcp"` を含む JSON |
| 3 行目 | `401` と `WWW-Authenticate: Bearer ... resource_metadata=...`（鍵がないので拒否される、が正常） |

最後に、ブラウザで `<base>/oura/connect` を開きます。
GitHub でログイン → Oura で許可 → 「Oura account linked」と出たら完了です。これは 1 回だけです。

### 7. Claude に接続する
claude.ai → 設定 → コネクタ → **カスタムコネクタを追加** → URL に `<base>/mcp` を入力。
- **Client ID / Client Secret:** 空欄のままにします（Claude が自動で登録します）。
- **GitHub ログイン:** 求められたらログインして許可します。
- **スマホアプリ:** 同じアカウントなら自動で使えるようになります。

## 困ったとき

詳しい手順は [docs/runbook.md](docs/runbook.md)（英語）にあります。よく使うものだけ載せます。

- **乗っ取りが疑われるとき（緊急停止）:** 全リクエストが止まります（`/healthz` も 503 になります）。
  そのあと runbook の A の手順（鍵の無効化・入れ替え）に進みます。
  ```bash
  npx wrangler deploy --var KILL_SWITCH:1
  ```
  再開するときは次のコマンドです。
  ```bash
  npx wrangler deploy --var KILL_SWITCH:0
  ```
- **Claude がつながらないとき:** 確認するのは次の 3 つです。
  - 手順 6 の 2 行目の確認コマンドが正しい JSON を返すか。
  - `PUBLIC_BASE_URL` が実際の URL と完全に一致しているか（末尾の `/` なし）。
  - GitHub と Oura に登録したコールバック URL が合っているか。
- **「Re-link」や鍵の更新エラーが出るとき:** Oura 側で許可が取り消されたか、鍵が期限切れです。
  `<base>/oura/disconnect` → `<base>/oura/connect` の順に開いて連携し直します。
- **連携を解除したいとき:** `<base>/oura/disconnect` を開きます。GitHub で本人確認したあと、
  Oura の鍵を取り消して保管庫から削除します。

## 開発とテスト

- **手元で動かす:** `.dev.vars.example` を `.dev.vars` にコピーして値を入れ、`npm run dev`。
  開発用には**別の** GitHub OAuth App（コールバック `http://localhost:8787/callback`）を使います。
  `.dev.vars` は絶対にコミットしないでください。
- **テスト:** CI では、すべてのテストを Linux（Node 22）と Windows（Node 24）の両方で毎回実行しています。
  - `npm run test:unit`: 暗号化、入力チェック、ログの伏せ字処理、データの整形など、中核部分のテスト。
  - `npm run test:workers`: 本番と同じ Cloudflare Workers の環境で、サーバー全体を動かすテスト。
    GitHub と Oura だけを偽物に差し替え、接続 → 本人確認 → ツール呼び出し → 鍵の更新 → 連携解除までを通しで確認します。
    公式の MCP クライアントで実際に接続するテストと、SECURITY.md の各対策が破られたら失敗するテストも含みます。
- **今後の予定:** [docs/roadmap.md](docs/roadmap.md)

## ライセンス

非公開。All rights reserved.
