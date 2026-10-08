// 用一個真正的 Chrome / Edge 視窗載入頁面（Chrome DevTools Protocol，零依賴）。
// 用獨立的使用者資料夾，不會動到你平常的瀏覽器設定檔。不做任何指紋偽裝，遇到人機驗證就交還給你。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

export const findBrowser = () => (CANDIDATES[process.platform] ?? []).find(p => fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Browser {
  // cdpUrl：接到別處已經在跑的瀏覽器（例如 NAS 上的 Chromium 容器），這種模式下不會自己啟動或關閉瀏覽器
  constructor({ path, profileDir, port = 9333, cdpUrl = '' }) {
    Object.assign(this, { path: path || findBrowser(), profileDir, port, nextId: 1, pending: new Map(), waiters: [], spawned: false });
    this.remote = !!cdpUrl;
    this.base = (cdpUrl || `http://127.0.0.1:${port}`).replace(/\/$/, '');
  }

  async version() {
    const res = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.json();
  }

  // 已經有瀏覽器在跑就直接接上，否則啟動一個
  ready() {
    return this.starting ??= (async () => {
      let info = await this.version().catch(() => null);
      if (!info && this.remote) throw new Error(`連不上瀏覽器 ${this.base}（瀏覽器容器還沒啟動完成，或沒開遠端除錯埠）`);
      if (!info) {
        if (!this.path) throw new Error('找不到 Chrome 或 Edge，請在 config.walmart.browserPath 指定路徑');
        fs.mkdirSync(this.profileDir, { recursive: true });
        spawn(this.path, [`--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profileDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1100,800', 'about:blank'],
          { detached: true, stdio: 'ignore' }).unref();
        this.spawned = true;
        for (let i = 0; i < 40 && !info; i++) { await sleep(400); info = await this.version().catch(() => null); }
        if (!info) throw new Error('瀏覽器啟動逾時');
      }
      this.ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(new Error('連不上瀏覽器的除錯埠')); });
      this.ws.onmessage = ev => this.onMessage(JSON.parse(ev.data));
      this.ws.onclose = () => { this.starting = null; for (const p of this.pending.values()) p.reject(new Error('瀏覽器已關閉')); this.pending.clear(); };

      const { targetInfos } = await this.send('Target.getTargets');
      this.targetId = targetInfos.find(t => t.type === 'page')?.targetId ?? (await this.send('Target.createTarget', { url: 'about:blank' })).targetId;
      this.session = (await this.send('Target.attachToTarget', { targetId: this.targetId, flatten: true })).sessionId;
      await this.send('Page.enable', {}, this.session);
    })().catch(err => { this.starting = null; throw err; });
  }

  onMessage(msg) {
    if (msg.id) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message)); else p?.resolve(msg.result);
      return;
    }
    this.waiters = this.waiters.filter(w => {
      if (w.method !== msg.method || msg.sessionId !== this.session) return true;
      clearTimeout(w.timer);
      w.resolve(msg.params);
      return false;
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  }

  waitEvent(method, timeout) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      waiter.timer = setTimeout(() => { this.waiters = this.waiters.filter(w => w !== waiter); reject(new Error('頁面載入逾時')); }, timeout);
      this.waiters.push(waiter);
    });
  }

  // 在同一個分頁依序載入，回傳整頁 HTML
  async html(url, timeout = 30000) {
    await this.ready();
    const loaded = this.waitEvent('Page.domContentEventFired', timeout);
    const nav = await this.send('Page.navigate', { url }, this.session);
    if (nav.errorText) { loaded.catch(() => {}); throw new Error(`瀏覽器載入失敗: ${nav.errorText}`); }
    await loaded;
    const { result } = await this.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, this.session);
    return result.value;
  }

  // 把分頁帶到最前面（需要你手動處理人機驗證或登入時用）
  async focus() { await this.send('Page.bringToFront', {}, this.session).catch(() => {}); }

  // 只關掉自己啟動的瀏覽器；keepOpen 時留著視窗（等你處理人機驗證或登入）
  async dispose() {
    if (!this.starting) return;
    await this.starting.catch(() => {});
    if (this.spawned && !this.keepOpen) await Promise.race([this.send('Browser.close').catch(() => {}), sleep(1500)]);
    this.ws?.close();
  }
}
