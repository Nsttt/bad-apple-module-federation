import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import './App.css';
import { ensureRemote, loadRemoteModule } from './mfRuntime';

type FrameModule = {
  mount: (target: HTMLElement) => void;
  unmount?: (target: HTMLElement) => void;
};

type RuntimeConfig = {
  frameCount?: number;
  fps?: number;
  baseUrl?: string;
  remoteTemplate?: string;
  frameWidth?: number;
  frameHeight?: number;
  audioUrl?: string;
  audioOffsetSec?: number;
};

const runtimeConfig =
  (globalThis as typeof globalThis & { __BAD_APPLE__?: RuntimeConfig })
    .__BAD_APPLE__ ?? {};

const getEnvString = (key: string) => {
  // Rsbuild exposes env via import.meta.env (rspack define), but in some
  // deployments `process.env` may also be injected. Avoid hard dependency on
  // `process` to keep browser bundles clean.
  const metaEnv = (import.meta as unknown as { env?: Record<string, unknown> })
    .env;
  const metaVal = metaEnv?.[key];
  if (typeof metaVal === 'string' && metaVal.length) return metaVal;

  const procEnv = (globalThis as unknown as { process?: { env?: any } }).process
    ?.env;
  const procVal = procEnv?.[key];
  if (typeof procVal === 'string' && procVal.length) return procVal;

  return '';
};

const frameCount = Number(runtimeConfig.frameCount ?? 120);
const fps = Number(runtimeConfig.fps ?? 24);
const framesBaseUrl =
  runtimeConfig.baseUrl ??
  (getEnvString('ZE_PUBLIC_FRAMES_BASE_URL') || 'http://localhost:4173');
const remoteTemplate =
  runtimeConfig.remoteTemplate ??
  (getEnvString('ZE_PUBLIC_FRAME_REMOTE_TEMPLATE') || '');
const frameWidth = Number(runtimeConfig.frameWidth ?? 320);
const frameHeight = Number(runtimeConfig.frameHeight ?? 240);
const audioUrl = runtimeConfig.audioUrl ?? '';
const initialAudioOffsetSec = Number(runtimeConfig.audioOffsetSec ?? 0);

const frameDuration = 1000 / fps;
const padFrame = (value: number) => String(value).padStart(4, '0');

const resolveRemoteUrl = (frameId: string, bust: number) => {
  const frameDir = `frame-${frameId}`;
  const template = remoteTemplate.trim();
  if (template) {
    const url = template
      .replaceAll('{frameId}', frameId)
      .replaceAll('{frameDir}', frameDir);
    const join = url.includes('?') ? '&' : '?';
    return `${url}${join}v=${bust}`;
  }
  return `${framesBaseUrl.replace(/\/$/, '')}/${frameDir}/mf-manifest.json?v=${bust}`;
};

const App = () => {
  const stageRef = useRef<HTMLDivElement>(null);
  const stageShellRef = useRef<HTMLElement>(null);
  const controlsRef = useRef<HTMLElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const frameIndexRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const perfStartRef = useRef(0);
  const perfStartFrameRef = useRef(0);
  const audioOffsetRef = useRef(initialAudioOffsetSec);
  const loadingRef = useRef(false);
  const currentModuleRef = useRef<FrameModule | null>(null);
  const hasMountedRef = useRef(false);
  const manifestBustRef = useRef(Date.now());

  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [volume, setVolume] = useState(0.85);

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--frame-width',
      `${frameWidth}px`,
    );
    document.documentElement.style.setProperty(
      '--frame-height',
      `${frameHeight}px`,
    );
  }, [frameHeight, frameWidth]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = Math.max(0, Math.min(1, volume));
  }, [volume]);

  useEffect(() => {
    const shell = stageShellRef.current;
    if (!shell) return;

    const updateScale = () => {
      const w = shell.clientWidth;
      const h = shell.clientHeight;

      // Use nearly all of the viewport. Only reserve space for the bottom
      // controls overlay so the video can scale up.
      const padX = 12;
      const padY = 12;
      const sx = (w - padX * 2) / frameWidth;
      // Let the video scale behind the overlay; keeps it as large as possible.
      const sy = (h - padY * 2) / frameHeight;
      const raw = Math.max(0.1, Math.min(32, Math.min(sx, sy)));

      // Fix thin "seam" lines that can appear when scaling huge box-shadow
      // layers (our pixels). Integer upscales are the most reliable fix.
      // Use ceil so it "fills" more aggressively (may crop slightly).
      const scale = raw >= 1 ? Math.ceil(raw) : raw;

      document.documentElement.style.setProperty(
        '--stage-scale',
        scale.toFixed(4),
      );
    };

    updateScale();
    const ro = new ResizeObserver(updateScale);
    ro.observe(shell);
    window.addEventListener('resize', updateScale);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', updateScale);
    };
  }, []);

  const renderFrame = async (index: number) => {
    if (!stageRef.current || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError('');

    const frameId = padFrame(index + 1);
    const scope = `frame_${frameId}`;
    const remoteUrl = resolveRemoteUrl(frameId, manifestBustRef.current);

    try {
      ensureRemote({ name: scope, entry: remoteUrl });
      const mod = await loadRemoteModule<FrameModule>(`${scope}/Frame`);

      if (currentModuleRef.current?.unmount) {
        currentModuleRef.current.unmount(stageRef.current);
      }

      mod.mount(stageRef.current);
      currentModuleRef.current = mod;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  const getDesiredFrameIndex = (now: number) => {
    const a = audioRef.current;
    const offset = audioOffsetRef.current;

    // If audio is active, drive frames from audio time.
    if (a && audioUrl && !a.paused && isFinite(a.currentTime)) {
      const frameTime = Math.max(0, a.currentTime + offset);
      return Math.floor(frameTime * fps) % frameCount;
    }

    // Fallback clock: performance.now() from when playback started.
    const elapsedSec = Math.max(0, (now - perfStartRef.current) / 1000);
    const frameTime = perfStartFrameRef.current / fps + elapsedSec;
    return Math.floor(frameTime * fps) % frameCount;
  };

  const tick = (now: number) => {
    if (!playing) return;

    // Keep work bounded: only attempt a render when the target frame changed.
    if (now - lastTickRef.current >= frameDuration) {
      lastTickRef.current = now;
      const desired = getDesiredFrameIndex(now);
      if (desired !== frameIndexRef.current) {
        frameIndexRef.current = desired;
        setFrameIndex(desired);
        if (!loadingRef.current) renderFrame(desired);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  };

  const play = async () => {
    if (playing) return;
    setPlaying(true);
    const now = performance.now();
    lastTickRef.current = now;
    perfStartRef.current = now;
    perfStartFrameRef.current = frameIndexRef.current;

    const a = audioRef.current;
    if (a && audioUrl) {
      a.muted = muted;
      try {
        await a.play();
      } catch (err) {
        setError(
          `audio play blocked: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const pause = () => {
    setPlaying(false);
    const a = audioRef.current;
    if (a && audioUrl) a.pause();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  };

  const stepFrame = () => {
    pause();
    const nextIndex = (frameIndexRef.current + 1) % frameCount;
    frameIndexRef.current = nextIndex;
    setFrameIndex(nextIndex);
    const a = audioRef.current;
    if (a && audioUrl) {
      a.currentTime = Math.max(0, nextIndex / fps - audioOffsetRef.current);
    }
    renderFrame(nextIndex);
  };

  useEffect(() => {
    if (hasMountedRef.current) return;
    hasMountedRef.current = true;
    renderFrame(0);
  }, []);

  useEffect(() => {
    if (!playing && rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    if (playing) {
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing]);

  const onScrub = (event: ChangeEvent<HTMLInputElement>) => {
    pause();
    const value = Number(event.target.value || 1) - 1;
    const nextIndex = Math.max(0, Math.min(frameCount - 1, value));
    frameIndexRef.current = nextIndex;
    setFrameIndex(nextIndex);
    const a = audioRef.current;
    if (a && audioUrl) {
      a.currentTime = Math.max(0, nextIndex / fps - audioOffsetRef.current);
    }
    renderFrame(nextIndex);
  };

  return (
    <div className="app-shell">
      {audioUrl ? (
        <audio
          className="audio-el"
          ref={audioRef}
          src={audioUrl}
          preload="auto"
          muted={muted}
          onCanPlay={() => setAudioReady(true)}
          onError={() => setError(`audio load failed: ${audioUrl}`)}
        />
      ) : null}

      <main className="stage" ref={stageShellRef}>
        <div className="frame-stage" ref={stageRef} />
        {error ? <div className="error-banner">{error}</div> : null}
      </main>

      {/* ref used to reserve scale room for overlay */}
      <footer className="controls-bar" ref={controlsRef}>
        <div className="controls-row">
          <button onClick={playing ? pause : play}>
            {playing ? 'Pause' : 'Play'}
          </button>
          {audioUrl ? (
            <button className="ghost" onClick={() => setMuted((v) => !v)}>
              {muted ? 'Unmute' : 'Mute'}
            </button>
          ) : null}
          <button className="ghost" onClick={stepFrame}>
            Step
          </button>
          <div className="status-mini">
            <span>{playing ? `${fps}fps` : 'Paused'}</span>
            <span>{loading ? 'Loading' : 'Ready'}</span>
            {audioUrl ? (
              <span>{audioReady ? 'Audio' : 'Audio...'}</span>
            ) : null}
          </div>
        </div>

        <div className="controls-row">
          <div className="scrub">
            <input
              type="range"
              min={1}
              max={frameCount}
              value={frameIndex + 1}
              onChange={onScrub}
            />
            <div className="scrub-meta">
              {padFrame(frameIndex + 1)} / {padFrame(frameCount)}
            </div>
          </div>

          {audioUrl ? (
            <label className="volume">
              <div className="volume-label">Vol</div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
              />
              <div className="volume-meta">{Math.round(volume * 100)}%</div>
            </label>
          ) : null}

          <div className="meta">
            {frameWidth}x{frameHeight}
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
