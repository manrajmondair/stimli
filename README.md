# Stimli

Stimli is a brain-aware creative decision engine for DTC growth teams. Upload two or more scripts, landing pages, static ads, audio clips, or short videos, then get a direct recommendation on which variant to ship and what to edit before spending media budget.

## What It Does

- Compares creative variants side by side instead of burying the answer in charts.
- Produces a ship / revise recommendation with confidence and evidence.
- Converts attention, memory, cognitive load, hook, clarity, CTA, and brand-cue signals into concrete edit cards.
- Scores against a campaign brief: brand, audience, category, offer, required claims, and forbidden terms.
- Extracts landing-page text from URLs when available, with a reliable fallback when a site blocks automated fetches.
- Persists comparison history and launch outcomes so future versions can calibrate prediction quality against spend results.
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
- `TRIBE_INFERENCE_URL`: optional hosted TRIBE-compatible inference endpoint. The Vercel app calls this endpoint for brain-response timelines when configured.
- `TRIBE_API_KEY`: optional bearer token for the hosted inference endpoint.
- `STIMLI_BRAIN_PROVIDER=tribe-remote`: optional strict mode that fails instead of falling back when the remote inference endpoint is unavailable.

The full local TRIBE model is too large and slow for a normal Vercel serverless function. The production architecture keeps the web product on Vercel and uses the provider boundary to call a GPU-backed model service when the research model is needed.

### Modal GPU Inference

The Modal app in `inference/tribe_modal.py` exposes a GPU endpoint for real TRIBE v2 inference. It uses a Modal Volume for model cache and two Modal Secrets:

- `stimli-huggingface` with `HF_TOKEN`
- `stimli-modal-auth` with `STIMLI_MODAL_API_KEY`

```bash
cd inference
pip install -r requirements.txt
modal secret create stimli-huggingface HF_TOKEN=...
modal secret create stimli-modal-auth STIMLI_MODAL_API_KEY=...
modal deploy tribe_modal.py
```

After deploy, set the resulting Modal endpoint in Vercel as `TRIBE_INFERENCE_URL`, set the same bearer token as `TRIBE_API_KEY`, and redeploy Vercel.

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
- `POST /api/comparisons` creates an A/B or multi-variant comparison.
- `GET /api/comparisons/{id}` returns scores, timeline signals, recommendation, and edit suggestions.
- `GET /api/reports/{id}` returns a shareable report payload.
- `GET /api/comparisons` lists saved decisions.
- `POST /api/comparisons/{id}/outcomes` records post-launch results.
- `GET /api/learning/summary` summarizes logged launch outcomes.
- `POST /api/demo/seed` loads sample creative variants.

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
