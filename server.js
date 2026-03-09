const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== Config ======
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
// Use /data for Railway Volumes if available, otherwise fallback to __dirname
const DB_DIR = process.env.RAILWAY_ENVIRONMENT ? '/data' : __dirname;
const dbPath = path.join(DB_DIR, 'licenses.db');

console.log('Using DB Path:', dbPath);

// Init DB
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Database opening error: ', err);
    else console.log('Database connected!');
});

// Setup Table
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS licenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        duration_days INTEGER NOT NULL,
        status TEXT DEFAULT 'unused',  -- unused, active, expired, banned
        hwid TEXT,                     -- Hardware ID for locking
        activation_date DATETIME,
        expiry_date DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Helpers
function generateKey() {
    return 'WHTS-' +
        crypto.randomBytes(3).toString('hex').toUpperCase() + '-' +
        crypto.randomBytes(3).toString('hex').toUpperCase() + '-' +
        crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Serve Admin Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ========== ADMIN ENDPOINTS ==========
app.post('/api/admin/generate', (req, res) => {
    const { password, duration_days, copies, bound_hwid } = req.body;
    if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    const num = Math.min(parseInt(copies) || 1, 50);
    let days = parseInt(duration_days);
    if (isNaN(days) || days <= 0) days = 36500;

    const hwidToBind = (bound_hwid && bound_hwid.trim() !== '') ? bound_hwid.trim() : null;
    const generatedKeys = [];

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        const stmt = db.prepare(`INSERT INTO licenses (key, duration_days, hwid) VALUES (?, ?, ?)`);

        for (let i = 0; i < num; i++) {
            const k = generateKey();
            stmt.run(k, days, hwidToBind);
            generatedKeys.push({ key: k, duration_days: days, bound_hwid: hwidToBind });
        }

        stmt.finalize();
        db.run("COMMIT", (err) => {
            if (err) return res.status(500).json({ error: 'DB Transaction Failed' });
            res.json({ success: true, keys: generatedKeys });
        });
    });
});

app.post('/api/admin/list', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    db.all(`SELECT * FROM licenses ORDER BY created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database Error' });
        res.json({ success: true, licenses: rows });
    });
});

app.post('/api/admin/ban', (req, res) => {
    const { password, key } = req.body;
    if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    db.run(`UPDATE licenses SET status = 'banned' WHERE key = ?`, [key], function (err) {
        if (err) return res.status(500).json({ error: 'Database Error' });
        if (this.changes === 0) return res.status(404).json({ error: 'Key not found' });
        res.json({ success: true });
    });
});

// ========== APP EXPORT ENDPOINTS ==========
app.post('/api/app/activate', (req, res) => {
    const { key, hwid } = req.body;
    if (!key || !hwid) return res.status(400).json({ error: 'Missing Key or HWID' });

    db.get(`SELECT * FROM licenses WHERE key = ?`, [key], (err, row) => {
        if (err) return res.status(500).json({ error: 'Server Error' });
        if (!row) return res.status(404).json({ error: 'License key not found' });

        if (row.status === 'banned') return res.status(403).json({ error: 'This license has been banned.' });

        const now = new Date();

        if (row.status === 'active') {
            if (row.expiry_date && new Date(row.expiry_date) < now) {
                db.run(`UPDATE licenses SET status = 'expired' WHERE key = ?`, [key]);
                return res.status(403).json({ error: 'License expired.' });
            }
            if (row.hwid && row.hwid !== hwid) {
                return res.status(403).json({ error: 'License is already used on another computer.' });
            }
            return res.json({ success: true, message: 'License verified', expiry_date: row.expiry_date });
        }

        if (row.status === 'unused') {
            if (row.hwid && row.hwid !== hwid) {
                return res.status(403).json({ error: 'This key is bound to a different device.' });
            }

            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + row.duration_days);
            const expiryStr = row.duration_days >= 36000 ? null : expiryDate.toISOString();

            db.run(`UPDATE licenses SET status = 'active', hwid = ?, activation_date = ?, expiry_date = ? WHERE key = ?`,
                [hwid, now.toISOString(), expiryStr, key],
                (updateErr) => {
                    if (updateErr) return res.status(500).json({ error: 'Activation failed' });
                    return res.json({ success: true, message: 'License successfully activated!', expiry_date: expiryStr });
                });
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`License Server running on port ${PORT}`);
});
