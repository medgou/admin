const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Admin Password for generating keys
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// Railway has read-only filesystem except /tmp, use /tmp for DB in production
const DB_DIR = process.env.RAILWAY_ENVIRONMENT ? '/tmp' : __dirname;
const dbPath = path.join(DB_DIR, 'licenses.db');
const db = new sqlite3.Database(dbPath);

// Init DB
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS licenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE,
        duration_days INTEGER,
        max_devices INTEGER DEFAULT 1,
        status TEXT DEFAULT 'unused',  -- unused, active, expired, banned
        hwid TEXT DEFAULT NULL,
        activation_date TEXT DEFAULT NULL,
        expiry_date TEXT DEFAULT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Admin Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

function generateKey() {
    return 'WHTS-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// ---------------- ADMIN API ----------------
app.post('/api/admin/generate', (req, res) => {
    const { password, duration_days, copies, bound_hwid } = req.body;
    if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    const num = parseInt(copies) || 1;
    let days = parseInt(duration_days);
    if (isNaN(days) || days <= 0) days = 36500; // Lifetime roughly 100 years

    const keys = [];
    const stmt = db.prepare("INSERT INTO licenses (key, duration_days, hwid) VALUES (?, ?, ?)");

    const hwidToBind = (bound_hwid && bound_hwid.trim() !== '') ? bound_hwid.trim() : null;

    for (let i = 0; i < num; i++) {
        const k = generateKey();
        keys.push({ key: k, duration_days: days, bound_hwid: hwidToBind });
        stmt.run(k, days, hwidToBind);
    }
    stmt.finalize();

    res.json({ success: true, keys });
});

app.post('/api/admin/list', (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    db.all("SELECT * FROM licenses ORDER BY id DESC", (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, licenses: rows });
    });
});

app.post('/api/admin/ban', (req, res) => {
    const { password, key } = req.body;
    if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    db.run("UPDATE licenses SET status = 'banned' WHERE key = ?", [key], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ---------------- APP API ----------------
// Validate or Activate Key
app.post('/api/app/activate', (req, res) => {
    const { key, hwid } = req.body;
    if (!key || !hwid) return res.status(400).json({ error: 'Missing Key or HWID' });

    db.get("SELECT * FROM licenses WHERE key = ?", [key], (err, license) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!license) return res.status(404).json({ error: 'License key not found' });

        if (license.status === 'banned') return res.status(403).json({ error: 'This license has been banned.' });

        const now = new Date();

        // Already Activated Check
        if (license.status === 'active') {
            // Expired check
            if (license.expiry_date && new Date(license.expiry_date) < now) {
                db.run("UPDATE licenses SET status = 'expired' WHERE key = ?", [key]);
                return res.status(403).json({ error: 'License expired.' });
            }

            // HWID Lock Check
            if (license.hwid !== hwid) {
                return res.status(403).json({ error: 'License is already used on another computer.' });
            }

            return res.json({ success: true, message: 'License verified', expiry_date: license.expiry_date });
        }

        // Fresh Activation
        if (license.status === 'unused') {
            if (license.hwid && license.hwid !== hwid) {
                return res.status(403).json({ error: 'This key is bound to a different device.' });
            }

            const expiryDate = new Date();
            expiryDate.setDate(expiryDate.getDate() + license.duration_days);

            db.run(
                "UPDATE licenses SET status = 'active', hwid = ?, activation_date = ?, expiry_date = ? WHERE key = ?",
                [hwid, now.toISOString(), expiryDate.toISOString(), key],
                function (updateErr) {
                    if (updateErr) return res.status(500).json({ error: 'Failed to activate' });
                    res.json({ success: true, message: 'License successfully activated!', expiry_date: expiryDate.toISOString() });
                }
            );
        } else {
            res.status(403).json({ error: 'Invalid license state: ' + license.status });
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`License Server running on port ${PORT}`);
    console.log(`Admin Password is: ${ADMIN_PASS}`);
});
