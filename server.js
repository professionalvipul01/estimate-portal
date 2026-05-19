const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const XLSX = require('xlsx');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// Database setup
const db = new sqlite3.Database('./database.db');

// Create tables
db.serialize(() => {
  // Users table
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    mobile TEXT UNIQUE,
    password TEXT NOT NULL,
    isAdmin INTEGER DEFAULT 0,
    hasPaid INTEGER DEFAULT 0,
    estimateCount INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Estimates table
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
  
  // Exit surveys table
  db.run(`CREATE TABLE IF NOT EXISTS exit_surveys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    reason TEXT,
    feedback TEXT,
    paymentFailed INTEGER,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Insert default admin if not exists
  db.get(`SELECT * FROM users WHERE email = 'admin@estimate.com'`, (err, row) => {
    if (!row) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      db.run(`INSERT INTO users (name, email, password, isAdmin) VALUES (?, ?, ?, ?)`, 
        ['Admin User', 'admin@estimate.com', hashedPassword, 1]);
    }
  });
});

// JWT Secret
const JWT_SECRET = 'your-secret-key-change-this-in-production';

// Middleware to verify tokenconst authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ============ API ROUTES ============

// Register
app.post('/api/register', async (req, res) => {
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
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, mobile: user.mobile, isAdmin: user.isAdmin, hasPaid: user.hasPaid, estimateCount: user.estimateCount } });
  });
});

// Get current user
app.get('/api/me', authenticateToken, (req, res) => {
  db.get(`SELECT id, name, email, mobile, isAdmin, hasPaid, estimateCount FROM users WHERE id = ?`, [req.user.id], (err, user) => {
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
      // Increment estimate count
      db.run(`UPDATE users SET estimateCount = estimateCount + 1 WHERE id = ?`, [req.user.id]);
      res.json({ success: true, estimateId: this.lastID });
    });
});

// Update payment status
app.post('/api/payment-success', authenticateToken, (req, res) => {
  db.run(`UPDATE users SET hasPaid = 1 WHERE id = ?`, [req.user.id], (err) => {
    res.json({ success: true });
  });
});

// Save exit survey
app.post('/api/exit-survey', authenticateToken, (req, res) => {
  const { reason, feedback, paymentFailed } = req.body;
  db.run(`INSERT INTO exit_surveys (userId, reason, feedback, paymentFailed) VALUES (?, ?, ?, ?)`,
    [req.user.id, reason, feedback, paymentFailed ? 1 : 0], (err) => {
      res.json({ success: true });
    });
});

// Get all users (admin only)
app.get('/api/admin/users', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  db.all(`SELECT id, name, email, mobile, isAdmin, hasPaid, estimateCount, createdAt FROM users ORDER BY id`, (err, users) => {
    res.json(users);
  });
});

// Export users to Excel
app.get('/api/admin/export-users', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  db.all(`SELECT id, name, email, mobile, isAdmin, hasPaid, estimateCount, createdAt FROM users`, (err, users) => {
    const ws = XLSX.utils.json_to_sheet(users);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Users');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=users.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  });
});

// Get all estimates (admin only)
app.get('/api/admin/estimates', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  db.all(`SELECT e.*, u.name as userName FROM estimates e LEFT JOIN users u ON e.userId = u.id ORDER BY e.createdAt DESC`, (err, estimates) => {
    res.json(estimates);
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});