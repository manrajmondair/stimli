# Stimli

[![ci](https://github.com/manrajmondair/stimli/actions/workflows/ci.yml/badge.svg)](https://github.com/manrajmondair/stimli/actions/workflows/ci.yml)
[![deploy-pages](https://github.com/manrajmondair/stimli/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/manrajmondair/stimli/actions/workflows/deploy-pages.yml)
[![stimli.pages.dev](https://img.shields.io/badge/live-stimli.pages.dev-e96a3d)](https://stimli.pages.dev)
[![license: CC BY-NC 4.0](https://img.shields.io/badge/license-CC%20BY--NC%204.0-blue)](LICENSE)
[![node: 22+](https://img.shields.io/badge/node-22%2B-3c873a)](.nvmrc)

**Stimli is a brain-aware creative decision engine for DTC growth teams.** Upload competing ad variants — scripts, landing pages, static creative, audio, or video — and get a direct ship/revise recommendation with a confidence score, per-dimension evidence, and the exact edits to make before committing media budget.

> **Live:** [stimli.pages.dev](https://stimli.pages.dev) · **Status:** [stimli.pages.dev/api/health](https://stimli.pages.dev/api/health)

## Capabilities

**Decide.** Compare two to four variants side by side. Every variant is scored across ten dimensions — hook, clarity, CTA, brand cue, pacing, offer strength, audience fit, and a per-second neural attention / memory / cognitive-load timeline — and the result is one recommendation with the evidence behind it, ranked edit cards, focused challenger drafts, and brief-compliance checks against required claims and forbidden terms.

**Write.** The Copy Studio scores copy live as it is written, through the same engine that powers comparisons: named signal chips explain every score movement, the brief is linted in real time, a ranked ladder of engine rewrites is one click away, and finished drafts drop straight into the compare flow.

**Prove.** Decisions are a register, not a feed: label them, mark them shipped or killed, pin the ones that matter, and re-run them when the engine changes. Saving a revised draft records verified lineage — both sides rescored server-side by the same engine — and the Insights view reports what winning creative looks like, which score dimensions actually predict launch outcomes, measured Studio lift, rematch win rates, and spend-weighted prediction accuracy calibrated against logged results.

**Operate.** Team workspaces with role-based access, invite links, audit trails, brand profiles, a creative library with bulk import and bulk compare, public report sharing, workspace export, deletion review, and subscription billing.

## Architecture

The browser hits **Cloudflare Pages**. Static assets serve from the edge; everything under `/api/*` dispatches to a single **Pages Function** that handles auth, projects, assets, comparisons, the Studio preview engine, reports, sharing, billing, governance, and insights. Persistence is **Neon Postgres** over the serverless HTTP driver; private uploads go to **Cloudflare R2**; authentication is **Clerk**; billing is **Stripe**.

Brain-response inference is optional and degrades gracefully: when the **Modal** GPU service is configured, media uploads are processed asynchronously and text is scored inline against the hosted model, with a short timeout and circuit breaker guarding the request path. When it is unreachable, every path falls back to a deterministic in-process engine — and every variant in a comparison is always scored by the same engine, so rankings stay apples-to-apples. An optional **OpenRouter** copy-polish path rewrites edit cards and runs semantic compliance checks, with deterministic templates as the fallback. `/api/brain/providers` reports which engines are live.

```text
functions/api/       Cloudflare Pages Function — production API
  [[path]].js        router
  _lib/              analysis engine, auth, billing, LLM polish, store
frontend/            React + Vite application
inference/           Modal app: hosted inference + media extraction
backend/             FastAPI mirror for local development
tests/               Node-native API suite (runs the Pages Function directly)
docs/                product brief
```

## Deployment

Production deploys automatically on every push to `main` via `.github/workflows/deploy-pages.yml`: the workflow verifies secrets, runs the full test suite, builds, deploys with Wrangler, and health-checks the live deployment.

Required Cloudflare resources:

- **Pages project** `stimli` (output `frontend/dist`), with R2 buckets `stimli-media` (production) and `stimli-media-preview` (branch previews).
- **Pages secrets** via `wrangler pages secret put`: `POSTGRES_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`; optionally `TRIBE_INFERENCE_URL`, `TRIBE_CONTROL_URL`, `STIMLI_EXTRACT_URL`, `TRIBE_API_KEY` (Modal), `OPENROUTER_API_KEY` (copy polish), and the Stripe keys below.
- **GitHub Actions secrets**: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `VITE_CLERK_PUBLISHABLE_KEY`.

Public configuration (origins, rate limits, retention, fetch allowlists) lives in `wrangler.toml`. See `.env.example` for the full variable reference.

### Billing

Three tiers, defined in `functions/api/_lib/billing.js` and overridable per-plan via environment variables:

| Plan     | Price  | Comparisons / mo | Assets / mo | Seats |
|----------|--------|------------------|-------------|-------|
| Research | Free   | 25               | 200         | 3     |
| Growth   | $149   | 500              | 4,000       | 5     |
| Scale    | $499   | 5,000            | 40,000      | 25    |

Wire Stripe by creating recurring prices for Growth and Scale, setting `STRIPE_SECRET_KEY`, `STRIPE_GROWTH_PRICE_ID`, `STRIPE_SCALE_PRICE_ID`, and `STRIPE_WEBHOOK_SECRET`, and pointing a webhook at `/api/billing/webhook` for the `checkout.session.*`, `customer.subscription.*`, and `invoice.payment_*` events. Webhook deliveries are signature-verified and idempotent; subscription state in Postgres is the source of truth for plan resolution. Quota exhaustion returns a structured `402` that the frontend routes to the in-app billing flow.

### Hosted inference

The Modal app in `inference/tribe_modal.py` exposes three authenticated endpoints — synchronous inference, asynchronous job control for media, and OCR/transcription extraction:

```bash
cd inference
pip install -r requirements.txt
modal secret create stimli-huggingface HF_TOKEN=...
modal secret create stimli-modal-auth STIMLI_MODAL_API_KEY=...
modal deploy tribe_modal.py
```

Files up to 8 MB are passed to Modal inline; larger uploads are stored in R2 with filename-derived extraction fallback.

## Local development

**Production parity** — the same Workers runtime as production, with R2/auth/Modal integration:

```bash
npm install
npm run build
npm run dev:pages        # http://localhost:8788  (secrets in .dev.vars)
```

**Fast iteration** — Vite proxies `/api/*` to a local FastAPI mirror:

```bash
cd backend && python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
# in another terminal:
npm run dev:frontend     # http://localhost:5173
```

`docker compose up --build` brings up the same Vite + FastAPI pair.

## Testing

```bash
npm test
```

Runs, in order: the Node-native API suite (drives the Pages Function directly with Web Requests and a stubbed environment — auth and multi-team scoping, billing and webhooks, atomic quotas, share links, inference resilience, the Studio preview engine, revision lineage, and a full end-to-end journey), the Vitest + Testing Library frontend suite, the FastAPI test suite, and a production build as the final correctness check.

## Contributing & security

Bug fixes, accessibility improvements, and documentation are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Report vulnerabilities through a [private security advisory](https://github.com/manrajmondair/stimli/security/advisories/new); scope and response expectations are documented in [`SECURITY.md`](SECURITY.md).

## License

Released under [CC BY-NC 4.0](LICENSE) for non-commercial use. The TRIBE-backed inference mode is subject to the upstream model's own license terms; commercial use of that mode requires separate licensing. Full terms at [`/legal`](https://stimli.pages.dev/legal).
