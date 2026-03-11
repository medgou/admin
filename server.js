const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== Firebase Admin Init ======
try {
    const keyData = Buffer.from(process.env.FIREBASE_B64 || '', 'base64').toString('utf8');
    const serviceAccount = JSON.parse(keyData);

    // Fix ASN.1 parsing errors for multiline keys
    if (serviceAccount.private_key) {
        let pk = serviceAccount.private_key;
        pk = pk.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '');
        pk = pk.replace(/\s+/g, '').replace(/\\n/g, '');

        let formattedKey = '-----BEGIN PRIVATE KEY-----\n';
        for (let i = 0; i < pk.length; i += 64) {
            formattedKey += pk.substring(i, i + 64) + '\n';
        }
        formattedKey += '-----END PRIVATE KEY-----\n';
        serviceAccount.private_key = formattedKey;
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('[Firebase] Connected to Firestore ✅');
} catch (e) {
    console.error('[Firebase] Failed to init. Check FIREBASE_B64 env var.');
}

const db = admin.firestore ? admin.firestore() : null;

// Serve Admin Dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ========== APP EXPORT ENDPOINTS ==========
// Activate or Verify License
app.post('/api/app/activate', async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized.' });

    const { key, hwid } = req.body;
    if (!key || !hwid) return res.status(400).json({ error: 'Missing Key or HWID' });

    try {
        const licensesRef = db.collection('licenses');
        const snapshot = await licensesRef.where('key', '==', key).get();

        if (snapshot.empty) {
            return res.status(404).json({ error: 'License key not found' });
        }

        const doc = snapshot.docs[0];
        const row = doc.data();
        const docId = doc.id;

        if (row.status === 'banned') return res.status(403).json({ error: 'This license has been banned.' });

        const now = new Date();

        if (row.status === 'active') {
            if (row.expiry_date && new Date(row.expiry_date) < now) {
                await licensesRef.doc(docId).update({ status: 'expired' });
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

            await licensesRef.doc(docId).update({
                status: 'active',
                hwid: hwid,
                activation_date: now.toISOString(),
                expiry_date: expiryStr
            });

            return res.json({ success: true, message: 'License successfully activated!', expiry_date: expiryStr });
        }
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database verification failed.' });
    }
});

// Settings & Remote Push (Updates, Notifications)
app.get('/api/app/config', async (req, res) => {
    if (!db) return res.status(500).json({ error: 'Database not initialized.' });

    try {
        const doc = await db.collection('settings').doc('app_config').get();
        if (!doc.exists) {
            return res.json({
                notification: null,
                latest_version: "1.0.0",
                force_update: false,
                kill_switch: false
            });
        }
        return res.json(doc.data());
    } catch (err) {
        return res.status(500).json({ error: 'Failed config fetch' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`License Server running on port ${PORT}`);
});
