import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";
import "dotenv/config";
const url = process.env.TURSO_DATABASE_URL;
if (!url)
    throw new Error("TURSO_DATABASE_URL is required");
export const db = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
});
export async function initializeDatabase() {
    const statements = [
        `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, full_name TEXT NOT NULL, mobile TEXT NOT NULL UNIQUE,
      email TEXT, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
    )`,
        `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
        `CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL,
      error_message TEXT, created_at TEXT NOT NULL, completed_at TEXT
    )`,
        `CREATE TABLE IF NOT EXISTS usage_history (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, job_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
        `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, message TEXT NOT NULL,
      target TEXT NOT NULL, created_at TEXT NOT NULL, sent_count INTEGER NOT NULL DEFAULT 0
    )`,
        `CREATE TABLE IF NOT EXISTS fcm_tokens (
      user_id TEXT PRIMARY KEY, token TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    ];
    for (const sql of statements)
        await db.execute(sql);
    const defaults = {
        prompt: "Enhance this photo naturally. Preserve the subject's identity, facial features, pose, and composition. Improve clarity, lighting, color balance, and fine detail without adding or removing objects.",
        appName: "AI Photo Enhancer Pro",
        homeBanner: "Enhance Your Photos with AI",
        maintenanceMode: false,
        maintenanceMessage: "We are performing scheduled maintenance. Please try again soon.",
        maxPhotoSizeMb: 10,
        dailyEnhancementLimit: 10,
        modelName: process.env.GEMINI_MODEL || "gemini-2.5-flash-image",
        adsEnabled: false,
        bannerAdUnitId: "",
        interstitialAdUnitId: "",
        rewardedAdUnitId: "",
        adFrequency: 1,
        testAdMode: true,
        lastGeminiStatus: "Not tested",
    };
    for (const [key, value] of Object.entries(defaults)) {
        await db.execute({
            sql: "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
            args: [key, JSON.stringify(value), new Date().toISOString()],
        });
    }
    const username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_PASSWORD;
    if (!username || !password) {
        throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD are required to bootstrap the admin account");
    }
    const existingAdmin = await db.execute({
        sql: "SELECT id FROM users WHERE role = 'admin' LIMIT 1",
        args: [],
    });
    if (existingAdmin.rows.length === 0) {
        const hash = await bcrypt.hash(password, 12);
        await db.execute({
            sql: `INSERT INTO users (id, full_name, mobile, email, password_hash, role, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'admin', 'approved', ?)`,
            args: [crypto.randomUUID(), "Administrator", username, null, hash, new Date().toISOString()],
        });
    }
}
export async function getSettings() {
    const result = await db.execute("SELECT key, value FROM settings");
    return Object.fromEntries(result.rows.map((row) => [String(row.key), JSON.parse(String(row.value))]));
}
export async function setSettings(values) {
    for (const [key, value] of Object.entries(values)) {
        await db.execute({
            sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
            args: [key, JSON.stringify(value), new Date().toISOString()],
        });
    }
}
