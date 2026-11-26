import base64
import os

from google import genai
from google.genai import types

from backend.wav_utils import parse_sample_rate, pcm_to_wav

VISION_MODEL = "gemini-3.8-flash"
TTS_MODEL = "gemini-2.5-flash-preview-tts"
DEFAULT_VOICE = "Aoede"

EXTRACT_PROMPT = (
    "You are transcribing a photo of a French children's book page so it can be read aloud.\n"
    "Rules:\n"
    "- Extract ONLY the story text and character dialogue in natural reading order "
    "(if this is a two-page spread, read the left page completely, then the right page).\n"
    "- Omit page numbers, headers, footers, copyright notices, ISBNs, and publisher logos.\n"
    "- Rejoin words that are hyphenated across line breaks.\n"
    "- Preserve French accents (é, è, ê, ç, œ, etc.) and punctuation (« », !, ?, ...) accurately.\n"
    "- Return ONLY the plain French text with no markdown, quotes, or commentary.\n"
    "- If the page has no readable story text (illustration only), return an empty string."
)


def _get_client(api_version: str | None = None) -> genai.Client:
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not configured on the server.")
    use_vertex = api_key.startswith("AQ.") or (
        os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "").strip().lower() == "true"
    )
    http_options = (
        types.HttpOptions(api_version=api_version) if api_version else None
    )
    if use_vertex:
        return genai.Client(vertexai=True, api_key=api_key, http_options=http_options)
    return genai.Client(api_key=api_key, http_options=http_options)


def extract_french_text(image_bytes: bytes, mime_type: str) -> str:
    """Extract clean French story text from a book page image using Gemini Vision."""
    client = _get_client()
    vision_model = (os.getenv("GEMINI_VISION_MODEL") or VISION_MODEL).strip()
    config = (
        types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(thinking_budget=0)
        )
        if "3.8" in vision_model or "2.5" in vision_model
        else None
    )
    response = client.models.generate_content(
        model=vision_model,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            EXTRACT_PROMPT,
        ],
        config=config,
    )
    return (response.text or "").strip()


def synthesize_french_speech(text: str, voice_name: str | None = None) -> bytes:
    """Synthesize warm, expressive French storytelling audio (WAV) from text."""
    client = _get_client(api_version="v1beta")
    resolved_voice = (voice_name or os.getenv("GEMINI_VOICE") or DEFAULT_VOICE).strip()

    story_prompt = (
        "Lis ce passage d'un livre pour enfants en français d'une voix douce, "
        "chaleureuse, naturelle et expressive, avec un rythme calme adapté à "
        f"l'histoire du soir :\n\n{text}"
    )

    response = client.models.generate_content(
        model=TTS_MODEL,
        contents=story_prompt,
        config=types.GenerateContentConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=resolved_voice,
                    )
                )
            ),
        ),
    )

    candidates = response.candidates or []
    if not candidates or not candidates[0].content or not candidates[0].content.parts:
        raise RuntimeError("Gemini TTS returned no audio content.")

    for part in candidates[0].content.parts:
        inline_data = getattr(part, "inline_data", None)
        if inline_data and inline_data.data:
            raw = inline_data.data
            audio_bytes = base64.b64decode(raw) if isinstance(raw, str) else bytes(raw)
            mime_type = getattr(inline_data, "mime_type", None) or ""
            if "wav" in mime_type.lower():
                return audio_bytes
            sample_rate = parse_sample_rate(mime_type, default=24000)
            return pcm_to_wav(audio_bytes, sample_rate=sample_rate)

    raise RuntimeError("Gemini TTS response did not include inline audio data.")
