# Stimli

[![deploy-pages](https://github.com/manrajmondair/stimli/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/manrajmondair/stimli/actions/workflows/deploy-pages.yml)
[![stimli.pages.dev](https://img.shields.io/badge/live-stimli.pages.dev-e96a3d)](https://stimli.pages.dev)

Stimli is a brain-aware creative decision engine for DTC growth teams. Upload two or more scripts, landing pages, static ads, audio clips, or short videos, then get a direct recommendation on which variant to ship and what to edit before spending media budget.

> Live at **https://stimli.pages.dev**.

## What it does

- Compares creative variants side by side instead of burying the answer in charts.
- Produces a ship / revise recommendation with a confidence score and the evidence behind it.
- Converts attention, memory, cognitive load, hook, clarity, CTA, and brand-cue signals into concrete edit cards.
- Scores against a campaign brief: brand, audience, category, offer, required claims, and forbidden terms.
- Extracts landing-page text from URLs, with a reliable fallback when a site blocks automated fetches.
- Persists comparison history and launch outcomes so future versions can calibrate prediction quality against spend results.
- Supports passkey accounts, team workspaces, free invite links, project ownership, and public report sharing.
- Adds enterprise controls for team roles, audit events, hosted-job observability, retry recovery, workspace export, deletion review, validation benchmarks, brand profiles, creative library, and bulk imports.
- Works with a deterministic local brain-response provider for reproducible demos, with a clean adapter boundary for TRIBE-style model inference.
- Exports a report payload suitable for a short project demo or client-style review.

## Project structure

```text
functions/        Cloudflare Pages Functions — production API
  api/
    [[path]].js    main router
    _lib/          analysis, auth, billing, store helpers
frontend/         React/Vite dashboard (builds to frontend/dist)
inference/        Modal app for hosted TRIBE inference + extraction
backend/          FastAPI research backend (local experimentation only)
tests/            Node test suite for the Pages Function
wrangler.toml     Cloudflare Pages config (compatibility flags, env, R2)
.github/workflows/
  deploy-pages.yml  Auto-deploy to Cloudflare Pages on push to main
```

## Architecture in one paragraph

The browser hits **Cloudflare Pages** at `stimli.pages.dev`. Static assets are served straight from R2's edge cache. Anything under `/api/*` is dispatched to a single **Pages Function** (`functions/api/[[path]].js`) that handles auth, projects, assets, comparisons, reports, sharing, billing, governance, validation, library, imports, and admin. Persistence is **Neon Postgres** via the `@neondatabase/serverless` HTTP driver (Workers can't open raw TCP). Private uploads go to **Cloudflare R2** (`env.STIMLI_MEDIA.put(...)`). Brain-response inference is optional — when `TRIBE_INFERENCE_URL` and `TRIBE_CONTROL_URL` point at the **Modal** app in `inference/tribe_modal.py`, comparisons go async and stream results from a GPU; otherwise a deterministic in-process heuristic produces the timeline.

## Deploy

Production deploys happen automatically on every push to `main` via the GitHub Action at `.github/workflows/deploy-pages.yml`. The Action installs deps, builds the frontend, and runs `wrangler pages deploy frontend/dist --project-name=stimli`.

Manual deploy (from a clean checkout):

```bash
npm install
npx wrangler login          # one-time
npm run deploy:pages
```

### Required Cloudflare resources

- **Pages project** `stimli` (production branch `main`, output dir `frontend/dist`, build `npm run build`).
- **R2 bucket** `stimli-media` for private uploaded assets.
- **Pages secrets** (set via `wrangler pages secret put`):
  - `POSTGRES_URL` — Neon connection string.
  - `CLERK_SECRET_KEY` — Clerk API secret (sk_test_… / sk_live_…).
  - `CLERK_PUBLISHABLE_KEY` — Clerk publishable key (pk_test_… / pk_live_…).
  - `TRIBE_INFERENCE_URL`, `TRIBE_CONTROL_URL`, `STIMLI_EXTRACT_URL` — Modal endpoint URLs.
  - `TRIBE_API_KEY` — bearer token shared with the Modal worker.
- **GitHub Actions secrets** (set via `gh secret set` or repo settings → Actions):
  - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — used by `wrangler-action`.
  - `VITE_CLERK_PUBLISHABLE_KEY` — Vite reads this at build time and inlines it into the bundle. Same value as the Clerk publishable key.
- **Public env vars** (in `wrangler.toml [vars]`): `STIMLI_ORIGIN`, `STIMLI_APP_URL`, `CLERK_AUTHORIZED_PARTIES`, rate limits, retention defaults.

## Authentication (Clerk)

Sign-in uses [Clerk](https://clerk.com). Providers configured: Google, Apple, GitHub, Microsoft, email/password, magic link, and passkey. Configure them in the Clerk dashboard under **User & Authentication → Email, Phone, Username** and **Social Connections**.

On the server, `functions/api/_lib/auth.js` verifies each request's `Authorization: Bearer <jwt>` against Clerk's JWKS via `@clerk/backend`. The verified Clerk `userId` is mapped to a row in `stimli_users` (auto-created on first call) and a personal team (also auto-created). Sessions are owned entirely by Clerk — the API does not issue or store its own cookies.

Run `wrangler pages secret list --project-name=stimli` to confirm what's set.

### Optional integrations

- `STIMLI_TRIBE_COMMERCIAL_LICENSE=1` flips the license badge to `commercial-ready` for surfaces that gate commerce on the brain provider's license terms.

### Subscription billing (Stripe)

Three tiers, all defined in `functions/api/_lib/billing.js`:

| Plan      | Price  | Comparisons / mo | Assets / mo | Seats |
|-----------|--------|------------------|-------------|-------|
| Research  | Free   | 25               | 200         | 1     |
| Growth    | $149   | 500              | 4,000       | 5     |
| Scale     | $499   | 5,000            | 40,000      | 25    |

Hourly limits (40 assets / 12 comparisons on Research, scaling up by tier) remain as bot/abuse protection. Monthly quotas are the real SaaS quota and reset on the subscription's billing cycle (or on the UTC calendar month for free tenants without a Stripe subscription).

Wiring billing on top of the base deployment requires:

1. Create three Stripe products (Research is free — no Stripe object needed):
   - **Growth** — recurring monthly price → `STRIPE_GROWTH_PRICE_ID`.
   - **Scale** — recurring monthly price → `STRIPE_SCALE_PRICE_ID`.
2. Set Pages secrets via `wrangler pages secret put`:
   - `STRIPE_SECRET_KEY` (sk_test_… in dev, sk_live_… in production).
   - `STRIPE_GROWTH_PRICE_ID`, `STRIPE_SCALE_PRICE_ID`.
   - `STRIPE_WEBHOOK_SECRET` (created when you add the webhook endpoint).
3. Add a Stripe webhook pointing at `https://stimli.pages.dev/api/billing/webhook` listening for:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `customer.subscription.trial_will_end`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`

Stripe events are deduped by event id in `stimli_billing_events`, so retries are safe. Subscription state (period bounds, cancel flag, trial end, status) lives in `stimli_subscriptions` and is the source of truth for plan resolution; the team's denormalized `plan` field is kept in sync so anonymous billing-status reads stay cheap. Stripe itself charges no platform fee — costs only apply on real customer charges (2.9% + 30¢ at typical US rates), so this entire system can run at zero recurring cost in test mode and idle.

When a request exceeds the monthly quota, the API returns `402 Payment Required` with a structured body:

```json
{
  "detail": "Monthly comparison quota reached on the Research plan. Upgrade to keep shipping.",
  "code": "quota_exceeded",
  "details": {
    "kind": "comparison",
    "limit": 25,
    "used": 25,
    "plan": "research",
    "reset_at": "2026-06-01T00:00:00.000Z",
    "upgrade_url": "/?billing=upgrade"
  }
}
```

The frontend listens for this status on every fetch and routes the user to the in-app **Billing** view, which renders pricing cards driven by `/api/billing/status` and opens Stripe Checkout for upgrades / Stripe Customer Portal for subscription management.

Per-plan quotas and prices can be overridden without a redeploy via env vars (e.g. `STIMLI_GROWTH_COMPARISON_LIMIT_PER_MONTH=750`, `STIMLI_GROWTH_PRICE_CENTS_MONTHLY=19900`).

## Modal GPU inference

The Modal app in `inference/tribe_modal.py` exposes three endpoints:

- `https://<workspace>--stimli-tribe.modal.run` — sync TRIBE inference (`TRIBE_INFERENCE_URL`).
- `https://<workspace>--stimli-tribe-control.modal.run` — async job control for media (`TRIBE_CONTROL_URL`).
- `https://<workspace>--stimli-extract.modal.run` — OCR/transcript extraction (`STIMLI_EXTRACT_URL`).

Two Modal secrets are required:

- `stimli-huggingface` with `HF_TOKEN`
- `stimli-modal-auth` with `STIMLI_MODAL_API_KEY` (this is the bearer the Cloudflare Pages secret `TRIBE_API_KEY` matches)

```bash
cd inference
pip install -r requirements.txt
modal secret create stimli-huggingface HF_TOKEN=...
modal secret create stimli-modal-auth STIMLI_MODAL_API_KEY=...
modal deploy tribe_modal.py
```

Media files are sent to Modal inline (base64 in `asset.metadata.file_base64`) for sizes up to `STIMLI_MAX_INLINE_FILE_BYTES` (8 MB by default). Larger files are stored in R2 only and Modal falls back to filename-derived text for extraction — wire up an R2 signed-URL path if you need extraction at the 8–25 MB tier.

## Local development

Two local-dev paths. Pick by whether you need production parity or fast iteration.

### Path A — Wrangler Pages dev (production parity, recommended)

Uses the same Cloudflare Workers runtime as production. Good for testing R2 / auth / Modal integration locally.

```bash
npm install
npm run build                # populates frontend/dist
npm run dev:pages            # wrangler pages dev on http://localhost:8788
```

Add a local secrets file at `.dev.vars` (gitignored) with `POSTGRES_URL=...` and any Modal secrets you want to exercise.

### Path B — Vite + FastAPI (fast iteration on the workbench)

Use this when iterating on the React shell or the analysis heuristics. The Pages Function is bypassed; the Vite dev server proxies `/api/*` to a local FastAPI process.

In one terminal, the Python backend:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

In another, the Vite dev server:

```bash
npm install
npm run dev:frontend         # http://localhost:5173
```

`vite.config.ts` proxies `/api/*` to `http://127.0.0.1:8000` (override with `STIMLI_API_PROXY`), stripping the `/api` prefix so requests land on the FastAPI routes directly. The FastAPI service implements a useful subset (assets, comparisons, demo seed, learning summary, reports, challengers, outcomes); the enterprise routes return 404 and the UI handles that gracefully.

### Docker

```bash
docker compose up --build
```

Brings up the same Vite + FastAPI pair as Path B at `http://localhost:5173`.

## Tests

```bash
npm test
```

Runs in order:

1. **`npm run test:api`** — Node-native test suite (`node --test tests/serverless-api.test.js`) that drives `functions/api/[[path]].js` with Web Requests + a stub env. 17 tests covering health, CORS, passkeys, billing status, team invites, role enforcement, demo seed, calibration, share links, project scoping, workspace isolation, async TRIBE comparisons, cancellation, rate limits, hosted extraction, enterprise controls, and job retries.
2. **`npm run test:web`** — Vitest + @testing-library/react across `frontend/src/test/`. 14 tests covering error-message parsing, Landing page rendering, and App router behavior.
3. **`npm run build`** — TypeScript build + production Vite bundle as a final correctness check.

## License & trust

Stimli is released under CC BY-NC 4.0 for non-commercial use. Built for CS 153 at Stanford. See [`/legal`](https://stimli.pages.dev/legal) on the live site for full terms.
