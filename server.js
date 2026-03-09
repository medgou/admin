const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Admin Password
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ===== Firebase Admin Init =====
// Service account JSON stored as env var FIREBASE_SERVICE_ACCOUNT (JSON string)
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    // Fix for Railway/Env variables where \n gets escaped as \\n
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log('[Firebase] Connected to Firestore ✅');
} catch (e) {
    console.error('[Firebase] Failed to init:', e.message);
    process.exit(1);
}

const LICENSES_COL = 'licenses';

// ===== HELPERS =====
function generateKey() {
    return 'WHTS-' +
        crypto.randomBytes(3).toString('hex').toUpperCase() + '-' +
        crypto.randomBytes(3).toString('hex').toUpperCase() + '-' +
        crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Admin Dashboard HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ========== ADMIN API ===========

// Generate Keys
app.post('/api/admin/generate', async (req, res) => {
    const { password, duration_days, copies, bound_hwid } = req.body;
    if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    const num = Math.min(parseInt(copies) || 1, 50);
    let days = parseInt(duration_days);
    if (isNaN(days) || days <= 0) days = 36500;

    const hwidToBind = (bound_hwid && bound_hwid.trim() !== '') ? bound_hwid.trim() : null;
    const keys = [];
    const batch = db.batch();

    for (let i = 0; i < num; i++) {
        const k = generateKey();
        const docRef = db.collection(LICENSES_COL).doc(k);
        const licenseData = {
            key: k,
            duration_days: days,
            status: 'unused',
            hwid: hwidToBind,
            activation_date: null,
            expiry_date: null,
            created_at: new Date().toISOString()
        };
        batch.set(docRef, licenseData);
        keys.push({ key: k, duration_days: days, bound_hwid: hwidToBind });
    }

    await batch.commit();
    res.json({ success: true, keys });
});

// List Licenses
app.post('/api/admin/list', async (req, res) => {
    const { password } = req.body;
    if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    const snap = await db.collection(LICENSES_COL).orderBy('created_at', 'desc').get();
    const licenses = snap.docs.map(d => d.data());
    res.json({ success: true, licenses });
});

// Ban Key
app.post('/api/admin/ban', async (req, res) => {
    const { password, key } = req.body;
    if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });

    await db.collection(LICENSES_COL).doc(key).update({ status: 'banned' });
    res.json({ success: true });
});

// ========== APP API ===========
// Activate / Validate License
app.post('/api/app/activate', async (req, res) => {
    const { key, hwid } = req.body;
    if (!key || !hwid) return res.status(400).json({ error: 'Missing Key or HWID' });

    const docRef = db.collection(LICENSES_COL).doc(key);
    const doc = await docRef.get();

    if (!doc.exists) return res.status(404).json({ error: 'License key not found' });

    const license = doc.data();
    const now = new Date();

    if (license.status === 'banned') return res.status(403).json({ error: 'This license has been banned.' });

    if (license.status === 'active') {
        // Check expiry
        if (license.expiry_date && new Date(license.expiry_date) < now) {
            await docRef.update({ status: 'expired' });
            return res.status(403).json({ error: 'License expired.' });
        }
        // Check HWID lock
        if (license.hwid && license.hwid !== hwid) {
            return res.status(403).json({ error: 'License is already used on another computer.' });
        }
        return res.json({ success: true, message: 'License verified', expiry_date: license.expiry_date });
    }

    if (license.status === 'unused') {
        // Pre-bound HWID check
        if (license.hwid && license.hwid !== hwid) {
            return res.status(403).json({ error: 'This key is bound to a different device.' });
        }

        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + license.duration_days);
        const expiryISO = license.duration_days >= 36000 ? null : expiryDate.toISOString();

        await docRef.update({
            status: 'active',
            hwid: hwid,
            activation_date: now.toISOString(),
            expiry_date: expiryISO
        });

        return res.json({
            success: true,
            message: 'License successfully activated!',
            expiry_date: expiryISO
        });
    }

    res.status(403).json({ error: 'Invalid license state: ' + license.status });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`License Server running on port ${PORT}`);
    console.log(`Admin Password: ${ADMIN_PASS}`);
});
