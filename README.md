# BANSO Pilates — 予約・精算管理

オフィススペースを間貸しして行うピラティスレッスンの、枠・予約・実施記録・月次精算を管理するシステムです。

## できること（MVP）

| 機能 | 内容 |
|---|---|
| 枠の登録 | インストラクターが「来られる時間帯」を入れると60分ごとの枠を作成。スペース専用Googleカレンダーで埋まっている時間はスキップし、作成した枠はカレンダーに「仮押さえ」として書き込む |
| 予約 | 枠にお客さま名・メニューを入れて予約。カレンダーの予定名も「予約」に更新 |
| 実施完了 | レッスン後に支払方法（現金/PayPay/振込/その他）を選んで「実施完了」 |
| キャンセル | 24時間前まで＝無料（枠は空きに戻る）／それ以降＝全額・精算対象。開始後は「無断キャンセル」（全額・精算対象） |
| 月次精算 | 実施完了＋直前キャンセル＋無断キャンセルの税込売上 × 料率（初期30%、1円未満切り捨て） |
| LINE通知 | 毎日20:00 明日の予約リマインド＋実施完了の押し忘れ／毎月1日9:00 前月の精算額 |
| ログイン | Googleアカウント。管理者（`ADMIN_EMAIL`）と、管理者が登録したインストラクターのみ |

ヒロキの個人カレンダーには一切書き込みません（スペース専用カレンダーにだけ書き込む）。

## 構成（月額0円）

- Cloudflare Workers（無料プラン・商用可）＋ Hono（サーバーサイドレンダリング）
- Cloudflare D1（SQLite）
- Google Calendar API（サービスアカウント）
- LINE Messaging API（無料のコミュニケーションプラン）

## セットアップ手順

### 1. Cloudflare
1. Cloudflare アカウントを作成する。テスト段階は無料の `*.workers.dev` のURLで動かせる。`pilates.banso-club.com` で公開するときは、`banso-club.com` のネームサーバーを Cloudflare に移す（無料プランでは、サブドメインだけを CNAME で向ける方式は使えない）。移す前に、メール（MX）などの既存の DNS レコードが Cloudflare 側に引き継がれているか必ず確認する
2. `npm install`
3. `npx wrangler login`
4. `npx wrangler d1 create pilates` → 表示された `database_id` を `wrangler.jsonc` に貼る
5. `npm run db:migrate:remote`

### 2. スペース専用Googleカレンダー
1. ヒロキのGoogleアカウントで新しいカレンダー「スペース（オフィス）」を作成（追加費用なし）
2. Google Cloud でプロジェクトを作成 → Google Calendar API を有効化 → サービスアカウントを作成し、JSONキーを発行
3. スペースカレンダーの「共有」にサービスアカウントのメールアドレスを「予定の変更」権限で追加
   - Google Workspace で外部共有が制限されている場合は、管理コンソールで外部共有を許可するか、無料のGmailアカウントでカレンダーを作成する
4. カレンダー設定の「カレンダーID」を控える
5. スペースを使う他の予定（打合せ・別利用など）は、このカレンダーに入れる

### 3. Googleログイン
1. 同じ Google Cloud プロジェクトで「OAuth同意画面」を設定（外部・本番公開）
2. 認証情報 →「OAuth クライアント ID（ウェブアプリケーション）」を作成
3. 承認済みリダイレクトURIに `https://pilates.banso-club.com/auth/callback` を追加

### 4. LINE公式アカウント
1. LINE公式アカウントを作成し、Messaging API を有効化
2. LINE Developers でチャネルシークレットとチャネルアクセストークン（長期）を取得
3. Webhook URL に `https://pilates.banso-club.com/line/webhook` を設定し、Webhookをオンにする（応答メッセージはオフ推奨）

### 5. シークレット登録とデプロイ
```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SPACE_CALENDAR_ID
npx wrangler secret put GOOGLE_SA_EMAIL
npx wrangler secret put GOOGLE_SA_PRIVATE_KEY   # JSONキーの private_key（\n を含んだままでOK）
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npm run deploy
```
Cloudflare ダッシュボードで Worker にカスタムドメイン `pilates.banso-club.com` を割り当てる。

### 6. 初期設定
1. `ADMIN_EMAIL`（hiroki.ito@banso-club.com）でログイン → 自動で管理者になる
2. 設定 → インストラクター追加（翔太さんのGoogleメールアドレス・料率30%）。初期メニュー「パーソナル60分 10,000円」「体験 5,000円」が作られる
3. 翔太さんがログイン → 設定 → 「連携コードを発行」→ LINE公式アカウントを友だち追加してコードを送信

## ローカル開発

```sh
cp .dev.vars.example .dev.vars   # DEV_LOGIN=1 にすると Google ログインなしで試せる
npm run db:migrate:local
npm run dev
# http://localhost:8787/dev-login               → 管理者としてログイン
# http://localhost:8787/dev-login?email=<登録済み> → インストラクターとしてログイン
npm test
npm run typecheck
```
Google カレンダー・LINE の値が未設定なら、連携はスキップされ、通知内容はログに出力されます。
`/dev-login` は `DEV_LOGIN=1` かつ `APP_URL` が localhost のときだけ有効です。

## 今後（第2段階）

- Stripe による毎月1日の自動引き落とし（翔太さんのカード登録 → 前月スペース利用料を請求 → 領収書メールは Stripe から自動送信。手数料は伴走クラブ負担）
- 精算の「確定」記録（料率変更が過去月に影響しないよう、月ごとに確定額を保存）
- お客さまが空き枠から直接予約できる公開ページ
