import hmac
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from backend import gemini_service

load_dotenv()

MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"

app = FastAPI(title="Renconte — French Story Reader API", version="0.1.0")


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    voice: str | None = Field(default=None, max_length=64)


def verify_pin(x_app_pin: str | None = Header(default=None)) -> None:
    expected_pin = os.getenv("APP_PIN", "").strip()
    if not expected_pin:
        return
    if not x_app_pin or not hmac.compare_digest(x_app_pin.strip(), expected_pin):
        raise HTTPException(status_code=401, detail="Invalid or missing family PIN.")


@app.get("/api/health")
def health() -> dict[str, object]:
    return {
        "status": "ok",
        "api_key_configured": bool(os.getenv("GEMINI_API_KEY", "").strip()),
        "pin_required": bool(os.getenv("APP_PIN", "").strip()),
    }


@app.post("/api/extract", dependencies=[Depends(verify_pin)])
async def extract_text(file: UploadFile = File(...)) -> dict[str, str]:
    content_type = (file.content_type or "").lower()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Please upload an image file.")

    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded image is empty.")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds the 10 MB limit.")

    try:
        text = gemini_service.extract_french_text(image_bytes, content_type)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Could not read page text: {exc}"
        ) from exc

    return {"text": text}


@app.post("/api/speak", dependencies=[Depends(verify_pin)])
def speak_text(payload: SpeakRequest) -> Response:
    cleaned_text = payload.text.strip()
    if not cleaned_text:
        raise HTTPException(status_code=400, detail="Text cannot be empty.")

    try:
        wav_bytes = gemini_service.synthesize_french_speech(
            cleaned_text, voice_name=payload.voice
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=502, detail=f"Could not synthesize French audio: {exc}"
        ) from exc

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )


if FRONTEND_DIST.is_dir():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str) -> FileResponse:
        candidate = (FRONTEND_DIST / full_path).resolve()
        if (
            full_path
            and candidate.is_file()
            and str(candidate).startswith(str(FRONTEND_DIST.resolve()))
        ):
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
