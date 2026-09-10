# CafeBot

A simple chatbot for cafe orders with deterministic pricing, delivery/pickup, promotions and staff dashboard.

## Project Structure

- `frontend/` — `index.html` chat UI + `staff.html` dashboard (static, no build)
- `backend/` — `server.js` Express API + `package.json` scripts
- `prompts/` — `system-prompt.md` + greeting/response templates
- `data/` — `menu.json`, `promotions.json`, `orders.json` (file-based, no DB)

## Prerequisites

- Node.js 18+ and npm

## Environment Variables

Verified against `backend/server.js:10` — all are placeholders in `.env.example` (no real secrets):

| Variable | Required | Example | Used in |
|----------|----------|---------|---------|
| `PORT` | No | `3000` | `server.js:8` |
| `LLM_PROVIDER` | Yes for AI | `openai` | `.env.example:2` |
| `LLM_API_KEY` | Yes | `your_api_key_here` | `server.js` via LLM call |
| `LLM_BASE_URL` | No | `https://api.openai.com/v1` | LLM |
| `MODEL_NAME` | No | `gpt-4o-mini` | LLM |
| `TAX_RATE` | No | `0.08` | `server.js:11` deterministic total |
| `DELIVERY_FEE` | No | `3.00` | `server.js:12` |
| `NODE_ENV` | No | `development` | `server.js` |

Copy and fill:

```bash
cp .env.example .env
# edit .env - never commit real keys
```

## Build Scripts

Verified `backend/package.json:6`:

```json
"scripts": {
  "start": "node server.js",
  "dev": "node server.js"
}
```

No frontend build step (static HTML). For production use `npm start`.

```bash
cd backend
npm install
npm start        # http://localhost:3000  (chat)
# staff dashboard: http://localhost:3000/staff.html
npm run dev      # same, for local dev
```

`node --check backend/server.js` passes; `dotenv` loads from project root (`backend/server.js:1`).

## Deployment Checklist

- [ ] `.env` created from `.env.example` with real values on server (not committed)
- [ ] `node_modules/` not committed (see `.gitignore:5`)
- [ ] `backend/server.js` uses `process.env.PORT/TAX_RATE/DELIVERY_FEE` with defaults
- [ ] `GET /api/orders` and `frontend/staff.html` work after deploy
- [ ] `data/orders.json` writable (file-based demo store)
- [ ] No secrets in git history (`git ls-files` shows only `.env.example`)

## Ignored Secret Files

Verified `.gitignore:1`:

```
.env
*.env
!.env.example
node_modules/
```

`.env` does not exist in repo (`Test-Path .env` = False); only `.env.example` is tracked.

## Getting Started (Quick)

1. `cp .env.example .env` and fill `LLM_API_KEY`
2. `cd backend && npm install && npm start`
3. Open `http://localhost:3000` and `http://localhost:3000/staff.html`
