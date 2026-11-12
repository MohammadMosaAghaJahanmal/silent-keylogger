'use strict';

// Optional acceptance test: installed Chrome/Edge, Node built-ins, no browser npm dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createApp } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.resolve(ROOT, '../build');
const SETUP = path.resolve(ROOT, '../dist/PDF-Setup.exe');
const COUNT = '\r\nTotal key presses: 42\r\n';

async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error('Timed out: ' + message);
}
class CDP {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.events = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else this.events.push(message);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('Browser disconnected.'));
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  async evaluate(expression, sessionId, userGesture = false) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture }, sessionId);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text + ': ' + response.exceptionDetails.exception?.description);
    return response.result.value;
  }
}

async function main() {
  const browser = process.env.PDF_TEST_BROWSER || [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].find(file => fs.existsSync(file));
  if (!browser) throw new Error('Install Chrome/Edge or set PDF_TEST_BROWSER to its executable.');
  const dataDir = fs.mkdtempSync(path.join(ROOT, '.test-browser-'));
  const downloads = path.join(dataDir, 'downloads'); fs.mkdirSync(downloads);
  const service = createApp({ dataDir });
  const listener = service.app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const base = `http://127.0.0.1:${listener.address().port}`;
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--metrics-recording-only',
    '--remote-debugging-port=0', '--user-data-dir=' + path.join(dataDir, 'profile'), 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  let cdp;
  const tests = [];
  const limitations = [];
  const pass = message => { tests.push(message); console.log('PASS:', message); };
  try {
    const endpoint = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'browser debugging endpoint');
    const socket = new WebSocket(endpoint); await once(socket, 'open'); cdp = new CDP(socket);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    const evaluate = (expression, gesture = false) => cdp.evaluate(expression, sessionId, gesture);
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: base + '/' });
    await until(() => evaluate("document.body?.innerText.includes('No file available.')"), 'empty download page');
    pass('Browser displays No file available before admin uploads a setup');
    await send('Page.navigate', { url: base + '/admin' });
    await until(() => evaluate("document.querySelector('#uploads')?.textContent.includes('No count files')"), 'empty admin table');
    const document = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#setup-file' });
    await send('DOM.setFileInputFiles', { nodeId, files: [SETUP] });
    await evaluate("document.querySelector('#setup-form').requestSubmit()", true);
    await until(() => evaluate("document.querySelector('#status').textContent.includes('Setup uploaded.')"), 'setup upload form');
    assert.equal(service.db.prepare('SELECT count(*) AS n FROM appsetup').get().n, 1);
    pass('Admin form uploads the actual compiled setup and updates its SQLite record');

    async function setupDownload(action, label) {
      const before = cdp.events.length;
      await action();
      const began = await until(() => cdp.events.slice(before).find(event => event.method === 'Browser.downloadWillBegin'), label + ' download request');
      assert.equal(began.params.url, base + '/download/app');
      assert.equal(began.params.suggestedFilename, 'PDF-Setup.exe');
      const done = await until(() => cdp.events.slice(before).find(event => event.method === 'Browser.downloadProgress'
        && event.params.guid === began.params.guid && ['completed', 'canceled'].includes(event.params.state)), label + ' download result');
      if (done.params.state === 'canceled') limitations.push(label + ': Chrome canceled executable download; HTTP byte integrity is tested separately.');
      else assert.deepEqual(fs.readFileSync(path.join(downloads, 'PDF-Setup.exe')), fs.readFileSync(SETUP));
    }
    await setupDownload(() => send('Page.navigate', { url: base + '/' }), 'Automatic setup download');
    assert.equal(await evaluate("document.querySelector('#download')?.getAttribute('href')"), '/download/app');
    pass('Opening / automatically requests the setup without a click and retains the manual link');
    await setupDownload(() => evaluate("document.querySelector('#download').click()", true), 'Manual setup download');
    pass('Visible manual setup link requests the correct attachment');
    await send('Page.navigate', { url: base + '/admin' });
    await until(() => evaluate("document.querySelector('#uploads')?.textContent.includes('No count files')"), 'return to admin');

    for (const name of ['older.txt', '<img src=x onerror=window.bad=true>.txt']) {
      const form = new FormData(); form.append('file', new Blob([COUNT]), name);
      if (name !== 'older.txt') {
        form.append('device_id', '12345678-1234-4567-89ab-123456789abc');
        form.append('device_name', 'CODE-LAPTOP'); form.append('os_version', 'Windows 11 (build 26200), x64');
      }
      assert.equal((await fetch(base + '/create', { method: 'POST', body: form })).status, 201);
    }
    await evaluate("document.querySelector('#refresh').click()", true);
    await until(() => evaluate("document.querySelectorAll('#uploads tr[data-id]').length === 2"), 'upload rows');
    assert.equal(await evaluate("document.querySelector('#uploads tr').cells[1].textContent"), '<img src=x onerror=window.bad=true>.txt');
    assert.equal(await evaluate("document.querySelectorAll('#uploads img').length"), 0);
    assert.equal(await evaluate('window.bad === undefined'), true);
    assert.equal(await evaluate("document.querySelector('#uploads tr .device-name').textContent"), 'CODE-LAPTOP');
    assert.equal(await evaluate("document.querySelector('#uploads tr .device-id').textContent"), '12345678-1234-4567-89ab-123456789abc');
    assert.equal(await evaluate("document.querySelector('#uploads tr .device-os').textContent"), 'Windows 11 (build 26200), x64');
    assert.equal(await evaluate("document.querySelector('#uploads tr:last-child .device-name').textContent"), 'Unknown device');
    pass('Admin renders newest uploads first and escapes filenames as text');
    pass('Admin shows device name, stable ID and OS with Unknown device for legacy uploads');

    await evaluate("document.querySelector('#uploads tr:last-child .actions a').click()", true);
    const openTarget = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url.includes('/api/uploads/') && target.url.endsWith('/open')), 'Open action browser tab');
    const opened = await cdp.send('Target.attachToTarget', { targetId: openTarget.targetId, flatten: true });
    await until(() => cdp.evaluate('document.body?.innerText.includes("Total key presses: 42")', opened.sessionId), 'opened count text');
    assert.equal((await cdp.evaluate('document.body.innerText', opened.sessionId)).trim(), COUNT.trim());
    await cdp.send('Target.closeTarget', { targetId: openTarget.targetId });
    pass('Open action displays exact count text in a separate browser tab');
    await evaluate("document.querySelector('#uploads tr:last-child .actions a:nth-child(2)').click()", true);
    await until(() => fs.existsSync(path.join(downloads, 'older.txt')), 'count download');
    assert.equal(fs.readFileSync(path.join(downloads, 'older.txt'), 'utf8'), COUNT);
    pass('Download action saves the original count file bytes');

    for (const accept of [false, true]) {
      const before = cdp.events.length;
      const clicking = evaluate("document.querySelector('#uploads tr:last-child .delete').click()", true);
      await until(() => cdp.events.slice(before).find(event => event.method === 'Page.javascriptDialogOpening'), 'delete confirmation');
      await send('Page.handleJavaScriptDialog', { accept }); await clicking;
      if (accept) await until(() => evaluate("document.querySelectorAll('#uploads tr[data-id]').length === 1"), 'deleted row');
      else assert.equal(await evaluate("document.querySelectorAll('#uploads tr[data-id]').length"), 2);
    }
    assert.equal(service.db.prepare('SELECT count(*) AS n FROM uploads').get().n, 1);
    assert.equal(fs.readdirSync(service.uploadDir).filter(name => name.endsWith('.txt')).length, 1);
    pass('Delete confirmation cancel preserves data; confirm removes file, row and table entry');

    fs.mkdirSync(BUILD, { recursive: true });
    const desktopShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(BUILD, 'admin-desktop.png'), Buffer.from(desktopShot.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= 390'), true);
    const mobileShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(BUILD, 'admin-mobile.png'), Buffer.from(mobileShot.data, 'base64'));
    pass('Desktop and mobile admin layouts render without page overflow');

    assert.equal(cdp.events.filter(event => event.method === 'Runtime.exceptionThrown').length, 0);
    const version = await cdp.send('Browser.getVersion');
    fs.writeFileSync(path.join(BUILD, 'browser-verification.json'), JSON.stringify({ status: limitations.length ? 'PASSED_WITH_BROWSER_LIMITATION' : 'PASSED', browser: version.product, tests, limitations }, null, 2));
    for (const limitation of limitations) console.log('LIMITATION:', limitation);
  } catch (error) {
    fs.mkdirSync(BUILD, { recursive: true });
    fs.writeFileSync(path.join(BUILD, 'browser-failure.json'), JSON.stringify(cdp?.events || [], null, 2));
    throw error;
  } finally {
    if (cdp) { try { await cdp.send('Browser.close'); } catch {} cdp.socket.close(); }
    if (child.exitCode === null) {
      await Promise.race([once(child, 'exit'), delay(5000)]);
      if (child.exitCode === null) child.kill();
    }
    listener.closeIdleConnections();
    await new Promise(resolve => listener.close(resolve)); service.close();
    assert.ok(dataDir.startsWith(ROOT + path.sep + '.test-browser-'));
    // Chrome can release its profile files shortly after its parent exits.
    for (let attempt = 0; attempt < 20; ++attempt) {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); break; }
      catch (error) { if (attempt === 19) throw error; await delay(100); }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
