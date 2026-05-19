const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const XLSX = require('xlsx');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// Database setup
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  // Users table – added OTP fields
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    mobile TEXT UNIQUE,
    password TEXT,
    isAdmin INTEGER DEFAULT 0,
    estimateCount INTEGER DEFAULT 0,
    otp TEXT,
    otpExpiry INTEGER,
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
  
  // Pre‑create admin user (if not exists)
  const adminMobile = '9244039211';
  const adminEmail = 'professionalvipul01@gmail.com';
  const adminPasswordHash = bcrypt.hashSync('Nivi@1983', 10);
  
  db.get(`SELECT * FROM users WHERE mobile = ? OR email = ?`, [adminMobile, adminEmail], (err, row) => {
    if (!row) {
      db.run(`INSERT INTO users (name, email, mobile, password, isAdmin) VALUES (?, ?, ?, ?, ?)`,
        ['Admin User', adminEmail, adminMobile, adminPasswordHash, 1]);
    } else if (row.isAdmin !== 1) {
      // Upgrade existing user to admin if email/mobile matches
      db.run(`UPDATE users SET isAdmin = 1, password = ? WHERE id = ?`, [adminPasswordHash, row.id]);
    }
  });
});

const JWT_SECRET = 'your-secret-key-change-this-in-production';

// Helper to generate 6‑digit OTP
const generateOTP = () => crypto.randomInt(100000, 999999).toString();

// Send OTP (mock – prints to console, in real life call SMS API)
app.post('/api/send-otp', (req, res) => {
  const { mobile } = req.body;
  if (!mobile || mobile.length < 10) {
    return res.status(400).json({ error: 'Valid mobile number required' });
  }
  
  const otp = generateOTP();
  const expiry = Date.now() + 5 * 60 * 1000; // 5 minutes
  
  db.run(`INSERT INTO users (mobile, otp, otpExpiry) VALUES (?, ?, ?)
          ON CONFLICT(mobile) DO UPDATE SET otp = ?, otpExpiry = ?`,
    [mobile, otp, expiry, otp, expiry], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      console.log(`🔐 OTP for ${mobile}: ${otp}`); // In production, send via SMS
      res.json({ success: true, message: 'OTP sent' });
    });
});

// Verify OTP and login/register
app.post('/api/verify-otp', (req, res) => {
  const { mobile, otp, name } = req.body;
  if (!mobile || !otp) {
    return res.status(400).json({ error: 'Mobile and OTP required' });
  }
  
  db.get(`SELECT * FROM users WHERE mobile = ?`, [mobile], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // Check OTP validity
    if (!user || user.otp !== otp || user.otpExpiry < Date.now()) {
      return res.status(401).json({ error: 'Invalid or expired OTP' });
    }
    
    // Clear OTP after successful verification
    db.run(`UPDATE users SET otp = NULL, otpExpiry = NULL WHERE mobile = ?`, [mobile]);
    
    // If user exists, generate token and return
    if (user.id) {
      const token = jwt.sign({ id: user.id, name: user.name || name, isAdmin: user.isAdmin }, JWT_SECRET);
      return res.json({
        token,
        user: {
          id: user.id,
          name: user.name || name,
          email: user.email,
          mobile: user.mobile,
          isAdmin: user.isAdmin,
          estimateCount: user.estimateCount
        }
      });
    }
    
    // New user – create account
    const newName = name || mobile;
    db.run(`INSERT INTO users (mobile, name, otp, otpExpiry) VALUES (?, ?, NULL, NULL)`,
      [mobile, newName], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        const token = jwt.sign({ id: this.lastID, name: newName, isAdmin: 0 }, JWT_SECRET);
        res.json({
          token,
          user: { id: this.lastID, name: newName, mobile, isAdmin: 0, estimateCount: 0 }
        });
      });
  });
});

// Get current user (from JWT)
app.get('/api/me', authenticateToken, (req, res) => {
  db.get(`SELECT id, name, email, mobile, isAdmin, estimateCount FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  });
});

// Middleware to verify JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// Save estimate (unchanged)
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

// Admin: get all users (unchanged)
app.get('/api/admin/users', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  db.all(`SELECT id, name, email, mobile, isAdmin, estimateCount, createdAt FROM users ORDER BY id`, (err, users) => {
    res.json(users);
  });
});

// Export users to Excel (unchanged)
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
