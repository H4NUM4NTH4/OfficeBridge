const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { DatabaseSync: Database } = require('node:sqlite');
const { Server } = require('socket.io');

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const port = positiveNumber(process.env.PORT, 3000);
const databasePath = path.resolve(__dirname, process.env.DATABASE_PATH || '../../data/officebridge.sqlite');
const storagePath = path.resolve(__dirname, process.env.STORAGE_PATH || '../../storage');
const maxUploadSize = positiveNumber(process.env.MAX_UPLOAD_SIZE, 10 * 1024 * 1024);
const defaultExpirationMinutes = positiveNumber(process.env.DEFAULT_ROOM_EXPIRATION_MINUTES, 60);
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.mkdirSync(storagePath, { recursive: true });

const db = new Database(databasePath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(id, room_id)
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    original_filename TEXT NOT NULL, stored_filename TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL, size INTEGER NOT NULL,
    uploader_id TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(uploader_id, room_id) REFERENCES users(id, room_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS shared_texts (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, content TEXT NOT NULL, language TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id, room_id) REFERENCES users(id, room_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_rooms_expiry ON rooms(expires_at);
  CREATE INDEX IF NOT EXISTS idx_files_room ON files(room_id);
  CREATE INDEX IF NOT EXISTS idx_texts_room ON shared_texts(room_id, created_at);
`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });
app.use(express.json({ limit: '256kb' }));

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const now = () => new Date().toISOString();
const roomByCode = db.prepare('SELECT * FROM rooms WHERE code = ?');
const memberById = db.prepare('SELECT id, display_name AS displayName FROM users WHERE id = ? AND room_id = ?');
function safeFilename(name) {
  const leaf = String(name || '').replace(/\\/g, '/').split('/').pop();
  const sanitized = leaf.replace(/[\x00-\x1f\x7f]/g, '').replace(/[<>:"|?*]/g, '_').trim().slice(0, 180);
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : 'upload';
}
function getActiveRoom(code) {
  const room = roomByCode.get(String(code || '').toUpperCase());
  if (!room) throw new ApiError(404, 'Room not found');
  if (room.status !== 'active' || Date.parse(room.expires_at) <= Date.now()) throw new ApiError(410, 'Room has expired');
  return room;
}
function getMember(req, room) {
  const userId = req.get('X-User-Id');
  if (!userId) throw new ApiError(401, 'X-User-Id header is required');
  const member = memberById.get(userId, room.id);
  if (!member) throw new ApiError(403, 'User is not a member of this room');
  return member;
}
function roomRoute(req, _res, next) {
  try { req.room = getActiveRoom(req.params.code); next(); } catch (error) { next(error); }
}
function requireMember(req, _res, next) {
  try { req.member = getMember(req, req.room); next(); } catch (error) { next(error); }
}
function publicRoom(room) {
  return { id: room.id, code: room.code, name: room.name, createdAt: room.created_at, expiresAt: room.expires_at,
    status: Date.parse(room.expires_at) <= Date.now() ? 'expired' : room.status };
}
function newRoomCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do { code = [...crypto.randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join(''); } while (roomByCode.get(code));
  return code;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, storagePath),
    filename: (_req, _file, callback) => callback(null, `${crypto.randomUUID()}.blob`),
  }),
  limits: { fileSize: maxUploadSize, files: 1 },
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.post('/api/rooms', async (req, res, next) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim().slice(0, 40) : '';
    if (!name) throw new ApiError(400, 'Room name is required');
    if (!displayName) throw new ApiError(400, 'Display name is required');
    const minutes = positiveNumber(req.body?.expirationMinutes, defaultExpirationMinutes);
    if (minutes > 7 * 24 * 60) throw new ApiError(400, 'Room expiration cannot exceed 7 days');
    const id = crypto.randomUUID(); const userId = crypto.randomUUID(); const code = newRoomCode(); const createdAt = now();
    const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO rooms(id, code, name, created_at, expires_at) VALUES(?, ?, ?, ?, ?)').run(id, code, name, createdAt, expiresAt);
      db.prepare('INSERT INTO users(id, room_id, display_name, created_at) VALUES(?, ?, ?, ?)').run(userId, id, displayName, createdAt);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const qrCode = await QRCode.toDataURL(code);
    res.status(201).json({ room: publicRoom(roomByCode.get(code)), user: { id: userId, displayName }, qrCode });
  } catch (error) { next(error); }
});

app.get('/api/rooms/:code', roomRoute, requireMember, async (req, res, next) => {
  try {
    const members = db.prepare('SELECT id, display_name AS displayName FROM users WHERE room_id = ? ORDER BY created_at').all(req.room.id);
    const qrCode = await QRCode.toDataURL(req.room.code);
    res.json({ room: publicRoom(req.room), members, qrCode });
  } catch (error) { next(error); }
});
app.post('/api/rooms/:code/join', roomRoute, (req, res, next) => {
  try {
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim().slice(0, 40) : '';
    if (!displayName) throw new ApiError(400, 'Display name is required');
    const user = { id: crypto.randomUUID(), displayName };
    db.prepare('INSERT INTO users(id, room_id, display_name, created_at) VALUES(?, ?, ?, ?)').run(user.id, req.room.id, displayName, now());
    io.to(req.room.code).emit('user:joined', { user });
    res.status(201).json({ room: publicRoom(req.room), user });
  } catch (error) { next(error); }
});

app.get('/api/rooms/:code/files', roomRoute, requireMember, (req, res) => {
  const files = db.prepare(`SELECT id, original_filename AS originalFilename, mime_type AS mimeType, size,
    uploader_id AS uploaderId, created_at AS createdAt FROM files WHERE room_id = ? ORDER BY created_at DESC`).all(req.room.id);
  res.json({ files });
});
app.post('/api/rooms/:code/files', roomRoute, requireMember, (req, res, next) => {
  upload.single('file')(req, res, (error) => {
    if (error) return next(error);
    try {
      if (!req.file) throw new ApiError(400, 'A file is required in multipart field "file"');
      const id = crypto.randomUUID(); const storedFilename = req.file.filename;
      const file = { id, roomId: req.room.id, originalFilename: safeFilename(req.file.originalname), storedFilename,
        mimeType: req.file.mimetype || 'application/octet-stream', size: req.file.size, uploaderId: req.member.id, createdAt: now() };
      db.prepare(`INSERT INTO files(id, room_id, original_filename, stored_filename, mime_type, size, uploader_id, created_at)
        VALUES(@id, @roomId, @originalFilename, @storedFilename, @mimeType, @size, @uploaderId, @createdAt)`).run(file);
      delete file.storedFilename;
      io.to(req.room.code).emit('file:uploaded', { file });
      res.status(201).json({ file });
    } catch (err) { if (req.file) fs.rmSync(path.join(storagePath, path.basename(req.file.filename)), { force: true }); next(err); }
  });
});
app.get('/api/rooms/:code/files/:fileId', roomRoute, requireMember, (req, res, next) => {
  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND room_id = ?').get(req.params.fileId, req.room.id);
    if (!file) throw new ApiError(404, 'File not found');
    if (!/^[0-9a-f-]{36}\.blob$/i.test(file.stored_filename)) throw new ApiError(500, 'Stored file metadata is invalid');
    const filePath = path.resolve(storagePath, file.stored_filename);
    if (!filePath.startsWith(`${path.resolve(storagePath)}${path.sep}`)) throw new ApiError(400, 'Invalid file path');
    res.download(filePath, file.original_filename, (error) => { if (error && !res.headersSent) next(error); });
  } catch (error) { next(error); }
});
app.delete('/api/rooms/:code/files/:fileId', roomRoute, requireMember, (req, res, next) => {
  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND room_id = ?').get(req.params.fileId, req.room.id);
    if (!file) throw new ApiError(404, 'File not found');
    db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    fs.rmSync(path.join(storagePath, path.basename(file.stored_filename)), { force: true });
    io.to(req.room.code).emit('file:deleted', { fileId: file.id });
    res.status(204).end();
  } catch (error) { next(error); }
});
app.get('/api/rooms/:code/texts', roomRoute, requireMember, (req, res) => {
  const texts = db.prepare(`SELECT id, user_id AS userId, content, language, created_at AS createdAt
    FROM shared_texts WHERE room_id = ? ORDER BY created_at ASC`).all(req.room.id);
  res.json({ texts });
});
app.post('/api/rooms/:code/texts', roomRoute, requireMember, (req, res, next) => {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const language = typeof req.body?.language === 'string' ? req.body.language.trim().slice(0, 40) || null : null;
    if (!content.trim()) throw new ApiError(400, 'Content is required');
    if (content.length > 50_000) throw new ApiError(400, 'Content cannot exceed 50000 characters');
    const text = { id: crypto.randomUUID(), roomId: req.room.id, userId: req.member.id, content, language, createdAt: now() };
    db.prepare('INSERT INTO shared_texts(id, room_id, user_id, content, language, created_at) VALUES(@id, @roomId, @userId, @content, @language, @createdAt)').run(text);
    const result = { id: text.id, userId: text.userId, content, language, createdAt: text.createdAt };
    io.to(req.room.code).emit('text:shared', { text: result });
    res.status(201).json({ text: result });
  } catch (error) { next(error); }
});

io.use((socket, next) => {
  try {
    const room = getActiveRoom(socket.handshake.auth?.roomCode);
    const userId = socket.handshake.auth?.userId;
    const member = memberById.get(userId, room.id);
    if (!member) return next(new Error('Room membership required'));
    socket.data.roomCode = room.code; socket.data.member = member;
    next();
  } catch (error) { next(new Error(error.message)); }
});
const connectedUsers = new Map();
io.on('connection', (socket) => {
  const roomCode = socket.data.roomCode;
  const member = socket.data.member;
  if (!connectedUsers.has(roomCode)) connectedUsers.set(roomCode, new Map());
  const roomUsers = connectedUsers.get(roomCode);
  let presence = roomUsers.get(member.id);
  const isFirstConnection = !presence;
  if (!presence) {
    presence = { user: member, sockets: new Set() };
    roomUsers.set(member.id, presence);
  }
  presence.sockets.add(socket.id);
  socket.join(roomCode);
  socket.emit('users:present', { users: [...roomUsers.values()].map(({ user }) => user) });
  if (isFirstConnection) socket.to(roomCode).emit('user:joined', { user: member });
  socket.on('disconnect', () => {
    const active = roomUsers.get(member.id);
    if (!active) return;
    active.sockets.delete(socket.id);
    if (active.sockets.size === 0) {
      roomUsers.delete(member.id);
      socket.to(roomCode).emit('user:left', { userId: member.id });
    }
    if (roomUsers.size === 0) connectedUsers.delete(roomCode);
  });
});

function cleanupExpiredRooms() {
  const expired = db.prepare("SELECT id, code FROM rooms WHERE status = 'active' AND expires_at <= ?").all(now());
  for (const room of expired) {
    const files = db.prepare('SELECT stored_filename FROM files WHERE room_id = ?').all(room.id);
    for (const file of files) {
      if (/^[0-9a-f-]{36}\.blob$/i.test(file.stored_filename)) fs.rmSync(path.join(storagePath, file.stored_filename), { force: true });
    }
    db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
    io.to(room.code).emit('room:expired', { code: room.code });
  }
  return expired.length;
}
cleanupExpiredRooms();
const cleanupTimer = setInterval(cleanupExpiredRooms, 60_000);
cleanupTimer.unref();

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the configured upload size limit' : error.message });
  }
  const status = error instanceof ApiError ? error.status : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : error.message });
});

if (require.main === module) {
  server.listen(port, () => console.log(`OfficeBridge backend listening on port ${port}`));
}
module.exports = { app, server, io, db, cleanupExpiredRooms };
