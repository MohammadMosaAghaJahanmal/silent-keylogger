'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const TEXT_LIMIT = 5 * 1024 * 1024;
const SETUP_LIMIT = 64 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// A separate directory under server/ is allowed for isolated integration tests.
function createApp({ dataDir = ROOT, log = console.error } = {}) {
  dataDir = path.resolve(dataDir);
  if (dataDir !== ROOT && !dataDir.startsWith(ROOT + path.sep)) {
    throw new Error('Data directory must be inside server/.');
  }
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
        file_path TEXT NOT NULL, file_size INTEGER NOT NULL CHECK(file_size > 0),
        received_at TEXT NOT NULL
      );`);
    // Add nullable columns without rewriting existing files, rows or IDs.
    db.exec('BEGIN IMMEDIATE');
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(uploads)').all().map(column => column.name));
      for (const column of ['device_id', 'device_name', 'os_version']) {
        if (!columns.has(column)) db.exec(`ALTER TABLE uploads ADD COLUMN ${column} TEXT`);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) { db.close(); throw error; }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer'
    });
    // Bind to loopback and reject DNS rebinding and cross-site browser writes.
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) {
      return next(new HttpError(403, 'Use the local server address.'));
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if ((origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
        return next(new HttpError(403, 'Cross-site changes are not allowed.'));
      }
    }
    next();
  });

  const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (_req, _file, callback) => callback(null, randomUUID() + '.pending')
  });
  function receiver(kind) {
    return multer({
      storage, preservePath: true,
      limits: { fileSize: kind === 'text' ? TEXT_LIMIT : SETUP_LIMIT,
        files: 1, fields: kind === 'text' ? 3 : 0, parts: kind === 'text' ? 4 : 1,
        fieldSize: 1024, fieldNameSize: 100, headerPairs: 32 },
      fileFilter(_req, file, callback) {
        const name = file.originalname;
        // Never derive a filesystem path from an incoming filename.
        if (!name || name.length > 200 || /[\\/:\x00-\x1f\x7f]/.test(name) || name !== path.basename(name)) {
          return callback(new HttpError(400, 'Invalid filename.'));
        }
        if (kind === 'text' ? !/\.txt$/i.test(name) : !/^PDF-Setup\.exe$/i.test(name)) {
          return callback(new HttpError(415, kind === 'text'
            ? 'Upload a UTF-8 .txt file.' : 'Upload PDF-Setup.exe.'));
        }
        callback(null, true);
      }
    }).single('file');
  }

  function remove(file) {
    try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function safePath(row, extension) {
    if (!row || !new RegExp(`^[a-f0-9-]{36}\\.${extension}$`).test(row.stored_name)
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
  async function validateText(file) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      for await (const chunk of fs.createReadStream(file)) {
        const text = decoder.decode(chunk, { stream: true });
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
          throw new HttpError(415, 'File contains binary control characters.');
        }
      }
      decoder.decode();
    } catch (error) {
      if (error instanceof TypeError) throw new HttpError(415, 'File must contain valid UTF-8 text.');
      throw error;
    }
  }
  function validateSetup(file) {
    const fd = fs.openSync(file, 'r');
    try {
      const header = Buffer.alloc(64);
      const length = fs.fstatSync(fd).size;
      if (fs.readSync(fd, header, 0, 64, 0) !== 64 || header.toString('ascii', 0, 2) !== 'MZ') {
        throw new HttpError(415, 'Setup must be a Windows executable.');
      }
      const offset = header.readUInt32LE(60);
      const pe = Buffer.alloc(24);
      if (offset < 64 || offset > length - 24 || fs.readSync(fd, pe, 0, 24, offset) !== 24
          || pe.readUInt32LE(0) !== 0x4550 || !(pe.readUInt16LE(22) & 2)
          || (pe.readUInt16LE(22) & 0x2000)) {
        throw new HttpError(415, 'Setup must be a Windows executable.');
      }
    } finally { fs.closeSync(fd); }
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
    return async (req, res, next) => {
      let newFile;
      let saved = false;
      try {
        if (!req.file) throw new HttpError(400, 'Provide one file using the field named file.');
        const device = kind === 'text' ? deviceMetadata(req.body) : null;
        if (kind === 'text') await validateText(req.file.path);
        else validateSetup(req.file.path);
        syncFile(req.file.path);
        const stored = randomUUID() + (kind === 'text' ? '.txt' : '.exe');
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
        // Failed validation/DB writes must not leave an accepted-looking upload.
        for (const file of [req.file?.path, !saved && newFile].filter(Boolean)) {
          try { remove(file); } catch (error) { log('Upload cleanup:', error.message); }
        }
      }
    };
  }
  app.post('/create', receiver('text'), saveUpload('text'));
  app.post('/api/appsetup', receiver('setup'), saveUpload('setup'));
  app.get('/api/appsetup', (_req, res) => res.json(metadata(db.prepare('SELECT * FROM appsetup WHERE id=1').get())));
  app.get('/api/uploads', (_req, res) => {
    res.json(db.prepare(`SELECT id,original_name,file_size,received_at,device_id,device_name,os_version
      FROM uploads ORDER BY id DESC`).all());
  });

  app.get('/', (_req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM appsetup WHERE id=1').get();
      if (row) {
        try { existing(row, 'exe'); } catch (error) { if (error.status !== 404) throw error; return res.sendFile(path.join(ROOT, 'public', 'empty.html')); }
        return res.sendFile(path.join(ROOT, 'public', 'index.html'));
      }
      res.sendFile(path.join(ROOT, 'public', 'empty.html'));
    } catch (error) { next(error); }
  });
  app.get('/download/app', (_req, res, next) => {
    try {
      const row = db.prepare('SELECT * FROM appsetup WHERE id=1').get();
      if (!row) throw new HttpError(404, 'No file available.');
      const file = existing(row, 'exe');
      res.download(path.basename(file), 'PDF-Setup.exe', { root: uploadDir, headers: { 'Content-Type': 'application/octet-stream' } }, error => { if (error) next(error); });
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
  app.get('/api/uploads/:id/open', (req, res, next) => {
    try {
      const file = existing(countRow(req), 'txt');
      res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Security-Policy': "sandbox; default-src 'none'" });
      res.sendFile(path.basename(file), { root: uploadDir }, error => { if (error) next(error); });
    } catch (error) { next(error); }
  });
  app.get('/api/uploads/:id/download', (req, res, next) => {
    try {
      const row = countRow(req);
      const file = existing(row, 'txt');
      res.download(path.basename(file), row.original_name, { root: uploadDir, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }, error => { if (error) next(error); });
    } catch (error) { next(error); }
  });
  app.delete('/api/uploads/:id', (req, res, next) => {
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
  app.get('/admin', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
  app.use(express.static(path.join(ROOT, 'public'), { index: false, dotfiles: 'deny' }));
  app.use((_req, _res, next) => next(new HttpError(404, 'Not found.')));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    let status = error instanceof HttpError ? error.status
      : Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    let message = error instanceof HttpError ? error.message
      : status === 404 ? 'File is no longer available.' : status < 500 ? 'Invalid request.' : 'Unable to complete the request.';
    if (error instanceof multer.MulterError) {
      status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the upload size limit.'
        : 'Invalid multipart fields. Use one file and only the supported device fields.';
    } else if (['Multipart: Boundary not found', 'Malformed part header', 'Unexpected end of form', 'Unexpected end of file'].includes(error.message)) {
      status = 400; message = 'Invalid multipart upload.';
    } else if (error.code === 'ENOENT') { status = 404; message = 'File is no longer available.'; }
    if (status === 500) log(error.message);
    res.status(status).json({ error: message });
  });
  return { app, db, dataDir, uploadDir, close: () => db.close() };
}

if (require.main === module) {
  try {
    const service = createApp();
    const server = service.app.listen(8000, '127.0.0.1', () => {
      console.log('PDF server: http://127.0.0.1:8000/  Admin: http://127.0.0.1:8000/admin');
    });
    server.on('error', error => { console.error('Server startup failed:', error.message); service.close(); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      server.close(() => { service.close(); });
      server.closeIdleConnections();
    });
  } catch (error) { console.error('Server startup failed:', error.message); process.exitCode = 1; }
}

module.exports = { createApp, TEXT_LIMIT, SETUP_LIMIT };
