# AI Photo Enhancer Pro backend

Express API for the user and admin Android apps. With real Turso credentials, it initializes and persists app metadata in libSQL tables. With the `.env.example` Turso placeholders, it uses `data/store.json` for local development.

## Run and test

```powershell
npm install
Copy-Item .env.example .env
npm start
npm test
```

Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` before admin login. No hardcoded admin account exists. Gemini image editing requires `GEMINI_API_KEY`; that key is read only by this backend. Firebase push requires the Firebase service-account variables and user-app Firebase configuration.

## Routes

The user and admin API details are in [API Documentation](../docs/API-Documentation.md). Key flows:

- Registration → pending account → admin approval → login.
- Multipart photo request → saved admin prompt → Gemini → validated image response.
- In-memory upload/output buffers are zeroed after processing; image bytes are not persisted.
- Android Gallery download and the rewarded-ad callback are implemented in the user app. A free download remains available when no ad is loaded.

## Persistence

Turso uses metadata tables described in [Database Schema](../docs/Database-Schema.md). The current implementation stores an application snapshot and mirrors it to domain tables for the single-instance Render service. Horizontal scaling requires replacing snapshot writes with row-level transactions. User/admin bearer sessions are held in memory and need a new login after process restart.
