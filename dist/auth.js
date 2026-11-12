import jwt from "jsonwebtoken";
import { db } from "./db.js";
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32)
    throw new Error("JWT_SECRET must contain at least 32 characters");
export function createToken(userId, role) {
    return jwt.sign({ role }, secret, { subject: userId, expiresIn: "7d" });
}
export async function requireAuth(req, res, next) {
    const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
    }
    let payload;
    try {
        payload = jwt.verify(token, secret);
    }
    catch {
        res.status(401).json({ error: "Session expired. Please sign in again." });
        return;
    }
    if (!payload.sub || (payload.role !== "user" && payload.role !== "admin")) {
        res.status(401).json({ error: "Invalid authentication token" });
        return;
    }
    try {
        const account = await db.execute({
            sql: "SELECT role, status FROM users WHERE id = ?",
            args: [payload.sub],
        });
        const row = account.rows[0];
        if (!row || row.role !== payload.role || row.status !== "approved") {
            res.status(403).json({ error: "This account is not approved for access." });
            return;
        }
        req.auth = { userId: payload.sub, role: payload.role };
        next();
    }
    catch (error) {
        next(error);
    }
}
export function requireAdmin(req, res, next) {
    if (req.auth?.role !== "admin") {
        res.status(403).json({ error: "Administrator access required" });
        return;
    }
    next();
}
