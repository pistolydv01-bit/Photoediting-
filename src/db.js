import {createClient} from "@libsql/client";
let db;
export function database(){
 if(!process.env.TURSO_DATABASE_URL||!process.env.TURSO_AUTH_TOKEN) throw new Error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in Render ENV");
 return db ||= createClient({url:process.env.TURSO_DATABASE_URL,authToken:process.env.TURSO_AUTH_TOKEN});
}
export async function initDb(){
 const d=database();
 for(const sql of [
 `CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS image_jobs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,image_key TEXT,status TEXT NOT NULL,provider TEXT,prompt_version INTEGER,created_at TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)`
 ]) await d.execute(sql);
 const defaults={appName:"AI Photo Enhancer Pro",maintenance:false,announcement:"",activeProvider:"gemini",promptVersion:1,activePrompt:"Enhance this photo realistically. Preserve identity, face structure, expression, hairstyle, clothes and body proportions. Improve exposure, detail, natural skin texture, hair and clothing. Apply natural colors and realistic background blur. Do not replace the face or change pose or clothes."};
 for(const [k,v] of Object.entries(defaults)) await d.execute({sql:"INSERT OR IGNORE INTO app_settings(key,value,updated_at) VALUES(?,?,?)",args:[k,JSON.stringify(v),new Date().toISOString()]});
}
export async function settings(){const r=await database().execute("SELECT key,value FROM app_settings");return Object.fromEntries(r.rows.map(x=>[x.key,JSON.parse(x.value)]));}
export async function setSetting(k,v){await database().execute({sql:"INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",args:[k,JSON.stringify(v),new Date().toISOString()]});}
