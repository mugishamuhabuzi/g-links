require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const AfricasTalking = require('africastalking');

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

// 1. FIREBASE ADMIN SETUP
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
} catch (error) {
  console.error('❌ Firebase Admin setup error:', error.message);
}

const db = admin.apps.length ? admin.firestore() : null;

// 2. AFRICA'S TALKING SMS SETUP
let sms = null;
if (process.env.AT_API_KEY && process.env.AT_USERNAME) {
  try {
    const africasTalking = AfricasTalking({
      apiKey: process.env.AT_API_KEY,
      username: process.env.AT_USERNAME,
    });
    sms = africasTalking.SMS;
  } catch (e) {
    console.error('❌ Africa\'s Talking setup error:', e.message);
  }
}

async function sendSMS(to, message) {
  if (!sms) return;
  try {
    const formattedNumber = formatUgandaPhone(to);
    await sms.send({
      to: [`+${formattedNumber}`],
      message: message,
      from: process.env.AT_SENDER_ID || undefined,
    });
  } catch (err) {
    console.error('❌ SMS error:', err.message);
  }
}

// 3. PESAPAL API CONFIGURATION
const IS_LIVE = process.env.PESAPAL_ENV === 'live';
const PESAPAL_BASE_URL = IS_LIVE
  ? 'https://pay.pesapal.com/v3'
  : 'https://cybqa.pesapal.com/pesapalv3';

// Keys default to current working keys if env variables aren't provided
const CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY || 'TDpigBOOhs+zAl8cwH2Fl82jJGyD8xev';
const CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET || '1KpqkfsMaihIcOlhnBo/gBZ5smw=';

// Get OAuth Token from Pesapal
async function getPesapalAuthToken() {
  const res = await fetch(`${PESAPAL_BASE_URL}/api/Auth/RequestToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      consumer_key: CONSUMER_KEY,
      consumer_secret: CONSUMER_SECRET,
    }),
  });

  const data = await res.json();
  if (res.ok && data.token) {
    return data.token;
  }
  throw new Error(`Pesapal Auth Failed (${res.status}): ${data.error?.message || data.message || JSON.stringify(data)}`);
}

// Register IPN URL with Pesapal dynamically
let cachedIpnId = null;
async function getOrRegisterIpnId(token) {
  if (process.env.PESAPAL_NOTIFICATION_ID || process.env.PESAPAL_IPN_ID) {
    return process.env.PESAPAL_NOTIFICATION_ID || process.env.PESAPAL_IPN_ID;
  }
  if (cachedIpnId) return cachedIpnId;

  const serverUrl = process.env.MY_SERVER_URL || 'https://g-links-backend.onrender.com';
  const ipnUrl = `${serverUrl}/api/ipn/pesapal`;

  const res = await fetch(`${PESAPAL_BASE_URL}/api/URLSetup/RegisterIPN`, {
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

  const data = await res.json();
  if (res.ok && data.ipn_id) {
    cachedIpnId = data.ipn_id;
    return cachedIpnId;
  }
  throw new Error(`Pesapal IPN Registration Failed: ${data.error?.message || data.message || JSON.stringify(data)}`);
}

// 4. API ENDPOINTS
app.get('/', (req, res) => {
  res.json({ status: 'active', message: 'Venx Market Pesapal API is live!', env: IS_LIVE ? 'live' : 'sandbox' });
});

const initiatePaymentHandler = async (req, res) => {
  try {
    const amount = Number(req.body.amount) || 3000;
    const rawEmail = req.body.email || req.body.email_address || 'vendor@venxmarket.com';
    const email = String(rawEmail).trim();
    const phone = formatUgandaPhone(req.body.phone || req.body.phoneNumber);
    const buyerName = String(req.body.businessName || req.body.buyerName || req.body.name || 'Venx Customer').trim();
    const orderId = req.body.orderId || req.body.merchantReference || `VENX-${Date.now()}`;

    // Step 1: Get Token
    const token = await getPesapalAuthToken();

    // Step 2: Get or Register IPN ID
    const notificationId = await getOrRegisterIpnId(token);

    // Step 3: Format Order Payload
    const nameParts = buyerName.split(' ');
    const firstName = nameParts[0] || 'Venx';
    const lastName = nameParts.slice(1).join(' ') || 'Customer';

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
        first_name: firstName,
        last_name: lastName,
        country_code: 'UG',
      },
    };

    // Step 4: Submit Order to Pesapal
    const orderRes = await fetch(`${PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(orderPayload),
    });

    const pesapalData = await orderRes.json();

    if (orderRes.ok && pesapalData.redirect_url) {
      return res.status(200).json({
        status: 'success',
        paymentUrl: pesapalData.redirect_url,
        redirect_url: pesapalData.redirect_url,
        orderTrackingId: pesapalData.order_tracking_id,
        order_tracking_id: pesapalData.order_tracking_id,
      });
    }

    return res.status(400).json({
      error: pesapalData.error?.message || pesapalData.message || 'Pesapal rejected order creation.',
      details: pesapalData
    });

  } catch (err) {
    console.error('❌ Payment Initiation Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

app.post('/api/payments/initiate', initiatePaymentHandler);
app.post('/api/pesapal-pay', initiatePaymentHandler);
app.post('/api/pesapal/initiate-payment', initiatePaymentHandler);

// IPN Notification Handler
const handlePesapalIPN = async (req, res) => {
  const orderTrackingId = req.query.OrderTrackingId || req.body.OrderTrackingId;
  const merchantRef = req.query.OrderMerchantReference || req.body.OrderMerchantReference;

  if (!orderTrackingId) return res.status(400).send('Missing OrderTrackingId');

  try {
    const token = await getPesapalAuthToken();
    const statusResponse = await fetch(`${PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });

    const statusData = await statusResponse.json();
    const orderId = statusData.merchant_reference || merchantRef;

    if ((statusData.payment_status_description === 'Completed' || statusData.status_code === 1) && db) {
      const orderRef = db.collection('orders').doc(orderId);
      const orderDoc = await orderRef.get();

      if (orderDoc.exists) {
        await orderRef.update({
          paymentStatus: 'Paid',
          escrowStatus: 'Held in Escrow',
          pesapalTrackingId: orderTrackingId,
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const customerPhone = orderDoc.data().buyerPhone || statusData.payment_account;
        if (customerPhone) {
          await sendSMS(customerPhone, `Venx Market: Payment for Order #${orderId} verified and locked in Escrow!`);
        }
      }
    }

    res.status(200).json({ orderNotificationType: 'IPNChange', orderTrackingId, status: '200' });
  } catch (err) {
    console.error('❌ IPN Error:', err.message);
    res.status(500).send('IPN processing error');
  }
};

app.get('/api/ipn/pesapal', handlePesapalIPN);
app.post('/api/ipn/pesapal', handlePesapalIPN);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
