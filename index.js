const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let messageQueue = [];
let isProcessingQueue = false;

// Rate limiting: 1 message every 3 seconds
const MESSAGE_DELAY = 3000;

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr);
      connectionStatus = 'qr_ready';
      console.log('📱 QR Code ready! Open /qr to scan');
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      connectionStatus = 'disconnected';

      if (reason !== DisconnectReason.loggedOut) {
        console.log('🔄 Reconnecting...');
        setTimeout(connectWhatsApp, 5000);
      } else {
        console.log('❌ Logged out. Delete auth_session folder and restart.');
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrCodeData = null;
      console.log('✅ WhatsApp connected!');
      processQueue();
    }
  });
}

// Process message queue with rate limiting
async function processQueue() {
  if (isProcessingQueue || messageQueue.length === 0) return;
  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    if (connectionStatus !== 'connected') {
      isProcessingQueue = false;
      return;
    }

    const { phone, message, resolve, reject } = messageQueue.shift();

    try {
      const jid = phone + '@s.whatsapp.net';
      await sock.sendMessage(jid, { text: message });
      console.log(`✅ Message sent to ${phone}`);
      resolve({ success: true });
    } catch (err) {
      console.error(`❌ Failed to send to ${phone}:`, err.message);
      reject(err);
    }

    // Wait between messages to avoid ban
    await new Promise(r => setTimeout(r, MESSAGE_DELAY));
  }

  isProcessingQueue = false;
}

// === API Routes ===

// Health check
app.get('/', (req, res) => {
  res.json({
    status: connectionStatus,
    queueLength: messageQueue.length,
    timestamp: new Date().toISOString(),
  });
});

// Get QR code page
app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.send(`
      <html dir="rtl">
        <head><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0fdf4;}
        .card{background:white;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);text-align:center;}</style></head>
        <body><div class="card">
          <h1 style="color:#16a34a">✅ واتساب متصل!</h1>
          <p>السيرفر جاهز لإرسال الرسائل تلقائياً</p>
        </div></body>
      </html>
    `);
  }

  if (!qrCodeData) {
    return res.send(`
      <html dir="rtl">
        <head><meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="3">
        <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#fef3c7;}
        .card{background:white;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);text-align:center;}</style></head>
        <body><div class="card">
          <h1>⏳ جاري تحميل QR...</h1>
          <p>الصفحة ستتحدث تلقائياً</p>
        </div></body>
      </html>
    `);
  }

  res.send(`
    <html dir="rtl">
      <head><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="refresh" content="5">
      <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#eff6ff;}
      .card{background:white;padding:30px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);text-align:center;max-width:400px;width:90%;}
      img{max-width:280px;width:100%;border-radius:8px;}</style></head>
      <body><div class="card">
        <h2>📱 امسح الكود من واتساب</h2>
        <p style="color:#666;font-size:14px;">افتح واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز</p>
        <img src="${qrCodeData}" alt="QR Code" />
        <p style="color:#999;font-size:12px;margin-top:15px;">الصفحة تتحدث تلقائياً...</p>
      </div></body>
    </html>
  `);
});

// Get status as JSON
app.get('/status', (req, res) => {
  res.json({
    connected: connectionStatus === 'connected',
    status: connectionStatus,
    qrAvailable: !!qrCodeData,
    queueLength: messageQueue.length,
  });
});

// Get QR as JSON (for embedding in the main app)
app.get('/qr-data', (req, res) => {
  res.json({
    connected: connectionStatus === 'connected',
    qr: qrCodeData,
    status: connectionStatus,
  });
});

// Send message endpoint
app.post('/send-message', (req, res) => {
  const { phone, message } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'phone and message required' });
  }

  if (connectionStatus !== 'connected') {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
  }

  // Add to queue
  const promise = new Promise((resolve, reject) => {
    messageQueue.push({ phone, message, resolve, reject });
  });

  // Start processing if not already
  processQueue();

  promise
    .then(result => res.json(result))
    .catch(err => res.status(500).json({ success: false, error: err.message }));
});

// Retry failed message
app.post('/retry', (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message required' });
  }

  const promise = new Promise((resolve, reject) => {
    messageQueue.unshift({ phone, message, resolve, reject }); // Priority
  });

  processQueue();

  promise
    .then(result => res.json(result))
    .catch(err => res.status(500).json({ success: false, error: err.message }));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Bot Server running on port ${PORT}`);
  connectWhatsApp();
});
