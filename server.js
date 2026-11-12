require('dotenv').config();
require('express-async-errors');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@libsql/client');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const port = Number(process.env.PORT || 3000);
const appName = process.env.APP_NAME || 'AI Photo Enhancer Pro';
const defaultPrompt = process.env.DEFAULT_PROMPT || 'Enhance the uploaded photograph into a premium professional DSLR-quality portrait. Preserve the original person\'s facial identity, facial structure, expression, hairstyle, clothes and body proportions. Improve overall image brightness, exposure and dynamic range. Recover dark shadows and hidden details from face, hair and clothes. Apply professional HDR enhancement. Make face naturally smooth and clear while preserving realistic skin texture. Improve hair details and individual hair strands without drastically changing hairstyle. Improve clothing texture and fabric details. Apply balanced cinematic color grading. Make colors rich, vibrant and natural. Improve yellow, green and other colors without excessive saturation. Apply beautiful natural lighting and balanced shadows. Create smooth professional DSLR-style background blur with natural optical bokeh. Keep original person sharp and clearly visible. Do not replace face, generate a different person, apply artificial beauty filters, change pose or clothing. Final output should look like a professionally edited DSLR photograph with excellent clarity, realistic colors, balanced lighting and natural background blur.';

const dataDir = process.env.PHOTO_ENHANCER_DATA_DIR || path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'store.json');
const tursoConfigured = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN &&
  !/your-db|replace-with-real-token/i.test(`${process.env.TURSO_DATABASE_URL} ${process.env.TURSO_AUTH_TOKEN}`));
const turso = tursoConfigured
  ? createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : null;
const sessions = new Map();
const supportedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
let firebaseAccessToken = null;
let dbCache = null;
let dbInitialization = null;
let writeQueue = Promise.resolve();

function createInitialState() {
  return {
    users: [],
    prompts: [{ id: 'default', value: defaultPrompt, updatedAt: new Date().toISOString() }],
    settings: {
      appName,
      geminiSettings: { modelName: process.env.GEMINI_MODEL || 'gemini-3.1-flash-image' },
      maintenanceMode: false,
      maintenanceMessage: 'We are updating services. Please try again shortly.',
      appAnnouncement: 'New premium AI enhancements are live!',
      adSettings: {
        enabled: true,
        rewardVideoEnabled: true,
        placement: 'post-selection,post-processing,download',
        bannerAdUnitId: '',
        interstitialAdUnitId: '',
        rewardedAdUnitId: '',
        maxRewardedAdsPerDay: 5,
        testMode: true
      },
      usageLimits: { maxDailyEnhancements: 50, maxImageSizeMb: 10 }
    },
    notifications: [],
    deviceTokens: [],
    activityLogs: [],
    stats: {
      totalUsers: 0,
      pendingUsers: 0,
      activeUsers: 0,
      blockedUsers: 0,
      totalEnhancementRequests: 0,
      successfulRequests: 0,
      failedRequests: 0
    }
  };
}

function migrateDb(data) {
  let migrated = false;
  for (const [key, value] of Object.entries({
    users: [],
    prompts: [{ id: 'default', value: defaultPrompt, updatedAt: new Date().toISOString() }],
    settings: createInitialState().settings,
    notifications: [],
    activityLogs: [],
    stats: {}
  })) {
    if (data[key] === undefined) {
      data[key] = value;
      migrated = true;
    }
  }
  const defaults = createInitialState();
  const previousSettings = JSON.stringify(data.settings);
  data.settings = {
    ...defaults.settings,
    ...data.settings,
    adSettings: { ...defaults.settings.adSettings, ...(data.settings?.adSettings || {}) },
    usageLimits: { ...defaults.settings.usageLimits, ...(data.settings?.usageLimits || {}) },
    geminiSettings: { ...defaults.settings.geminiSettings, ...(data.settings?.geminiSettings || {}) }
  };
  if (previousSettings !== JSON.stringify(data.settings)) migrated = true;
  for (const user of data.users) {
    if (!user.email) user.email = '';
    if (!user.role) user.role = 'user';
    if (!user.createdAt) {
      user.createdAt = new Date().toISOString();
      migrated = true;
    }
    if (!user.updatedAt) {
      user.updatedAt = user.createdAt;
      migrated = true;
    }
  }
  if (!Array.isArray(data.deviceTokens)) {
    data.deviceTokens = [];
    migrated = true;
  }
  for (const user of data.users || []) {
    if (user.password && !user.passwordHash) {
      user.passwordHash = hashPassword(user.password);
      delete user.password;
      migrated = true;
    }
  }
  const legacyTokens = (data.notifications || []).filter((item) => item.type === 'fcm_token');
  if (legacyTokens.length) {
    for (const item of legacyTokens) {
      if (!data.deviceTokens.some((entry) => entry.userId === item.userId && entry.token === item.message)) {
        data.deviceTokens.push({ userId: item.userId, token: item.message, createdAt: item.createdAt });
      }
    }
    data.notifications = data.notifications.filter((item) => item.type !== 'fcm_token');
    migrated = true;
  }
  return migrated;
}

const tursoSchema = [
  'CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, mobile TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, status TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS editing_prompts (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS usage_history (id TEXT PRIMARY KEY, action TEXT NOT NULL, user_id TEXT, details TEXT NOT NULL, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS processing_jobs (id TEXT PRIMARY KEY, user_id TEXT, status TEXT NOT NULL, mime_type TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL, user_id TEXT, delivery TEXT, created_at TEXT NOT NULL, is_read INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS device_tokens (user_id TEXT NOT NULL, token TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, token))'
];

async function persistTurso(data) {
  const transaction = await turso.transaction('write');
  try {
    const snapshot = JSON.stringify(data);
    await transaction.execute({
      sql: 'INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      args: ['main', snapshot, new Date().toISOString()]
    });
    for (const table of ['users', 'admin_settings', 'editing_prompts', 'usage_history', 'processing_jobs', 'notifications', 'device_tokens']) {
      await transaction.execute(`DELETE FROM ${table}`);
    }
    for (const user of data.users || []) {
      await transaction.execute({
        sql: 'INSERT INTO users (id, name, email, mobile, password_hash, status, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [user.id, user.name, user.email || null, user.mobile, user.passwordHash, user.status, user.role || 'user', user.createdAt, user.updatedAt]
      });
    }
    for (const [key, value] of Object.entries(data.settings || {})) {
      await transaction.execute({ sql: 'INSERT INTO admin_settings (key, value) VALUES (?, ?)', args: [key, JSON.stringify(value)] });
    }
    for (const prompt of data.prompts || []) {
      await transaction.execute({ sql: 'INSERT INTO editing_prompts (id, value, updated_at) VALUES (?, ?, ?)', args: [prompt.id, prompt.value, prompt.updatedAt] });
    }
    const persistedJobs = new Set();
    for (const entry of data.activityLogs || []) {
      await transaction.execute({
        sql: 'INSERT INTO usage_history (id, action, user_id, details, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [entry.id, entry.action, entry.userId, JSON.stringify(entry.details || {}), entry.createdAt]
      });
      if (entry.action.startsWith('enhancement.')) {
        const jobId = entry.details?.runId || entry.id;
        if (persistedJobs.has(jobId)) continue;
        persistedJobs.add(jobId);
        const status = entry.action === 'enhancement.completed' ? 'completed'
          : entry.action === 'enhancement.failed' ? 'failed' : 'processing';
        await transaction.execute({
          sql: 'INSERT OR REPLACE INTO processing_jobs (id, user_id, status, mime_type, created_at) VALUES (?, ?, ?, ?, ?)',
          args: [jobId, entry.userId, status, entry.details?.mimeType || null, entry.createdAt]
        });
      }
    }
    for (const notification of data.notifications || []) {
      await transaction.execute({
        sql: 'INSERT INTO notifications (id, type, title, message, user_id, delivery, created_at, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [notification.id, notification.type, notification.title || '', notification.message || '', notification.userId, notification.delivery || null, notification.createdAt, notification.isRead ? 1 : 0]
      });
    }
    for (const entry of data.deviceTokens || []) {
      await transaction.execute({
        sql: 'INSERT INTO device_tokens (user_id, token, created_at) VALUES (?, ?, ?)',
        args: [entry.userId, entry.token, entry.createdAt]
      });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function ensureStorage() {
  if (!dbInitialization) {
    dbInitialization = (async () => {
      let data;
      let isTursoNewState = false;
      if (turso) {
        for (const statement of tursoSchema) await turso.execute(statement);
        const result = await turso.execute({ sql: 'SELECT value FROM app_state WHERE key = ?', args: ['main'] });
        if (result.rows.length) data = JSON.parse(result.rows[0].value);
        else {
          isTursoNewState = true;
          data = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : createInitialState();
        }
      } else {
        fs.mkdirSync(dataDir, { recursive: true });
        if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify(createInitialState(), null, 2), 'utf8');
        data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      }
      const migrated = migrateDb(data);
      dbCache = data;
      if (turso) {
        if (migrated || isTursoNewState) await persistTurso(data);
        if (migrated && fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
      } else if (migrated) {
        fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf8');
      }
    })();
  }
  await dbInitialization;
}

async function readDb() {
  await ensureStorage();
  await writeQueue;
  return JSON.parse(JSON.stringify(dbCache));
}

async function writeDb(data) {
  await ensureStorage();
  return mutateDb((current) => {
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, JSON.parse(JSON.stringify(data)));
  });
}

async function mutateDb(update) {
  await ensureStorage();
  const operation = writeQueue.catch(() => {}).then(async () => {
    const updatedState = JSON.parse(JSON.stringify(dbCache));
    const result = update(updatedState);
    if (turso) {
      await persistTurso(updatedState);
    } else {
      fs.writeFileSync(dbPath, JSON.stringify(updatedState, null, 2), 'utf8');
    }
    dbCache = updatedState;
    return result;
  });
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function buildUserSummary(user) {
  const { password, passwordHash, ...safeUser } = user;
  return safeUser;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  const [scheme, saltHex, hashHex] = encoded.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function getUserIdFromRequest(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match ? match[1] : null;
}

async function getUserFromRequest(req) {
  const token = getUserIdFromRequest(req);
  const session = token && sessions.get(token);
  if (!session || session.type !== 'user' || session.expiresAt < Date.now()) return null;
  const db = await readDb();
  const user = db.users.find((entry) => entry.id === session.userId) || null;
  return user && user.status === 'active' ? user : null;
}

function isAdminRequest(req) {
  const token = getUserIdFromRequest(req);
  const session = token && sessions.get(token);
  if (!session || session.type !== 'admin' || session.expiresAt < Date.now()) return false;
  return true;
}

function createSession(type, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { type, userId, expiresAt: Date.now() + sessionLifetimeMs });
  return token;
}

function requireAdmin(req, res, next) {
  if (!isAdminRequest(req)) return res.status(401).json({ message: 'Valid admin authentication is required.' });
  next();
}

function requireUser(req, res, next) {
  getUserFromRequest(req).then((user) => {
    req.authenticatedUser = user;
    if (!user) return res.status(401).json({ message: 'Valid active user authentication is required.' });
    next();
  }).catch(next);
}

async function logActivity(action, userId, details) {
  await mutateDb((db) => db.activityLogs.unshift({
    id: makeId('activity'),
    action,
    userId: userId || null,
    details: details || {},
    createdAt: new Date().toISOString()
  }));
}

async function createNotification(type, title, message, userId) {
  await mutateDb((db) => db.notifications.unshift({
    id: makeId('notification'),
    type,
    title,
    message,
    userId: userId || null,
    createdAt: new Date().toISOString(),
    isRead: false
  }));
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function imageSignatureMatches(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mimeType === 'image/png') {
    return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  return mimeType === 'image/webp' &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

async function getFirebaseAccessToken() {
  if (firebaseAccessToken && firebaseAccessToken.expiresAt > Date.now() + 60_000) {
    return firebaseAccessToken.value;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase service-account credentials are not configured.');

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify(claims))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(15000),
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!response.ok) throw new Error(`Firebase authorization failed (${response.status}).`);
  const result = await response.json();
  if (!result.access_token || !result.expires_in) throw new Error('Firebase authorization returned an invalid response.');
  firebaseAccessToken = { value: result.access_token, expiresAt: Date.now() + Number(result.expires_in) * 1000 };
  return result.access_token;
}

async function sendFcmNotification(token, title, message) {
  const accessToken = await getFirebaseAccessToken();
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(process.env.FIREBASE_PROJECT_ID)}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body: message },
        android: { priority: 'HIGH' }
      }
    })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message || `FCM delivery failed (${response.status}).`);
  }
}

async function calculateStats() {
  const db = await readDb();
  const users = db.users || [];
  const totalUsers = users.length;
  const pendingUsers = users.filter((user) => user.status === 'pending').length;
  const activeUsers = users.filter((user) => user.status === 'active').length;
  const blockedUsers = users.filter((user) => user.status === 'blocked').length;
  const enhancementEntries = (db.activityLogs || []).filter((entry) =>
    entry.action === 'enhancement.completed' || entry.action === 'enhancement.failed' || entry.action === 'enhancement.requested');
  const requestedRunIds = new Set(enhancementEntries
    .filter((entry) => entry.action === 'enhancement.requested' && entry.details?.runId)
    .map((entry) => entry.details.runId));
  const legacyFinalResults = enhancementEntries.filter((entry) =>
    entry.action !== 'enhancement.requested' && !entry.details?.runId);
  const totalEnhancementRequests = requestedRunIds.size + legacyFinalResults.length;
  const successfulRequests = (db.activityLogs || []).filter((entry) => entry.action === 'enhancement.completed').length;
  const failedRequests = (db.activityLogs || []).filter((entry) => entry.action === 'enhancement.failed').length;
  const today = new Date().toISOString().slice(0, 10);
  const todaysEnhancements = (db.activityLogs || []).filter((entry) =>
    (entry.action === 'enhancement.requested' || (entry.action === 'enhancement.completed' && !entry.details?.runId)) &&
    entry.createdAt.startsWith(today)).length;

  return {
    totalUsers,
    pendingUsers,
    activeUsers,
    blockedUsers,
    totalEnhancementRequests,
    successfulRequests,
    failedRequests,
    todaysEnhancements
  };
}

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!supportedMimeTypes.includes(file.mimetype)) {
      return cb(new Error('Unsupported image format. Use JPEG, PNG or WebP.'));
    }
    cb(null, true);
  }
});

app.post('/api/admin/notifications', requireAdmin, async (req, res) => {
  const { title, message, userId } = req.body || {};
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanMessage = typeof message === 'string' ? message.trim() : '';
  if (!cleanTitle || !cleanMessage || cleanTitle.length > 120 || cleanMessage.length > 2000) {
    return res.status(400).json({ message: 'Title (1–120 chars) and message (1–2,000 chars) are required.' });
  }
  const db = await readDb();
  if (userId && !db.users.some((user) => user.id === userId)) {
    return res.status(404).json({ message: 'Selected user was not found.' });
  }
  const notification = {
    id: makeId('notification'),
    type: 'admin_message',
    title: cleanTitle,
    message: cleanMessage,
    userId: userId || null,
    delivery: 'in_app_only',
    createdAt: new Date().toISOString(),
    isRead: false
  };
  db.notifications.unshift(notification);
  await writeDb(db);
  await logActivity('notification.created', null, { userId: userId || 'all' });
  if (process.env.FCM_ENABLED !== 'true') {
    return res.status(201).json({
      message: 'Notification saved in the app inbox. FCM push is disabled.',
      notification,
      push: { sent: 0, failed: 0 }
    });
  }
  const deliveryDb = await readDb();
  const recipients = deliveryDb.deviceTokens.filter((entry) => {
    const recipient = deliveryDb.users.find((user) => user.id === entry.userId);
    return recipient && recipient.status === 'active' && (!userId || userId === recipient.id);
  });
  if (!recipients.length) {
    return res.status(201).json({
      message: 'Notification saved in the app inbox. No active devices have registered for push notifications.',
      notification,
      push: { sent: 0, failed: 0 }
    });
  }
  try {
    const deliveries = await Promise.allSettled(recipients.map((entry) =>
      sendFcmNotification(entry.token, cleanTitle, cleanMessage)));
    const sent = deliveries.filter((result) => result.status === 'fulfilled').length;
    const failed = deliveries.length - sent;
    notification.delivery = failed ? (sent ? 'partially_sent' : 'failed') : 'sent';
    const updatedDb = await readDb();
    const stored = updatedDb.notifications.find((entry) => entry.id === notification.id);
    if (stored) stored.delivery = notification.delivery;
    await writeDb(updatedDb);
    return res.status(201).json({
      message: failed ? `Notification saved; ${sent} push notifications sent and ${failed} failed.` : `Notification saved and sent to ${sent} device(s).`,
      notification,
      push: { sent, failed }
    });
  } catch (error) {
    console.error('FCM delivery failed:', error);
    notification.delivery = 'failed';
    const updatedDb = await readDb();
    const stored = updatedDb.notifications.find((entry) => entry.id === notification.id);
    if (stored) stored.delivery = 'failed';
    await writeDb(updatedDb);
    return res.status(201).json({
      message: 'Notification saved to the app inbox, but push delivery failed. Check Firebase configuration.',
      notification,
      push: { sent: 0, failed: recipients.length }
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    appName,
    timestamp: new Date().toISOString(),
    platform: 'render-node-express',
    privacy: 'No permanent photo storage in database or disk.'
  });
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, email, mobile, password } = req.body || {};
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const cleanMobile = typeof mobile === 'string' ? mobile.replace(/[^\d+]/g, '') : '';

    if (!cleanName || !cleanMobile || typeof password !== 'string' || password.length < 8 || password.length > 128) {
      return res.status(400).json({ message: 'Name and mobile are required; password must be 8–128 characters.' });
    }
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ message: 'Email address is invalid.' });
    }

    if (!/^\+?\d{7,15}$/.test(cleanMobile)) {
      return res.status(400).json({ message: 'Mobile number must contain 7–15 digits.' });
    }

    const user = {
      id: makeId('user'),
      name: cleanName,
      email: cleanEmail,
      mobile: cleanMobile,
      passwordHash: hashPassword(password),
      status: 'pending',
      role: 'user',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const created = await mutateDb((latest) => {
      const existing = latest.users.find((existingUser) =>
        (cleanEmail && String(existingUser.email || '').toLowerCase() === cleanEmail) ||
        existingUser.mobile === cleanMobile);
      if (existing) return false;
      latest.users.push(user);
      return true;
    });
    if (!created) return res.status(409).json({ message: 'A user with this email or mobile already exists.' });
    await createNotification('registration_received', 'Registration received', 'Your account is pending approval.', user.id);
    await logActivity('user.registered', user.id, { mobile: user.mobile });

    res.status(201).json({
      message: 'Registration submitted successfully. Admin approval is required before login.',
      user: buildUserSummary(user)
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to register user.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const db = await readDb();
    const { email, mobile, identifier: suppliedIdentifier, password } = req.body || {};
    const identifier = suppliedIdentifier || email || mobile;

    if (typeof identifier !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ message: 'Email or mobile and password are required.' });
    }

    const normalized = identifier.trim().toLowerCase();
    const user = db.users.find((item) => (item.email === normalized || item.mobile === identifier.trim()) && verifyPassword(password, item.passwordHash));
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ message: `Your account is currently ${user.status}.` });
    }

    await logActivity('user.login', user.id, { email: user.email });
    res.json({
      message: 'Login successful.',
      token: createSession('user', user.id),
      user: buildUserSummary(user)
    });
  } catch (error) {
    res.status(500).json({ message: error.message || 'Unable to process login.' });
  }
});

app.post('/api/admin/login', (req, res) => {
  const { username, email, password } = req.body || {};
  const configuredUsername = process.env.ADMIN_USERNAME;
  const configuredPassword = process.env.ADMIN_PASSWORD;
  const suppliedUsername = username || email;
  if (!configuredUsername || !configuredPassword) {
    return res.status(503).json({ message: 'Admin credentials are not configured on the backend.' });
  }
  const suppliedPassword = typeof password === 'string' ? Buffer.from(password) : Buffer.alloc(0);
  const expectedPassword = Buffer.from(configuredPassword);
  if (suppliedUsername === configuredUsername && suppliedPassword.length === expectedPassword.length &&
      crypto.timingSafeEqual(suppliedPassword, expectedPassword)) {
    res.json({ message: 'Admin login successful.', token: createSession('admin'), role: 'admin' });
  } else {
    res.status(401).json({ message: 'Invalid admin credentials.' });
  }
});

app.post('/api/logout', requireUser, (req, res) => {
  const token = getUserIdFromRequest(req);
  sessions.delete(token);
  res.json({ message: 'Signed out.' });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = getUserIdFromRequest(req);
  sessions.delete(token);
  res.json({ message: 'Admin signed out.' });
});

app.get('/api/user/profile', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  res.json({ user: buildUserSummary(user) });
});

app.get('/api/user/history', requireUser, async (req, res) => {
  const db = await readDb();
  const history = (db.activityLogs || [])
    .filter((entry) => entry.userId === req.authenticatedUser.id &&
      (entry.action === 'enhancement.completed' || entry.action === 'enhancement.failed'))
    .slice(0, 50)
    .map(({ action, createdAt, details }) => ({ action, createdAt, runId: details?.runId || null }));
  res.json({ history });
});

app.get('/api/settings', async (req, res) => {
  const db = await readDb();
  const settings = db.settings || {};
  res.json({ settings: {
    maintenanceMode: !!settings.maintenanceMode,
    maintenanceMessage: settings.maintenanceMessage || '',
    appAnnouncement: settings.appAnnouncement || '',
    appName: settings.appName || appName,
    maxImageSizeMb: settings.usageLimits?.maxImageSizeMb || 10,
    dailyEnhancementLimit: settings.usageLimits?.maxDailyEnhancements ?? 50,
    adSettings: {
      enabled: !!settings.adSettings?.enabled,
      rewardedAdUnitId: settings.adSettings?.rewardedAdUnitId || '',
      maxRewardedAdsPerDay: settings.adSettings?.maxRewardedAdsPerDay ?? 5,
      testMode: settings.adSettings?.testMode !== false
    }
  } });
});

app.put('/api/settings', requireAdmin, async (req, res) => {
  const db = await readDb();
  const updates = req.body || {};
  const current = db.settings || {};
  const maxImageSizeMb = Number(updates.maxImageSizeMb ?? current.usageLimits?.maxImageSizeMb ?? 10);
  const dailyEnhancementLimit = Number(updates.dailyEnhancementLimit ?? current.usageLimits?.maxDailyEnhancements ?? 50);
  const maxRewardedAdsPerDay = Number(updates.maxRewardedAdsPerDay ?? current.adSettings?.maxRewardedAdsPerDay ?? 5);
  const updatedAppName = String(updates.appName ?? current.appName ?? appName).trim();
  if (!Number.isInteger(maxImageSizeMb) || maxImageSizeMb < 1 || maxImageSizeMb > 25 ||
      !Number.isInteger(dailyEnhancementLimit) || dailyEnhancementLimit < 0 || dailyEnhancementLimit > 10000 ||
      !Number.isInteger(maxRewardedAdsPerDay) || maxRewardedAdsPerDay < 1 || maxRewardedAdsPerDay > 50 ||
      !updatedAppName || updatedAppName.length > 80) {
    return res.status(400).json({ message: 'Photo size must be 1–25 MB, daily enhancement limit 0–10,000, and rewarded ad cap 1–50.' });
  }
  db.settings = {
    ...current,
    appName: updatedAppName,
    maintenanceMode: Boolean(updates.maintenanceMode ?? current.maintenanceMode),
    maintenanceMessage: String(updates.maintenanceMessage ?? current.maintenanceMessage ?? ''),
    appAnnouncement: String(updates.appAnnouncement ?? current.appAnnouncement ?? ''),
    adSettings: {
      ...(current.adSettings || {}),
      enabled: Boolean(updates.adsEnabled ?? current.adSettings?.enabled),
      bannerAdUnitId: String(updates.bannerAdUnitId ?? current.adSettings?.bannerAdUnitId ?? ''),
      interstitialAdUnitId: String(updates.interstitialAdUnitId ?? current.adSettings?.interstitialAdUnitId ?? ''),
      rewardedAdUnitId: String(updates.rewardedAdUnitId ?? current.adSettings?.rewardedAdUnitId ?? ''),
      maxRewardedAdsPerDay,
      testMode: Boolean(updates.adTestMode ?? current.adSettings?.testMode ?? true)
    },
    usageLimits: { ...(current.usageLimits || {}), maxImageSizeMb, maxDailyEnhancements: dailyEnhancementLimit }
  };
  await writeDb(db);
  await logActivity('settings.updated', null, { updated: Object.keys(updates) });
  res.json({ message: 'Settings updated.', settings: db.settings });
});

app.get('/api/gemini/prompt', requireAdmin, async (req, res) => {
  const db = await readDb();
  const current = db.prompts[0] || { value: defaultPrompt };
  res.json({ prompt: current.value });
});

app.post('/api/gemini/prompt/reset', requireAdmin, async (req, res) => {
  const db = await readDb();
  db.prompts = [{ id: 'default', value: defaultPrompt, updatedAt: new Date().toISOString() }];
  await writeDb(db);
  await logActivity('prompt.reset', null, {});
  res.json({ message: 'Default prompt restored.', prompt: defaultPrompt });
});

app.put('/api/gemini/prompt', requireAdmin, async (req, res) => {
  const db = await readDb();
  const prompt = req.body && typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt || prompt.length > 8000) return res.status(400).json({ message: 'Prompt must be 1–8,000 characters.' });
  db.prompts = [{ id: 'default', value: prompt, updatedAt: new Date().toISOString() }];
  await writeDb(db);
  await logActivity('prompt.updated', null, { prompt });
  res.json({ message: 'Prompt updated.', prompt });
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  const db = await readDb();
  const stats = await calculateStats();
  res.json({
    stats,
    users: db.users.map(buildUserSummary),
    notifications: db.notifications.filter((item) => item.type !== 'fcm_token').slice(0, 10)
  });
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  const db = await readDb();
  res.json({ settings: db.settings });
});

app.put('/api/admin/gemini/settings', requireAdmin, async (req, res) => {
  const modelName = typeof req.body?.modelName === 'string' ? req.body.modelName.trim() : '';
  if (!/^[A-Za-z0-9._-]{3,100}$/.test(modelName)) {
    return res.status(400).json({ message: 'Model name must be a valid Gemini model identifier.' });
  }
  const db = await readDb();
  db.settings.geminiSettings = { ...(db.settings.geminiSettings || {}), modelName };
  await writeDb(db);
  await logActivity('gemini.settings.updated', null, { modelName });
  res.json({ message: 'Gemini model updated.', modelName });
});

app.get('/api/admin/notifications', requireAdmin, async (req, res) => {
  const db = await readDb();
  res.json({ notifications: (db.notifications || []).filter((item) => item.type !== 'fcm_token').slice(0, 100) });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const db = await readDb();
  res.json({ users: db.users.map(buildUserSummary) });
});

app.patch('/api/admin/user/:id/status', requireAdmin, async (req, res) => {
  const db = await readDb();
  const { status } = req.body || {};
  const user = db.users.find((entry) => entry.id === req.params.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found.' });
  }

  if (!['pending', 'active', 'blocked', 'rejected', 'suspended'].includes(status)) {
    return res.status(400).json({ message: 'Status is invalid.' });
  }

  user.status = status;
  user.updatedAt = new Date().toISOString();
  await writeDb(db);

  const messages = {
    pending: 'User moved to pending.',
    active: 'User activated successfully.',
    blocked: 'User blocked successfully.',
    rejected: 'User rejected.',
    suspended: 'User suspended successfully.'
  };

  await createNotification('user_status_change', 'User status updated', `${user.name} is now ${status}.`, user.id);
  await logActivity('user.status.changed', user.id, { status });
  res.json({ message: messages[status] || 'Status updated.', user: buildUserSummary(user) });
});

app.post('/api/fcm/token', requireUser, async (req, res) => {
  const user = req.authenticatedUser;
  const db = await readDb();
  const token = req.body && req.body.token;
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
    return res.status(400).json({ message: 'FCM token is required.' });
  }

  const existing = db.deviceTokens.find((entry) => entry.token === token && entry.userId === user.id);
  if (!existing) {
    db.deviceTokens = db.deviceTokens.filter((entry) => entry.userId !== user.id || entry.token !== token);
    db.deviceTokens.unshift({ userId: user.id, token, createdAt: new Date().toISOString() });
    const userTokens = db.deviceTokens.filter((entry) => entry.userId === user.id);
    for (const expired of userTokens.slice(5)) {
      db.deviceTokens = db.deviceTokens.filter((entry) => entry !== expired);
    }
  }
  await writeDb(db);

  res.json({ message: 'Notification token registered.' });
});

app.delete('/api/fcm/token', requireUser, async (req, res) => {
  const token = req.body && req.body.token;
  if (!token) return res.status(400).json({ message: 'FCM token is required.' });
  const db = await readDb();
  db.deviceTokens = db.deviceTokens.filter((entry) =>
    entry.userId !== req.authenticatedUser.id || entry.token !== token);
  await writeDb(db);
  res.json({ message: 'Notification token removed.' });
});

app.get('/api/notifications', requireUser, async (req, res) => {
  const user = req.authenticatedUser;
  const db = await readDb();
  const notifications = db.notifications.filter((item) =>
    item.type !== 'fcm_token' && (!item.userId || item.userId === user.id));
  res.json({ notifications: notifications.slice(0, 20) });
});

app.get('/api/reports', requireAdmin, async (req, res) => {
  const db = await readDb();
  const stats = await calculateStats();
  res.json({
    dailyReport: { date: new Date().toISOString().slice(0, 10), ...stats },
    monthlyReport: { month: new Date().toISOString().slice(0, 7), ...stats },
    successfulProcessing: stats.successfulRequests,
    failedProcessing: stats.failedRequests,
    userActivity: db.activityLogs.slice(0, 20)
  });
});

app.post('/api/enhance', requireUser, upload.single('photo'), async (req, res) => {
  const user = req.authenticatedUser;
  if (!req.file) {
    return res.status(400).json({ message: 'A valid photo is required.' });
  }
  if (!imageSignatureMatches(req.file.buffer, req.file.mimetype)) {
    req.file.buffer.fill(0);
    return res.status(415).json({ message: 'The photo contents do not match a supported image format.' });
  }

  let imageData = '';
  let outputBuffer = null;
  const runId = makeId('enhancement');

  try {
    const config = await mutateDb((db) => {
      const settings = db.settings || {};
      const maxImageSizeMb = settings.usageLimits?.maxImageSizeMb || 10;
      if (req.file.size > maxImageSizeMb * 1024 * 1024) {
        return { error: { status: 413, message: `Photo exceeds the ${maxImageSizeMb} MB upload limit.` } };
      }
      if (settings.maintenanceMode) {
        return { error: { status: 503, message: settings.maintenanceMessage || 'Enhancement is temporarily unavailable.' } };
      }
      const today = new Date().toISOString().slice(0, 10);
      const dailyLimit = Number(settings.usageLimits?.maxDailyEnhancements ?? 50);
      const todaysEnhancements = (db.activityLogs || []).filter((entry) =>
        entry.userId === user.id &&
        (entry.action === 'enhancement.requested' || (entry.action === 'enhancement.completed' && !entry.details?.runId)) &&
        entry.createdAt.startsWith(today)).length;
      if (dailyLimit > 0 && todaysEnhancements >= dailyLimit) {
        return { error: { status: 429, message: 'You have reached your daily enhancement limit.' } };
      }
      db.activityLogs.unshift({
        id: makeId('activity'),
        action: 'enhancement.requested',
        userId: user.id,
        details: { runId },
        createdAt: new Date().toISOString()
      });
      return {
        prompt: db.prompts?.[0]?.value || defaultPrompt,
        model: db.settings?.geminiSettings?.modelName || process.env.GEMINI_MODEL || 'gemini-3.1-flash-image'
      };
    });
    if (config.error) return res.status(config.error.status).json({ message: config.error.message });
    const prompt = config.prompt;
    const geminiModel = config.model;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!geminiApiKey) {
      throw new Error('Gemini API key is not configured on the Render backend.');
    }
    imageData = req.file.buffer.toString('base64');

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiApiKey },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inline_data: { mime_type: req.file.mimetype, data: imageData } }
          ]
        }]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const payload = await response.json();
    const generatedImage = payload.candidates?.[0]?.content?.parts?.find((part) => part.inlineData || part.inline_data)?.inlineData || payload.candidates?.[0]?.content?.parts?.find((part) => part.inlineData || part.inline_data)?.inline_data;

    if (!generatedImage || !generatedImage.data) {
      throw new Error('Gemini returned a text-only response. A generated image is required.');
    }

    outputBuffer = Buffer.from(generatedImage.data, 'base64');
    const outputMimeType = generatedImage.mime_type || generatedImage.mimeType;
    if (!supportedMimeTypes.includes(outputMimeType) || outputBuffer.length === 0 || outputBuffer.length > 25 * 1024 * 1024) {
      throw new Error('Gemini returned an invalid or unsupported image payload.');
    }
    if (!imageSignatureMatches(outputBuffer, outputMimeType)) {
      throw new Error('Gemini image format did not match its declared MIME type.');
    }
    const outputUrl = `data:${generatedImage.mime_type || req.file.mimetype};base64,${generatedImage.data}`;

    await logActivity('enhancement.completed', user.id, { runId, mimeType: outputMimeType });

    res.json({
      message: 'Enhancement completed successfully.',
      runId,
      original: { mimeType: req.file.mimetype, size: req.file.size },
      result: {
        mimeType: outputMimeType,
        base64: outputUrl,
        size: outputBuffer.length,
        width: null,
        height: null
      },
      output: { mimeType: outputMimeType, base64: outputUrl }
    });
  } catch (error) {
    await logActivity('enhancement.failed', user.id, { runId, message: error.message });
    console.error('Enhancement failed:', error);
    res.status(500).json({
      message: 'Enhancement failed.',
      error: error.message || 'Unable to process image.'
    });
  } finally {
    req.file.buffer.fill(0);
    if (outputBuffer) outputBuffer.fill(0);
    imageData = '';
  }
});

app.get('/api/admin/gemini/status', requireAdmin, async (req, res) => {
  const db = await readDb();
  res.json({
    provider: process.env.AI_PROVIDER || 'gemini',
    model: db.settings?.geminiSettings?.modelName || process.env.GEMINI_MODEL || 'gemini-3.1-flash-image',
    configured: Boolean(process.env.GEMINI_API_KEY),
    lastRequest: (db.activityLogs || []).find((entry) =>
      entry.action === 'enhancement.completed' || entry.action === 'enhancement.failed') || null
  });
});

app.post('/api/admin/gemini/test', requireAdmin, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = (await readDb()).settings?.geminiSettings?.modelName || process.env.GEMINI_MODEL || 'gemini-3.1-flash-image';
  if (!apiKey) return res.status(503).json({ message: 'GEMINI_API_KEY is not configured on the backend.' });
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return res.status(502).json({ message: `Gemini connection failed (${response.status}).` });
    const payload = await response.json();
    res.json({ message: 'Gemini connection successful.', model: payload.name || model });
  } catch (error) {
    console.error('Gemini connection test failed:', error);
    res.status(502).json({ message: 'Gemini connection test failed.' });
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (req.file?.buffer) req.file.buffer.fill(0);
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ message: error.code === 'LIMIT_FILE_SIZE' ? 'Photo exceeds the maximum 25 MB request size.' : error.message });
  }
  if (error.message && error.message.startsWith('Unsupported image format.')) {
    return res.status(415).json({ message: error.message });
  }
  console.error('Unhandled API error:', error);
  res.status(500).json({ message: 'An unexpected server error occurred.' });
});

let server;

async function closeStorage() {
  if (turso) await turso.close();
}

if (require.main === module) {
  server = app.listen(port, () => {
    console.log(`${appName} backend running on http://localhost:${port}`);
  });
}

module.exports = { app, server, closeStorage, readDb };
