// 網頁介面的小伺服器。預設只聽 127.0.0.1；開放給區域網路時（host = 0.0.0.0）請設密碼。
// 寫入類的請求要帶自訂標頭，別的網站沒辦法代你觸發。
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const PAGE = new URL('./ui.html', import.meta.url);

// HTTP Basic 驗證：帳號隨意，密碼要對
function authorized(req, password) {
  if (!password) return true;
  const given = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString().split(':').slice(1).join(':');
  const digest = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(digest(given), digest(password));
}

export function startUi({ port, host = '127.0.0.1', password = '', getState, getLog, rescan, setPaused, notifyTest }) {
  const server = http.createServer(async (req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      // 給 Docker 健康檢查用，不需要密碼也不洩漏內容
      if (url.pathname === '/healthz') return json(200, { ok: true });
      if (!authorized(req, password)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="dealwatch", charset="UTF-8"' });
        return res.end('需要密碼');
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(PAGE));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, getState());
      if (req.method === 'GET' && url.pathname === '/api/log') return json(200, { lines: getLog() });
      if (req.method === 'POST' && req.headers['x-dealwatch'] === '1') {
        if (url.pathname === '/api/rescan') { rescan(); return json(200, { ok: true }); }
        if (url.pathname === '/api/pause') return json(200, { ok: setPaused(url.searchParams.get('store'), url.searchParams.get('on') === '1') });
        if (url.pathname === '/api/notify-test') return json(200, { ok: !!(await notifyTest()) });
      }
      json(404, { error: 'not found' });
    } catch (err) { json(500, { error: err.message }); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', err => reject(new Error(err.code === 'EADDRINUSE' ? `port ${port} 已被占用（dealwatch ui 是不是已經在跑？）` : err.message)));
    server.listen(port, host, resolve);
  });
}
