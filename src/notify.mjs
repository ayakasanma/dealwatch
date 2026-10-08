// 終端機表格輸出 + 推播（LINE / Discord / Telegram / ntfy）。推播設定取自環境變數或 config.notify。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tty = process.stdout.isTTY;
const color = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { dim: s => color(2, s), green: s => color(32, s), yellow: s => color(33, s), red: s => color(31, s), cyan: s => color(36, s), bold: s => color(1, s) };

const fmt = n => (Number.isInteger(n) ? String(n) : n.toFixed(2));
export const offPct = item => (item.ref > item.price ? Math.round((1 - item.price / item.ref) * 100) : 0);

export function priceText(item) {
  const hist = item.hist?.length > 1 ? item.hist.map(fmt).join('->') : fmt(item.price);
  if (item.offers?.length > 1) return `${hist} (${item.offers.slice(1).map(o => `${o.cond[0]}${fmt(o.price)}`).join(' ')})`;
  return hist;
}

// 成色已經有獨立欄位，從名稱拿掉省寬度
const shortName = name => name.replace(/(Geek Squad Certified )?Refurbished( Excellent| Good| Fair)?( - )?/i, '').replace(/^(.+?) - /, '$1 ').replace(/\s+/g, ' ').trim();

export function printTable(items, { numbered = true } = {}) {
  if (!items.length) { console.log(c.dim('（沒有符合條件的商品）')); return; }
  const nameW = Math.max(24, Math.min(46, (process.stdout.columns || 150) - 100));
  const rows = items.map((it, i) => [
    (it.deal?.steal ? '★' : '') + (numbered ? String(i + 1) : ''),
    it.store === 'bb' ? 'BB' : 'WM',
    it.id,
    it.cat ?? '',
    it.cond,
    shortName(it.name).slice(0, nameW),
    it.specs?.cpu ?? '', it.specs?.gpu ?? '', it.specs?.ram ?? '', it.specs?.disk ?? '',
    it.seller.slice(0, 14),
    it.deal?.sum ? String(it.deal.sum) : '',
    it.ref ? fmt(it.ref) : '',
    offPct(it) ? `-${offPct(it)}%` : '',
    priceText(it),
  ]);
  const head = ['#', '店', 'sku', '類', '狀態', 'name', 'cpu', 'gpu', 'ram', 'disk', '賣家', '估值', '原價', '折', 'price'];
  const right = new Set([0, 11, 12, 13, 14]);
  // 中文字寬 2 格
  const width = s => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
  const widths = head.map((h, i) => Math.max(width(h), ...rows.map(r => width(r[i]))));
  const pad = (s, i) => (right.has(i) ? ' '.repeat(widths[i] - width(s)) + s : s + ' '.repeat(widths[i] - width(s)));
  console.log(c.bold(head.map(pad).join(' ')));
  for (const [n, r] of rows.entries()) {
    const line = r.map(pad).join(' ');
    const off = offPct(items[n]);
    console.log(items[n].deal?.steal ? c.bold(c.green(line)) : off >= 25 ? c.green(line) : off >= 12 ? c.yellow(line) : line);
  }
}

export function alertLine({ why, item, prev }) {
  const tag = why === 'STEAL' ? c.bold(c.green('[撿漏]')) : why === 'NEW' ? c.cyan('[上新]') : c.green(`[降價 ${fmt(prev)}->${fmt(item.price)}]`);
  const off = offPct(item) ? ` (-${offPct(item)}% vs ${fmt(item.ref)})` : '';
  const line = `${tag} ${item.store === 'bb' ? 'BestBuy' : 'Walmart'} ${item.cond} $${fmt(item.price)}${off} | ${item.seller} | ${shortName(item.name).slice(0, 90)}`;
  return why === 'STEAL' ? `${line}\n   ${item.deal.reason}` : line;
}

function alertText({ why, item, prev }) {
  const off = offPct(item) ? ` (-${offPct(item)}%，原價 $${fmt(item.ref)})` : '';
  const head = why === 'STEAL' ? '💎 撿漏' : why === 'NEW' ? '🆕 上新' : `📉 降價 $${fmt(prev)} → $${fmt(item.price)}`;
  return [
    `${head}｜${item.store === 'bb' ? 'Best Buy' : 'Walmart'} ${item.cond}`,
    shortName(item.name).slice(0, 140),
    `$${fmt(item.price)}${off}｜${item.seller}`,
    ...(why === 'STEAL' ? [item.deal.reason] : []),
    `加入購物車: ${item.cartUrl}`,
    `商品頁: ${item.url}`,
  ].join('\n');
}

async function post(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    if (!res.ok) console.error(c.red(`推播失敗 HTTP ${res.status}: ${new URL(url).host}`));
    return res.ok;
  } catch (e) { console.error(c.red(`推播失敗: ${e.message}`)); return false; }
}

// LINE 免費方案每月只有 200 則，而且是按「一次推播 × 收件人數」計算，
// 所以把同一輪的提醒併成一次推播（一次最多 5 個訊息物件，每個 5000 字以內）。
const LINE_COUNT_FILE = fileURLToPath(new URL('../data/line-count.json', import.meta.url));

// 今天已經成功推了幾則
function lineSentToday() {
  const day = new Date().toISOString().slice(0, 10);
  try { const saved = JSON.parse(fs.readFileSync(LINE_COUNT_FILE, 'utf8')); if (saved.day === day) return saved; } catch {}
  return { day, n: 0 };
}

// 有長期 token 就直接用；否則用 Channel ID + secret 換 15 分鐘有效的 stateless token 並快取
let lineTokenCache = null;
async function lineAccessToken({ lineToken, lineChannelId, lineChannelSecret }) {
  if (lineToken) return lineToken;
  if (lineTokenCache?.exp > Date.now() + 60000) return lineTokenCache.token;
  const res = await fetch('https://api.line.me/oauth2/v3/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: lineChannelId, client_secret: lineChannelSecret }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`用 Channel ID / secret 換 token 失敗 (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  lineTokenCache = { token: json.access_token, exp: Date.now() + json.expires_in * 1000 };
  return lineTokenCache.token;
}

async function pushLine(target, texts) {
  const { lineTo, lineDailyMax } = target;
  const sent = lineSentToday();
  if (sent.n >= lineDailyMax) { console.error(c.yellow(`LINE 今日已達 ${lineDailyMax} 則上限，這則不推（提醒仍記在 data/alerts.jsonl）`)); return false; }
  const messages = [];
  for (const text of texts) {
    const last = messages.at(-1);
    if (last && last.text.length + text.length + 2 <= 4500) last.text += '\n\n' + text;
    else if (messages.length < 5) messages.push({ type: 'text', text: text.slice(0, 4500) });
  }
  const url = `https://api.line.me/v2/bot/message/${lineTo ? 'push' : 'broadcast'}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await lineAccessToken(target)}` },
      body: JSON.stringify(lineTo ? { to: lineTo, messages } : { messages }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      fs.mkdirSync(path.dirname(LINE_COUNT_FILE), { recursive: true });
      fs.writeFileSync(LINE_COUNT_FILE, JSON.stringify({ day: sent.day, n: sent.n + 1 }));
      return true;
    }
    const hint = res.status === 401 ? '（token 無效）' : res.status === 429 ? '（本月免費則數用完或送太快）' : '';
    console.error(c.red(`LINE 推播失敗 HTTP ${res.status}${hint}: ${(await res.text()).slice(0, 200)}`));
  } catch (e) { console.error(c.red(`LINE 推播失敗: ${e.message}`)); }
  return false;
}

export function pushTargets(cfg = {}) {
  const env = process.env;
  const lineToken = cfg.lineToken || env.LINE_TOKEN;
  const lineChannelId = cfg.lineChannelId || env.LINE_CHANNEL_ID;
  const lineChannelSecret = cfg.lineChannelSecret || env.LINE_CHANNEL_SECRET;
  return {
    line: !!(lineToken || (lineChannelId && lineChannelSecret)),
    lineToken, lineChannelId, lineChannelSecret,
    lineTo: cfg.lineTo || env.LINE_TO,
    lineDailyMax: cfg.lineDailyMax ?? 6,
    discord: cfg.discordWebhook || env.DISCORD_WEBHOOK,
    telegramToken: cfg.telegramToken || env.TELEGRAM_BOT_TOKEN,
    telegramChat: cfg.telegramChatId || env.TELEGRAM_CHAT_ID,
    ntfy: cfg.ntfyTopic || env.NTFY_TOPIC,
  };
}

// 一次最多推 8 則，避免首次掃描或大量上新時洗版
export async function push(cfg, alerts, note) {
  const t = pushTargets(cfg);
  if (!t.line && !t.discord && !t.telegramToken && !t.ntfy) return;
  if (!alerts.length && !note) return;
  const shown = alerts.slice(0, 8);
  const texts = shown.map(alertText);
  if (note) texts.push(note);
  if (alerts.length > shown.length) texts.push(`…另有 ${alerts.length - shown.length} 則，見 data/alerts.jsonl`);
  const jobs = [];
  if (t.line) jobs.push(pushLine(t, texts));
  for (const text of texts) {
    if (t.discord) jobs.push(post(t.discord, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) }));
    if (t.telegramToken && t.telegramChat) jobs.push(post(`https://api.telegram.org/bot${t.telegramToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: t.telegramChat, text, disable_web_page_preview: true }) }));
    if (t.ntfy) jobs.push(post(`https://ntfy.sh/${encodeURIComponent(t.ntfy)}`, { method: 'POST', body: text }));
  }
  return (await Promise.all(jobs)).every(Boolean);
}
