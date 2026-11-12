import "dotenv/config";
import bcrypt from "bcryptjs";
import cors from "cors";
import express from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { createToken, requireAdmin, requireAuth } from "./auth.js";
import { db, getSettings, initializeDatabase, setSettings } from "./db.js";
import { editImage } from "./gemini.js";
const app = express();
const port = Number(process.env.PORT || 3000);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const asyncRoute = (handler) => (req, res, next) => { void handler(req, res).catch(next); };
app.use(cors({ origin: process.env.APP_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));
function publicUser(row) {
    return { id: row.id, fullName: row.full_name, mobile: row.mobile, email: row.email, status: row.status };
}
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/public/config", asyncRoute(async (_req, res) => {
    const settings = await getSettings();
    res.json({
        appName: settings.appName,
        homeBanner: settings.homeBanner,
        maintenanceMode: settings.maintenanceMode,
        maintenanceMessage: settings.maintenanceMessage,
        maxPhotoSizeMb: settings.maxPhotoSizeMb,
        adsEnabled: settings.adsEnabled,
        bannerAdUnitId: settings.bannerAdUnitId,
        interstitialAdUnitId: settings.interstitialAdUnitId,
        rewardedAdUnitId: settings.rewardedAdUnitId,
        adFrequency: settings.adFrequency,
        testAdMode: settings.testAdMode,
    });
}));
app.post("/api/auth/register", asyncRoute(async (req, res) => {
    const { fullName, mobile, email, password, confirmPassword } = req.body;
    if (!fullName?.trim() || !/^\+?[0-9]{7,15}$/.test(mobile || "") || !password || password.length < 8) {
        res.status(400).json({ error: "Enter your name, a valid mobile number, and a password of at least 8 characters." });
        return;
    }
    if (password !== confirmPassword) {
        res.status(400).json({ error: "Passwords do not match." });
        return;
    }
    const id = randomUUID();
    try {
        await db.execute({
            sql: `INSERT INTO users (id, full_name, mobile, email, password_hash, role, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'user', 'pending', ?)`,
            args: [id, fullName.trim(), mobile, email?.trim() || null, await bcrypt.hash(password, 12), new Date().toISOString()],
        });
    }
    catch (error) {
        if (String(error).toLowerCase().includes("unique")) {
            res.status(409).json({ error: "An account with this mobile number already exists." });
            return;
        }
        throw error;
    }
    res.status(201).json({ status: "pending", message: "Account created. Sign-in will be available after administrator approval." });
}));
app.post("/api/auth/login", asyncRoute(async (req, res) => {
    const { mobile, password } = req.body;
    const result = await db.execute({
        sql: "SELECT * FROM users WHERE mobile = ? AND role = 'user' LIMIT 1",
        args: [mobile || ""],
    });
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password || "", String(user.password_hash)))) {
        res.status(401).json({ error: "Incorrect mobile number or password." });
        return;
    }
    if (user.status === "pending") {
        res.status(403).json({ code: "PENDING", error: "Your account is awaiting administrator approval." });
        return;
    }
    if (user.status !== "approved") {
        res.status(403).json({ code: "BLOCKED", error: "This account is blocked. Contact support." });
        return;
    }
    res.json({ token: createToken(String(user.id), "user"), user: publicUser(user) });
}));
app.post("/api/admin/login", asyncRoute(async (req, res) => {
    const { username, password } = req.body;
    const result = await db.execute({
        sql: "SELECT * FROM users WHERE mobile = ? AND role = 'admin' LIMIT 1",
        args: [username || ""],
    });
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password || "", String(user.password_hash)))) {
        res.status(401).json({ error: "Invalid administrator credentials." });
        return;
    }
    res.json({ token: createToken(String(user.id), "admin"), user: { id: user.id, username: user.mobile } });
}));
app.get("/api/profile", requireAuth, asyncRoute(async (req, res) => {
    const result = await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [req.auth.userId] });
    if (!result.rows[0]) {
        res.status(404).json({ error: "User not found." });
        return;
    }
    res.json(publicUser(result.rows[0]));
}));
app.post("/api/user/fcm-token", requireAuth, asyncRoute(async (req, res) => {
    const token = req.body.token;
    if (!token) {
        res.status(400).json({ error: "FCM token is required." });
        return;
    }
    await db.execute({
        sql: `INSERT INTO fcm_tokens (user_id, token, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at`,
        args: [req.auth.userId, token, new Date().toISOString()],
    });
    res.json({ saved: true });
}));
app.get("/api/history", requireAuth, asyncRoute(async (req, res) => {
    const result = await db.execute({
        sql: `SELECT id, status, error_message, created_at, completed_at FROM jobs
          WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
        args: [req.auth.userId],
    });
    res.json({ items: result.rows });
}));
app.get("/api/notifications", requireAuth, asyncRoute(async (req, res) => {
    const result = await db.execute({
        sql: "SELECT id, title, message, created_at FROM notifications WHERE target = 'all' OR target = ? ORDER BY created_at DESC LIMIT 100",
        args: [req.auth.userId],
    });
    res.json({ items: result.rows });
}));
app.post("/api/enhance", requireAuth, upload.single("photo"), (_req, res, next) => {
    res.once("finish", () => _req.file?.buffer.fill(0));
    next();
}, asyncRoute(async (req, res) => {
    const file = req.file;
    if (!file) {
        res.status(400).json({ error: "Select a photo to enhance." });
        return;
    }
    const releaseUpload = () => file.buffer.fill(0);
    const mimeTypes = {
        "image/jpeg": "image/jpeg", "image/png": "image/png", "image/webp": "image/webp",
    };
    const mimeType = mimeTypes[file.mimetype];
    if (!mimeType) {
        releaseUpload();
        res.status(415).json({ error: "Only JPG, PNG, and WEBP photos are supported." });
        return;
    }
    if (mimeType === "image/jpeg" && !(file.buffer[0] === 0xff && file.buffer[1] === 0xd8 && file.buffer[2] === 0xff)) {
        releaseUpload();
        res.status(415).json({ error: "The selected file is not a valid JPEG image." });
        return;
    }
    if (mimeType === "image/png" && !file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        releaseUpload();
        res.status(415).json({ error: "The selected file is not a valid PNG image." });
        return;
    }
    if (mimeType === "image/webp" && (file.buffer.toString("ascii", 0, 4) !== "RIFF" || file.buffer.toString("ascii", 8, 12) !== "WEBP")) {
        releaseUpload();
        res.status(415).json({ error: "The selected file is not a valid WEBP image." });
        return;
    }
    const settings = await getSettings();
    const jobId = randomUUID();
    const now = new Date().toISOString();
    if (settings.maintenanceMode) {
        releaseUpload();
        res.status(503).json({ error: String(settings.maintenanceMessage || "App is under maintenance.") });
        return;
    }
    if (file.size > Number(settings.maxPhotoSizeMb) * 1024 * 1024) {
        releaseUpload();
        res.status(413).json({ error: `Photo exceeds the ${settings.maxPhotoSizeMb} MB limit.` });
        return;
    }
    const dayCount = await db.execute({
        sql: "SELECT COUNT(*) AS count FROM usage_history WHERE user_id = ? AND date(created_at) = date('now')",
        args: [req.auth.userId],
    });
    const limit = Number(settings.dailyEnhancementLimit);
    if (limit > 0 && Number(dayCount.rows[0]?.count || 0) >= limit) {
        releaseUpload();
        res.status(429).json({ error: "Your daily enhancement limit has been reached." });
        return;
    }
    await db.execute({
        sql: "INSERT INTO jobs (id, user_id, status, created_at) VALUES (?, ?, 'processing', ?)",
        args: [jobId, req.auth.userId, now],
    });
    try {
        const prompt = String(settings.prompt || "");
        if (!prompt.trim())
            throw new Error("The administrator has not configured an editing prompt.");
        const edited = await editImage(file.buffer, mimeType, prompt, String(settings.modelName));
        await setSettings({ lastGeminiStatus: "Image editing succeeded" });
        const completedAt = new Date().toISOString();
        await db.batch([
            { sql: "UPDATE jobs SET status = 'completed', completed_at = ? WHERE id = ?", args: [completedAt, jobId] },
            { sql: "INSERT INTO usage_history (id, user_id, job_id, created_at) VALUES (?, ?, ?, ?)", args: [randomUUID(), req.auth.userId, jobId, completedAt] },
        ], "write");
        res.json({ jobId, status: "completed", imageBase64: edited.data, mimeType: edited.mimeType });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Image processing failed.";
        await setSettings({ lastGeminiStatus: `Image editing failed: ${message.slice(0, 180)}` });
        await db.execute({
            sql: "UPDATE jobs SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?",
            args: [message, new Date().toISOString(), jobId],
        });
        throw error;
    }
    finally {
        releaseUpload();
    }
}));
const admin = [requireAuth, requireAdmin];
app.get("/api/admin/dashboard", ...admin, asyncRoute(async (_req, res) => {
    const users = await db.execute(`SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status = 'pending' AND role = 'user' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status = 'approved' AND role = 'user' THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN status = 'blocked' AND role = 'user' THEN 1 ELSE 0 END) AS blocked
    FROM users WHERE role = 'user'`);
    const jobs = await db.execute(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN date(created_at) = date('now') THEN 1 ELSE 0 END) AS today
    FROM usage_history`);
    res.json({ users: users.rows[0], enhancements: jobs.rows[0] });
}));
app.get("/api/admin/users", ...admin, asyncRoute(async (req, res) => {
    const status = String(req.query.status || "");
    const search = String(req.query.mobile || "");
    const args = [];
    let where = "WHERE role = 'user'";
    if (["pending", "approved", "blocked"].includes(status)) {
        where += " AND status = ?";
        args.push(status);
    }
    if (search) {
        where += " AND mobile LIKE ?";
        args.push(`%${search}%`);
    }
    const result = await db.execute({
        sql: `SELECT id, full_name, mobile, email, status, created_at FROM users ${where} ORDER BY created_at DESC LIMIT 500`,
        args,
    });
    res.json({ users: result.rows });
}));
app.patch("/api/admin/users/:id/status", ...admin, asyncRoute(async (req, res) => {
    const status = req.body.status;
    if (!["approved", "blocked", "pending"].includes(status || "")) {
        res.status(400).json({ error: "Status must be approved, blocked, or pending." });
        return;
    }
    const result = await db.execute({
        sql: "UPDATE users SET status = ? WHERE id = ? AND role = 'user'",
        args: [status, String(req.params.id)],
    });
    if (Number(result.rowsAffected) === 0) {
        res.status(404).json({ error: "User not found." });
        return;
    }
    res.json({ updated: true });
}));
app.get("/api/admin/settings", ...admin, asyncRoute(async (_req, res) => {
    res.json(await getSettings());
}));
app.put("/api/admin/settings", ...admin, asyncRoute(async (req, res) => {
    const allowed = new Set([
        "appName", "homeBanner", "maintenanceMode", "maintenanceMessage", "maxPhotoSizeMb",
        "dailyEnhancementLimit", "modelName", "adsEnabled", "bannerAdUnitId", "interstitialAdUnitId",
        "rewardedAdUnitId", "adFrequency", "testAdMode",
    ]);
    const entries = Object.entries(req.body).filter(([key]) => allowed.has(key));
    if (!entries.length) {
        res.status(400).json({ error: "No editable settings were provided." });
        return;
    }
    const values = Object.fromEntries(entries);
    for (const key of ["maxPhotoSizeMb", "dailyEnhancementLimit", "adFrequency"]) {
        const maxAllowed = key === "maxPhotoSizeMb" ? 25 : Number.POSITIVE_INFINITY;
        if (key in values && (!Number.isFinite(Number(values[key])) || Number(values[key]) < 0 || Number(values[key]) > maxAllowed)) {
            res.status(400).json({ error: key === "maxPhotoSizeMb" ? "maxPhotoSizeMb must be between 0 and 25 MB." : `${key} must be a non-negative number.` });
            return;
        }
    }
    for (const key of ["maintenanceMode", "adsEnabled", "testAdMode"]) {
        if (key in values && typeof values[key] !== "boolean") {
            res.status(400).json({ error: `${key} must be true or false.` });
            return;
        }
    }
    await setSettings(values);
    res.json({ saved: true });
}));
app.put("/api/admin/prompt", ...admin, asyncRoute(async (req, res) => {
    const prompt = req.body.prompt;
    if (!prompt?.trim()) {
        res.status(400).json({ error: "Prompt cannot be empty." });
        return;
    }
    await setSettings({ prompt });
    res.json({ saved: true });
}));
app.post("/api/admin/gemini/test", ...admin, asyncRoute(async (_req, res) => {
    const settings = await getSettings();
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        res.status(503).json({ connected: false, error: "GEMINI_API_KEY is not configured on the backend." });
        return;
    }
    const model = String(settings.modelName);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ contents: [{ parts: [{ text: "Reply with the word OK." }] }] }),
    });
    const body = await response.json();
    const status = response.ok ? "Connected" : `Failed: ${body.error?.message || response.status}`;
    await setSettings({ lastGeminiStatus: status });
    if (!response.ok) {
        res.status(502).json({ connected: false, error: status });
        return;
    }
    res.json({ connected: true, model });
}));
function initializeFirebase() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw)
        return false;
    try {
        if (getApps().length === 0) {
            initializeApp({ credential: cert(JSON.parse(raw)) });
        }
        return true;
    }
    catch (error) {
        throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${String(error)}`);
    }
}
app.post("/api/admin/notifications", ...admin, asyncRoute(async (req, res) => {
    const { title, message, userId } = req.body;
    if (!title?.trim() || !message?.trim()) {
        res.status(400).json({ error: "Notification title and message are required." });
        return;
    }
    if (!initializeFirebase()) {
        res.status(503).json({ error: "Firebase is not configured on the backend." });
        return;
    }
    const recipients = await db.execute({
        sql: userId ? "SELECT user_id, token FROM fcm_tokens WHERE user_id = ?" : "SELECT user_id, token FROM fcm_tokens",
        args: userId ? [userId] : [],
    });
    const tokens = recipients.rows.map((row) => String(row.token));
    if (!tokens.length) {
        res.status(404).json({ error: "No registered FCM recipients were found." });
        return;
    }
    let sentCount = 0;
    const messaging = getMessaging();
    for (let i = 0; i < tokens.length; i += 500) {
        const result = await messaging.sendEachForMulticast({
            tokens: tokens.slice(i, i + 500),
            notification: { title: title.trim(), body: message.trim() },
        });
        sentCount += result.successCount;
    }
    await db.execute({
        sql: "INSERT INTO notifications (id, title, message, target, created_at, sent_count) VALUES (?, ?, ?, ?, ?, ?)",
        args: [randomUUID(), title.trim(), message.trim(), userId || "all", new Date().toISOString(), sentCount],
    });
    res.json({ sentCount, targetCount: tokens.length });
}));
app.get("/api/admin/notifications", ...admin, asyncRoute(async (_req, res) => {
    const result = await db.execute("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200");
    res.json({ notifications: result.rows });
}));
app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "Photo exceeds the 25 MB server upload limit." });
        return;
    }
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error." });
});
await initializeDatabase();
app.listen(port, () => console.log(`AI Photo Enhancer API listening on ${port}`));
