const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    mobile TEXT UNIQUE,
    password TEXT NOT NULL,
    isAdmin INTEGER DEFAULT 0,
    estimateCount INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  db.run(`CREATE TABLE IF NOT EXISTS estimates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    clientName TEXT,
    address TEXT,
    landmark TEXT,
    lengthFt REAL,
    widthFt REAL,
    noOfFloors INTEGER,
    ratePerSqft REAL,
    totalAmount INTEGER,
    builtUpArea REAL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);
  
  db.get(`SELECT * FROM users WHERE email = 'admin@estimate.com'`, (err, row) => {
    if (!row) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      db.run(`INSERT INTO users (name, email, password, isAdmin) VALUES (?, ?, ?, ?)`,
        ['Admin User', 'admin@estimate.com', hashedPassword, 1]);
    }
  });
});

const JWT_SECRET = 'your-secret-key-change-this-in-production';

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Register
app.post('/api/register', (req, res) => {
  const { name, email, mobile, password } = req.body;
  if (!name || (!email && !mobile) || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const hashedPassword = bcrypt.hashSync(password, 10);
  db.run(`INSERT INTO users (name, email, mobile, password) VALUES (?, ?, ?, ?)`,
    [name, email || null, mobile || null, hashedPassword],
    function(err) {
      if (err) return res.status(400).json({ error: 'User already exists' });
      res.json({ success: true, userId: this.lastID });
    });
});

// Login
app.post('/api/login', (req, res) => {
  const { credential, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ? OR mobile = ?`, [credential, credential], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, name: user.name, isAdmin: user.isAdmin }, JWT_SECRET);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, mobile: user.mobile, isAdmin: user.isAdmin, estimateCount: user.estimateCount } });
  });
});

// Get current user
app.get('/api/me', authenticateToken, (req, res) => {
  db.get(`SELECT id, name, email, mobile, isAdmin, estimateCount FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    res.json(user);
  });
});

// Save estimate
app.post('/api/estimate', authenticateToken, (req, res) => {
  const { clientName, address, landmark, lengthFt, widthFt, noOfFloors, ratePerSqft, totalAmount, builtUpArea } = req.body;
  db.run(`INSERT INTO estimates (userId, clientName, address, landmark, lengthFt, widthFt, noOfFloors, ratePerSqft, totalAmount, builtUpArea) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, clientName, address, landmark, lengthFt, widthFt, noOfFloors, ratePerSqft, totalAmount, builtUpArea],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.run(`UPDATE users SET estimateCount = estimateCount + 1 WHERE id = ?`, [req.user.id]);
      res.json({ success: true, estimateId: this.lastID });
    });
});

// Admin: get all users
app.get('/api/admin/users', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  db.all(`SELECT id, name, email, mobile, isAdmin, estimateCount, createdAt FROM users ORDER BY id`, (err, users) => {
    res.json(users);
  });
});

// Export users to Excel
app.get('/api/admin/export-users', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  db.all(`SELECT id, name, email, mobile, isAdmin, estimateCount, createdAt FROM users`, (err, users) => {
    const ws = XLSX.utils.json_to_sheet(users);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=users.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
