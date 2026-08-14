require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Format Uganda Phone Numbers
function formatUgandaPhone(phone) {
  if (!phone) return '256700000000';
  let cleaned = String(phone).trim().replace(/\s+/g, '');
  if (cleaned.startsWith('0')) return '256' + cleaned.substring(1);
  if (cleaned.startsWith('+')) return cleaned.substring(1);
  return cleaned;
}

// 1. FIREBASE INITIALIZATION
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
  console.error('❌ Firebase setup error:', e.message);
}

const db = admin.apps.length ? admin.firestore() : null;

// 2. PESAPAL CONFIGURATION
const IS_LIVE = process.env.PESAPAL_ENV === 'live';
const PESAPAL_BASE_URL = IS_LIVE
  ? 'https://pay.pesapal.com/v3'
  : 'https://cybqa.pesapal.com/pesapalv3';

const CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;

// Safe Pesapal HTTP Helper
async function pesapalApiCall(endpoint, body, bearerToken = null) {
  const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
  const fullUrl = `${PESAPAL_BASE_URL}${endpoint}`;

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`;
  }

  const res = await fetchFn(fullUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  let parsedData;
  try {
    parsedData = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Pesapal endpoint ${endpoint} returned HTML status ${res.status}. Verify Live/Sandbox key match in Render.`);
  }

  return { ok: res.ok, status: res.status, data: parsedData };
}

let cachedIpnId = null;

// 3. PAYMENT INITIATION HANDLER
const initiatePaymentHandler = async (req, res) => {
  try {
    if (!CONSUMER_KEY || !CONSUMER_SECRET) {
      return res.status(400).json({ error: 'Missing PESAPAL_CONSUMER_KEY or PESAPAL_CONSUMER_SECRET in Render Environment settings.' });
    }

    const amount = Number(req.body.amount) || 3000;
    const rawEmail = req.body.email || req.body.email_address || 'vendor@venxmarket.com';
    const email = String(rawEmail).trim();
    const phone = formatUgandaPhone(req.body.phone || req.body.phoneNumber);
    const buyerName = String(req.body.businessName || req.body.buyerName || req.body.name || 'Venx Customer').trim();
    const orderId = req.body.orderId || req.body.merchantReference || `VENX-${Date.now()}`;

    // Step 1: Request Token
    const authRes = await pesapalApiCall('/api/Auth/RequestToken', {
      consumer_key: CONSUMER_KEY,
      consumer_secret: CONSUMER_SECRET,
    });

    if (!authRes.ok || !authRes.data?.token) {
      return res.status(400).json({
        error: 'Pesapal Authentication Failed. Ensure keys in Render match the active PESAPAL_ENV.',
        details: authRes.data,
      });
    }
    const token = authRes.data.token;

    // Step 2: Register IPN URL (v3 Endpoint: /api/URLSetup/RegisterUrl)
    let notificationId = process.env.PESAPAL_NOTIFICATION_ID || process.env.PESAPAL_IPN_ID || cachedIpnId;

    if (!notificationId) {
      const serverUrl = process.env.MY_SERVER_URL || 'https://g-links-backend.onrender.com';
      try {
        const ipnRes = await pesapalApiCall(
          '/api/URLSetup/RegisterUrl',
          { url: `${serverUrl}/api/ipn/pesapal`, ipn_notification_type: 'GET' },
          token
        );
        if (ipnRes.data?.ipn_id) {
          cachedIpnId = ipnRes.data.ipn_id;
          notificationId = cachedIpnId;
        }
      } catch (ipnErr) {
        console.warn('⚠️ IPN registration warning:', ipnErr.message);
      }
    }

    if (!notificationId) {
      return res.status(400).json({
        error: 'Failed to obtain IPN Notification ID from Pesapal. Verify domain URL and IPN access.',
      });
    }

    // Step 3: Order Payload
    const nameParts = buyerName.split(' ');
    const orderPayload = {
      id: orderId,
      currency: req.body.currency || 'UGX',
      amount: amount,
      description: req.body.description || `Business Registration - ${buyerName}`,
      callback_url: req.body.callback_url || process.env.FRONTEND_CALLBACK_URL || 'https://mugishamuhabuzi.github.io/g-links/add-business.html',
      notification_id: notificationId,
      billing_address: {
        email_address: email,
        phone_number: phone,
        first_name: nameParts[0] || 'Venx',
        last_name: nameParts.slice(1).join(' ') || 'Customer',
        country_code: 'UG',
      },
    };

    // Step 4: Submit Order Request
    const orderRes = await pesapalApiCall('/api/Transactions/SubmitOrderRequest', orderPayload, token);

    if (orderRes.ok && orderRes.data?.redirect_url) {
      return res.status(200).json({
        status: 'success',
        paymentUrl: orderRes.data.redirect_url,
        redirect_url: orderRes.data.redirect_url,
        orderTrackingId: orderRes.data.order_tracking_id,
      });
    }

    return res.status(400).json({
      error: orderRes.data?.error?.message || orderRes.data?.message || 'Pesapal rejected order creation.',
      details: orderRes.data,
    });

  } catch (err) {
    console.error('❌ Payment Handler Error:', err.message);
    return res.status(400).json({ error: err.message });
  }
};

app.get('/', (req, res) => res.json({ status: 'active', env: IS_LIVE ? 'live' : 'sandbox' }));
app.post('/api/payments/initiate', initiatePaymentHandler);
app.post('/api/pesapal-pay', initiatePaymentHandler);
app.post('/api/pesapal/initiate-payment', initiatePaymentHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
