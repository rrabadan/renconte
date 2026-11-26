import { useEffect, useRef, useState } from "react";
import { compressImage } from "./utils/image";

type Stage = "idle" | "extracting" | "speaking" | "ready" | "empty" | "error";

const PIN_STORAGE_KEY = "renconte_family_pin";

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function splitIntoSpeechChunks(text: string, maxChunkChars = 180): string[] {
  const sentences = text
    .split(/(?<=[.!?…»])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length <= 1) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > maxChunkChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export default function App() {
  const [stage, setStage] = useState<Stage>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [extractedText, setExtractedText] = useState<string>("");
  const [showText, setShowText] = useState(false);

  const [audioUrls, setAudioUrls] = useState<string[]>([]);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState<0.85 | 1>(1);

  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState<string>(
    () => localStorage.getItem(PIN_STORAGE_KEY) ?? ""
  );
  const [pinDraft, setPinDraft] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const scanRunIdRef = useRef(0);
  const audioUrlsRef = useRef<string[]>([]);
  const shouldAutoPlayRef = useRef(false);

  const audioUrl = audioUrls[chunkIndex] ?? null;

  useEffect(() => {
    audioUrlsRef.current = audioUrls;
  }, [audioUrls]);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.pin_required) {
          setPinRequired(true);
        }
      })
      .catch(() => {
        // Ignore initial health check failure; errors will surface on scan.
      });
  }, []);

  useEffect(() => {
    return () => {
      audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioUrl) return;
    audio.playbackRate = playbackRate;
    if (shouldAutoPlayRef.current) {
      shouldAutoPlayRef.current = false;
      audio.play().catch(() => setIsPlaying(false));
    }
  }, [audioUrl]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, audioUrl]);

  function getAuthHeaders(): HeadersInit {
    return pin ? { "X-App-Pin": pin } : {};
  }

  function handleSavePin(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = pinDraft.trim();
    if (!cleaned) return;
    localStorage.setItem(PIN_STORAGE_KEY, cleaned);
    setPin(cleaned);
    setPinDraft("");
    setErrorMessage(null);
  }

  async function fetchSpeechUrl(text: string): Promise<string> {
    const speakRes = await fetch("/api/speak", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ text }),
    });

    if (!speakRes.ok) {
      const err = await speakRes.json().catch(() => ({}));
      throw new Error(err.detail || "Could not generate French voice.");
    }

    const audioBlob = await speakRes.blob();
    return URL.createObjectURL(audioBlob);
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const runId = ++scanRunIdRef.current;

    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlaying(false);
    setErrorMessage(null);
    setExtractedText("");
    setShowText(false);
    setAudioUrls((prev) => {
      prev.forEach((url) => URL.revokeObjectURL(url));
      return [];
    });
    setChunkIndex(0);
    setTotalChunks(0);
    setStage("extracting");

    try {
      const compressed = await compressImage(file);
      const formData = new FormData();
      formData.append("file", compressed, "page.jpg");

      const extractRes = await fetch("/api/extract", {
        method: "POST",
        headers: getAuthHeaders(),
        body: formData,
      });

      if (runId !== scanRunIdRef.current) return;

      if (extractRes.status === 401) {
        localStorage.removeItem(PIN_STORAGE_KEY);
        setPin("");
        setPinRequired(true);
        setStage("error");
        setErrorMessage("Family PIN required. Please enter the PIN to continue.");
        return;
      }

      if (!extractRes.ok) {
        const err = await extractRes.json().catch(() => ({}));
        throw new Error(err.detail || "Could not read this page.");
      }

      const { text } = (await extractRes.json()) as { text: string };
      const cleaned = (text || "").trim();
      if (!cleaned) {
        setStage("empty");
        return;
      }

      setExtractedText(cleaned);
      setStage("speaking");

      const chunks = splitIntoSpeechChunks(cleaned);
      setTotalChunks(chunks.length);

      const firstUrl = await fetchSpeechUrl(chunks[0]);
      if (runId !== scanRunIdRef.current) {
        URL.revokeObjectURL(firstUrl);
        return;
      }

      shouldAutoPlayRef.current = true;
      setAudioUrls([firstUrl]);
      setChunkIndex(0);
      setCurrentTime(0);
      setDuration(0);
      setStage("ready");

      // Pre-synthesize remaining chunks in the background so playback stays seamless.
      for (let i = 1; i < chunks.length; i++) {
        const nextUrl = await fetchSpeechUrl(chunks[i]);
        if (runId !== scanRunIdRef.current) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        setAudioUrls((prev) => [...prev, nextUrl]);
      }
    } catch (err) {
      if (runId !== scanRunIdRef.current) return;
      setStage("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Something went wrong."
      );
    }
  }

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.playbackRate = playbackRate;
      audio.play().catch(() => setIsPlaying(false));
    } else {
      audio.pause();
    }
  }

  function replay() {
    if (chunkIndex !== 0) {
      shouldAutoPlayRef.current = true;
      setChunkIndex(0);
      setCurrentTime(0);
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    audio.playbackRate = playbackRate;
    audio.play().catch(() => setIsPlaying(false));
  }

  function handleAudioEnded() {
    if (chunkIndex + 1 < audioUrls.length) {
      shouldAutoPlayRef.current = true;
      setChunkIndex((idx) => idx + 1);
      setCurrentTime(0);
    } else {
      setIsPlaying(false);
    }
  }

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const audio = audioRef.current;
    if (!audio) return;
    const nextTime = Number(e.target.value);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function toggleSpeed() {
    setPlaybackRate((prev) => (prev === 1 ? 0.85 : 1));
  }

  const isBusy = stage === "extracting" || stage === "speaking";

  if (pinRequired && !pin) {
    return (
      <main className="app">
        <header className="header">
          <h1>Renconte</h1>
          <p className="subtitle">Enter your family PIN to start reading</p>
        </header>
        <form className="card pin-form" onSubmit={handleSavePin}>
          <input
            type="password"
            inputMode="numeric"
            placeholder="Family PIN"
            value={pinDraft}
            onChange={(e) => setPinDraft(e.target.value)}
            className="pin-input"
            autoFocus
          />
          <button type="submit" className="btn-primary">
            Unlock
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="header">
        <h1>Renconte</h1>
        <p className="subtitle">Snap a French book page &amp; listen</p>
      </header>

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileSelected}
        hidden
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelected}
        hidden
      />

      <section className="actions">
        <button
          type="button"
          className="btn-primary btn-scan"
          disabled={isBusy}
          onClick={() => cameraInputRef.current?.click()}
        >
          {isBusy
            ? stage === "extracting"
              ? "Reading page..."
              : "Generating French voice..."
            : audioUrl
              ? "Scan Next Page"
              : "Scan Page"}
        </button>

        {!isBusy && (
          <button
            type="button"
            className="btn-link"
            onClick={() => galleryInputRef.current?.click()}
          >
            or choose photo from library
          </button>
        )}
      </section>

      {isBusy && (
        <section className="card status-card" aria-live="polite">
          <div className="spinner" />
          <p>
            {stage === "extracting"
              ? "Reading the French text on the page..."
              : "Preparing warm French narration..."}
          </p>
        </section>
      )}

      {stage === "empty" && (
        <section className="card status-card" aria-live="polite">
          <p>No story text found on this page — try scanning the next page.</p>
        </section>
      )}

      {stage === "error" && errorMessage && (
        <section className="card error-card" role="alert">
          <p>{errorMessage}</p>
        </section>
      )}

      {audioUrl && (
        <section className="card player-card">
          <audio
            ref={audioRef}
            src={audioUrl}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onEnded={handleAudioEnded}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          />

          <div className="player-controls">
            <button
              type="button"
              className="btn-icon"
              onClick={replay}
              aria-label="Replay"
            >
              ↺
            </button>

            <button
              type="button"
              className="btn-play"
              onClick={togglePlayPause}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? "❚❚" : "▶"}
            </button>

            <button
              type="button"
              className="btn-speed"
              onClick={toggleSpeed}
              aria-label="Toggle reading speed"
            >
              {playbackRate}x
            </button>
          </div>

          <div className="scrubber">
            <span>{formatTime(currentTime)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              aria-label="Audio progress"
            />
            <span>{formatTime(duration)}</span>
          </div>

          {totalChunks > 1 && (
            <p className="subtitle" style={{ textAlign: "center", margin: 0 }}>
              Part {chunkIndex + 1} of {totalChunks}
            </p>
          )}

          {extractedText && (
            <div className="text-drawer">
              <button
                type="button"
                className="btn-link"
                onClick={() => setShowText((v) => !v)}
              >
                {showText ? "Hide text" : "Show text"}
              </button>
              {showText && <p className="extracted-text">{extractedText}</p>}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
