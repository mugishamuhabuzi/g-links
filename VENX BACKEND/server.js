require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const PESAPAL_BASE = 'https://pay.pesapal.com/v3';

// 1. Uganda Phone Number Formatter
function formatUgandaPhone(phone) {
  if (!phone) return '256700000000';
  let cleaned = String(phone).trim().replace(/\s+/g, '');
  if (cleaned.startsWith('0')) return '256' + cleaned.substring(1);
  if (cleaned.startsWith('+')) return cleaned.substring(1);
  return cleaned;
}

// 2. Firebase Admin Setup
try {
  if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    console.log('✅ Connected to Firebase.');
  }
} catch (e) {
  console.warn('⚠️ Firebase init skipped:', e.message);
}

// 3. Pesapal API Helper
async function pesapalFetch(endpoint, method = 'GET', body = null, token = null) {
  const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const options = { method, headers };
  if (body && method !== 'GET') options.body = JSON.stringify(body);

  const res = await fetchFn(`${PESAPAL_BASE}${endpoint}`, options);
  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, status: res.status, error: rawText };
  }
  return { ok: res.ok, status: res.status, data };
}

let cachedIpnId = null;

// Helper to retrieve existing IPN ID or register a new one
async function getIpnId(token) {
  if (cachedIpnId) return cachedIpnId;

  // 1. Check environment variable
  if (process.env.PESAPAL_NOTIFICATION_ID) {
    cachedIpnId = process.env.PESAPAL_NOTIFICATION_ID;
    return cachedIpnId;
  }

  // 2. Fetch existing IPNs from Pesapal
  const listRes = await pesapalFetch('/api/URLSetup/GetIpnList', 'GET', null, token);
  if (listRes.ok && Array.isArray(listRes.data)) {
    const matched = listRes.data.find(
      (item) => item.url && item.url.includes('g-links-backend.onrender.com')
    );
    if (matched && matched.ipn_id) {
      cachedIpnId = matched.ipn_id;
      console.log('✅ Retrieved existing IPN ID from Pesapal:', cachedIpnId);
      return cachedIpnId;
    }
  }

  // 3. Register IPN if not already registered
  const targetUrl = 'https://g-links-backend.onrender.com/api/ipn/pesapal';
  const regRes = await pesapalFetch('/api/URLSetup/RegisterIPN', 'POST', {
    url: targetUrl,
    ipn_notification_type: 'GET',
  }, token);

  if (regRes.ok && regRes.data?.ipn_id) {
    cachedIpnId = regRes.data.ipn_id;
    console.log('✅ Registered new IPN ID with Pesapal:', cachedIpnId);
    return cachedIpnId;
  }

  console.error('❌ Unable to retrieve IPN ID from Pesapal:', regRes);
  return null;
}

// 4. Payment Request Handler
const handlePayment = async (req, res) => {
  try {
    const key = process.env.PESAPAL_CONSUMER_KEY;
    const secret = process.env.PESAPAL_CONSUMER_SECRET;

    if (!key || !secret) {
      return res.status(500).json({ error: 'Missing PESAPAL_CONSUMER_KEY or PESAPAL_CONSUMER_SECRET on Render.' });
    }

    // Step A: Request Authentication Token
    const auth = await pesapalFetch('/api/Auth/RequestToken', 'POST', {
      consumer_key: key,
      consumer_secret: secret,
    });

    if (!auth.ok || !auth.data?.token) {
      console.error('❌ Auth Failed:', auth.data || auth.error);
      return res.status(400).json({ error: 'Pesapal authentication failed. Verify production keys on Render.' });
    }

    const token = auth.data.token;

    // Step B: Fetch or Register IPN ID
    const ipnId = await getIpnId(token);
    if (!ipnId) {
      return res.status(400).json({ error: 'Failed to retrieve active IPN ID from Pesapal.' });
    }

    // Step C: Prepare Order Payload
    const amount = Number(req.body.amount || req.body.totalAmount || req.body.price) || 3000;
    const email = String(req.body.email || req.body.email_address || 'customer@venxmarket.com').trim();
    const phone = formatUgandaPhone(req.body.phone || req.body.phoneNumber);
    const fullName = String(req.body.businessName || req.body.buyerName || req.body.name || req.body.fullName || 'Venx Customer').trim();
    const rawOrderId = req.body.orderId || req.body.merchantReference || req.body.orderReference || `VENX-${Date.now()}`;
    const callbackUrl = req.body.callback_url || process.env.FRONTEND_CALLBACK_URL || 'https://mugishamuhabuzi.github.io/g-links/';

    const nameParts = fullName.split(' ');
    const orderPayload = {
      id: String(rawOrderId).replace(/[^a-zA-Z0-9_.-]/g, '-'),
      currency: 'UGX',
      amount: amount,
      description: req.body.description || `Payment for order ${rawOrderId}`,
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

    // Step D: Submit Order to Pesapal
    const orderRes = await pesapalFetch('/api/Transactions/SubmitOrderRequest', 'POST', orderPayload, token);

    if (orderRes.ok && orderRes.data?.redirect_url) {
      return res.status(200).json({
        status: 'success',
        paymentUrl: orderRes.data.redirect_url,
        redirect_url: orderRes.data.redirect_url,
        orderTrackingId: orderRes.data.order_tracking_id,
      });
    }

    console.error('❌ Order Rejected:', orderRes.data);
    return res.status(400).json({
      error: orderRes.data?.error?.message || orderRes.data?.message || 'Pesapal rejected payment request.',
      details: orderRes.data,
    });

  } catch (err) {
    console.error('❌ Server Payment Exception:', err.message);
    return res.status(500).json({ error: 'Server error processing payment: ' + err.message });
  }
};

// Endpoints
app.get('/', (req, res) => res.json({ status: 'active', mode: 'Pesapal v3 Live' }));
app.post('/api/payments/initiate', handlePayment);
app.post('/api/pesapal-pay', handlePayment);
app.post('/api/pesapal/initiate-payment', handlePayment);
app.post('/api/checkout', handlePayment);
app.post('/api/orders/create', handlePayment);

// IPN Webhook Handlers
const handleIpn = (req, res) => {
  console.log('📩 Pesapal IPN Notification:', req.query, req.body);
  res.status(200).json({ status: '200', message: 'IPN Received' });
};
app.get('/api/ipn/pesapal', handleIpn);
app.post('/api/ipn/pesapal', handleIpn);
app.get('/api/payments/ipn', handleIpn);
app.post('/api/payments/ipn', handleIpn);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Live Server running on port ${PORT}`));
