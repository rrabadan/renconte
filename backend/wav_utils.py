import io
import re
import wave


def parse_sample_rate(mime_type: str | None, default: int = 24000) -> int:
    """Extract sample rate from a PCM mime type like 'audio/L16;codec=pcm;rate=24000'."""
    if not mime_type:
        return default
    match = re.search(r"rate=(\d+)", mime_type)
    if match:
        return int(match.group(1))
    return default


def pcm_to_wav(
    pcm_bytes: bytes,
    sample_rate: int = 24000,
    channels: int = 1,
    sample_width: int = 2,
) -> bytes:
    """Wrap raw signed little-endian linear PCM bytes in a standard RIFF/WAV header."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(sample_width)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_bytes)
    return buffer.getvalue()
