# Renconte — French Story Reader PWA

A minimal, mobile-first Progressive Web App that helps non-French-speaking parents read physical French children's books aloud to their kids:
1. Snap a photo of a book page with your phone's camera.
2. **Gemini 2.5 Flash** extracts clean French story text in natural reading order (handling illustrated layouts, whimsical fonts, and two-page spreads).
3. **Gemini 2.5 Flash Preview TTS** narrates the page warmly and fluently in French.

## Quick Start (Local)

1. Copy `.env.example` to `.env` and set your `GEMINI_API_KEY`:
   ```bash
   cp .env.example .env
   ```

2. **With `uv` + `npm`:**
   ```bash
   uv sync
   npm --prefix frontend install

   # Terminal 1 (Backend on :8000)
   uv run uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000

   # Terminal 2 (Frontend on :5173, accessible over local Wi-Fi)
   npm --prefix frontend run dev
   ```

   **Or with `pixi` (manages both Python and Node.js):**
   ```bash
   pixi run install-frontend
   pixi run dev-backend
   pixi run dev-frontend
   ```

3. Run tests and production build:
   ```bash
   uv run pytest
   npm --prefix frontend run build
   ```

## Deploy to Google Cloud Run (Single Container)

FastAPI serves both `/api/*` and the compiled `frontend/dist` PWA from one HTTPS URL (zero CORS setup, scales to zero when idle):

```bash
gcloud run deploy renconte \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=your-key-here,APP_PIN=1234"
```

Open the Cloud Run URL on your phone and tap **"Add to Home Screen"** for a full-screen bedtime app experience.
