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

export function requireBrowserRuntime() {
  if (typeof globalThis.WebSocket !== 'function') throw new Error('瀏覽器模式需要內建 WebSocket；請使用 Node.js 22 以上。直接 HTTP 模式可用 WALMART_VIA=http。');
}

export class Browser {
  // cdpUrl：接到別處已經在跑的瀏覽器（例如 NAS 上的 Chromium 容器），這種模式下不會自己啟動或關閉瀏覽器
  // idleMs：載入都做完後過多久把分頁換成空白頁，0 = 不換
  // parent：跟另一個 Browser 共用同一個瀏覽器，但自己開一個分頁（各自排隊，互不卡住）；瀏覽器由 parent 負責啟動與關閉
  constructor({ path, profileDir, port = 9333, cdpUrl = '', commandTimeout = 10000, idleMs = 30000, parent = null }) {
    Object.assign(this, { path: path || findBrowser(), profileDir, port, commandTimeout, idleMs, parent, hold: false, nextId: 1, pending: new Map(), waiters: [], spawned: false });
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
      requireBrowserRuntime();
      if (this.parent) await this.parent.ready();
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
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.ws.close(); reject(new Error('瀏覽器除錯埠連線逾時')); }, this.commandTimeout);
        this.ws.onopen = () => { clearTimeout(timer); resolve(); };
        this.ws.onerror = () => { clearTimeout(timer); reject(new Error('連不上瀏覽器的除錯埠')); };
      });
      this.ws.onmessage = ev => this.onMessage(JSON.parse(ev.data));
      this.ws.onclose = () => {
        this.starting = null;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('瀏覽器已關閉')); }
        this.pending.clear();
        for (const w of this.waiters) { clearTimeout(w.timer); w.reject(new Error('瀏覽器已關閉')); }
        this.waiters = [];
      };

      const { targetInfos } = await this.send('Target.getTargets');
      const existing = this.parent ? null : targetInfos.find(t => t.type === 'page')?.targetId;
      this.targetId = existing ?? (await this.send('Target.createTarget', { url: 'about:blank' })).targetId;
      this.session = (await this.send('Target.attachToTarget', { targetId: this.targetId, flatten: true })).sessionId;
      await this.send('Page.enable', {}, this.session);
    })().catch(err => { this.starting = null; throw err; });
  }

  onMessage(msg) {
    if (msg.id) {
      const p = this.pending.get(msg.id);
      clearTimeout(p?.timer);
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
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`瀏覽器指令逾時: ${method}`)); }, this.commandTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) })); }
      catch (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
    });
  }

  waitEvent(method, timeout) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve, reject };
      waiter.timer = setTimeout(() => { this.waiters = this.waiters.filter(w => w !== waiter); reject(new Error('頁面載入逾時')); }, timeout);
      this.waiters.push(waiter);
    });
  }

  // 只有一個分頁，所有載入都排隊依序做。排隊清空 idleMs 後把分頁換成空白頁：
  // 網站的腳本（尤其是人機驗證的指紋腳本）留在分頁上，兩輪之間會一直吃 CPU、記憶體並寫入設定檔。
  serial(fn, { idle = false } = {}) {
    clearTimeout(this.idleTimer);
    const job = (this.chain ?? Promise.resolve()).then(fn);
    const chain = this.chain = job.catch(() => {});
    if (!idle && this.idleMs > 0) chain.then(() => {
      if (this.chain !== chain) return; // 後面還有排隊的載入，由最後一個負責
      this.idleTimer = setTimeout(() => this.blank(), this.idleMs);
      this.idleTimer.unref?.();
    });
    return job;
  }

  // 換成空白頁。hold 時保留目前頁面（等你處理人機驗證或登入）；連線已關就不重連
  blank() {
    return this.serial(async () => {
      if (this.hold || !this.starting || !this.session) return;
      await this.navigate('about:blank', 5000).catch(() => {});
    }, { idle: true });
  }

  async navigate(url, timeout) {
    await this.ready();
    const loaded = this.waitEvent('Page.domContentEventFired', timeout);
    loaded.catch(() => {}); // navigate 失敗時，事件逾時也有處理者。
    const nav = await this.send('Page.navigate', { url }, this.session);
    if (nav.errorText) { loaded.catch(() => {}); throw new Error(`瀏覽器載入失敗: ${nav.errorText}`); }
    await loaded;
  }

  async run(expression) {
    const { result } = await this.send('Runtime.evaluate', { expression, returnByValue: true }, this.session);
    return result.value;
  }

  // 載入一頁，回傳整頁 HTML
  html(url, timeout = 30000) {
    return this.serial(async () => { await this.navigate(url, timeout); return this.run('document.documentElement.outerHTML'); });
  }

  // 不重新載入，讀分頁目前的 HTML（頁面自己換過內容時用）
  currentHtml() {
    return this.serial(() => this.run('document.documentElement.outerHTML'));
  }

  // 載入一頁後反覆執行一段運算式，直到 until(結果) 成立或逾時，回傳最後一次的結果。
  // 給內容是載入後才由腳本畫出來的頁面用。
  evaluate(url, expression, { until = v => !!v, timeout = 10000 } = {}) {
    return this.serial(async () => {
      await this.navigate(url, 30000);
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = await this.run(expression);
        if (until(value) || Date.now() > deadline) return value;
        await sleep(500);
      }
    });
  }

  // 把分頁帶到最前面（需要你手動處理人機驗證或登入時用）
  async focus() { await this.send('Page.bringToFront', {}, this.session).catch(() => {}); }

  // 只關掉自己啟動的瀏覽器；keepOpen 時留著視窗（等你處理人機驗證或登入）
  async dispose() {
    clearTimeout(this.idleTimer);
    if (!this.starting) return;
    await this.starting.catch(() => {});
    // 接到別處的瀏覽器時不關它，但把分頁換回空白頁（hold 時保留）
    if (this.parent) {
      // 只有還在等人驗證的分頁才留著；驗證過了或別的查詢已經成功就關掉，不留下沒人管的分頁
      if (!this.hold) await Promise.race([this.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {}), sleep(1500)]);
    } else if (this.remote && this.idleMs > 0) await Promise.race([this.blank(), sleep(6000)]);
    if (this.spawned && !this.keepOpen) await Promise.race([this.send('Browser.close').catch(() => {}), sleep(1500)]);
    this.ws?.close();
  }
}

// 要用瀏覽器的店各給一個分頁：第一家用主分頁（瀏覽器由它負責），其他共用同一個瀏覽器、各開一個分頁。
// 驗證頁和 hold 是跟著分頁走的，共用分頁時別家的載入會蓋掉驗證頁，別家載入成功也會把 hold 放掉。
export function storeTabs(options, [first, ...rest]) {
  const main = new Browser(options);
  return Object.fromEntries([[first, main], ...rest.map(code => [code, new Browser({ ...options, parent: main })])]);
}
