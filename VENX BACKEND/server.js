require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const PESAPAL_BASE = 'https://pay.pesapal.com/v3';

// Uganda Phone Formatter
function formatUgandaPhone(phone) {
  if (!phone) return '256700000000';
  let cleaned = String(phone).trim().replace(/\s+/g, '');
  if (cleaned.startsWith('0')) return '256' + cleaned.substring(1);
  if (cleaned.startsWith('+')) return cleaned.substring(1);
  return cleaned;
}

// Firebase Initialization
try {
  if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    console.log('✅ Firebase Admin initialized.');
  }
} catch (e) {
  console.warn('⚠️ Firebase init warning:', e.message);
}

// Pesapal API Fetcher with Cloudflare Bypass Headers
async function pesapalFetch(endpoint, method = 'GET', body = null, token = null) {
  const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
  const url = `${PESAPAL_BASE}${endpoint}`;

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const options = { method, headers };
  if (body && method !== 'GET') options.body = JSON.stringify(body);

  try {
    const res = await fetchFn(url, options);
    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.error(`❌ Pesapal returned HTML (Status ${res.status}):`, text.substring(0, 300));
      return {
        ok: false,
        status: res.status,
        error: `Pesapal returned HTTP ${res.status} HTML error. Check Consumer Key/Secret at pay.pesapal.com.`,
        rawText: text.substring(0, 300)
      };
    }

    return { ok: res.ok, status: res.status, data };
  } catch (netErr) {
    console.error('❌ Network Call Failed:', netErr.message);
    return { ok: false, status: 500, error: netErr.message };
  }
}

let cachedIpnId = null;

async function getIpnId(token) {
  if (cachedIpnId) return cachedIpnId;
  if (process.env.PESAPAL_NOTIFICATION_ID) {
    cachedIpnId = process.env.PESAPAL_NOTIFICATION_ID.trim();
    return cachedIpnId;
  }

  const list = await pesapalFetch('/api/URLSetup/GetIpnList', 'GET', null, token);
  if (list.ok && Array.isArray(list.data)) {
    const found = list.data.find((item) => item.url && item.url.includes('g-links-backend.onrender.com'));
    if (found && found.ipn_id) {
      cachedIpnId = found.ipn_id;
      return cachedIpnId;
    }
  }

  const reg = await pesapalFetch('/api/URLSetup/RegisterIPN', 'POST', {
    url: 'https://g-links-backend.onrender.com/api/ipn/pesapal',
    ipn_notification_type: 'GET',
  }, token);

  if (reg.ok && reg.data?.ipn_id) {
    cachedIpnId = reg.data.ipn_id;
    return cachedIpnId;
  }

  return null;
}

// Payment Initiation Handler
const handlePayment = async (req, res) => {
  console.log('➡️ Incoming Payment Payload:', req.body);
  try {
    const key = process.env.PESAPAL_CONSUMER_KEY?.trim();
    const secret = process.env.PESAPAL_CONSUMER_SECRET?.trim();

    if (!key || !secret) {
      return res.status(500).json({ error: 'Missing PESAPAL_CONSUMER_KEY or PESAPAL_CONSUMER_SECRET in Render Environment.' });
    }

    // Step 1: Auth Token
    const auth = await pesapalFetch('/api/Auth/RequestToken', 'POST', {
      consumer_key: key,
      consumer_secret: secret,
    });

    if (!auth.ok || !auth.data?.token) {
      console.error('❌ Pesapal Authentication Failed:', auth);
      return res.status(400).json({
        error: 'Pesapal Authentication failed. Check key validity in pay.pesapal.com.',
        details: auth.data || auth.error,
      });
    }

    const token = auth.data.token;

    // Step 2: Get IPN
    const ipnId = await getIpnId(token);
    if (!ipnId) {
      return res.status(400).json({ error: 'Could not obtain active IPN Notification ID from Pesapal.' });
    }

    // Step 3: Submit Order
    const amount = Number(req.body.amount || req.body.totalAmount || req.body.price) || 3000;
    const email = String(req.body.email || req.body.email_address || 'customer@venxmarket.com').trim();
    const phone = formatUgandaPhone(req.body.phone || req.body.phoneNumber);
    const fullName = String(req.body.businessName || req.body.buyerName || req.body.name || req.body.fullName || 'Venx Customer').trim();
    const orderId = String(req.body.orderId || req.body.merchantReference || `VENX-${Date.now()}`).replace(/[^a-zA-Z0-9_.-]/g, '-');
    const callbackUrl = req.body.callback_url || process.env.FRONTEND_CALLBACK_URL || 'https://mugishamuhabuzi.github.io/g-links/';

    const nameParts = fullName.split(' ');
    const orderPayload = {
      id: orderId,
      currency: 'UGX',
      amount: amount,
      description: req.body.description || `Payment for order ${orderId}`,
      callback_url: callbackUrl,
      notification_id: ipnId,
      billing_address: {
        email_address: email,
        phone_number: phone,
        first_name: nameParts[0] || 'Venx',
        last_name: nameParts.slice(1).join(' ') || 'Customer',
        country_code: 'UG',
      },
    };

    const orderRes = await pesapalFetch('/api/Transactions/SubmitOrderRequest', 'POST', orderPayload, token);

    if (orderRes.ok && orderRes.data?.redirect_url) {
      return res.status(200).json({
        status: 'success',
        paymentUrl: orderRes.data.redirect_url,
        redirect_url: orderRes.data.redirect_url,
        orderTrackingId: orderRes.data.order_tracking_id,
      });
    }

    return res.status(400).json({
      error: orderRes.data?.error?.message || orderRes.data?.message || 'Pesapal rejected payment creation.',
      details: orderRes.data || orderRes.error,
    });

  } catch (err) {
    console.error('❌ Server Payment Exception:', err.message);
    return res.status(500).json({ error: 'Internal Server Error: ' + err.message });
  }
};

// Application Endpoints
app.get('/', (req, res) => res.json({ status: 'active', gateway: 'Pesapal v3 Production' }));
app.post('/api/payments/initiate', handlePayment);
app.post('/api/pesapal-pay', handlePayment);
app.post('/api/pesapal/initiate-payment', handlePayment);
app.post('/api/checkout', handlePayment);
app.post('/api/orders/create', handlePayment);

// IPN Routes
const handleIpn = (req, res) => {
  console.log('📩 IPN Received:', req.query, req.body);
  res.status(200).json({ status: '200', message: 'IPN Received' });
};
app.get('/api/ipn/pesapal', handleIpn);
app.post('/api/ipn/pesapal', handleIpn);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Production server operational on port ${PORT}`));
