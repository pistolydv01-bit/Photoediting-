# AI Photo Enhancer Backend

## Deploy on Render
- Runtime: Node
- Root Directory: leave blank if this repository contains the backend files at its root.
- Build Command: `npm install`
- Start Command: `npm start`
- Node version: 20 or newer

## Required environment variables
Copy the keys from `.env.example` into Render's Environment settings and enter real values there:
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `JWT_SECRET` (at least 32 characters; use a long random secret)
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `GEMINI_API_KEY`
- `GEMINI_MODEL` (optional; defaults in the app)

Do not upload `.env`, real API keys, database tokens, or local database files to GitHub.

## Important project note
This archive contains the compiled runtime in `dist/`, but it does not contain the TypeScript source directory (`src/`) referenced by `tsconfig.json`. Therefore deploy using `npm install` as the build command and `npm start` as the start command. Do not use `npm run build` unless the missing `src/` files are added.
