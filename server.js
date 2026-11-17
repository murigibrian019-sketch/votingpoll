require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const {
  PORT = 3000, BASE_URL, VOTE_PRICE_KES = '10', ADMIN_KEY,
  MPESA_ENV = 'sandbox', MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE, MPESA_PARTYB, MPESA_PASSKEY,
  MPESA_TXN_TYPE = 'CustomerPayBillOnline', MPESA_CALLBACK_SECRET,
  PESAPAL_BASE = 'https://cybqa.pesapal.com/pesapalv3/api',
  PESAPAL_CONSUMER_KEY, PESAPAL_CONSUMER_SECRET, PESAPAL_IPN_ID,
} = process.env;

const PRICE = Number(VOTE_PRICE_KES);
const DARAJA = MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

/* ---------- Database ---------- */
const db = new Database(path.join(__dirname, 'votes.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS contestants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    votes INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,                 -- our own reference, also sent to the gateways
    contestant_id INTEGER NOT NULL,
    votes INTEGER NOT NULL,
    amount INTEGER NOT NULL,             -- KES, always calculated on the server
    method TEXT NOT NULL,                -- 'mpesa' or 'card'
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | failed
    provider_ref TEXT,                   -- CheckoutRequestID (M-Pesa) or OrderTrackingId (Pesapal)
    receipt TEXT,
    contact TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_payments_provider ON payments(provider_ref);
`);

if (db.prepare('SELECT COUNT(*) AS c FROM contestants').get().c === 0) {
  const ins = db.prepare('INSERT INTO contestants (name, description) VALUES (?, ?)');
  [
    ['Cyber Samurai', 'Black and gold wrap, rear-door mural'],
    ['Neon Nduthi', 'Route 111, full neon airbrush'],
    ['Kijiji Express', 'Ngong Road, wildstyle graffiti'],
  ].forEach((row) => ins.run(...row));
}

const newRef = () => 'V' + crypto.randomBytes(5).toString('hex'); // 11 chars (M-Pesa limit is 12)
const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Credit votes exactly once. Safe to call from the callback, the IPN and the status poll.
const settle = db.transaction((ref, receipt) => {
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(ref);
  if (!p || p.status !== 'pending') return false;
  db.prepare("UPDATE payments SET status = 'paid', receipt = ? WHERE id = ?").run(receipt, ref);
  db.prepare('UPDATE contestants SET votes = votes + ? WHERE id = ?').run(p.votes, p.contestant_id);
  return true;
});
const markFailed = (ref) =>
  db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'").run(ref);

function parseOrder(body) {
  const contestantId = Number(body.contestantId);
  const votes = Number(body.votes);
  if (!Number.isInteger(contestantId) || !Number.isInteger(votes) || votes < 1 || votes > 1000) {
    throw httpError(400, 'Choose between 1 and 1000 votes.');
  }
  if (!db.prepare('SELECT 1 FROM contestants WHERE id = ?').get(contestantId)) {
    throw httpError(404, 'Contestant not found.');
  }
  return { contestantId, votes, amount: votes * PRICE }; // never trust an amount from the browser
}

/* ---------- M-Pesa (Daraja STK Push) ---------- */
function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(d)) return '254' + d.slice(1);
  if (/^254[17]\d{8}$/.test(d)) return d;
  if (/^[17]\d{8}$/.test(d)) return '254' + d;
  throw httpError(400, 'Enter a valid Safaricom number, for example 0712 345 678.');
}

const timestamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // YYYYMMDDHHmmss
const stkPassword = (ts) => Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + ts).toString('base64');

async function darajaToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const r = await fetch(`${DARAJA}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!r.ok) throw new Error('Daraja auth failed: ' + r.status);
  return (await r.json()).access_token;
}

async function darajaPost(pathname, payload) {
  const token = await darajaToken();
  const r = await fetch(DARAJA + pathname, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function stkPush({ phone, amount, ref }) {
  const ts = timestamp();
  const data = await darajaPost('/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: MPESA_SHORTCODE,
    Password: stkPassword(ts),
    Timestamp: ts,
    TransactionType: MPESA_TXN_TYPE,
    Amount: amount,
    PartyA: phone,
    PartyB: MPESA_PARTYB || MPESA_SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: `${BASE_URL}/api/mpesa/callback/${MPESA_CALLBACK_SECRET}`,
    AccountReference: ref,
    TransactionDesc: 'Votes',
  });
  if (String(data.ResponseCode) !== '0') {
    throw httpError(502, data.errorMessage || data.ResponseDescription || 'M-Pesa request failed.');
  }
  return data.CheckoutRequestID;
}

// Fallback if Safaricom's callback never reaches us
async function reconcileMpesa(p) {
  const ts = timestamp();
  const d = await darajaPost('/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: MPESA_SHORTCODE,
    Password: stkPassword(ts),
    Timestamp: ts,
    CheckoutRequestID: p.provider_ref,
  });
  if (d.ResultCode === undefined) return; // still processing
  if (String(d.ResultCode) === '0') settle(p.id, null);
  else markFailed(p.id);                  // cancelled, wrong PIN, insufficient funds, timeout...
}

/* ---------- Card / bank (Pesapal API 3.0 hosted checkout) ---------- */
const ps = { token: null, exp: 0, ipn: PESAPAL_IPN_ID || null };

async function pesapal(pathname, { method = 'GET', body } = {}) {
  if (!ps.token || Date.now() > ps.exp) {
    const r = await fetch(`${PESAPAL_BASE}/Auth/RequestToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ consumer_key: PESAPAL_CONSUMER_KEY, consumer_secret: PESAPAL_CONSUMER_SECRET }),
    });
    const d = await r.json();
    if (!d.token) throw new Error('Pesapal auth failed');
    ps.token = d.token;
    ps.exp = Date.now() + 4 * 60 * 1000; // tokens are short-lived
  }
  const r = await fetch(PESAPAL_BASE + pathname, {
    method,
    headers: { Authorization: `Bearer ${ps.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

async function ipnId() {
  if (!ps.ipn) {
    const d = await pesapal('/URLSetup/RegisterIPN', {
      method: 'POST',
      body: { url: `${BASE_URL}/api/pesapal/ipn`, ipn_notification_type: 'GET' },
    });
    if (!d.ipn_id) throw new Error('Pesapal IPN registration failed');
    ps.ipn = d.ipn_id;
  }
  return ps.ipn;
}

// The browser redirect and the IPN are only hints. This server-to-server call is the proof.
async function verifyPesapal(p) {
  const d = await pesapal(`/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(p.provider_ref)}`);
  const s = String(d.payment_status_description || '').toLowerCase();
  if (s === 'completed') {
    if (Number(d.amount) === p.amount && d.currency === 'KES') settle(p.id, d.confirmation_code || p.provider_ref);
    else console.warn('Pesapal amount mismatch for', p.id, d);
  } else if (['failed', 'invalid', 'reversed'].includes(s)) {
    markFailed(p.id);
  }
}

/* ---------- App ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const payLimiter = rateLimit({ windowMs: 60_000, limit: 8, standardHeaders: true, legacyHeaders: false });
const statusLimiter = rateLimit({ windowMs: 60_000, limit: 90, standardHeaders: true, legacyHeaders: false });

app.get('/api/contestants', (req, res) => {
  res.json({
    price: PRICE,
    contestants: db.prepare('SELECT id, name, description, image_url, votes FROM contestants ORDER BY votes DESC, id').all(),
  });
});

app.post('/api/pay/mpesa', payLimiter, wrap(async (req, res) => {
  const order = parseOrder(req.body);
  const phone = normalizePhone(req.body.phone);
  const ref = newRef();
  db.prepare('INSERT INTO payments (id, contestant_id, votes, amount, method, contact) VALUES (?,?,?,?,?,?)')
    .run(ref, order.contestantId, order.votes, order.amount, 'mpesa', phone);
  try {
    const checkoutId = await stkPush({ phone, amount: order.amount, ref });
    db.prepare('UPDATE payments SET provider_ref = ? WHERE id = ?').run(checkoutId, ref);
  } catch (e) {
    markFailed(ref);
    throw e;
  }
  res.json({ ref });
}));

app.post('/api/mpesa/callback/:secret', (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' }); // acknowledge first, Safaricom does not retry
  if (!MPESA_CALLBACK_SECRET || req.params.secret !== MPESA_CALLBACK_SECRET) return;
  const cb = req.body && req.body.Body && req.body.Body.stkCallback;
  if (!cb) return;
  const p = db.prepare('SELECT * FROM payments WHERE provider_ref = ?').get(cb.CheckoutRequestID);
  if (!p) return;
  if (cb.ResultCode !== 0) return void markFailed(p.id);
  const items = Object.fromEntries(((cb.CallbackMetadata || {}).Item || []).map((i) => [i.Name, i.Value]));
  if (Number(items.Amount) !== p.amount) return void console.warn('M-Pesa amount mismatch for', p.id);
  settle(p.id, String(items.MpesaReceiptNumber));
});

app.post('/api/pay/card', payLimiter, wrap(async (req, res) => {
  const order = parseOrder(req.body);
  const email = String(req.body.email || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, 'Enter a valid email address.');
  const ref = newRef();
  db.prepare('INSERT INTO payments (id, contestant_id, votes, amount, method, contact) VALUES (?,?,?,?,?,?)')
    .run(ref, order.contestantId, order.votes, order.amount, 'card', email);
  try {
    const d = await pesapal('/Transactions/SubmitOrderRequest', {
      method: 'POST',
      body: {
        id: ref,
        currency: 'KES',
        amount: order.amount,
        description: `${order.votes} vote(s)`,
        callback_url: `${BASE_URL}/`, // Pesapal adds OrderTrackingId and OrderMerchantReference
        notification_id: await ipnId(),
        billing_address: { email_address: email, country_code: 'KE' },
      },
    });
    if (!d.redirect_url) throw httpError(502, 'Could not start checkout. Try again.');
    db.prepare('UPDATE payments SET provider_ref = ? WHERE id = ?').run(d.order_tracking_id, ref);
    res.json({ ref, redirectUrl: d.redirect_url });
  } catch (e) {
    markFailed(ref);
    throw e;
  }
}));

app.get('/api/pesapal/ipn', wrap(async (req, res) => {
  const { OrderTrackingId, OrderMerchantReference, OrderNotificationType } = req.query;
  const p = db.prepare('SELECT * FROM payments WHERE id = ? AND provider_ref = ?')
    .get(String(OrderMerchantReference), String(OrderTrackingId));
  if (p && p.status === 'pending') await verifyPesapal(p);
  res.json({
    orderNotificationType: OrderNotificationType,
    orderTrackingId: OrderTrackingId,
    orderMerchantReference: OrderMerchantReference,
    status: 200,
  });
}));

app.get('/api/pay/status/:ref', statusLimiter, wrap(async (req, res) => {
  let p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.ref);
  if (!p) throw httpError(404, 'Payment not found.');
  if (p.status === 'pending' && p.provider_ref) {
    const age = Date.now() / 1000 - p.created_at;
    if (p.method === 'card') await verifyPesapal(p);
    else if (age > 25) await reconcileMpesa(p);
    p = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.ref);
  }
  res.json({ status: p.status, votes: p.votes });
}));

app.post('/api/admin/contestants', (req, res) => {
  if (!ADMIN_KEY || req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { name, description = '', imageUrl = '' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const r = db.prepare('INSERT INTO contestants (name, description, image_url) VALUES (?,?,?)').run(name, description, imageUrl);
  res.json({ id: r.lastInsertRowid });
});

app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Try again.' });
});

app.listen(PORT, () => {
  if (!BASE_URL) console.warn('BASE_URL is not set. Payment callbacks will not reach this server.');
  console.log(`Voting server running on http://localhost:${PORT}`);
});
