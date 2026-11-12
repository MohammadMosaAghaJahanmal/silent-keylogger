'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { createApp, TEXT_LIMIT, SETUP_LIMIT } = require('../server');

const ROOT = path.resolve(__dirname, '..');
const SETUP = path.resolve(ROOT, '../dist/PDF-Setup.exe');
const NATIVE = path.resolve(ROOT, '../build/upload_test.exe');
const COUNT = Buffer.from('\r\nTotal key presses: 42\r\n');
const DEVICE = { device_id: '12345678-1234-4567-89ab-123456789abc',
  device_name: 'TEST-DEVICE', os_version: 'Windows 11 (build 26200), x64' };

test('Existing Phase 4 database migrates twice without losing old rows, IDs or file bytes', async () => {
  const dataDir = fs.mkdtempSync(path.join(ROOT, '.test-migration-'));
  let service;
  try {
    const uploadDir = path.join(dataDir, 'uploads'); fs.mkdirSync(uploadDir);
    const stored = randomUUID() + '.txt'; fs.writeFileSync(path.join(uploadDir, stored), COUNT);
    const legacy = new DatabaseSync(path.join(dataDir, 'database.sqlite'));
    legacy.exec(`CREATE TABLE uploads (id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL, received_at TEXT NOT NULL)`);
    legacy.prepare('INSERT INTO uploads VALUES (7,?,?,?,?,?)').run('yourtext.txt', stored,
      'uploads/' + stored, COUNT.length, '2026-11-11T00:00:00.000Z');
    legacy.close();
    for (let attempt = 0; attempt < 2; ++attempt) {
      service = createApp({ dataDir, log: () => {} });
      const rows = service.db.prepare('SELECT * FROM uploads').all();
      assert.equal(rows.length, 1); assert.equal(rows[0].id, 7);
      assert.equal(rows[0].device_id, null); assert.equal(rows[0].device_name, null); assert.equal(rows[0].os_version, null);
      assert.deepEqual(fs.readFileSync(path.join(dataDir, rows[0].file_path)), COUNT);
      service.close(); service = undefined;
    }
  } finally {
    service?.close();
    assert.ok(dataDir.startsWith(ROOT + path.sep + '.test-migration-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Phase 4 server and native-client integration', async t => {
  const dataDir = fs.mkdtempSync(path.join(ROOT, '.test-server-'));
  const service = createApp({ dataDir, log: () => {} });
  let listener = service.app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  let base = `http://127.0.0.1:${listener.address().port}`;
  const storedFiles = () => fs.readdirSync(service.uploadDir).sort();
  const rows = () => service.db.prepare('SELECT * FROM uploads ORDER BY id DESC').all();
  async function upload(bytes = COUNT, name = 'yourtext.txt', route = '/create', field = 'file', headers, device) {
    const data = new FormData();
    if (device) for (const [key, value] of Object.entries(device)) data.append(key, value);
    data.append(field, new Blob([bytes], { type: 'application/octet-stream' }), name);
    return fetch(base + route, { method: 'POST', body: data, headers });
  }
  async function closeListener() {
    if (!listener.listening) return;
    listener.closeIdleConnections();
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
  t.after(async () => {
    await closeListener(); service.close();
    assert.ok(dataDir.startsWith(ROOT + path.sep + '.test-server-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await t.test('Initializes both tables; empty download page and missing setup', async () => {
    assert.ok(fs.existsSync(path.join(dataDir, 'database.sqlite')));
    assert.deepEqual(service.db.prepare('PRAGMA table_info(uploads)').all().map(c => c.name),
      ['id', 'original_name', 'stored_name', 'file_path', 'file_size', 'received_at', 'device_id', 'device_name', 'os_version']);
    assert.ok(service.db.prepare("SELECT name FROM sqlite_master WHERE name='appsetup'").get());
    const home = await fetch(base + '/');
    assert.equal(home.status, 200); assert.match(await home.text(), /No file available\./);
    assert.equal((await fetch(base + '/download/app')).status, 404);
  });
  let first;
  await t.test('UTF-8 multipart upload persists exact bytes and matching UTC record before 201', async () => {
    const content = Buffer.from('Total key presses: 42\r\nUnicode check: € فارسی 😀\r\n');
    const response = await upload(content);
    assert.equal(response.status, 201);
    const result = await response.json(); assert.equal(result.success, true);
    first = rows()[0];
    assert.equal(first.id, result.upload.id); assert.equal(first.original_name, 'yourtext.txt');
    assert.equal(first.file_size, content.length); assert.match(first.received_at, /^\d{4}-.*Z$/);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, first.file_path)), content);
    assert.deepEqual(storedFiles(), [first.stored_name]);
    assert.equal(first.device_id, null); assert.equal(first.device_name, null); assert.equal(first.os_version, null);
  });
  await t.test('Unique filenames, newest-first list, empty valid text, and byte-preserving open/download', async () => {
    assert.equal((await upload()).status, 201);
    assert.equal((await upload(Buffer.alloc(0))).status, 201);
    const list = await (await fetch(base + '/api/uploads')).json();
    assert.equal(list.length, 3); assert.ok(list[0].id > list[1].id);
    assert.equal(new Set(rows().map(row => row.stored_name)).size, 3);
    const opened = await fetch(`${base}/api/uploads/${first.id}/open`);
    assert.match(opened.headers.get('content-type'), /^text\/plain; charset=utf-8/);
    assert.match(opened.headers.get('content-security-policy'), /sandbox/);
    const downloaded = await fetch(`${base}/api/uploads/${first.id}/download`);
    assert.match(downloaded.headers.get('content-disposition'), /attachment.*yourtext.txt/);
    assert.equal(await downloaded.text(), await opened.text());
  });
  await t.test('Rejects invalid UTF-8, binary, wrong extension, unexpected field, missing file and extra parts', async () => {
    const before = storedFiles(); const count = rows().length;
    assert.equal((await upload(Buffer.from([0xc3, 0x28]))).status, 415);
    assert.equal((await upload(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0xe2]))).status, 415);
    assert.equal((await upload(Buffer.from('abc\x00def'))).status, 415);
    assert.equal((await upload(COUNT, 'bad.exe')).status, 415);
    assert.equal((await upload(COUNT, 'yourtext.txt', '/create', 'other')).status, 400);
    assert.equal((await fetch(base + '/create', { method: 'POST' })).status, 400);
    assert.equal((await fetch(base + '/create', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: 'invalid' })).status, 400);
    assert.equal((await fetch(base + '/create', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=broken' },
      body: '--broken\r\nContent-Disposition: form-data; name="file"; filename="file.txt"\r\n\r\npartial' })).status, 400);
    const form = new FormData(); form.append('file', new Blob([COUNT]), 'yourtext.txt'); form.append('extra', 'value');
    assert.equal((await fetch(base + '/create', { method: 'POST', body: form })).status, 400);
    const multiple = new FormData();
    multiple.append('file', new Blob([COUNT]), 'a.txt'); multiple.append('file', new Blob([COUNT]), 'b.txt');
    assert.equal((await fetch(base + '/create', { method: 'POST', body: multiple })).status, 400);
    assert.deepEqual(storedFiles(), before); assert.equal(rows().length, count);
  });
  await t.test('Rejects text over 5 MiB and setup over 64 MiB without partial files/rows', async () => {
    const before = storedFiles();
    assert.equal((await upload(Buffer.alloc(TEXT_LIMIT + 1, 65))).status, 413);
    assert.equal((await upload(Buffer.alloc(SETUP_LIMIT + 1), 'PDF-Setup.exe', '/api/appsetup')).status, 413);
    assert.deepEqual(storedFiles(), before);
  });
  await t.test('Rejects traversal filenames, unsafe IDs, DNS rebinding, cross-site changes and private data access', async () => {
    assert.equal((await upload(COUNT, '../escape.txt')).status, 400);
    assert.equal((await upload(COUNT, '..\\escape.txt')).status, 400);
    assert.equal((await upload(COUNT, 'C:\\escape.txt')).status, 400);
    for (const id of ['0', 'NaN', '-1', '999999999999999999999999']) {
      assert.equal((await fetch(`${base}/api/uploads/${id}/open`)).status, 400);
    }
    assert.equal((await fetch(`${base}/api/uploads/999999/open`)).status, 404);
    assert.equal((await fetch(base + '/database.sqlite')).status, 404);
    assert.equal((await fetch(base + '/uploads/' + first.stored_name)).status, 404);
    const rebinding = await new Promise((resolve, reject) => {
      const request = http.get(base + '/api/uploads', { headers: { Host: 'evil.example:8000' } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      request.on('error', reject);
    });
    assert.equal(rebinding, 403);
    assert.equal((await upload(COUNT, 'yourtext.txt', '/create', 'file', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await fetch(`${base}/api/uploads/${first.id}`, { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    const row = rows()[0];
    service.db.prepare('UPDATE uploads SET file_path=? WHERE id=?').run('../server.js', row.id);
    assert.equal((await fetch(`${base}/api/uploads/${row.id}/open`)).status, 500);
    service.db.prepare('UPDATE uploads SET file_path=? WHERE id=?').run(row.file_path, row.id);
  });
  await t.test('A failed database insert gives 500 and removes its new file', async () => {
    const before = storedFiles(); const count = rows().length;
    service.db.exec("CREATE TRIGGER reject_upload BEFORE INSERT ON uploads BEGIN SELECT RAISE(ABORT,'test failure'); END");
    assert.equal((await upload()).status, 500);
    assert.deepEqual(storedFiles(), before); assert.equal(rows().length, count);
    service.db.exec('DROP TRIGGER reject_upload');
  });
  await t.test('Database errors do not delete files; normal deletion removes file and row', async () => {
    service.db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON uploads BEGIN SELECT RAISE(ABORT,'test failure'); END");
    assert.equal((await fetch(`${base}/api/uploads/${first.id}`, { method: 'DELETE' })).status, 500);
    assert.ok(fs.existsSync(path.join(dataDir, first.file_path)));
    assert.ok(service.db.prepare('SELECT id FROM uploads WHERE id=?').get(first.id));
    service.db.exec('DROP TRIGGER reject_delete');
    assert.equal((await fetch(`${base}/api/uploads/${first.id}`, { method: 'DELETE' })).status, 200);
    assert.ok(!fs.existsSync(path.join(dataDir, first.file_path)));
    assert.ok(!service.db.prepare('SELECT id FROM uploads WHERE id=?').get(first.id));
    assert.equal((await fetch(`${base}/api/uploads/${first.id}`, { method: 'DELETE' })).status, 404);
  });
  await t.test('Missing files return 404 and stale records can still be deleted', async () => {
    const row = rows()[0]; fs.unlinkSync(path.join(dataDir, row.file_path));
    assert.equal((await fetch(`${base}/api/uploads/${row.id}/open`)).status, 404);
    assert.equal((await fetch(`${base}/api/uploads/${row.id}/download`)).status, 404);
    assert.equal((await fetch(`${base}/api/uploads/${row.id}`, { method: 'DELETE' })).status, 200);
  });
  await t.test('Admin HTML, JavaScript and CSS are served; uploaded markup opens as inert text', async () => {
    for (const route of ['/admin', '/admin.js', '/style.css']) assert.equal((await fetch(base + route)).status, 200);
    const response = await upload(Buffer.from('<script>window.bad=true</script>'), 'markup.txt');
    const id = (await response.json()).upload.id;
    const opened = await fetch(`${base}/api/uploads/${id}/open`);
    assert.equal(opened.headers.get('x-content-type-options'), 'nosniff');
    assert.match(opened.headers.get('content-type'), /^text\/plain/);
    assert.equal(await opened.text(), '<script>window.bad=true</script>');
  });
  await t.test('Setup validates PE structure; stores a single current setup; serves exact attachment bytes', async () => {
    assert.equal((await upload(COUNT, 'PDF-Setup.exe', '/api/appsetup')).status, 415);
    assert.equal((await upload(COUNT, 'other.exe', '/api/appsetup')).status, 415);
    const bytes = fs.readFileSync(SETUP);
    assert.equal((await upload(bytes, 'PDF-Setup.exe', '/api/appsetup')).status, 201);
    const old = service.db.prepare('SELECT * FROM appsetup').get();
    service.db.exec("CREATE TRIGGER reject_setup BEFORE UPDATE ON appsetup BEGIN SELECT RAISE(ABORT,'test failure'); END");
    const before = storedFiles();
    assert.equal((await upload(bytes, 'PDF-Setup.exe', '/api/appsetup')).status, 500);
    assert.deepEqual(storedFiles(), before);
    assert.equal(service.db.prepare('SELECT stored_name FROM appsetup').get().stored_name, old.stored_name);
    service.db.exec('DROP TRIGGER reject_setup');
    assert.equal((await upload(bytes, 'PDF-Setup.exe', '/api/appsetup')).status, 201);
    assert.ok(!fs.existsSync(path.join(dataDir, old.file_path)));
    assert.equal(service.db.prepare('SELECT count(*) AS n FROM appsetup').get().n, 1);
    const response = await fetch(base + '/download/app');
    assert.match(response.headers.get('content-disposition'), /attachment.*PDF-Setup.exe/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const home = await (await fetch(base + '/')).text();
    assert.match(home, /download\.js/); assert.match(home, /href="\/download\/app"/);
    assert.match(await (await fetch(base + '/download.js')).text(), /getElementById\('download'\).click\(\)/);
    assert.equal((await (await fetch(base + '/api/appsetup')).json()).original_name, 'PDF-Setup.exe');
    const current = service.db.prepare('SELECT * FROM appsetup').get();
    fs.unlinkSync(path.join(dataDir, current.file_path));
    assert.equal((await fetch(base + '/download/app')).status, 404);
    assert.match(await (await fetch(base + '/')).text(), /No file available\./);
  });
  await t.test('Concurrent valid uploads each produce exactly one distinct file and record', async () => {
    const before = rows().length;
    const responses = await Promise.all(Array.from({ length: 20 }, () => upload()));
    assert.ok(responses.every(response => response.status === 201));
    assert.equal(rows().length, before + 20);
    for (const row of rows()) assert.equal(fs.statSync(path.join(dataDir, row.file_path)).size, row.file_size);
  });
  await t.test('Device metadata is persisted and returned with its upload; Unicode labels survive exactly', async () => {
    const device = { ...DEVICE, device_name: 'CODE-LAPTOP فارسی' };
    const response = await upload(COUNT, 'yourtext.txt', '/create', 'file', undefined, device);
    assert.equal(response.status, 201);
    const received = (await response.json()).upload;
    const row = service.db.prepare('SELECT * FROM uploads WHERE id=?').get(received.id);
    const listed = (await (await fetch(base + '/api/uploads')).json()).find(value => value.id === row.id);
    for (const [key, value] of Object.entries(device)) {
      assert.equal(row[key], value); assert.equal(received[key], value); assert.equal(listed[key], value);
    }
    assert.deepEqual(fs.readFileSync(path.join(dataDir, row.file_path)), COUNT);
  });
  await t.test('Invalid, partial, duplicate, oversized and unexpected metadata is rejected without files or rows', async () => {
    const before = storedFiles(); const count = rows().length;
    for (const device of [
      { device_id: DEVICE.device_id }, { ...DEVICE, device_id: 'not-a-uuid' },
      { ...DEVICE, device_name: '' }, { ...DEVICE, device_name: 'a'.repeat(256) },
      { ...DEVICE, os_version: 'a'.repeat(97) }, { ...DEVICE, device_name: 'bad\r\nvalue' },
      { ...DEVICE, device_id: 'a'.repeat(1025) }, { ...DEVICE, extra: 'unexpected' }
    ]) assert.equal((await upload(COUNT, 'yourtext.txt', '/create', 'file', undefined, device)).status, 400);
    const duplicate = new FormData();
    duplicate.append('file', new Blob([COUNT]), 'yourtext.txt');
    duplicate.append('device_id', DEVICE.device_id); duplicate.append('device_id', DEVICE.device_id);
    assert.equal((await fetch(base + '/create', { method: 'POST', body: duplicate })).status, 400);
    assert.deepEqual(storedFiles(), before); assert.equal(rows().length, count);
  });
  await t.test('Real C++ WinHTTP client uses /create, clears only after saved file+record, retains after DB failure', {
    skip: !fs.existsSync(NATIVE) && 'Build tests/Test-Upload.ps1 first to enable native-client acceptance.'
  }, async () => {
    const fixture = path.join(dataDir, 'yourtext.txt'); fs.writeFileSync(fixture, COUNT);
    async function runClient() {
      const child = spawn(NATIVE, ['once', fixture], { windowsHide: true, stdio: 'ignore',
        env: { ...process.env, PDF_TEST_PORT: String(listener.address().port) } });
      const [code] = await once(child, 'exit'); return code;
    }
    const count = rows().length;
    assert.equal(await runClient(), 0); assert.equal(fs.statSync(fixture).size, 0);
    assert.equal(rows().length, count + 1);
    for (const [key, value] of Object.entries(DEVICE)) assert.equal(rows()[0][key], value);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, rows()[0].file_path)), COUNT);
    fs.writeFileSync(fixture, COUNT);
    service.db.exec("CREATE TRIGGER reject_native BEFORE INSERT ON uploads BEGIN SELECT RAISE(ABORT,'test failure'); END");
    const before = storedFiles();
    assert.equal(await runClient(), 1); assert.deepEqual(fs.readFileSync(fixture), COUNT);
    assert.deepEqual(storedFiles(), before); assert.equal(rows().length, count + 1);
    service.db.exec('DROP TRIGGER reject_native');
    assert.equal(await runClient(), 0); assert.equal(fs.statSync(fixture).size, 0);
    assert.equal(rows().length, count + 2);
    assert.equal(rows()[0].device_id, rows()[1].device_id);
  });
});
