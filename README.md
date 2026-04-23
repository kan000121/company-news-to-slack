# Company News to Slack

指定した企業リストの直近ニュースを Google News RSS から取得し、Slack に定期配信するスクリプト。GitHub Actions で月水金に自動実行する構成になっています。

現在の初期設定は「AI上場企業ベンチマーク（25社）」をウォッチしていますが、`companies.json` を差し替えれば **任意の企業リスト・業界・テーマ** に応用できます。

---

## ディレクトリ構成

```
森さんニュース/
├── .github/workflows/company-news.yml   # GitHub Actions cron 設定（月水金 朝8時JST）
├── .env.example                          # 環境変数テンプレート
├── .env                                  # 実際のWebhook URL（gitignore対象）
├── .gitignore
├── AI上場企業ベンチマーク_202604_v2.xlsx   # 元データ（参考）
├── companies.json                        # 監視対象企業リスト（これを編集）
├── company_news_to_slack.js              # 本体スクリプト
├── package.json
└── README.md
```

---

## ローカルで使う

### 1. 依存をインストール

```bash
cd "/Users/kanta_mac/eleand/RA/森さんニュース"
npm install
```

### 2. `.env` を作成

```bash
cp .env.example .env
# エディタで SLACK_WEBHOOK_URL を記入
```

Slack Incoming Webhook URL は [https://my.slack.com/services/new/incoming-webhook](https://my.slack.com/services/new/incoming-webhook) から発行。

### 3. 実行

```bash
npm run dry   # Slackに送らず内容だけ確認（開発時）
npm start     # Slackへ実際に送信
```

---

## GitHub Actions で定期実行（月水金 朝8時JST）

### 1. GitHubリポジトリを用意

```bash
cd "/Users/kanta_mac/eleand/RA/森さんニュース"
git init
git add .
git commit -m "initial commit"

# GitHubでリポジトリ作成後
git remote add origin git@github.com:<あなたのアカウント>/<リポジトリ名>.git
git branch -M main
git push -u origin main
```

### 2. Secretsに Webhook URL を登録

GitHub上でリポジトリの **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `SLACK_WEBHOOK_URL` | `https://hooks.slack.com/services/...` |

> **重要：** `.env` はコミットせず、必ず GitHub Secrets 経由で渡してください。`.gitignore` で除外済みです。

### 3. 動作確認

GitHub上で **Actions タブ → "Company News to Slack" → Run workflow**（手動実行）。

それ以降は cron（月水金 朝8時 JST）で自動実行されます。

### 実行タイミングを変えたい場合

`.github/workflows/company-news.yml` の `cron` を編集。**GitHub ActionsのcronはUTC基準**なので、JSTに戻すときは -9時間に注意。

| やりたいこと | cron 値 |
|---|---|
| 月水金 朝8時 JST（現状） | `0 23 * * 0,2,4` |
| 平日毎日 朝8時 JST | `0 23 * * 0-4` |
| 毎日 朝7時 JST | `0 22 * * *` |
| 月曜だけ 朝9時 JST | `0 0 * * 1` |

[crontab.guru](https://crontab.guru/) で検算するのがラク。

---

## 企業リストの追加・変更

`companies.json` を直接編集します。

```json
[
  {
    "category": "AI専業",
    "code": "3993",
    "name": "PKSHA Technology",
    "market": "プライム"
  },
  ...
]
```

- **`name`**：Google News 検索クエリのベースになる（必須）
- **`code`**：Slackメッセージに「(3993)」と表示されるだけ。無くてもOK
- **`category`、`market`**：現状は表示に使っていない。将来のグルーピング用

編集して保存するだけでOK。スクリプトの再ビルドなどは不要。

---

## 検索クエリのチューニング

### 社名が一般語と衝突するとき

例えば「モルフォ」で検索するとプラモデルや蝶が混ざる、「JIG-SAW」だと電動工具や競走馬が混ざる、など。

`company_news_to_slack.js` の `QUERY_OVERRIDES` に社名→絞り込みクエリを追記：

```js
const QUERY_OVERRIDES = {
  'モルフォ': '"株式会社モルフォ" OR "モルフォ AI" OR "モルフォ 画像"',
  'JIG-SAW': '"JIG-SAW" AI OR IoT OR クラウド',
  // 追加ここ
  '新しい会社': '"新しい会社" 業界関連ワード',
};
```

Google Newsのクエリは `"フレーズ完全一致"`、`OR` で連結、スペース区切りでAND、という標準的な記法が使えます。

### Yahoo株価などの自動生成ノイズを除外したい

`TITLE_BLOCKLIST` に正規表現を追加：

```js
const TITLE_BLOCKLIST = [
  /株価・株式情報/,
  /値動きの背景をAIが解説/,
  /株つぶやき/,
  // 追加ここ
  /除外したいパターン/,
];
```

---

## 設定パラメータ

`company_news_to_slack.js` の冒頭で変更可能：

| 変数 | デフォルト | 意味 |
|---|---|---|
| `PER_COMPANY_LIMIT` | `2` | 1社あたりの最大表示件数 |
| `SLACK_CHUNK_LIMIT` | `38000` | 1メッセージあたりの文字数上限（Slackは40000まで）|
| `BUFFER_HOURS` | `1` | cron遅延に対する取りこぼし防止バッファ |
| `SCHEDULE_RULES` | 月水金 | 曜日→取得期間のマッピング（下記参照）|

### 取得期間のロジック（重複配信防止）

前回配信以降のニュースだけを拾う仕組みで、内容が被りません：

| 実行曜日 | カバー範囲 | `hoursBack` |
|---|---|---|
| **月曜 8:00 JST** | 金8:00〜月8:00（金土日） | `72` |
| **水曜 8:00 JST** | 月8:00〜水8:00（月火） | `48` |
| **金曜 8:00 JST** | 水8:00〜金8:00（水木） | `48` |
| それ以外の手動実行 | 直近72時間 | `72`（DEFAULT_RULE） |

スケジュールを変えた場合は `SCHEDULE_RULES` も合わせて更新してください。例えば毎日配信にするなら：

```js
const SCHEDULE_RULES = {
  Mon: { hoursBack: 72, prevLabel: '金曜' }, // 月曜は金土日分
  Tue: { hoursBack: 24, prevLabel: '月曜' },
  Wed: { hoursBack: 24, prevLabel: '火曜' },
  // ...
};
```

---

## 他の用途に応用する

このリポジトリ構成は **「Google News RSS × リスト × Slack定期配信」** の汎用テンプレートとして使えます。

### 例: 競合企業ウォッチ

```json
// companies.json
[
  { "name": "競合A", "code": "" },
  { "name": "競合B", "code": "" }
]
```

### 例: 特定の自治体のニュース

```json
[
  { "name": "横浜市" },
  { "name": "川崎市" }
]
```

Slackメッセージ上の表記（`▼ 企業名 (コード)`）を「▼ 自治体名」にしたい場合は `company_news_to_slack.js` 内のテンプレートを調整：

```js
let block = `▼ ${company.name}${code}\n`;
// ↓ 例えば
let block = `📍 ${company.name}\n`;
```

### 例: 技術キーワードウォッチ（企業ではなくトピック）

`companies.json` を `topics.json` にリネームして：

```json
[
  { "name": "生成AI 業務利用" },
  { "name": "RAG 企業導入" }
]
```

この場合、コード欄や `▼` のラベルを「🔍」などに変更するとそれっぽくなります。

### 別の用途向けリポジトリを派生させる手順

1. このディレクトリをコピー or フォーク
2. `companies.json` を差し替え
3. `QUERY_OVERRIDES` / `TITLE_BLOCKLIST` をその領域向けにチューニング
4. `SLACK_WEBHOOK_URL` を別チャンネル用に切替（`.env` / GitHub Secret）
5. `.github/workflows/company-news.yml` の cron を必要に応じて変更

---

## よくある質問

**Q. ヒット0件のときどうなる？**
A. Slackへの送信自体をスキップします（空メッセージは流れません）。GitHub Actionsログには `[INFO] 直近ニュースなし。Slack送信スキップ` と出ます。

**Q. Google News RSSにレート制限はある？**
A. 明示的な制限はないが、大量並列アクセスはブロックされるので、このスクリプトでは25社程度の並列取得に留めています。100社以上にする場合は `Promise.all` を `for` ループ + sleep に変えるのが安全。

**Q. 記事要約はつかないの？**
A. 初期版は「タイトル+日付+リンク」のみ。要約が欲しい場合は姉妹スクリプト `youtube-ranking-playwright/scripts/news_to_slack.js` の `summarize*()` パターンを参考に追加可能。

**Q. Webhook URLを変えたい**
A. ローカル実行は `.env`、GitHub Actions は Secrets の `SLACK_WEBHOOK_URL` を書き換えるだけ。スクリプト側の変更は不要。

---

## ライセンス / メモ

- 社内用途想定。Google News RSS は Google の規約に従って使用してください。
- 元データ：`AI上場企業ベンチマーク_202604_v2.xlsx`（2026年4月時点）。カテゴリ「AI活用大手」「AIインフラ」は空欄なので、必要に応じて手動で `companies.json` に追記してください。
