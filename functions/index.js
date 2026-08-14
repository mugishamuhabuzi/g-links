const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");

admin.initializeApp();
const db = admin.firestore();

// --- PESAPAL CONFIGURATION ---
const PESAPAL_CONSUMER_KEY = process.env.PESAPAL_KEY || "c7vnpsVpt1YQUzOhDWPbF7WBqSOFeSNu";
const PESAPAL_CONSUMER_SECRET = process.env.PESAPAL_SECRET || "cKl3tTyMoZVKQjvfI37XQj2hsJY=";
const PESAPAL_IPN_ID_ENV = process.env.PESAPAL_IPN_ID;
const IS_LIVE = true;

const PESAPAL_BASE_URL = IS_LIVE 
  ? "https://pay.pesapal.com/v3" 
  : "https://cybqa.pesapal.com/pesapalv3";

const CALLBACK_URL = "https://venx-online-market.web.app/payment-success.html";
const IPN_URL = "https://pesapalipn-k5xcp3ar3a-uc.a.run.app";

async function getPesapalAuthToken() {
  const response = await axios.post(`${PESAPAL_BASE_URL}/api/Auth/RequestToken`, {
    consumer_key: PESAPAL_CONSUMER_KEY,
    consumer_secret: PESAPAL_CONSUMER_SECRET
  }, {
    headers: { "Content-Type": "application/json", "Accept": "application/json" }
  });
  return response.data.token;
}

async function getOrRegisterIPNId(token) {
  if (PESAPAL_IPN_ID_ENV) return PESAPAL_IPN_ID_ENV;

  try {
    const response = await axios.post(`${PESAPAL_BASE_URL}/api/URLSetup/RegisterUrl`, {
      url: IPN_URL,
      ipn_notification_type: "GET"
    }, {
      headers: { 
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      }
    });
    return response.data.ipn_id;
  } catch (err) {
    console.warn("IPN Registration warning:", err.response?.data || err.message);
    if (err.response?.data?.ipn_id) return err.response.data.ipn_id;
    throw err;
  }
}

/**
 * UNIFIED CHECKOUT FUNCTION (2nd Gen)
 */
exports.pesapalUnifiedCheckout = onRequest({ cors: true }, async (req, res) => {
  try {
    const { 
      amount, 
      currency = "UGX", 
      email, 
      phoneNumber, 
      merchantReference, 
      paymentType, // "rider", "package", "business", "deposit", or "order"
      referenceId,  // riderId, businessId, userId, or orderId
      description 
    } = req.body;

    if (!amount || !email || !merchantReference || !paymentType || !referenceId) {
      return res.status(400).json({ error: "Missing required payment fields (amount, email, merchantReference, paymentType, or referenceId)." });
    }

    const token = await getPesapalAuthToken();
    const ipnId = await getOrRegisterIPNId(token);

    // Split names safely for Pesapal Billing Requirements
    const cleanEmail = email.trim();
    const firstName = paymentType.toUpperCase();
    const lastName = "User";

    const orderPayload = {
      id: merchantReference,
      currency: currency,
      amount: parseFloat(amount),
      description: description || `Venx Market ${paymentType.toUpperCase()} Payment`,
      callback_url: CALLBACK_URL,
      notification_id: ipnId,
      billing_address: {
        email_address: cleanEmail,
        phone_number: phoneNumber || "",
        first_name: firstName,
        last_name: lastName,
        country_code: "UG"
      }
    };

    const orderResponse = await axios.post(
      `${PESAPAL_BASE_URL}/api/Transactions/SubmitOrderRequest`,
      orderPayload,
      { 
        headers: { 
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        } 
      }
    );

    const { order_tracking_id, redirect_url } = orderResponse.data;

    let targetCollection = "orders";
    let updateData = {
      pesapalTrackingId: order_tracking_id,
      merchantReference: merchantReference,
      paymentStatus: "PENDING_PESAPAL",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (paymentType === "rider") {
      targetCollection = "riders";
      updateData.status = "pending_payment";
      updateData.isApproved = false;
    } else if (paymentType === "package" || paymentType === "business") {
      targetCollection = "businesses";
      updateData.status = "pending_payment";
    } else if (paymentType === "deposit") {
      targetCollection = "deposits";
      updateData.status = "pending";
    }

    await db.collection(targetCollection).doc(referenceId).set(updateData, { merge: true });

    return res.status(200).json({ order_tracking_id, redirect_url });

  } catch (error) {
    const errorDetails = error.response?.data || error.message;
    console.error("Unified Payment Error Details:", errorDetails);
    return res.status(500).json({ 
      error: "Payment initiation failed", 
      details: errorDetails 
    });
  }
});

/**
 * UNIFIED IPN LISTENER FUNCTION (2nd Gen)
 */
exports.pesapalIPN = onRequest({ cors: true }, async (req, res) => {
  const orderTrackingId = req.query.OrderTrackingId || req.body.OrderTrackingId || req.query.orderTrackingId;
  if (!orderTrackingId) return res.status(400).send("Missing OrderTrackingId");

  try {
    const token = await getPesapalAuthToken();
    const statusResponse = await axios.get(
      `${PESAPAL_BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );

    const isCompleted = statusResponse.data.payment_status_description === "COMPLETED";
    const statusText = isCompleted ? "COMPLETED" : "FAILED";

    // 1. Orders
    const orderDoc = await db.collection("orders").where("pesapalTrackingId", "==", orderTrackingId).limit(1).get();
    if (!orderDoc.empty) {
      await orderDoc.docs[0].ref.update({
        paymentStatus: statusText,
        orderStatus: isCompleted ? "paid" : "payment_failed",
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(200).json({ orderNotificationType: "IPNCHANGE", status: 200 });
    }

    // 2. Businesses
    const bizDoc = await db.collection("businesses").where("pesapalTrackingId", "==", orderTrackingId).limit(1).get();
    if (!bizDoc.empty) {
      const graceEnd = new Date();
      graceEnd.setFullYear(graceEnd.getFullYear() + 1);
      await bizDoc.docs[0].ref.update({
        paymentStatus: statusText,
        status: isCompleted ? "approved" : "pending_payment",
        isLive: isCompleted,
        isGracePeriodActive: isCompleted,
        gracePeriodExpiresAt: graceEnd,
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(200).json({ orderNotificationType: "IPNCHANGE", status: 200 });
    }

    // 3. Riders
    const riderDoc = await db.collection("riders").where("pesapalTrackingId", "==", orderTrackingId).limit(1).get();
    if (!riderDoc.empty) {
      await riderDoc.docs[0].ref.update({
        paymentStatus: statusText,
        status: isCompleted ? "active" : "pending_payment",
        isApproved: isCompleted,
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return res.status(200).json({ orderNotificationType: "IPNCHANGE", status: 200 });
    }

    return res.status(200).json({ orderNotificationType: "IPNCHANGE", status: 200 });

  } catch (error) {
    console.error("IPN Error:", error.response?.data || error.message);
    return res.status(500).send("IPN Error");
  }
});
