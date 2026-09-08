import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_IDS = new Set((process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean));
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'yalta_alerts';
const TRIGGER_RE = /бпла|беспилот|дрон|дрона|воздушн|ракет/i;
let db;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}
function publicKey() { return process.env.VAPID_PUBLIC_KEY || ''; }
function hashEndpoint(endpoint) { return crypto.createHash('sha256').update(endpoint).digest('hex'); }

async function connectMongo() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not configured');
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  db = client.db(MONGODB_DB_NAME);
  await db.collection('subscriptions').createIndex({ endpointHash: 1 }, { unique: true });
  await db.collection('alerts').createIndex({ city: 1, createdAt: -1 });
  console.log(`MongoDB connected, database: ${MONGODB_DB_NAME}`);
}

if (process.env.VAPID_SUBJECT && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}

async function telegram(method, body) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.description || 'Telegram API error');
  return result.result;
}

function getMessageText(message) {
  return (message?.text || message?.caption || '').trim();
}
function cleanAlertText(textValue) {
  return textValue.replace(/^\/alert\s*/i, '').trim();
}

async function saveSubscription(subscription) {
  const endpointHash = hashEndpoint(subscription.endpoint);
  await db.collection('subscriptions').updateOne(
    { endpointHash },
    { $set: { endpointHash, subscription, city: 'Ялта', updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true }
  );
}

async function saveAlert(textValue) {
  const alert = {
    id: crypto.randomUUID(),
    city: 'Ялта',
    text: textValue,
    createdAt: new Date(),
    source: 'Telegram, ручная пересылка'
  };
  await db.collection('alerts').insertOne(alert);
  return alert;
}

async function sendAlert(textValue, telegramChatId) {
  const alert = await saveAlert(textValue);
  const subscriptions = await db.collection('subscriptions').find({ city: 'Ялта' }).toArray();

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    for (const record of subscriptions) {
      try {
        await webpush.sendNotification(record.subscription, JSON.stringify({
          title: 'Оповещение для Ялты',
          body: textValue,
          url: '/?alert=' + encodeURIComponent(alert.id)
        }));
      } catch (error) {
        const status = error?.statusCode;
        if (status === 404 || status === 410) {
          await db.collection('subscriptions').deleteOne({ _id: record._id });
        } else {
          console.error('Push delivery failed:', error.message);
        }
      }
    }
  }

  if (telegramChatId) {
    await telegram('sendMessage', {
      chat_id: telegramChatId,
      text: 'Уведомление опубликовано для подписчиков Ялты.\n\n' + textValue
    });
  }
  return alert;
}

async function handleTelegramUpdate(update) {
  const message = update?.message;
  if (!message) return;
  const senderId = String(message.from?.id || '');
  if (!ADMIN_IDS.has(senderId)) {
    await telegram('sendMessage', { chat_id: message.chat.id, text: 'Бот принимает предупреждения только от разрешённых администраторов.' });
    return;
  }
  const originalText = getMessageText(message);
  if (!originalText) return;
  const isCommand = /^\/alert\b/i.test(originalText);
  if (!isCommand && !TRIGGER_RE.test(originalText)) {
    await telegram('sendMessage', { chat_id: message.chat.id, text: 'Сообщение не отправлено: не найден признак предупреждения. Используйте /alert перед текстом или слова «БПЛА», «дрон», «беспилотник».' });
    return;
  }
  const textValue = cleanAlertText(originalText);
  if (textValue.length < 5) return;
  await sendAlert(textValue, message.chat.id);
}

async function setupWebhook() {
  if (!BOT_TOKEN || !PUBLIC_URL || !WEBHOOK_SECRET) return;
  const webhookUrl = `${PUBLIC_URL}/telegram-webhook/${encodeURIComponent(WEBHOOK_SECRET)}`;
  try {
    await telegram('setWebhook', { url: webhookUrl, allowed_updates: ['message'], drop_pending_updates: false });
    console.log('Telegram webhook configured');
  } catch (error) {
    console.error('Webhook setup failed:', error.message);
  }
}

function serveStatic(req, res) {
  let requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (requested === '/') requested = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!file.startsWith(PUBLIC_DIR)) return text(res, 403, 'Forbidden');
  fs.readFile(file, (error, data) => {
    if (error) return text(res, 404, 'Not found');
    const ext = path.extname(file);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json',
      '.webmanifest': 'application/manifest+json',
      '.svg': 'image/svg+xml'
    };
    text(res, 200, data, types[ext] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return json(res, 200, { vapidPublicKey: publicKey(), city: 'Ялта' });
    }
    if (req.method === 'GET' && url.pathname === '/api/alerts') {
      const alerts = await db.collection('alerts').find({ city: 'Ялта' }).sort({ createdAt: -1 }).limit(50).toArray();
      return json(res, 200, alerts);
    }
    if (req.method === 'POST' && url.pathname === '/api/subscribe') {
      const body = JSON.parse(await readBody(req));
      if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) return json(res, 400, { error: 'Invalid subscription' });
      await saveSubscription(body);
      return json(res, 201, { ok: true });
    }
    if (req.method === 'POST' && WEBHOOK_SECRET && url.pathname === `/telegram-webhook/${encodeURIComponent(WEBHOOK_SECRET)}`) {
      const update = JSON.parse(await readBody(req));
      await handleTelegramUpdate(update);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET') return serveStatic(req, res);
    return text(res, 404, 'Not found');
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'Internal server error' });
  }
});

async function start() {
  try {
    await connectMongo();
    server.listen(PORT, () => {
      console.log(`Yalta alerts server listening on ${PORT}`);
      setupWebhook();
    });
  } catch (error) {
    console.error('Startup failed:', error.message);
    process.exit(1);
  }
}
start();
