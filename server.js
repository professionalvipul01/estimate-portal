const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'ratewise_super_secret_key_change_in_production';
const ADMIN_EMAIL = 'admin@ratewise.com';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync('admin123', 8); // default admin password: admin123

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-Memory Storage ----------
let users = [];       // { id, name, mobile, passwordHash }
let estimates = [];   // { id, userId, clientName, address, landmark, length, width, noFloor, rateSqft, builtUpArea, totalAmount, subtotal, extraAmount, abstractItems, createdAt }

// Helper: generate estimate data from user input (based on provided Excel logic)
function generateEstimateData(input) {
    const { length, width, noFloor, rateSqft, name, address, landmark } = input;
    const plotAreaSqft = length * width;
    const builtUpArea = plotAreaSqft * noFloor;
    // Coefficients derived from the SOR abstract sheet logic (example realistic coefficients)
    // These mimic the percentages from the original abstract formulas.
    const subtotal = rateSqft * builtUpArea * 0.85;   // 85% of total goes to items 1-22
    const extraAmount = rateSqft * builtUpArea * 0.15; // 15% extra for electrification, plumbing, contingencies
    const totalAmount = subtotal + extraAmount;

    // Build dummy but realistic abstract items (22 items as per sample)
    const abstractItems = [
        { description: "Earth work in excavation (all soil)", unit: "CUM", quantity: (builtUpArea * 0.12).toFixed(2), rate: (rateSqft * 0.05).toFixed(2), amount: (subtotal * 0.05).toFixed(2) },
        { description: "Filling in footing pits with excavated earth", unit: "CUM", quantity: (builtUpArea * 0.08).toFixed(2), rate: (rateSqft * 0.04).toFixed(2), amount: (subtotal * 0.04).toFixed(2) },
        { description: "Filling plinth with Moorum/Hard copra", unit: "CUM", quantity: (builtUpArea * 0.06).toFixed(2), rate: (rateSqft * 0.03).toFixed(2), amount: (subtotal * 0.03).toFixed(2) },
        { description: "M20 concrete in footing & trenches", unit: "CUM", quantity: (builtUpArea * 0.10).toFixed(2), rate: (rateSqft * 0.07).toFixed(2), amount: (subtotal * 0.07).toFixed(2) },
        { description: "RCC work upto plinth (M20)", unit: "CUM", quantity: (builtUpArea * 0.09).toFixed(2), rate: (rateSqft * 0.09).toFixed(2), amount: (subtotal * 0.09).toFixed(2) },
        { description: "RCC work above plinth (M20)", unit: "CUM", quantity: (builtUpArea * 0.11).toFixed(2), rate: (rateSqft * 0.10).toFixed(2), amount: (subtotal * 0.10).toFixed(2) },
        { description: "Steel reinforcement @1.5% of concrete", unit: "KG", quantity: (builtUpArea * 5.5).toFixed(2), rate: (rateSqft * 0.06).toFixed(2), amount: (subtotal * 0.06).toFixed(2) },
        { description: "Formwork for RCC", unit: "SQM", quantity: (builtUpArea * 1.2).toFixed(2), rate: (rateSqft * 0.05).toFixed(2), amount: (subtotal * 0.05).toFixed(2) },
        { description: "Brickwork in foundation & plinth (1:4 mortar)", unit: "CUM", quantity: (builtUpArea * 0.15).toFixed(2), rate: (rateSqft * 0.08).toFixed(2), amount: (subtotal * 0.08).toFixed(2) },
        { description: "Brickwork in superstructure (class 40)", unit: "CUM", quantity: (builtUpArea * 0.20).toFixed(2), rate: (rateSqft * 0.12).toFixed(2), amount: (subtotal * 0.12).toFixed(2) },
        { description: "Wood work in door/window frames (other than teak)", unit: "CUM", quantity: (builtUpArea * 0.02).toFixed(2), rate: (rateSqft * 0.04).toFixed(2), amount: (subtotal * 0.04).toFixed(2) },
        { description: "Glazed shutters for windows/doors", unit: "SQM", quantity: (builtUpArea * 0.05).toFixed(2), rate: (rateSqft * 0.03).toFixed(2), amount: (subtotal * 0.03).toFixed(2) },
        { description: "Tile work in tread & riser", unit: "SQM", quantity: (builtUpArea * 0.04).toFixed(2), rate: (rateSqft * 0.02).toFixed(2), amount: (subtotal * 0.02).toFixed(2) },
        { description: "Vitrified flooring (30mm)", unit: "SQM", quantity: (builtUpArea * 0.7).toFixed(2), rate: (rateSqft * 0.07).toFixed(2), amount: (subtotal * 0.07).toFixed(2) },
        { description: "Acid resistant tiles in toilet", unit: "SQM", quantity: (builtUpArea * 0.08).toFixed(2), rate: (rateSqft * 0.04).toFixed(2), amount: (subtotal * 0.04).toFixed(2) },
        { description: "12mm cement plaster (inner)", unit: "SQM", quantity: (builtUpArea * 2.5).toFixed(2), rate: (rateSqft * 0.04).toFixed(2), amount: (subtotal * 0.04).toFixed(2) },
        { description: "20mm cement plaster (external)", unit: "SQM", quantity: (builtUpArea * 1.2).toFixed(2), rate: (rateSqft * 0.03).toFixed(2), amount: (subtotal * 0.03).toFixed(2) },
        { description: "12mm ceiling plaster", unit: "SQM", quantity: (builtUpArea * 0.9).toFixed(2), rate: (rateSqft * 0.01).toFixed(2), amount: (subtotal * 0.01).toFixed(2) },
        { description: "Acrylic washable distemper", unit: "SQM", quantity: (builtUpArea * 2.2).toFixed(2), rate: (rateSqft * 0.03).toFixed(2), amount: (subtotal * 0.03).toFixed(2) },
        { description: "Waterproofing in sunken toilet", unit: "SQM", quantity: (builtUpArea * 0.1).toFixed(2), rate: (rateSqft * 0.01).toFixed(2), amount: (subtotal * 0.01).toFixed(2) },
        { description: "Roof slab waterproofing", unit: "SQM", quantity: (builtUpArea * 0.5).toFixed(2), rate: (rateSqft * 0.02).toFixed(2), amount: (subtotal * 0.02).toFixed(2) },
        { description: "Handrail & steel work (primer coat)", unit: "KG", quantity: (builtUpArea * 1.8).toFixed(2), rate: (rateSqft * 0.01).toFixed(2), amount: (subtotal * 0.01).toFixed(2) }
    ];
    // format amounts as numbers
    const formattedItems = abstractItems.map(item => ({
        ...item,
        quantity: parseFloat(item.quantity),
        rate: parseFloat(item.rate),
        amount: parseFloat(item.amount)
    }));
    return {
        abstractItems: formattedItems,
        summary: {
            builtUpArea: builtUpArea,
            ratePerSqft: rateSqft,
            subtotal: subtotal,
            extraAmount: extraAmount,
            totalAmount: totalAmount
        }
    };
}

// ---------- AUTH MIDDLEWARE ----------
function authenticateUser(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'No token provided' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid token' });
    }
}

function authenticateAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ message: 'Admin token missing' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded.isAdmin) return res.status(403).json({ message: 'Admin access required' });
        req.adminId = decoded.adminId;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid admin token' });
    }
}

// ---------- API ROUTES ----------
app.post('/api/auth/register', async (req, res) => {
    const { name, mobile, password } = req.body;
    if (!name || !mobile || !password) return res.status(400).json({ message: 'All fields required' });
    if (users.find(u => u.mobile === mobile)) return res.status(400).json({ message: 'Mobile already registered' });
    const hashed = bcrypt.hashSync(password, 8);
    const newUser = { id: users.length + 1, name, mobile, passwordHash: hashed };
    users.push(newUser);
    const token = jwt.sign({ userId: newUser.id, mobile: newUser.mobile }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: newUser.id, name: newUser.name, mobile: newUser.mobile } });
});

app.post('/api/auth/login', async (req, res) => {
    const { mobile, password } = req.body;
    const user = users.find(u => u.mobile === mobile);
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });
    const valid = bcrypt.compareSync(password, user.passwordHash);
    if (!valid) return res.status(401).json({ message: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, mobile: user.mobile }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, mobile: user.mobile } });
});

app.post('/api/admin/login', (req, res) => {
    const { email, password } = req.body;
    if (email !== ADMIN_EMAIL) return res.status(401).json({ message: 'Invalid admin' });
    const valid = bcrypt.compareSync(password, ADMIN_PASSWORD_HASH);
    if (!valid) return res.status(401).json({ message: 'Invalid admin password' });
    const token = jwt.sign({ isAdmin: true, adminId: 'admin' }, JWT_SECRET, { expiresIn: '1d' });
    res.json({ token });
});

app.post('/api/estimate/generate', authenticateUser, (req, res) => {
    const { name, address, landmark, plotSize, length, width, noFloor, rateSqft } = req.body;
    if (!length || !width || !noFloor || !rateSqft) {
        return res.status(400).json({ message: 'Missing required fields' });
    }
    const estimateData = generateEstimateData({ name, address, landmark, length, width, noFloor, rateSqft });
    // store in memory
    const newEstimate = {
        id: estimates.length + 1,
        userId: req.userId,
        clientName: name,
        address,
        landmark,
        plotSize: plotSize || '',
        length,
        width,
        noFloor,
        rateSqft,
        builtUpArea: estimateData.summary.builtUpArea,
        totalAmount: estimateData.summary.totalAmount,
        subtotal: estimateData.summary.subtotal,
        extraAmount: estimateData.summary.extraAmount,
        abstractItems: estimateData.abstractItems,
        createdAt: new Date().toISOString()
    };
    estimates.push(newEstimate);
    res.json({ abstractItems: estimateData.abstractItems, summary: estimateData.summary });
});

app.get('/api/admin/estimates', authenticateAdmin, (req, res) => {
    const enriched = estimates.map(est => {
        const user = users.find(u => u.id === est.userId);
        return {
            ...est,
            userName: user ? user.name : 'Unknown',
            userMobile: user ? user.mobile : 'N/A'
        };
    });
    res.json({ estimates: enriched });
});

// Serve frontend for any other route
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin default login: ${ADMIN_EMAIL} / admin123`);
});
