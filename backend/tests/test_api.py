import io
import wave
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import app
from backend.wav_utils import parse_sample_rate, pcm_to_wav

client = TestClient(app)


def test_pcm_to_wav_produces_valid_wav() -> None:
    raw_pcm = b"\x00\x01" * 240  # 10ms of 24kHz 16-bit mono PCM
    wav_bytes = pcm_to_wav(raw_pcm, sample_rate=24000, channels=1, sample_width=2)

    assert wav_bytes[:4] == b"RIFF"
    assert wav_bytes[8:12] == b"WAVE"

    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2
        assert wf.getframerate() == 24000
        assert wf.readframes(wf.getnframes()) == raw_pcm


def test_parse_sample_rate() -> None:
    assert parse_sample_rate("audio/L16;codec=pcm;rate=24000") == 24000
    assert parse_sample_rate("audio/L16;rate=16000") == 16000
    assert parse_sample_rate("audio/pcm", default=24000) == 24000
    assert parse_sample_rate(None, default=24000) == 24000


def test_health_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.delenv("APP_PIN", raising=False)

    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {
        "status": "ok",
        "api_key_configured": True,
        "pin_required": False,
    }


def test_extract_endpoint_happy_path(monkeypatch) -> None:
    monkeypatch.delenv("APP_PIN", raising=False)
    with patch(
        "backend.gemini_service.extract_french_text",
        return_value="Il était une fois un petit renard.",
    ) as mock_extract:
        res = client.post(
            "/api/extract",
            files={"file": ("page.jpg", b"fake-jpeg-bytes", "image/jpeg")},
        )

    assert res.status_code == 200
    assert res.json() == {"text": "Il était une fois un petit renard."}
    mock_extract.assert_called_once_with(b"fake-jpeg-bytes", "image/jpeg")


def test_extract_rejects_non_image(monkeypatch) -> None:
    monkeypatch.delenv("APP_PIN", raising=False)
    res = client.post(
        "/api/extract",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert res.status_code == 400


def test_speak_endpoint_returns_wav(monkeypatch) -> None:
    monkeypatch.delenv("APP_PIN", raising=False)
    expected_wav = pcm_to_wav(b"\x00\x00" * 100)
    with patch(
        "backend.gemini_service.synthesize_french_speech",
        return_value=expected_wav,
    ) as mock_speak:
        res = client.post(
            "/api/speak",
            json={"text": "Bonne nuit petit lapin."},
        )

    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/wav"
    assert res.content == expected_wav
    mock_speak.assert_called_once_with("Bonne nuit petit lapin.", voice_name=None)


def test_pin_protection(monkeypatch) -> None:
    monkeypatch.setenv("APP_PIN", "1234")

    res_missing = client.post("/api/speak", json={"text": "Bonjour"})
    assert res_missing.status_code == 401

    res_wrong = client.post(
        "/api/speak",
        json={"text": "Bonjour"},
        headers={"X-App-Pin": "0000"},
    )
    assert res_wrong.status_code == 401

    expected_wav = pcm_to_wav(b"\x00\x00" * 50)
    with patch(
        "backend.gemini_service.synthesize_french_speech",
        return_value=expected_wav,
    ):
        res_ok = client.post(
            "/api/speak",
            json={"text": "Bonjour"},
            headers={"X-App-Pin": "1234"},
        )
    assert res_ok.status_code == 200


def test_get_client_detects_vertex_express_key(monkeypatch) -> None:
    from backend import gemini_service

    monkeypatch.setenv("GEMINI_API_KEY", "AQ.example-express-key")
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    with patch("backend.gemini_service.genai.Client") as mock_client:
        gemini_service._get_client()
    mock_client.assert_called_once_with(
        vertexai=True, api_key="AQ.example-express-key", http_options=None
    )

    monkeypatch.setenv("GEMINI_API_KEY", "AIza-example-studio-key")
    with patch("backend.gemini_service.genai.Client") as mock_client:
        gemini_service._get_client()
    mock_client.assert_called_once_with(
        api_key="AIza-example-studio-key", http_options=None
    )
