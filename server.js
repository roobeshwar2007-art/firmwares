// R Track Creation - ESP32-S3 Web Flasher
// Backend: Express + SQLite (better-sqlite3) + sessions
// Roles: admin (uploads firmware, creates user accounts) / user (logs in, flashes)

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS firmware (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  filename TEXT NOT NULL,
  flash_address TEXT NOT NULL DEFAULT '0x0',
  chip TEXT NOT NULL DEFAULT 'esp32s3',
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS flash_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  firmware_id INTEGER,
  status TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// --- Seed a default admin account on first run only ---
const adminExists = db.prepare(`SELECT id FROM users WHERE role='admin' LIMIT 1`).get();
if (!adminExists) {
  const defaultUser = process.env.ADMIN_USER || 'admin';
  const defaultPass = process.env.ADMIN_PASS || 'ChangeMe123!';
  const hash = bcrypt.hashSync(defaultPass, 10);
  db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')`)
    .run(defaultUser, hash);
  console.log('======================================================');
  console.log(' First run: created default admin account');
  console.log(' Username:', defaultUser);
  console.log(' Password:', defaultPass);
  console.log(' >>> LOG IN AND CHANGE THIS PASSWORD IMMEDIATELY <<<');
  console.log('======================================================');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// ---------- auth helpers ----------
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ---------- auth routes ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  const row = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.user = { id: row.id, username: row.username, role: row.role };
  res.json({ ok: true, role: row.role, username: row.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, ...req.session.user });
});

// ---------- admin: create customer accounts ----------
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing username/password' });
  const finalRole = role === 'admin' ? 'admin' : 'user';
  try {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`)
      .run(username, hash, finalRole);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT id, username, role, created_at FROM users ORDER BY id DESC`).all();
  res.json(rows);
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  db.prepare(`DELETE FROM users WHERE id = ? AND role != 'admin'`).run(req.params.id);
  res.json({ ok: true });
});

// ---------- admin: upload firmware ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const safe = Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9_.-]/g, '_');
      cb(null, safe);
    }
  }),
  limits: { fileSize: 32 * 1024 * 1024 }, // 32MB
  fileFilter: (req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.bin')) {
      return cb(new Error('Only .bin files are allowed'));
    }
    cb(null, true);
  }
});

app.post('/api/admin/firmware', requireAdmin, upload.single('firmware'), (req, res) => {
  const { name, version, flash_address, chip } = req.body || {};
  if (!req.file || !name || !version) {
    return res.status(400).json({ error: 'Missing name, version, or file' });
  }
  db.prepare(`INSERT INTO firmware (name, version, filename, flash_address, chip, uploaded_by)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(name, version, req.file.filename, flash_address || '0x0', chip || 'esp32s3', req.session.user.id);
  res.json({ ok: true });
});

app.delete('/api/admin/firmware/:id', requireAdmin, (req, res) => {
  const fw = db.prepare(`SELECT * FROM firmware WHERE id = ?`).get(req.params.id);
  if (fw) {
    const p = path.join(UPLOAD_DIR, fw.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    db.prepare(`DELETE FROM firmware WHERE id = ?`).run(req.params.id);
  }
  res.json({ ok: true });
});

// ---------- everyone logged in: list firmware (no raw file path exposed) ----------
app.get('/api/firmware', requireLogin, (req, res) => {
  const rows = db.prepare(`SELECT id, name, version, flash_address, chip, created_at FROM firmware ORDER BY id DESC`).all();
  res.json(rows);
});

// ---------- protected binary stream for flashing (used by esptool-js in-browser) ----------
// Never exposes a direct downloadable link; only same-session fetch() can read bytes.
app.get('/api/firmware/:id/bin', requireLogin, (req, res) => {
  const fw = db.prepare(`SELECT * FROM firmware WHERE id = ?`).get(req.params.id);
  if (!fw) return res.status(404).end();
  const filePath = path.join(UPLOAD_DIR, fw.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Content-Type', 'application/octet-stream');
  // No Content-Disposition: attachment -> browser won't offer "Save As" via a normal link click
  fs.createReadStream(filePath).pipe(res);
});

// ---------- flash result logging ----------
app.post('/api/flash-log', requireLogin, (req, res) => {
  const { firmware_id, status } = req.body || {};
  db.prepare(`INSERT INTO flash_log (user_id, firmware_id, status) VALUES (?, ?, ?)`)
    .run(req.session.user.id, firmware_id, status);
  res.json({ ok: true });
});

app.get('/api/admin/flash-log', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT fl.id, u.username, f.name as firmware_name, f.version, fl.status, fl.created_at
    FROM flash_log fl
    LEFT JOIN users u ON u.id = fl.user_id
    LEFT JOIN firmware f ON f.id = fl.firmware_id
    ORDER BY fl.id DESC LIMIT 100
  `).all();
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
