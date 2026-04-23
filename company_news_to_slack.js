require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

const parser = new Parser({ timeout: 15000 });
const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const DRY_RUN = process.env.DRY_RUN === '1';

/**
 * =========================
 * 設定
 * =========================
 */
const LOOKBACK_DAYS = 7;          // 直近 N 日以内の記事のみ採用
const PER_COMPANY_LIMIT = 2;      // 企業ごとの最大表示件数
const SLACK_CHUNK_LIMIT = 38000;  // 1メッセージのおおよその上限（Slack 40000）

// 一般語と衝突しやすい・短すぎる社名は補強クエリを当てる
const QUERY_OVERRIDES = {
  'エーアイ': '"株式会社エーアイ" OR "エーアイ 4388"',
  'ABEJA': '"ABEJA" AI',
  'HEROZ': '"HEROZ" 将棋 OR AI',
  'Kudan': '"Kudan" 空間認識 OR SLAM OR 自律',
  'AI inside': '"AI inside" OR "DX Suite"',
  'Neural Group': '"Neural Group" OR "ニューラルグループ"',
  'モルフォ': '"株式会社モルフォ" OR "モルフォ AI" OR "モルフォ 画像"',
  'ロゼッタ': '"ロゼッタ 翻訳" OR "株式会社ロゼッタ"',
  'AI CROSS': '"AI CROSS" OR "AIクロス"',
  'TDSE': '"TDSE" データ OR AI',
  'JIG-SAW': '"JIG-SAW" AI OR IoT OR クラウド',
  'ユーザーローカル': '"ユーザーローカル"',
  'インティメート・マージャー': '"インティメート・マージャー"',
  'ファーストアカウンティング': '"ファーストアカウンティング"',
  'Sun Asterisk': '"Sun Asterisk" DX OR AI OR 開発',
  'Appier Group': '"Appier"',
  'Laboro.AI': '"Laboro.AI" OR "ラボロAI"',
  'AVILEN': '"AVILEN" OR "アヴィレン"',
  'オプティム': '"オプティム" OR "OPTiM"',
  'FFRIセキュリティ': '"FFRIセキュリティ" OR "FFRI"',
  'ブレインパッド': '"ブレインパッド"',
  'エクサウィザーズ': '"エクサウィザーズ" OR "ExaWizards"',
  'ヘッドウォータース': '"ヘッドウォータース"',
  'PKSHA Technology': '"PKSHA"',
  'FRONTEO': '"FRONTEO"'
};

// 株価自動記事などの低品質ノイズをタイトルで除外
const TITLE_BLOCKLIST = [
  /株価・株式情報/,
  /値動きの背景をAIが解説/,
  /株つぶやき/,
  /チャート分析/,
  /テクニカル分析/,
  /\[決算\]/,
  /Yahoo!ファイナンス$/,
  /みんかぶ/
];

/**
 * =========================
 * ユーティリティ
 * =========================
 */
function buildURL(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`;
}

function buildQuery(company) {
  return QUERY_OVERRIDES[company.name] || `"${company.name}"`;
}

function clean(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const i of items) {
    const k = keyFn(i);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(i);
    }
  }
  return out;
}

function withinLookback(item, days) {
  const iso = item.isoDate || item.pubDate;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) <= days * 24 * 60 * 60 * 1000;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * =========================
 * ニュース取得
 * =========================
 */
async function fetchNews(company) {
  const query = buildQuery(company);
  try {
    const feed = await parser.parseURL(buildURL(query));
    const fresh = (feed.items || [])
      .filter(it => withinLookback(it, LOOKBACK_DAYS))
      .map(it => ({
        title: clean(it.title),
        link: it.link,
        date: formatDate(it.isoDate || it.pubDate)
      }))
      .filter(it => !TITLE_BLOCKLIST.some(re => re.test(it.title)));
    return uniqBy(fresh, x => x.link || x.title).slice(0, PER_COMPANY_LIMIT);
  } catch (e) {
    console.error(`[WARN] ${company.name} 取得失敗: ${e.message}`);
    return [];
  }
}

/**
 * =========================
 * Slack 送信
 * =========================
 */
async function postToSlack(text) {
  if (DRY_RUN) {
    console.log('--- DRY RUN OUTPUT ---');
    console.log(text);
    console.log('--- END ---');
    return;
  }
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack送信失敗: ${res.status} ${body}`);
  }
}

function chunkMessages(header, blocks, limit) {
  const messages = [];
  let current = header;
  for (const block of blocks) {
    if ((current + block).length > limit) {
      messages.push(current);
      current = block;
    } else {
      current += block;
    }
  }
  if (current.trim()) messages.push(current);
  return messages;
}

/**
 * =========================
 * メイン
 * =========================
 */
async function main() {
  if (!WEBHOOK_URL && !DRY_RUN) {
    throw new Error('SLACK_WEBHOOK_URL が未設定（DRY_RUN=1 で送信スキップ可）');
  }

  const companiesPath = path.join(__dirname, 'companies.json');
  const companies = JSON.parse(fs.readFileSync(companiesPath, 'utf-8'));

  const today = formatDate(new Date().toISOString());
  console.log(`[INFO] ${companies.length}社をチェック（lookback=${LOOKBACK_DAYS}日）`);

  // 並列取得（Google News RSSは軽い）
  const results = await Promise.all(
    companies.map(async c => ({ company: c, news: await fetchNews(c) }))
  );

  const hits = results.filter(r => r.news.length > 0);
  console.log(`[INFO] ヒット ${hits.length}/${companies.length} 社`);

  if (hits.length === 0) {
    console.log('[INFO] 直近ニュースなし。Slack送信スキップ');
    return;
  }

  const header = `🏢 AI上場企業ニュースウォッチ (${today})\n直近${LOOKBACK_DAYS}日以内 / ヒット ${hits.length}/${companies.length}社\n\n`;

  const blocks = hits.map(({ company, news }) => {
    const code = company.code ? ` (${company.code})` : '';
    let block = `▼ ${company.name}${code}\n`;
    for (const n of news) {
      block += `・${n.title}${n.date ? ` [${n.date}]` : ''}\n`;
      block += `🔗 <${n.link}|記事を見る>\n`;
    }
    return block + '\n';
  });

  const messages = chunkMessages(header, blocks, SLACK_CHUNK_LIMIT);

  for (const [i, msg] of messages.entries()) {
    await postToSlack(msg);
    if (messages.length > 1) console.log(`[INFO] 送信 ${i + 1}/${messages.length}`);
  }

  console.log('送信完了');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
