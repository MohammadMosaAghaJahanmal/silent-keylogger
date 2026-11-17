'use strict';
const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// Works locally by default; works behind cPanel/Passenger when PORT is assigned.
const HOSTED = Boolean(process.env.PORT || process.env.NODE_ENV === 'production' ||
  process.env.PASSENGER_APP_ENV);

function getListenHost() {
  return process.env.HOST || (HOSTED ? '0.0.0.0' : '127.0.0.1');
}

function getListenPort() {
  const port = Number(process.env.PORT || 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be a valid port number (0-65535).');
  }
  return port;
}

function equalSecrets(supplied, expected) {
  if (typeof supplied !== 'string' || !supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireToken(token) {
  return (req, _res, next) => {
    if (!token) return next();
    const authorization = req.headers.authorization || '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!equalSecrets(req.get('x-api-key'), token) && !equalSecrets(bearer, token)) {
      return next(new HttpError(401, 'A valid API token is required.'));
    }
    next();
  };
}

function requestHostname(value) {
  if (typeof value !== 'string' || !value || /[\\\s/]/.test(value)) {
    throw new HttpError(400, 'Invalid Host header.');
  }
  try {
    const url = new URL('http://' + value);
    return { hostname: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), host: url.host.toLowerCase() };
  } catch {
    throw new HttpError(400, 'Invalid Host header.');
  }
}

function fallbackPage(res, name, fallback) {
  const file = path.join(PUBLIC_DIR, name);
  if (fs.existsSync(file)) return res.sendFile(file);
  return res.type('html').send(fallback);
}
// Upload any file type, provided it is strictly smaller than 10 MiB.
const UPLOAD_LIMIT = 10 * 1024 * 1024;
// Keep the old exported names for existing clients/tests.
const TEXT_LIMIT = UPLOAD_LIMIT;
const SETUP_LIMIT = UPLOAD_LIMIT;
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function logIncomingRequest(req) {
  const requestPath = req.url.split('?', 1)[0];
  console.log(`Request coming in via ${req.method} ${requestPath}`);
}
// DATA_DIR can override the default so hosted deployments can use private storage.
function createApp({
  dataDir = process.env.DATA_DIR || ROOT,
  log = console.error,
  localOnly = getListenHost() === '127.0.0.1' || getListenHost() === 'localhost'
} = {}) {
  dataDir = path.resolve(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  if (fs.lstatSync(uploadDir).isSymbolicLink()) throw new Error('uploads must be a real directory.');
  const db = new DatabaseSync(path.join(dataDir, 'database.sqlite'));
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL, file_size INTEGER NOT NULL CHECK(file_size >= 0),
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS appsetup (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL, file_size INTEGER NOT NULL CHECK(file_size >= 0),
        received_at TEXT NOT NULL
      );`);
    // Add nullable columns without rewriting existing files, rows or IDs.
    db.exec('BEGIN IMMEDIATE');
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(uploads)').all().map(column => column.name));
      for (const column of ['device_id', 'device_name', 'os_version']) {
        if (!columns.has(column)) db.exec(`ALTER TABLE uploads ADD COLUMN ${column} TEXT`);
      }
      // Older installations have a > 0 constraint for appsetup files.
      // Migrate it so a zero-byte file is also permitted, without losing data.
      const setupSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='appsetup'").get()?.sql || '';
      if (/CHECK\s*\(\s*file_size\s*>\s*0\s*\)/i.test(setupSql)) {
        db.exec(`CREATE TABLE appsetup_new (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE,
          file_path TEXT NOT NULL, file_size INTEGER NOT NULL CHECK(file_size >= 0),
          received_at TEXT NOT NULL
        );
        INSERT INTO appsetup_new (id,original_name,stored_name,file_path,file_size,received_at)
          SELECT id,original_name,stored_name,file_path,file_size,received_at FROM appsetup;
        DROP TABLE appsetup;
        ALTER TABLE appsetup_new RENAME TO appsetup;`);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { db.close(); throw error; }
  const app = express();
  app.disable('x-powered-by');
  app.use((req, _res, next) => {
    logIncomingRequest(req);
    next();
  });
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    });
    // Local access stays restricted; deployed hosts may use any domain unless
    // ALLOWED_HOSTS is configured. No hardcoded localhost restriction on cPanel.
    let requestHost;
    try { requestHost = requestHostname(req.headers.host); }
    catch (error) { return next(error); }
    if (localOnly && !['localhost', '127.0.0.1', '::1'].includes(requestHost.hostname)) {
      return next(new HttpError(403, 'Use the local server address.'));
    }
    const allowedHosts = (process.env.ALLOWED_HOSTS || '').split(',')
      .map(value => value.trim().toLowerCase()).filter(Boolean);
    if (allowedHosts.length && !allowedHosts.includes(requestHost.hostname)) {
      return next(new HttpError(403, 'Host is not allowed.'));
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        return next(new HttpError(403, 'Cross-site changes are not allowed.'));
      }
      const origin = req.headers.origin;
      if (origin) {
        try {
          const parsedOrigin = new URL(origin);
          const publicOrigin = process.env.PUBLIC_ORIGIN;
          const permitted = publicOrigin
            ? parsedOrigin.origin === new URL(publicOrigin).origin
            : ['http:', 'https:'].includes(parsedOrigin.protocol) &&
              parsedOrigin.host.toLowerCase() === requestHost.host;
          if (!permitted) return next(new HttpError(403, 'Cross-site changes are not allowed.'));
        } catch {
          return next(new HttpError(403, 'Invalid request Origin.'));
        }
      }
    }
    next();
  });
  const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (_req, _file, callback) => callback(null, randomUUID() + '.pending')
  });
  function receiver(kind) {
    console.log(`Receiver for ${kind} uploads is ready.`);
    return multer({
      storage,
      // Only a size limit: no extension, MIME type, filename or content checks.
      limits: {
        fileSize: UPLOAD_LIMIT,
        files: 1,
        fields: kind === 'text' ? 3 : 0,
        parts: kind === 'text' ? 4 : 1,
        fieldSize: 1024,
        fieldNameSize: 100,
        headerPairs: 32
      }
    }).single('file');
  }
  function remove(file) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function safePath(row, extension) {
    if (!row || !new RegExp(`^[a-f0-9-]{36}\\.(?:${extension}|upload)$`).test(row.stored_name)
        || row.file_path !== `uploads/${row.stored_name}`) {
      throw new HttpError(500, 'Invalid stored file record.');
    }
    return path.join(uploadDir, row.stored_name);
  }
  function existing(row, extension) {
    const file = safePath(row, extension);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'File is no longer available.');
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new HttpError(404, 'File is no longer available.');
    return file;
  }
  function syncFile(file) {
    const fd = fs.openSync(file, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  function metadata(row) {
    if (!row) return null;
    const result = { id: row.id, original_name: row.original_name, file_size: row.file_size, received_at: row.received_at };
    if ('device_id' in row) Object.assign(result, {
      device_id: row.device_id, device_name: row.device_name, os_version: row.os_version
    });
    return result;
  }
  function deviceMetadata(body = {}) {
    const keys = Object.keys(body);
    const allowed = ['device_id', 'device_name', 'os_version'];
    if (!keys.length) return { device_id: null, device_name: null, os_version: null };
    if (keys.length !== 3 || keys.some(key => !allowed.includes(key))) {
      throw new HttpError(400, 'Provide all three device fields, or omit them for an older client.');
    }
    const result = {};
    for (const field of allowed) {
      const value = body[field];
      const max = field === 'device_id' ? 36 : field === 'device_name' ? 255 : 96;
      if (typeof value !== 'string' || !value.trim() || [...value].length > max
          || /[\x00-\x1f\x7f]/.test(value)) {
        throw new HttpError(400, 'Invalid device metadata.');
      }
      result[field] = value.trim();
    }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.device_id)) {
      throw new HttpError(400, 'Device ID must be an application UUID.');
    }
    result.device_id = result.device_id.toLowerCase();
    return result;
  }
  function saveUpload(kind) {
    console.log(`Save handler for ${kind} uploads is ready.`);
    return async (req, res, next) => {
      let newFile;
      let saved = false;
      try {
        if (!req.file) throw new HttpError(400, 'Provide one file using the field named file.');
        const device = kind === 'text' ? deviceMetadata(req.body) : null;
        // Multer allows up to the limit; the application requires strictly LESS than 10 MiB.
        if (req.file.size >= UPLOAD_LIMIT) {
          throw new HttpError(413, 'File must be smaller than 10 MB.');
        }
        syncFile(req.file.path);
        const stored = randomUUID() + '.upload';
        newFile = path.join(uploadDir, stored);
        const row = { original_name: req.file.originalname, stored_name: stored,
          file_path: `uploads/${stored}`, file_size: req.file.size, received_at: new Date().toISOString() };
        // Only acknowledge after the durable file and SQLite commit both succeed.
        fs.renameSync(req.file.path, newFile);
        const old = kind === 'setup' ? db.prepare('SELECT * FROM appsetup WHERE id=1').get() : null;
        if (kind === 'text') {
          Object.assign(row, device);
          const result = db.prepare(`INSERT INTO uploads
            (original_name,stored_name,file_path,file_size,received_at,device_id,device_name,os_version)
            VALUES (?,?,?,?,?,?,?,?)`)
            .run(row.original_name, stored, row.file_path, row.file_size, row.received_at,
              device.device_id, device.device_name, device.os_version);
          row.id = Number(result.lastInsertRowid);
        } else {
          db.prepare(`INSERT INTO appsetup (id,original_name,stored_name,file_path,file_size,received_at)
            VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET original_name=excluded.original_name,
            stored_name=excluded.stored_name,file_path=excluded.file_path,
            file_size=excluded.file_size,received_at=excluded.received_at`)
            .run(row.original_name, stored, row.file_path, row.file_size, row.received_at);
          row.id = 1;
        }
        saved = true;
        if (old) {
          try { remove(safePath(old, 'exe')); } catch (error) { log('Previous setup cleanup:', error.message); }
        }
        res.status(201).json({ success: true, upload: metadata(row) });
      } catch (error) { next(error); }
      finally {
        // Failed size checks/DB writes must not leave an accepted-looking upload.
        for (const file of [req.file?.path, !saved && newFile].filter(Boolean)) {
          try { remove(file); } catch (error) { log('Upload cleanup:', error.message); }
        }
      }
    };
  }
  // Optional separate keys make a public deployment safer without changing
  // existing local clients. Set environment variables for hosted deployment.
  const adminAuth = requireToken(process.env.ADMIN_TOKEN);
  const uploadAuth = requireToken(process.env.UPLOAD_TOKEN);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.post('/create', uploadAuth, receiver('text'), saveUpload('text'));
  app.post('/api/appsetup', adminAuth, receiver('setup'), saveUpload('setup'));
  app.get('/api/appsetup', (_req, res) => res.json(metadata(db.prepare('SELECT * FROM appsetup WHERE id=1').get())));
  app.get('/api/uploads', adminAuth, (_req, res) => {
    res.json(db.prepare(`SELECT id,original_name,file_size,received_at,device_id,device_name,os_version
      FROM uploads ORDER BY id DESC`).all());
  });
  app.get('/', (_req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM appsetup WHERE id=1').get();
      if (row) {
        try { existing(row, 'exe'); } catch (error) {
          if (error.status !== 404) throw error;
          return fallbackPage(res, 'empty.html', '<h2>No setup file uploaded yet.</h2>');
        }
        return fallbackPage(res, 'index.html', '<h2>Setup is available</h2><p><a href="/download/app">Download setup</a></p>');
      }
      fallbackPage(res, 'empty.html', '<h2>No setup file uploaded yet.</h2>');
    } catch (error) { next(error); }
  });
  app.get('/download/app', (_req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM appsetup WHERE id=1').get();
      if (!row) throw new HttpError(404, 'No file available.');
      const file = existing(row, 'exe');
      res.download(path.basename(file), row.original_name, { root: uploadDir, headers: { 'Content-Type': 'application/octet-stream' } }, error => { if (error) next(error); });
    } catch (error) { next(error); }
  });
  function countRow(req) {
    if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))) {
      throw new HttpError(400, 'Invalid file ID.');
    }
    const row = db.prepare('SELECT * FROM uploads WHERE id=?').get(Number(req.params.id));
    if (!row) throw new HttpError(404, 'Upload not found.');
    return row;
  }
  app.get('/api/uploads/:id/open', adminAuth, (req, res, next) => {
    try {
      const row = countRow(req);
      const file = existing(row, 'txt');
      res.set('Content-Security-Policy', "sandbox; default-src 'none'");
      res.download(path.basename(file), row.original_name,
        { root: uploadDir, headers: { 'Content-Type': 'application/octet-stream' } },
        error => { if (error) next(error); });
    } catch (error) { next(error); }
  });
  app.get('/api/uploads/:id/download', adminAuth, (req, res, next) => {
    try {
      const row = countRow(req);
      const file = existing(row, 'txt');
      res.download(path.basename(file), row.original_name, { root: uploadDir, headers: { 'Content-Type': 'application/octet-stream' } }, error => { if (error) next(error); });
    } catch (error) { next(error); }
  });
  app.delete('/api/uploads/:id', adminAuth, (req, res, next) => {
    let moved;
    let original;
    try {
      const row = countRow(req);
      original = safePath(row, 'txt');
      // Renaming lets a failed SQLite commit restore the original file.
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM uploads WHERE id=?').run(row.id);
        try {
          existing(row, 'txt');
          moved = path.join(uploadDir, randomUUID() + '.deleting');
          fs.renameSync(original, moved);
        } catch (error) { if (error.status !== 404) throw error; moved = undefined; }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        if (moved && fs.existsSync(moved)) fs.renameSync(moved, original);
        throw error;
      }
      if (moved) remove(moved);
      res.json({ success: true });
    } catch (error) { next(error); }
  });
  app.get('/admin', (_req, res) => {
    const adminPage = path.join(PUBLIC_DIR, 'admin.html');
    if (fs.existsSync(adminPage)) return res.sendFile(adminPage);
    res.status(404).send('Admin page not supplied. Add public/admin.html.');
  });
  app.use(express.static(PUBLIC_DIR, { index: false, dotfiles: 'deny' }));
  app.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    let status = error instanceof HttpError ? error.status
      : Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    let message = error instanceof HttpError ? error.message
      : status === 404 ? 'File is no longer available.' : status < 500 ? 'Invalid request.' : 'Unable to complete the request.';
    if (error instanceof multer.MulterError) {
      status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = error.code === 'LIMIT_FILE_SIZE' ? 'File must be smaller than 10 MB.'
        : 'Invalid multipart fields. Use one file and only the supported device fields.';
    } else if (['Multipart: Boundary not found', 'Malformed part header', 'Unexpected end of form', 'Unexpected end of file'].includes(error.message)) {
      status = 400; message = 'Invalid multipart upload.';
    } else if (error.code === 'ENOENT') { status = 404; message = 'File is no longer available.'; }
    if (status === 500) log(error.message);
    res.status(status).json({ error: message });
  });
  return { app, db, dataDir, uploadDir, close: () => db.close() };
}
function startServer() {
  const host = getListenHost();
  const port = getListenPort();
  const service = createApp({ localOnly: host === '127.0.0.1' || host === 'localhost' });
  const server = service.app.listen(port, host, () => {
    const address = server.address();
    const shownHost = host === '0.0.0.0' ? 'localhost' : host;
    console.log(`PDF server listening on ${host}:${address.port}`);
    console.log(`Local URL: http://${shownHost}:${address.port}/`);
    if (host === '0.0.0.0' && !process.env.ADMIN_TOKEN) {
      console.warn('WARNING: ADMIN_TOKEN is unset. Public users may change or delete stored files.');
    }
    if (host === '0.0.0.0' && !process.env.UPLOAD_TOKEN) {
      console.warn('WARNING: UPLOAD_TOKEN is unset. Anyone can send uploads to /create.');
    }
  });
  // Refuse CONNECT proxy tunnels, like the original local server.
  server.on('connect', (req, socket) => {
    logIncomingRequest(req);
    socket.destroy();
  });
  server.on('error', error => {
    console.error('Server startup failed:', error.message);
    service.close();
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(() => service.close());
    server.closeIdleConnections();
  });
  return { ...service, server };
}

if (require.main === module) {
  try { startServer(); }
  catch (error) { console.error('Server startup failed:', error.message); process.exitCode = 1; }
}
module.exports = { createApp, startServer, UPLOAD_LIMIT, TEXT_LIMIT, SETUP_LIMIT };
