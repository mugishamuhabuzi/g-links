require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const AfricasTalking = require('africastalking');

const app = express();

// =========================================================================
// CORS CONFIGURATION (STEP 2: Allow GitHub Pages & Local Dev Origins)
// =========================================================================
const allowedOrigins = [
  'https://mugishamuhabuzi.github.io', // Production GitHub Pages frontend
  'http://localhost:3000',              // Local development
  'http://localhost:5000',              // Local server port
  'http://127.0.0.1:5500'               // VS Code Live Server
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow server-to-server, mobile, or Postman requests with no origin header
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.github.io')) {
      return callback(null, true);
    } else {
      return callback(new Error('CORS policy: Access denied for this origin.'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());

// =========================================================================
// 1. FIREBASE ADMIN SDK INITIALIZATION
// =========================================================================
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
  console.log('✅ Connected to Firebase Firestore.');
} catch (error) {
  console.error('❌ Firebase Admin setup error:', error.message);
}

const db = admin.firestore();

// =========================================================================
// 2. AFRICA'S TALKING SMS SERVICE SETUP
// =========================================================================
const africasTalking = AfricasTalking({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME,
});
const sms = africasTalking.SMS;

async function sendSMS(to, message) {
  try {
    const response = await sms.send({
      to: [to],
      message: message,
      from: process.env.AT_SENDER_ID || undefined,
    });
    console.log(`📱 SMS sent to ${to}`);
    return response;
  } catch (err) {
    console.error('❌ SMS error:', err.message);
  }
}

// =========================================================================
// 3. PESAPAL API UTILITY HELPERS
// =========================================================================
const PESAPAL_BASE_URL = process.env.PESAPAL_ENV === 'live'
  ? 'https://pay.pesapal.com/v3'
  : 'https://cybqa.pesapal.com/pesapalv3';

// Request OAuth Bearer Token from Pesapal
async function getPesapalAuthToken() {
  const response = await fetch(`${PESAPAL_BASE_URL}/api/Auth/RequestToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      consumer_key: process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
    }),
  });

  const data = await response.json();
  if (data.status === '200' && data.token) {
    return data.token;
  }
  throw new Error(data.message || 'Pesapal authentication failed');
}

// Register IPN URL with Pesapal dynamically
let cachedIpnId = null;
async function getOrRegisterIpnId(token) {
  if (cachedIpnId) return cachedIpnId;

  const ipnUrl = `${process.env.MY_SERVER_URL}/api/ipn/pesapal`;

  const response = await fetch(`${PESAPAL_BASE_URL}/api/URLSetup/RegisterUrl`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      url: ipnUrl,
      ipn_notification_type: 'GET',
    }),
  });

  const data = await response.json();
  if (data.ipn_id) {
    cachedIpnId = data.ipn_id;
    console.log(`✅ Registered Pesapal IPN ID: ${cachedIpnId}`);
    return cachedIpnId;
  }
  return null;
}

// =========================================================================
// 4. API ENDPOINTS
// =========================================================================

// Health Check Endpoint
app.get('/', (req, res) => {
  res.json({ status: 'active', message: 'Venx Market Pesapal API is live!' });
});

// Route A1: Initiate Order Escrow Payment (Called by Order Checkout Page)
app.post('/api/payments/initiate', async (req, res) => {
  const { amount, email, phone, buyerName, orderId } = req.body;

  if (!amount || !email || !orderId) {
    return res.status(400).json({ error: 'Missing required order details.' });
  }

  try {
    const token = await getPesapalAuthToken();
    const notificationId = await getOrRegisterIpnId(token);

    const nameParts = (buyerName || 'Venx Customer').trim().split(' ');
    const firstName = nameParts[0] || 'Venx';
    const lastName = nameParts.slice(1).join(' ') || 'Customer';

    const orderPayload = {
      id: orderId,
      currency: 'UGX',
      amount: parseFloat(amount),
      description: `Escrow Payment for Order #${orderId}`,
      callback_url: process.env.FRONTEND_CALLBACK_URL || 'https://mugishamuhabuzi.github.io/order-success.html',
      notification_id: notificationId,
      billing_address: {
        email_address: email,
        phone_number: phone || '',
        first_name: firstName,
        last_name: lastName,
      },
    };

    const response = await fetch(`${PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(orderPayload),
    });

    const pesapalData = await response.json();

    if (pesapalData.status === '200' && pesapalData.redirect_url) {
      res.status(200).json({
        status: 'success',
        paymentUrl: pesapalData.redirect_url,
        orderTrackingId: pesapalData.order_tracking_id,
      });
    } else {
      res.status(400).json({ error: pesapalData.message || 'Failed to generate Pesapal payment link.' });
    }
  } catch (err) {
    console.error('❌ Error initiating Pesapal payment:', err.message);
    res.status(500).json({ error: 'Server error processing Pesapal payment.' });
  }
});

// Route A2: Initiate Business Registration Payment (Called by add-business.html)
app.post('/api/pesapal/initiate-payment', async (req, res) => {
  const { amount, currency, phone, description, callback_url } = req.body;

  try {
    const token = await getPesapalAuthToken();
    const notificationId = await getOrRegisterIpnId(token);

    const vendorOrderId = `REG-${Date.now()}`;

    const orderPayload = {
      id: vendorOrderId,
      currency: currency || 'UGX',
      amount: parseFloat(amount) || 3000,
      description: description || 'Venx Business Registration Fee',
      callback_url: callback_url || 'https://mugishamuhabuzi.github.io/add-business.html',
      notification_id: notificationId,
      billing_address: {
        phone_number: phone || '',
        first_name: 'Vendor',
        last_name: 'Registration'
      },
    };

    const response = await fetch(`${PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(orderPayload),
    });

    const pesapalData = await response.json();

    if (pesapalData.status === '200' && pesapalData.redirect_url) {
      res.status(200).json({
        redirect_url: pesapalData.redirect_url,
        order_tracking_id: pesapalData.order_tracking_id,
      });
    } else {
      res.status(400).json({ error: pesapalData.message || 'Failed to generate Pesapal payment link.' });
    }
  } catch (err) {
    console.error('❌ Error initiating Vendor payment:', err.message);
    res.status(500).json({ error: 'Server error initiating registration payment.' });
  }
});

// Route A3: Verify Payment Status Directly (Called by add-business.html)
app.get('/api/pesapal/verify-payment', async (req, res) => {
  const { tracking_id } = req.query;

  if (!tracking_id) {
    return res.status(400).json({ error: 'Missing tracking_id query parameter.' });
  }

  try {
    const token = await getPesapalAuthToken();
    const statusResponse = await fetch(`${PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${tracking_id}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    const statusData = await statusResponse.json();
    const statusDescription = statusData.payment_status_description || 'PENDING';

    res.status(200).json({
      status: statusDescription.toUpperCase(),
      details: statusData
    });
  } catch (err) {
    console.error('❌ Verification error:', err.message);
    res.status(500).json({ error: 'Failed to verify transaction status.' });
  }
});

// Route B: Pesapal IPN Notification Handler (Automated Webhook)
const handlePesapalIPN = async (req, res) => {
  const orderTrackingId = req.query.OrderTrackingId || req.body.OrderTrackingId;
  const merchantRef = req.query.OrderMerchantReference || req.body.OrderMerchantReference;

  if (!orderTrackingId) {
    return res.status(400).send('Missing OrderTrackingId');
  }

  try {
    const token = await getPesapalAuthToken();

    // Query official transaction status from Pesapal
    const statusResponse = await fetch(`${PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    const statusData = await statusResponse.json();
    const orderId = statusData.merchant_reference || merchantRef;
    const paymentStatus = statusData.payment_status_description;
    const statusCode = statusData.status_code;

    if (paymentStatus === 'Completed' || statusCode === 1) {
      const amountPaid = statusData.amount;
      const currency = statusData.currency || 'UGX';

      const orderRef = db.collection('orders').doc(orderId);
      const orderDoc = await orderRef.get();

      if (orderDoc.exists) {
        const orderData = orderDoc.data();

        await orderRef.update({
          paymentStatus: 'Paid',
          escrowStatus: 'Held in Escrow',
          pesapalTrackingId: orderTrackingId,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`✅ Order #${orderId} updated in Firestore to Paid & Held in Escrow.`);

        // Send Automated SMS Alerts
        const customerPhone = orderData.buyerPhone || statusData.payment_account;
        if (customerPhone) {
          await sendSMS(customerPhone, `Venx Market: Payment of ${currency} ${amountPaid.toLocaleString()} for Order #${orderId} verified and locked in Escrow!`);
        }

        if (orderData.vendorPhone) {
          await sendSMS(orderData.vendorPhone, `Venx Market Alert: New paid order #${orderId}! Funds are safely held in Escrow. Prepare order for dispatch.`);
        }
      }
    }

    // Return acknowledgment back to Pesapal
    res.status(200).json({
      orderNotificationType: 'IPNChange',
      orderTrackingId: orderTrackingId,
      status: '200',
    });
  } catch (err) {
    console.error('❌ IPN handling error:', err.message);
    res.status(500).send('IPN processing error');
  }
};

app.get('/api/ipn/pesapal', handlePesapalIPN);
app.post('/api/ipn/pesapal', handlePesapalIPN);

// =========================================================================
// 5. START SERVER
// =========================================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Venx Pesapal Backend running on port ${PORT}`));