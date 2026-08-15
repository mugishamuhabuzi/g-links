require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Strict Pesapal v3 Production Base URL
const PESAPAL_BASE_URL = 'https://pay.pesapal.com/v3';

// 1. Phone Number Formatter for Uganda (077... -> 25677...)
function formatUgandaPhone(phone) {
  if (!phone) return '256700000000';
  let cleaned = String(phone).trim().replace(/\s+/g, '');
  if (cleaned.startsWith('0')) return '256' + cleaned.substring(1);
  if (cleaned.startsWith('+')) return cleaned.substring(1);
  return cleaned;
}

// 2. Firebase Admin Initialization
try {
  if (!admin.apps.length && process.env.FIREBASE_PROJECT_ID) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    console.log('✅ Connected to Firebase Firestore.');
  }
} catch (e) {
  console.warn('⚠️ Firebase setup skipped:', e.message);
}

// 3. Safe HTTP Helper for Pesapal Live API
async function callPesapalLive(endpoint, body, bearerToken = null) {
  const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
  const url = `${PESAPAL_BASE_URL}${endpoint}`;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`;
  }

  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      error: `Pesapal Live returned HTTP ${res.status} non-JSON output. Check key credentials in Render.`,
    };
  }

  return { ok: res.ok, status: res.status, data };
}

let cachedIpnId = process.env.PESAPAL_NOTIFICATION_ID || null;

// 4. Unified Production Payment Handler
const handleProductionPayment = async (req, res) => {
  try {
    const consumerKey = process.env.PESAPAL_CONSUMER_KEY;
    const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
      return res.status(400).json({
        error: 'Missing PESAPAL_CONSUMER_KEY or PESAPAL_CONSUMER_SECRET in Render Environment settings.',
      });
    }

    const amount = Number(req.body.amount || req.body.totalAmount || req.body.price) || 3000;
    const email = String(req.body.email || req.body.email_address || 'customer@venxmarket.com').trim();
    const phone = formatUgandaPhone(req.body.phone || req.body.phoneNumber);
    const fullName = String(req.body.businessName || req.body.buyerName || req.body.name || req.body.fullName || 'Venx Customer').trim();
    const orderId = req.body.orderId || req.body.merchantReference || req.body.orderReference || `VENX-${Date.now()}`;
    const description = req.body.description || `Payment for order ${orderId}`;
    const callbackUrl = req.body.callback_url || process.env.FRONTEND_CALLBACK_URL || 'https://mugishamuhabuzi.github.io/g-links/';

    // Step A: Request Authentication Token from Pesapal Live
    const authRes = await callPesapalLive('/api/Auth/RequestToken', {
      consumer_key: consumerKey,
      consumer_secret: consumerSecret,
    });

    if (!authRes.ok || !authRes.data?.token) {
      return res.status(400).json({
        error: 'Pesapal Live authentication failed. Verify keys in Render match your pay.pesapal.com Production Dashboard.',
        details: authRes.data,
      });
    }

    const token = authRes.data.token;

    // Step B: Register or Obtain IPN Notification ID
    if (!cachedIpnId) {
      const serverUrl = process.env.MY_SERVER_URL || 'https://g-links-backend.onrender.com';
      const ipnRes = await callPesapalLive(
        '/api/URLSetup/RegisterUrl',
        { url: `${serverUrl}/api/ipn/pesapal`, ipn_notification_type: 'GET' },
        token
      );

      if (ipnRes.ok && ipnRes.data?.ipn_id) {
        cachedIpnId = ipnRes.data.ipn_id;
      }
    }

    if (!cachedIpnId) {
      return res.status(400).json({
        error: 'Unable to register IPN Notification URL with Pesapal Live. Add PESAPAL_NOTIFICATION_ID directly to Render Environment Variables.',
      });
    }

    // Step C: Submit Order Request to Pesapal Live
    const nameParts = fullName.split(' ');
    const orderPayload = {
      id: orderId,
      currency: req.body.currency || 'UGX',
      amount: amount,
      description: description,
      callback_url: callbackUrl,
      notification_id: cachedIpnId,
      billing_address: {
        email_address: email,
        phone_number: phone,
        first_name: nameParts[0] || 'Venx',
        last_name: nameParts.slice(1).join(' ') || 'Customer',
        country_code: 'UG',
      },
    };

    const orderRes = await callPesapalLive('/api/Transactions/SubmitOrderRequest', orderPayload, token);

    if (orderRes.ok && orderRes.data?.redirect_url) {
      return res.status(200).json({
        status: 'success',
        paymentUrl: orderRes.data.redirect_url,
        redirect_url: orderRes.data.redirect_url,
        orderTrackingId: orderRes.data.order_tracking_id,
      });
    }

    return res.status(400).json({
      error: orderRes.data?.error?.message || orderRes.data?.message || 'Pesapal Live rejected order creation.',
      details: orderRes.data,
    });

  } catch (err) {
    console.error('❌ Production Payment Error:', err.message);
    return res.status(500).json({ error: 'Server error processing payment: ' + err.message });
  }
};

// Registered Endpoint Routes for Frontends
app.get('/', (req, res) => res.json({ status: 'active', mode: 'production', url: PESAPAL_BASE_URL }));
app.post('/api/payments/initiate', handleProductionPayment);
app.post('/api/pesapal-pay', handleProductionPayment);
app.post('/api/pesapal/initiate-payment', handleProductionPayment);
app.post('/api/checkout', handleProductionPayment);
app.post('/api/orders/create', handleProductionPayment);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Live Production Server running on port ${PORT}`));
