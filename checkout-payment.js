async function payWithPesapal(orderData) {
  try {
    const response = await fetch('https://g-links-backend.onrender.com/api/payments/initiate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        orderId: orderData.orderId,
        amount: orderData.amount,
        email: orderData.email,
        phone: orderData.phone,
        buyerName: orderData.buyerName
      })
    });

    const result = await response.json();

    if (result.paymentUrl) {
      // Redirect buyer to Pesapal payment portal
      window.location.href = result.paymentUrl;
    } else {
      alert("Payment Error: " + (result.error || result.message || "Failed to initiate payment"));
    }
  } catch (error) {
    console.error("Payment Request Failed:", error);
    alert("Could not reach payment server. Please check your network connection.");
  }
}
