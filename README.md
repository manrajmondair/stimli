# Stimli

Stimli is a brain-aware creative decision engine for DTC growth teams. Upload two or more scripts, landing pages, static ads, audio clips, or short videos, then get a direct recommendation on which variant to ship and what to edit before spending media budget.

## What It Does

- Compares creative variants side by side instead of burying the answer in charts.
- Produces a ship / revise recommendation with confidence and evidence.
- Converts attention, memory, cognitive load, hook, clarity, CTA, and brand-cue signals into concrete edit cards.
- Scores against a campaign brief: brand, audience, category, offer, required claims, and forbidden terms.
- Extracts landing-page text from URLs when available, with a reliable fallback when a site blocks automated fetches.
- Persists comparison history and launch outcomes so future versions can calibrate prediction quality against spend results.
- Supports passkey accounts, team workspaces, free invite links, project ownership, and public report sharing.
- Works with a deterministic local brain-response provider for reproducible demos, with a clean adapter boundary for TRIBE-style model inference.
- Exports a report payload suitable for a short project demo or client-style review.

## Project Structure

```text
api/         Vercel serverless API routes and production storage adapter
backend/     FastAPI service, analysis pipeline, SQLite storage, tests
frontend/    React/Vite dashboard for upload, comparison, and reports
.github/     CI workflow
```

## Deploy On Vercel

Stimli is configured as one Vercel project: the React dashboard builds to `frontend/dist`, and the product API runs from same-origin `/api/*` serverless functions. There is no separate hosted frontend/backend split required for production.

```bash
npm install
npm run build
npx vercel deploy --prod
```

Vercel uses the root `vercel.json`:

- Build command: `npm run build`
- Output directory: `frontend/dist`
- API runtime: `api/[...path].js`
- SPA routing: all non-API routes fall back to `index.html`

The recommended production path is to connect the GitHub repo to Vercel and let pushes to `main` deploy automatically. The CLI command above is useful for a manual production deployment after `vercel login`.

Production environment variables:

- `POSTGRES_URL` or `DATABASE_URL`: enables persistent production storage. Without it, Vercel uses warm-function memory only, which is useful for previews but not durable.
- `BLOB_READ_WRITE_TOKEN`: enables private Vercel Blob storage for uploaded files. Without it, small files can still be inlined for local workflows, but production media uploads are not durable.
- `TRIBE_INFERENCE_URL`: optional hosted TRIBE-compatible inference endpoint. The Vercel app calls this endpoint for brain-response timelines when configured.
- `TRIBE_CONTROL_URL`: optional hosted job-control endpoint for async media inference. When configured, audio/video comparisons return quickly with `status=processing` and finalize as the hosted jobs complete.
- `STIMLI_EXTRACT_URL`: optional hosted media-extraction endpoint for OCR and transcript text on image, audio, and video uploads.
- `TRIBE_API_KEY`: optional bearer token for the hosted inference endpoint.
- `STIMLI_BRAIN_PROVIDER=tribe-remote`: optional strict mode that fails instead of falling back when the remote inference endpoint is unavailable.
- `STIMLI_ASSET_LIMIT_PER_HOUR` and `STIMLI_COMPARISON_LIMIT_PER_HOUR`: optional per-workspace/client quotas for the public API.
- `STIMLI_RP_ID` and `STIMLI_ORIGIN`: optional passkey relying-party settings. For production, use the public app host and origin.
- `STIMLI_COMPARISON_JOB_TIMEOUT_MS` and `STIMLI_MODAL_JOB_RETRIES`: optional controls for hosted job timeout and retry behavior.

The full local TRIBE model is too large and slow for a normal Vercel serverless function. The production architecture keeps the web product on Vercel and uses the provider boundary to call a GPU-backed model service when the research model is needed.

### Free-Tier Deployment Profile

The product is designed to run with free options by default:

- Hosting/API: Vercel Hobby, same-origin Vite app plus serverless `/api/*`.
- Database: Neon Free Postgres through the Vercel integration.
- File storage: Vercel Blob on the Hobby allowance, with private URLs hidden from public payloads.
- Auth: built-in passkeys, sessions, and team workspaces in Postgres; no paid auth provider required.
- GPU inference: Modal Starter credits, with low default concurrency and short scale-down windows.
- Billing: Stripe integration is optional and disabled unless Stripe env vars are provided. Stripe has transaction fees, so it should not be configured for a purely free deployment.

Use `.env.example` as the free profile. The default direct-upload cap is 25 MB, public quota defaults are conservative, and Modal defaults to one GPU container so testing does not burn free credits unexpectedly. Raise those limits only after checking the provider dashboards.

Free-first env controls:

- `STIMLI_MAX_DIRECT_UPLOAD_BYTES=26214400`
- `STIMLI_ASSET_LIMIT_PER_HOUR=40`
- `STIMLI_COMPARISON_LIMIT_PER_HOUR=12`
- `STIMLI_MODAL_MAX_CONTAINERS=1`
- `STIMLI_MODAL_SCALEDOWN_WINDOW=60`
- `STIMLI_EXTRACT_SCALEDOWN_WINDOW=30`

### Modal GPU Inference

The Modal app in `inference/tribe_modal.py` exposes GPU endpoints for real TRIBE v2 inference and hosted media extraction. It uses a Modal Volume for model cache and three Modal Secrets:

- `stimli-huggingface` with `HF_TOKEN`
- `stimli-modal-auth` with `STIMLI_MODAL_API_KEY`
- `stimli-vercel-blob` with `BLOB_READ_WRITE_TOKEN`

```bash
cd inference
pip install -r requirements.txt
modal secret create stimli-huggingface HF_TOKEN=...
modal secret create stimli-modal-auth STIMLI_MODAL_API_KEY=...
modal secret create stimli-vercel-blob BLOB_READ_WRITE_TOKEN=...
modal deploy tribe_modal.py
```

After deploy, set the synchronous Modal endpoint in Vercel as `TRIBE_INFERENCE_URL`, set the control endpoint as `TRIBE_CONTROL_URL`, set the extraction endpoint as `STIMLI_EXTRACT_URL`, set the same bearer token as `TRIBE_API_KEY`, and redeploy Vercel. The control endpoint is used for production media jobs so large audio/video files do not block the browser request while GPU inference runs.

### Production Media Uploads

Production uploads use private Vercel Blob storage. Browser uploads go through the `/api/blob/upload` token route, then assets are registered in Postgres with blob metadata. Private blob URLs are kept out of public API responses; Modal receives the private URL server-to-server and downloads it with the `stimli-vercel-blob` secret. When `STIMLI_EXTRACT_URL` is configured, image uploads receive OCR text, audio uploads receive transcript text, and video uploads receive transcript plus sampled-frame OCR before scoring.

## Local Development

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The app will be available at `http://localhost:5173`.

### Docker

```bash
docker compose up --build
```

Then open `http://localhost:5173`.

## Demo Flow

1. Start the backend and frontend.
2. Open the dashboard.
3. Use the built-in sample variants or upload/paste your own assets.
4. Run a comparison.
5. Review the winner, confidence, timeline evidence, and action cards.
6. Draft a challenger variant and export a Markdown report.

Sample text assets live in `backend/data/sample_assets/`.

## API

- `POST /api/assets` uploads or registers an asset.
- `GET /api/assets` lists assets.
- `POST /api/comparisons` creates an A/B or multi-variant comparison. Text comparisons usually return `complete`; media comparisons may return `processing`.
- `GET /api/comparisons/{id}` returns scores, timeline signals, recommendation, and edit suggestions. Processing comparisons are refreshed against the hosted job-control endpoint before returning.
- `GET /api/reports/{id}` returns a shareable report payload.
- `GET /api/comparisons` lists saved decisions.
- `POST /api/comparisons/{id}/outcomes` records post-launch results.
- `GET /api/learning/summary` summarizes logged launch outcomes.
- `POST /api/demo/seed` loads sample creative variants.
- `POST /api/teams/invites` creates a team invite link for a signed-in owner.
- `POST /api/invites/{token}/accept` accepts a team invite and switches the session into that team.

## Notes On Model Use

The default implementation uses a deterministic fixture provider so the project runs reliably on a laptop without GPU downloads. The app also includes a real TRIBE v2 provider that can run `facebook/tribev2` inference when its research dependencies and model checkpoint are installed.

### Enable TRIBE v2

TRIBE v2 is licensed CC BY-NC 4.0 by its upstream authors, so this mode is for academic/non-commercial experimentation unless separate commercial rights are secured.

```bash
cd backend
source .venv/bin/activate
pip install -r requirements-tribe.txt
export STIMLI_BRAIN_PROVIDER=tribe
export STIMLI_TRIBE_CACHE=.data/tribe-cache
export HF_TOKEN=your_huggingface_token_with_required_model_access
uvicorn app.main:app --reload --port 8000
```

Provider modes:

- `STIMLI_BRAIN_PROVIDER=fixture`: deterministic local provider.
- `STIMLI_BRAIN_PROVIDER=tribe`: real TRIBE v2 inference; fails loudly if dependencies/model loading fail.
- `STIMLI_BRAIN_PROVIDER=auto`: tries TRIBE v2 first, then falls back to the deterministic provider.

Use `GET /brain/providers` to inspect provider availability. The endpoint only checks package import by default; set `STIMLI_TRIBE_HEALTH_LOAD=1` to also verify checkpoint loading.

Real script/text inference also requires Hugging Face access to TRIBE's configured text feature model, `meta-llama/Llama-3.2-3B`. Without an authenticated token that has access to that gated model, TRIBE model loading can succeed but inference will fail during text feature extraction.

## Testing

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pytest
```

```bash
cd frontend
npm install
npm run build
```

<sub>Assisted by Codex.</sub>
