require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Helper function to format Uganda phone numbers
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
  }
} catch (e) {
  console.error('Firebase init error:', e.message);
}

// 2. PESAPAL CONFIG
const IS_LIVE = process.env.PESAPAL_ENV === 'live';
const PESAPAL_BASE_URL = IS_LIVE
  ? 'https://pay.pesapal.com/v3'
  : 'https://cybqa.pesapal.com/pesapalv3';

const CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY || 'TDpigBOOhs+zAl8cwH2Fl82jJGyD8xev';
const CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET || '1KpqkfsMaihIcOlhnBo/gBZ5smw=';

// Safe HTTP Request Helper (Prevents JSON crash on HTML responses)
async function safePesapalPost(url, body, bearerToken = null) {
  const fetchFn = globalThis.fetch || (await import('node-fetch')).default;
  
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
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
  } catch (e) {
    throw new Error(`Pesapal endpoint (${url}) returned HTML/Non-JSON [HTTP ${res.status}]: ${rawText.substring(0, 120)}...`);
  }

  return { ok: res.ok, status: res.status, data };
}

let cachedIpnId = null;

// 3. MAIN PAYMENT HANDLER
const initiatePaymentHandler = async (req, res) => {
  try {
    const amount = Number(req.body.amount) || 3000;
    const email = String(req.body.email || req.body.email_address || 'vendor@venxmarket.com').trim();
    const phone = formatUgandaPhone(req.body.phone || req.body.phoneNumber);
    const buyerName = String(req.body.businessName || req.body.buyerName || req.body.name || 'Venx Customer').trim();
    const orderId = req.body.orderId || req.body.merchantReference || `VENX-${Date.now()}`;

    // Step 1: Request OAuth Bearer Token
    const authRes = await safePesapalPost(`${PESAPAL_BASE_URL}/api/Auth/RequestToken`, {
      consumer_key: CONSUMER_KEY,
      consumer_secret: CONSUMER_SECRET,
    });

    if (!authRes.ok || !authRes.data.token) {
      return res.status(400).json({
        error: 'Pesapal Authentication Failed',
        details: authRes.data,
      });
    }
    const token = authRes.data.token;

    // Step 2: Register IPN Notification URL
    if (!cachedIpnId && !process.env.PESAPAL_NOTIFICATION_ID) {
      const serverUrl = process.env.MY_SERVER_URL || 'https://g-links-backend.onrender.com';
      const ipnRes = await safePesapalPost(
        `${PESAPAL_BASE_URL}/api/URLSetup/RegisterIPN`,
        { url: `${serverUrl}/api/ipn/pesapal`, ipn_notification_type: 'GET' },
        token
      );

      if (ipnRes.ok && ipnRes.data.ipn_id) {
        cachedIpnId = ipnRes.data.ipn_id;
      } else {
        return res.status(400).json({
          error: 'IPN Registration Failed',
          details: ipnRes.data,
        });
      }
    }
    const notificationId = process.env.PESAPAL_NOTIFICATION_ID || cachedIpnId;

    // Step 3: Submit Order Request
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

    const orderRes = await safePesapalPost(
      `${PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`,
      orderPayload,
      token
    );

    if (orderRes.ok && orderRes.data.redirect_url) {
      return res.status(200).json({
        status: 'success',
        paymentUrl: orderRes.data.redirect_url,
        redirect_url: orderRes.data.redirect_url,
        orderTrackingId: orderRes.data.order_tracking_id,
      });
    }

    return res.status(400).json({
      error: 'Pesapal rejected order creation',
      details: orderRes.data,
    });

  } catch (err) {
    console.error('❌ Payment Initiation Error:', err.message);
    return res.status(500).json({
      error: 'Error initiating Vendor payment',
      message: err.message,
    });
  }
};

app.get('/', (req, res) => res.json({ status: 'active', env: IS_LIVE ? 'live' : 'sandbox' }));
app.post('/api/payments/initiate', initiatePaymentHandler);
app.post('/api/pesapal-pay', initiatePaymentHandler);
app.post('/api/pesapal/initiate-payment', initiatePaymentHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server active on port ${PORT}`));
