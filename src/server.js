import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { initDb, database, settings, setSetting } from "./db.js";

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || "").split(",").map(x => x.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : false }));
app.use(express.json({ limit: "14mb" }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }));
app.use("/api/images", rateLimit({ windowMs: 60 * 60 * 1000, limit: Number(process.env.IMAGE_RATE_LIMIT || 12) }));

const token = payload => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "12h" });
function auth(req, res, next) {
  try {
    const value = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    req.actor = jwt.verify(value, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: "Unauthorized" }); }
}
function isAdmin(req, res, next) {
  if (req.actor?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}
const safeError = (e) => String(e?.message || "Request failed").slice(0, 500);

app.get("/", (_, res) => res.json({ service: "AI Photo Enhancer Pro", status: "ok", ai: "Gemini" }));
app.get("/api/health", (_, res) => res.json({ ok: true, databaseConfigured: !!process.env.TURSO_DATABASE_URL, geminiConfigured: !!process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || "gemini-3.1-flash-image" }));

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name?.trim() || !email?.trim() || !password || password.length < 10) return res.status(400).json({ error: "Name, email and password (10+ characters) required" });
    const id = nanoid();
    const hash = await bcrypt.hash(password, 12);
    await database().execute({ sql: "INSERT INTO users VALUES(?,?,?,?,?,?)", args: [id, name.trim(), email.trim().toLowerCase(), hash, "pending", new Date().toISOString()] });
    res.status(201).json({ status: "pending", message: "Registration submitted. Wait for admin approval." });
  } catch { res.status(409).json({ error: "Registration failed; email may already exist" }); }
});
app.post("/api/auth/login", async (req, res) => {
  try {
    const r = await database().execute({ sql: "SELECT * FROM users WHERE email=?", args: [String(req.body?.email || "").toLowerCase()] });
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(req.body?.password || "", u.password_hash))) return res.status(401).json({ error: "Invalid email or password" });
    if (u.status !== "active") return res.status(403).json({ error: `Account is ${u.status}` });
    res.json({ token: token({ sub: u.id, role: "user" }), name: u.name });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});
app.post("/api/admin/login", (req, res) => {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) return res.status(503).json({ error: "Admin credentials are not configured" });
  if (req.body?.email !== process.env.ADMIN_EMAIL || req.body?.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: "Invalid admin login" });
  res.json({ token: token({ sub: "admin", role: "admin" }) });
});
app.get("/api/app/config", async (_, res) => { try { const s = await settings(); res.json({ appName: s.appName, maintenance: s.maintenance, announcement: s.announcement }); } catch (e) { res.status(500).json({ error: safeError(e) }); } });
app.get("/api/admin/dashboard", auth, isAdmin, async (_, res) => {
  try {
    const d = database();
    const [u, p, j] = await Promise.all([d.execute("SELECT COUNT(*) n FROM users"), d.execute("SELECT COUNT(*) n FROM users WHERE status='pending'"), d.execute("SELECT COUNT(*) n FROM image_jobs")]);
    res.json({ users: Number(u.rows[0].n), pending: Number(p.rows[0].n), processed: Number(j.rows[0].n), note: "Photo files are not stored in Turso." });
  } catch (e) { res.status(500).json({ error: safeError(e) }); }
});
app.get("/api/admin/users", auth, isAdmin, async (_, res) => {
  try { const r = await database().execute("SELECT id,name,email,status,created_at FROM users ORDER BY created_at DESC"); res.json({ users: r.rows }); }
  catch (e) { res.status(500).json({ error: safeError(e) }); }
});
app.patch("/api/admin/users/:id/status", auth, isAdmin, async (req, res) => {
  if (!["pending", "active", "blocked", "suspended"].includes(req.body?.status)) return res.status(400).json({ error: "Invalid status" });
  try { await database().execute({ sql: "UPDATE users SET status=? WHERE id=?", args: [req.body.status, req.params.id] }); res.json({ updated: true }); }
  catch (e) { res.status(500).json({ error: safeError(e) }); }
});
app.put("/api/admin/settings", auth, isAdmin, async (req, res) => {
  try { for (const k of ["appName", "maintenance", "announcement"]) if (req.body?.[k] !== undefined) await setSetting(k, req.body[k]); res.json({ saved: true }); }
  catch (e) { res.status(500).json({ error: safeError(e) }); }
});
app.get("/api/admin/prompt", auth, isAdmin, async (_, res) => { const s = await settings(); res.json({ prompt: s.activePrompt, version: s.promptVersion }); });
app.put("/api/admin/prompt", auth, isAdmin, async (req, res) => {
  if (typeof req.body?.prompt !== "string" || req.body.prompt.trim().length < 30 || req.body.prompt.length > 12000) return res.status(400).json({ error: "Prompt must be 30–12000 characters" });
  try { const s = await settings(); const version = Number(s.promptVersion || 1) + 1; await setSetting("activePrompt", req.body.prompt.trim()); await setSetting("promptVersion", version); res.json({ saved: true, version }); }
  catch (e) { res.status(500).json({ error: safeError(e) }); }
});

// Transient image pipeline: JSON/base64 -> server RAM -> Gemini -> response. No image is inserted into Turso or written to disk.
app.post("/api/images/enhance", auth, async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "Gemini API key is not configured on Render" });
    const { imageBase64, mimeType } = req.body || {};
    if (!imageBase64 || !["image/jpeg", "image/png", "image/webp"].includes(mimeType)) return res.status(400).json({ error: "A JPEG, PNG or WebP image is required" });
    const clean = String(imageBase64).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
    const input = Buffer.from(clean, "base64");
    if (!input.length || input.length > Number(process.env.MAX_IMAGE_BYTES || 8 * 1024 * 1024)) return res.status(413).json({ error: "Image is empty or larger than the 8 MB limit" });
    const s = await settings();
    if (s.maintenance) return res.status(503).json({ error: s.announcement || "App is under maintenance" });
    const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-image";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: s.activePrompt }, { inline_data: { mime_type: mimeType, data: input.toString("base64") } }] }], generationConfig: { responseModalities: ["IMAGE", "TEXT"] } }),
      signal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS || 120000))
    });
    const payload = await response.json();
    if (!response.ok) {
      const msg = payload?.error?.message || `Gemini returned HTTP ${response.status}`;
      return res.status(response.status === 429 ? 429 : 502).json({ error: msg.slice(0, 500) });
    }
    const parts = payload?.candidates?.flatMap(c => c?.content?.parts || []) || [];
    const imagePart = parts.find(p => p.inlineData?.data || p.inline_data?.data);
    const imageData = imagePart?.inlineData || imagePart?.inline_data;
    if (!imageData?.data) return res.status(502).json({ error: "Gemini did not return an edited image. Check the selected model and API access." });
    // Usage metadata only: never store original/edited photo bytes.
    try { await database().execute({ sql: "INSERT INTO image_jobs VALUES(?,?,?,?,?,?,?)", args: [nanoid(), req.actor.sub, "TRANSIENT", "completed", "gemini", Number(s.promptVersion || 1), new Date().toISOString()] }); } catch { /* usage logging must not block delivery */ }
    res.json({ mimeType: imageData.mimeType || imageData.mime_type || "image/png", imageBase64: imageData.data, model, status: "completed" });
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    res.status(timeout ? 504 : 500).json({ error: timeout ? "Gemini processing timed out. Please retry." : safeError(e) });
  }
});

const port = process.env.PORT || 10000;
await initDb();
app.listen(port, () => console.log(`AI Photo Enhancer API listening on ${port}`));
