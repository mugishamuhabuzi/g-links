require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// 1. Updated CORS configuration to explicitly allow your GitHub Pages frontend
app.use(cors({
  origin: [
    'https://mugishamuhabuzi.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    '*' // Fallback wildcard to ensure zero disruption with existing requests
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json());

const PESAPAL_BASE = 'https://pay.pesapal.com/v3';

// Uganda Phone Formatter
function formatUgandaPhone(phone) {
  if (!phone) return '256700000000';
  let cleaned = String(phone).trim().replace(/\s+/g, '');
  if (cleaned.startsWith('0')) return '256' + cleaned.substring(1);
  if (cleaned.startsWith('+')) return cleaned.substring(1);
  if (!cleaned.startsWith('256') && cleaned.length === 9) return '256' + cleaned;
  return cleaned;
}

// Firebase Initialization
let db;
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
  db = admin.firestore();
} catch (e) {
  console.warn('⚠️ Firebase init warning:', e.message);
}

// Pesapal API Fetcher
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
      console.error(`❌ Pesapal returned non-JSON response (Status ${res.status}):`, text.substring(0, 300));
      return {
        ok: false,
        status: res.status,
        error: `Pesapal HTTP ${res.status} error response.`,
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

// Master Payment Handler
const handlePayment = async (req, res) => {
  console.log('➡️ Incoming Payment Request Body:', req.body);
  try {
    const key = process.env.PESAPAL_CONSUMER_KEY?.trim();
    const secret = process.env.PESAPAL_CONSUMER_SECRET?.trim();

    if (!key || !secret) {
      return res.status(500).json({ error: 'Missing PESAPAL_CONSUMER_KEY or PESAPAL_CONSUMER_SECRET in Render Environment.' });
    }

    // Step 1: Authentication
    const auth = await pesapalFetch('/api/Auth/RequestToken', 'POST', {
      consumer_key: key,
      consumer_secret: secret,
    });

    if (!auth.ok || !auth.data?.token) {
      console.error('❌ Pesapal Authentication Failed:', auth);
      return res.status(400).json({
        error: 'Pesapal Authentication failed. Verify keys on pay.pesapal.com.',
        details: auth.data || auth.error,
      });
    }

    const token = auth.data.token;

    // Step 2: Get IPN ID
    const ipnId = await getIpnId(token);
    if (!ipnId) {
      console.error('❌ Could not acquire active IPN ID.');
      return res.status(400).json({ error: 'Could not obtain active IPN Notification ID from Pesapal.' });
    }

    // Step 3: Clean Amounts, Phone & Special Characters
    let rawAmount = req.body.amount || req.body.totalAmount || req.body.price || req.body.packagePrice || 3000;
    if (typeof rawAmount === 'string') {
      rawAmount = rawAmount.replace(/[^0-9.]/g, '');
    }
    const amount = Number(rawAmount) || 3000;

    const email = String(req.body.email || req.body.email_address || 'customer@venxmarket.com').trim();
    const phone = formatUgandaPhone(req.body.phone || req.body.phoneNumber);
    
    // Sanitize description: strip parenthesis and special characters for Pesapal compliance
    let rawDescription = req.body.description || req.body.packageName || (req.body.businessName ? `VENX Registration - ${req.body.businessName}` : `Order Payment`);
    const sanitizedDescription = String(rawDescription).replace(/[^a-zA-Z0-9\s-]/g, '').substring(0, 90).trim();

    const rawName = String(req.body.businessName || req.body.buyerName || req.body.name || req.body.fullName || 'Venx Customer').replace(/[^a-zA-Z0-9\s]/g, '').trim();
    const nameParts = rawName.split(' ');

    const orderId = `VENX-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const callbackUrl = req.body.callback_url || process.env.FRONTEND_CALLBACK_URL || 'https://mugishamuhabuzi.github.io/g-links/';

    const orderPayload = {
      id: orderId,
      currency: 'UGX',
      amount: amount,
      description: sanitizedDescription || 'VENX Registration Fee',
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

    // Step 4: Submit Order Request
    const orderRes = await pesapalFetch('/api/Transactions/SubmitOrderRequest', 'POST', orderPayload, token);

    if (orderRes.ok && orderRes.data?.redirect_url) {
      const redirectUrl = orderRes.data.redirect_url;
      console.log('✅ Payment Link Successfully Generated:', redirectUrl);

      return res.status(200).json({
        status: 'success',
        success: true,
        redirect_url: redirectUrl,
        redirectUrl: redirectUrl,
        paymentUrl: redirectUrl,
        url: redirectUrl,
        redirect: redirectUrl,
        orderTrackingId: orderRes.data.order_tracking_id,
        merchantReference: orderId,
      });
    }

    console.error('❌ Pesapal Rejected Order Submission:', orderRes.data || orderRes.error);
    return res.status(400).json({
      error: orderRes.data?.error?.message || orderRes.data?.message || 'Pesapal rejected payment creation.',
      details: orderRes.data || orderRes.error,
    });

  } catch (err) {
    console.error('❌ Server Payment Exception:', err.message);
    return res.status(500).json({ error: 'Internal Server Error: ' + err.message });
  }
};

// ==========================================
// ESCROW PAYOUT EVALUATION ENGINE (STEP 4)
// ==========================================
app.post('/api/evaluate-payout', async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({ success: false, message: "Order ID is required." });
  }

  if (!db) {
    return res.status(500).json({ success: false, message: "Firebase database not initialized on server." });
  }

  try {
    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ success: false, message: "Order not found." });
    }

    const orderData = orderDoc.data();

    // 1. Idempotency safeguard
    if (orderData.payoutStatus === "released") {
      return res.status(400).json({ success: false, message: "Payout has already been released for this order." });
    }

    // 2. Validate the Three Pillars of Verification
    const isCustomerPaid = 
      (orderData.paymentStatus || "").toLowerCase() === "completed" || 
      (orderData.paymentStatus || "").toLowerCase() === "successful";

    const isRiderConfirmed = 
      (orderData.riderStatus || orderData.deliveryStatus || "").toLowerCase() === "accepted" || 
      (orderData.riderStatus || orderData.deliveryStatus || "").toLowerCase() === "delivered";

    const isAdminApproved = orderData.adminApproval === true;

    // 3. Evaluate criteria
    if (!isCustomerPaid || !isRiderConfirmed || !isAdminApproved) {
      return res.status(200).json({ 
        success: false, 
        released: false,
        message: "Escrow hold active. Missing one or more required approvals.",
        checks: {
          customerPaid: isCustomerPaid,
          riderConfirmed: isRiderConfirmed,
          adminApproved: isAdminApproved
        }
      });
    }

    // 4. All conditions satisfied: Execute payout release atomically via batch write
    const payoutAmount = orderData.totalAmount || orderData.amount || 0;
    const vendorId = orderData.vendorId;

    const batch = db.batch();

    batch.update(orderRef, {
      payoutStatus: "released",
      releasedAt: new Date().toISOString()
    });

    const txnRef = db.collection('vendorTransactions').doc();
    batch.set(txnRef, {
      vendorId: vendorId,
      orderId: orderId,
      amount: payoutAmount,
      type: "payout_credit",
      status: "completed",
      createdAt: new Date().toISOString()
    });

    await batch.commit();

    return res.status(200).json({ 
      success: true, 
      released: true, 
      message: "Payout successfully released from escrow and logged to vendor history." 
    });

  } catch (error) {
    console.error("Error processing payout evaluation:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Application Routes
app.get('/', (req, res) => res.json({ status: 'active', gateway: 'Pesapal v3 Production' }));

// Health Check Route for Render Cold-Start Warm-up
app.get('/api/health', (req, res) => res.status(200).json({ status: 'healthy', timestamp: Date.now() }));

// Product Checkout Routes
app.post('/api/payments/initiate', handlePayment);
app.post('/api/pesapal-pay', handlePayment);
app.post('/api/pesapal/initiate-payment', handlePayment);
app.post('/api/checkout', handlePayment);
app.post('/api/orders/create', handlePayment);

// Registration & Package Routes
app.post('/api/payments/register-fee', handlePayment);
app.post('/api/payments/package', handlePayment);
app.post('/api/payments/package-fee', handlePayment);
app.post('/api/vendor/register-payment', handlePayment);

// Explicit rider button routes to prevent 404 fetch errors
app.post('/api/payments/initiate-registration', handlePayment);
app.post('/api/payments/initiate-cod-remittance', handlePayment);

// IPN Endpoints
const handleIpn = (req, res) => {
  console.log('📩 IPN Received:', req.query, req.body);
  res.status(200).json({ status: '200', message: 'IPN Received' });
};
app.get('/api/ipn/pesapal', handleIpn);
app.post('/api/ipn/pesapal', handleIpn);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Production server operational on port ${PORT}`));
