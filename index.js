const express = require('express');
const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

let sock = null;
let connectionStatus = 'disconnected';
let lastDisconnectReason = null;
let messageQueue = [];
let isProcessingQueue = false;
let reconnectTimer = null;
let pairingCode = null;
let pairingPhoneNumber = null;

const AUTH_DIR = path.join(process.cwd(), 'auth_session');
const MESSAGE_DELAY = 3000;

function clearAuthSession() {
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    console.log('🧹 auth_session cleared');
  } catch (err) {
    console.error('⚠️ Failed to clear auth_session:', err.message);
  }
}

function scheduleReconnect(delayMs = 5000) {
  if (reconnectTimer) return;
  connectionStatus = 'reconnecting';
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWhatsApp();
  }, delayMs);
}

async function connectWhatsApp(phoneForPairing) {
  connectionStatus = 'connecting';
  pairingCode = null;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      lastDisconnectReason = reason ?? 'unknown';

      if (reason === DisconnectReason.loggedOut) {
        console.log('🔐 Session logged out. Resetting auth...');
        pairingCode = null;
        clearAuthSession();
        scheduleReconnect(2000);
        return;
      }

      console.log(`🔄 Reconnecting... (reason: ${lastDisconnectReason})`);
      scheduleReconnect(5000);
    }

    if (connection === 'open') {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connectionStatus = 'connected';
      lastDisconnectReason = null;
      pairingCode = null;
      pairingPhoneNumber = null;
      console.log('✅ WhatsApp connected!');
      processQueue();
    }
  });

  // Request pairing code if phone number provided and not already registered
  if (phoneForPairing && !state.creds.registered) {
    try {
      // Wait a bit for the socket to initialize
      await new Promise(r => setTimeout(r, 3000));
      const cleanPhone = phoneForPairing.replace(/[^0-9]/g, '');
      const code = await sock.requestPairingCode(cleanPhone);
      pairingCode = code;
      pairingPhoneNumber = cleanPhone;
      connectionStatus = 'pairing_code_ready';
      console.log(`📱 Pairing code generated for ${cleanPhone}: ${code}`);
    } catch (err) {
      console.error('❌ Failed to generate pairing code:', err.message);
      pairingCode = null;
      connectionStatus = 'pairing_failed';
      lastDisconnectReason = err.message;
    }
  }
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

    await new Promise(r => setTimeout(r, MESSAGE_DELAY));
  }

  isProcessingQueue = false;
}

// === API Routes ===

app.get('/', (req, res) => {
  res.json({
    status: connectionStatus,
    queueLength: messageQueue.length,
    timestamp: new Date().toISOString(),
  });
});

app.get('/status', (req, res) => {
  res.json({
    connected: connectionStatus === 'connected',
    status: connectionStatus,
    pairingCode: pairingCode,
    pairingPhone: pairingPhoneNumber,
    queueLength: messageQueue.length,
    lastDisconnectReason,
  });
});

// Request pairing code with phone number
app.post('/request-pairing-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ success: false, error: 'phone number required' });
  }

  if (connectionStatus === 'connected') {
    return res.json({ success: true, alreadyConnected: true, message: 'Already connected' });
  }

  try {
    // Reset session and reconnect with pairing
    clearAuthSession();
    pairingCode = null;
    connectionStatus = 'connecting';
    
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    await connectWhatsApp(phone);
    
    // Wait up to 15 seconds for pairing code
    let attempts = 0;
    while (!pairingCode && attempts < 30 && connectionStatus !== 'connected') {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    if (connectionStatus === 'connected') {
      return res.json({ success: true, alreadyConnected: true, message: 'Connected!' });
    }

    if (pairingCode) {
      return res.json({ success: true, code: pairingCode, phone: pairingPhoneNumber });
    }

    return res.status(500).json({ success: false, error: 'Failed to generate pairing code. Try again.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Manual reset session
app.post('/reset-session', (req, res) => {
  clearAuthSession();
  pairingCode = null;
  pairingPhoneNumber = null;
  connectionStatus = 'reconnecting';
  scheduleReconnect(1000);
  res.json({ success: true, message: 'Session reset.' });
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

  const promise = new Promise((resolve, reject) => {
    messageQueue.push({ phone, message, resolve, reject });
  });

  processQueue();

  promise
    .then(result => res.json(result))
    .catch(err => res.status(500).json({ success: false, error: err.message }));
});

// QR page - now shows pairing info
app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.send(`<html dir="rtl"><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0fdf4;}
      .card{background:white;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);text-align:center;}</style></head>
      <body><div class="card"><h1 style="color:#16a34a">✅ واتساب متصل!</h1><p>السيرفر جاهز</p></div></body></html>`);
  }
  if (pairingCode) {
    return res.send(`<html dir="rtl"><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="refresh" content="5">
      <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#eff6ff;}
      .card{background:white;padding:30px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);text-align:center;}
      .code{font-size:36px;font-weight:bold;letter-spacing:8px;color:#2563eb;margin:20px 0;}</style></head>
      <body><div class="card"><h2>📱 كود الربط</h2><div class="code">${pairingCode}</div>
      <p>افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف</p></div></body></html>`);
  }
  res.send(`<html dir="rtl"><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="refresh" content="3">
    <style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#fef3c7;}
    .card{background:white;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1);text-align:center;}</style></head>
    <body><div class="card"><h1>⏳ في انتظار طلب ربط...</h1><p>أدخل رقم الهاتف من النظام لتوليد كود الربط</p></div></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Bot Server running on port ${PORT}`);
  connectWhatsApp();
});
