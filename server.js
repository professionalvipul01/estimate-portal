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
    name TEXT,
    email TEXT UNIQUE,
    mobile TEXT,
    password TEXT,
    trade TEXT,
    currency TEXT DEFAULT 'INR',
    isAdmin INTEGER DEFAULT 0,
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
    itemsData TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);
  
  // Create default admin (for testing)
  db.get(`SELECT * FROM users WHERE email = 'admin@example.com'`, (err, row) => {
    if (!row) {
      const hashed = bcrypt.hashSync('admin123', 10);
      db.run(`INSERT INTO users (name, email, password, isAdmin) VALUES (?, ?, ?, ?)`,
        ['Admin', 'admin@example.com', hashed, 1]);
    }
  });
});

const JWT_SECRET = 'your-secret-key-change-this';

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ========== AUTH ROUTES ==========
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  const hashed = bcrypt.hashSync(password, 10);
  db.run(`INSERT INTO users (name, email, password) VALUES (?, ?, ?)`, [name, email, hashed], function(err) {
    if (err) return res.status(400).json({ error: 'Email already exists' });
    const token = jwt.sign({ id: this.lastID, name, isAdmin: 0 }, JWT_SECRET);
    res.json({ token, user: { id: this.lastID, name, email, isAdmin: 0 } });
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user.id, name: user.name, isAdmin: user.isAdmin }, JWT_SECRET);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, trade: user.trade, currency: user.currency, isAdmin: user.isAdmin } });
  });
});

app.get('/api/me', authenticateToken, (req, res) => {
  db.get(`SELECT id, name, email, trade, currency, isAdmin FROM users WHERE id = ?`, [req.user.id], (err, user) => {
    res.json(user);
  });
});

app.post('/api/onboard', authenticateToken, (req, res) => {
  const { trade, currency } = req.body;
  db.run(`UPDATE users SET trade = ?, currency = ? WHERE id = ?`, [trade, currency, req.user.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ========== CALCULATION ENGINE (Excel logic) ==========
function calculateEstimate({ lengthFt, widthFt, noOfFloors, ratePerSqft }) {
  const L_ft = parseFloat(lengthFt);
  const B_ft = parseFloat(widthFt);
  const floors = parseInt(noOfFloors);
  const rate = parseFloat(ratePerSqft);
  
  const builtUpArea = L_ft * B_ft * floors;
  const L_m = L_ft / 3.28;
  const B_m = B_ft / 3.28;
  
  // Footing counts (as per original formulas)
  const f1Count = 4;
  const f2Count = Math.max(0, ((2 * L_m / 3.5) - 2) + ((2 * B_m / 3.5) - 2));
  const f3Count = Math.max(0, ((L_m / 3.5) - 1) * ((B_m / 3.5) - 1));
  
  // Earthwork excavation (m³)
  const volF1 = f1Count * 1.7 * 1.4 * 1.2;
  const volF2 = f2Count * 1.4 * 1.1 * 1.2;
  const volF3 = f3Count * 1.3 * 1.3 * 1.2;
  const totalExcavation = volF1 + volF2 + volF3;
  
  // PCC in footing (M20)
  const pccF1 = f1Count * (1.7-0.2)*(1.4-0.2)*0.1;
  const pccF2 = f2Count * (1.4-0.2)*(1.1-0.2)*0.1;
  const pccF3 = f3Count * (1.3-0.2)*(1.3-0.2)*0.1;
  const totalPcc = pccF1 + pccF2 + pccF3;
  
  // RCC footing (0.3m height)
  const rccF1 = f1Count * (1.7-0.2)*(1.4-0.2)*0.3;
  const rccF2 = f2Count * (1.4-0.2)*(1.1-0.2)*0.3;
  const rccF3 = f3Count * (1.3-0.2)*(1.3-0.2)*0.3;
  const rccFooting = rccF1 + rccF2 + rccF3;
  
  // Columns up to plinth
  const colCount = f1Count + f2Count + f3Count;
  const colUptoPlinth = colCount * 0.2 * 0.3 * 2.2;
  
  // Ground beam
  const groundBeamLen = (((L_m-0.4)*(B_m/3.5))+L_m) + ((B_m*(L_m/3.5))+B_m);
  const groundBeamVol = 1 * groundBeamLen * 0.2 * 0.3;
  
  // Ground floor slab
  const groundSlab = 1 * L_m * B_m * 0.1;
  
  const rccUptoPlinth = rccFooting + colUptoPlinth + groundBeamVol + groundSlab;
  
  // Above plinth RCC
  const colAbovePlinth = colCount * 0.2 * 0.3 * 3.0 * floors;
  const parapetCols = (f2Count * 0.2*0.3*1.05) + (f1Count * 0.2*0.3*1.05);
  const roofBeam = floors * groundBeamLen * 0.2 * 0.3;
  const landingBeam = floors * 2.5 * 0.2 * 0.3;
  const roofSlab = floors * ((L_m*B_m) - 7) * 0.125;
  const waistSlab = (2*floors) * 3.5 * 1 * 0.125;
  const landingSlab = floors * 1 * 2 * 0.125;
  const kitchenSlab = 1 * 4 * 0.6 * 0.1;
  const lintelVol = floors * groundBeamLen * 0.1 * 0.1;
  const rccAbovePlinth = colAbovePlinth + parapetCols + roofBeam + landingBeam + roofSlab + waistSlab + landingSlab + kitchenSlab + lintelVol;
  
  const totalRCC = rccUptoPlinth + rccAbovePlinth;
  const steelKg = totalRCC * 120; // 120 kg per cum
  
  // Formwork (simplified approximation)
  const formworkArea = (rccFooting * 3.2) + (colUptoPlinth * 12) + (rccAbovePlinth * 9) + 150;
  
  // Brickwork (simplified)
  const brickworkPlinth = groundBeamVol * 0.9;
  const brickworkSuper = floors * (groundBeamLen * 0.1 * 3) + (2*(L_m+B_m-0.2)*0.1*1.05) + (18*floors*0.95*0.15*0.25*0.5);
  let doorWindowDeduction = (floors*0.9*0.1*2.1)+(floors*0.75*0.1*2.1)+(floors*1.2*0.1*1.2)+(floors*0.9*0.1*1.2)+(floors*0.45*0.1*0.3);
  const brickworkTotal = brickworkPlinth + brickworkSuper - doorWindowDeduction;
  
  // Wood work
  const woodWork = ((0.9*0.12*0.075)*2 + (0.75*0.12*0.075)*2 + (1.2*0.12*0.075)*4 + (0.9*0.12*0.075)*4 + (0.7*0.12*0.075)*4) * floors;
  
  // Glazed shutters
  const glazedSqm = ((0.4*1.2)*3 + (0.45*1.2)*2) * floors;
  
  // Tiles
  const tileSteps = (18*floors*0.95*0.25) + (2.5*0.95);
  const vitrifiedFloor = (L_m*B_m) * floors + (1.3*groundBeamLen*0.1);
  const acidResist = (2.5*1.5) + (8*2.5);
  
  // Plaster
  const innerPlaster = (floors * groundBeamLen * 5.8) + (2*(L_m+B_m-0.2)*1.05) - ((0.9*2.1)+(0.75*2.1)+(1.2*1.2)+(0.9*1.2)+(0.45*0.3));
  const outerPlaster = (40*3.2) + (40*1.05) - (0.9*2.1 + 1.2*1.2);
  const ceilingPlaster = (L_m*B_m)*floors;
  const distemperArea = innerPlaster + outerPlaster + ceilingPlaster;
  
  const toiletWaterproof = acidResist * 0.5;
  const roofWaterproof = (L_m*B_m)*floors;
  
  // Handrail & steel work (kg)
  const handrailKg = 150;
  const steelWorkKg = 150;
  
  // Abstract amount calculations using percentages from the original Excel
  const builtUpSqft = builtUpArea;
  const baseAmount = builtUpSqft * rate;
  
  const items = [
    { name: "Earth Work Excavation", qty: totalExcavation, amount: 0.003 * rate * builtUpSqft / (floors||1) },
    { name: "Filling in Footing Pits", qty: totalExcavation*0.65, amount: 0.0012 * rate * builtUpSqft / (floors||1) },
    { name: "Moorum Filling in Plinth", qty: 12, amount: 0.02 * rate * builtUpSqft / (floors||1) },
    { name: "PCC M20 in Footing", qty: totalPcc, amount: 0.008 * rate * builtUpSqft / (floors||1) },
    { name: "RCC Upto Plinth (M20)", qty: rccUptoPlinth, amount: 0.08 * rate * builtUpSqft / (floors||1) },
    { name: "RCC Above Plinth (M20)", qty: rccAbovePlinth, amount: 0.085 * rate * builtUpSqft },
    { name: "Steel Reinforcement", qty: steelKg, amount: 0.25 * rate * builtUpSqft },
    { name: "Formwork", qty: formworkArea, amount: 0.05 * rate * builtUpSqft },
    { name: "Brickwork (Plinth)", qty: brickworkPlinth, amount: 0.015 * rate * builtUpSqft / (floors||1) },
    { name: "Brickwork Superstructure", qty: brickworkSuper, amount: 0.08 * rate * builtUpSqft },
    { name: "Wood Work Frames", qty: woodWork, amount: 0.03 * rate * builtUpSqft },
    { name: "Glazed Shutters", qty: glazedSqm, amount: 0.01 * rate * builtUpSqft },
    { name: "Tile Work Tread/Riser", qty: tileSteps, amount: 0.002 * rate * builtUpSqft },
    { name: "Vitrified Flooring", qty: vitrifiedFloor, amount: 0.06 * rate * builtUpSqft },
    { name: "Acid Resistant Tiles", qty: acidResist, amount: 0.04 * rate * builtUpSqft },
    { name: "12mm Inner Plaster", qty: innerPlaster, amount: 0.07 * rate * builtUpSqft },
    { name: "20mm Outer Plaster", qty: outerPlaster, amount: 0.03 * rate * builtUpSqft },
    { name: "Ceiling Plaster", qty: ceilingPlaster, amount: 0.01 * rate * builtUpSqft },
    { name: "Distempering", qty: distemperArea, amount: 0.04 * rate * builtUpSqft },
    { name: "Toilet Waterproofing", qty: toiletWaterproof, amount: 0.001 * rate * builtUpSqft },
    { name: "Roof Waterproofing", qty: roofWaterproof, amount: 0.02 * rate * builtUpSqft },
    { name: "Hand Rail (kg)", qty: handrailKg, amount: handrailKg * 84 },
    { name: "Steel Work (kg)", qty: steelWorkKg, amount: steelWorkKg * 80 }
  ];
  
  let sumAmount = items.reduce((acc, it) => acc + it.amount, 0);
  const extra = 0.15 * rate * builtUpSqft;
  let totalCost = Math.round(sumAmount + extra);
  sumAmount = Math.round(sumAmount);
  
  return { items, sumAmount, extra, totalCost, builtUpArea: builtUpSqft };
}

// Estimate API
app.post('/api/estimate', authenticateToken, (req, res) => {
  const { clientName, address, landmark, lengthFt, widthFt, noOfFloors, ratePerSqft } = req.body;
  const result = calculateEstimate({ lengthFt, widthFt, noOfFloors, ratePerSqft });
  const builtUpArea = result.builtUpArea;
  const totalAmount = result.totalCost;
  // Save to DB
  db.run(`INSERT INTO estimates (userId, clientName, address, landmark, lengthFt, widthFt, noOfFloors, ratePerSqft, totalAmount, builtUpArea, itemsData) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, clientName, address, landmark, lengthFt, widthFt, noOfFloors, ratePerSqft, totalAmount, builtUpArea, JSON.stringify(result.items)],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ estimateId: this.lastID, ...result });
    });
});

// Admin: get all users
app.get('/api/admin/users', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  db.all(`SELECT id, name, email, trade, currency, createdAt FROM users`, (err, users) => {
    res.json(users);
  });
});

app.get('/api/admin/export-users', authenticateToken, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
  db.all(`SELECT id, name, email, trade, currency, createdAt FROM users`, (err, users) => {
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
