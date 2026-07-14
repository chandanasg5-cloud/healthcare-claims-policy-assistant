# Deployment — GitHub → Encore Cloud + Vercel

A push to `main` deploys both halves: the Encore backend (from `backend/`) and the
Next.js frontend (from `frontend/`). The streaming transport is SSE, so there is **no
client-generation step** — the frontend just needs the backend's URL.

## 1. Backend → Encore Cloud

1. Install the CLI and log in:
   ```bash
   curl -L https://encore.dev/install.sh | bash
   encore auth login
   ```
2. From `backend/`, create (or link) the Encore app — this writes the real `id` into
   `backend/encore.app`; commit it:
   ```bash
   cd backend && encore app create   # choose a name; commit the updated encore.app
   ```
3. In the Encore Cloud dashboard, **connect this GitHub repo**. Because the app lives in
   a subdirectory, point Encore at **`backend/`** as the app root. Encore builds on every
   push to `main` and **auto-provisions Postgres**, applying `1_schema.up.sql`.
4. Set the production secret (dashboard, or CLI):
   ```bash
   cd backend && encore secret set --type prod GeminiApiKey   # paste your Google AI Studio key
   ```
5. Note the deployed API base URL (e.g. `https://<app>-<id>.encr.app`).

## 2. Frontend → Vercel

1. In the Vercel dashboard, **import the same GitHub repo**.
2. Set **Root Directory = `frontend/`**.
3. Add an environment variable: `NEXT_PUBLIC_API_URL = <the Encore Cloud base URL>`.
4. Deploy. Vercel auto-deploys on every push to `main`.

## 3. CORS — and the one thing to verify after first deploy

`backend/encore.app` includes a `global_cors` block allowing cross-origin requests, so
the browser on the Vercel origin can call the Encore API (JSON + SSE) directly. If you
lock CORS down later, allow your Vercel domain explicitly.

**Verify after the first deploy:** the streaming endpoints use `api.raw` (SSE) rather than
managed `api()` handlers. Encore applies CORS at the gateway, so they should be covered —
but confirm it the one way local gates can't: open the deployed Vercel site **in a browser**
and ask one question in the chat (e.g. "Why was CLM-1003 denied?") — confirm the step
lines and the answer stream in. If the claims list loads but the chat is blocked, the `api.raw` responses aren't getting
`Access-Control-Allow-Origin` — set it explicitly in `sseInit` (`backend/claims/api.ts`).
Test from a browser, not `curl` (curl ignores CORS).

## Notes

- **No `encore gen client` step** — the SSE design means the frontend uses plain `fetch`;
  there is no generated client to regenerate or commit.
- Both services are now connected to GitHub; a single push to `main` ships both.
- All data is synthetic and for demonstration only.
