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
backend/     FastAPI service, analysis pipeline, SQLite storage, tests
frontend/    React/Vite dashboard for upload, comparison, and reports
.github/     CI workflow
```

## Quick Start

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

## API

- `POST /assets` uploads or registers an asset.
- `GET /assets` lists assets.
- `POST /comparisons` creates an A/B or multi-variant comparison.
- `GET /comparisons/{id}` returns scores, timeline signals, recommendation, and edit suggestions.
- `GET /reports/{id}` returns a shareable report payload.
- `GET /comparisons` lists saved decisions.
- `POST /comparisons/{id}/outcomes` records post-launch results.
- `GET /learning/summary` summarizes logged launch outcomes.
- `POST /demo/seed` loads sample creative variants.

## Notes On Model Use

The default implementation uses a deterministic fixture provider so the project runs reliably on a laptop without GPU downloads. The provider interface is intentionally isolated so a research-only TRIBE-style adapter can be enabled later for academic experimentation, while a commercial version can swap in licensed or owned brain-response models.

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
