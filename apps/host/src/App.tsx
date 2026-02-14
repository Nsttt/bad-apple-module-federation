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
  frameWidth?: number;
  frameHeight?: number;
  audioUrl?: string;
  audioOffsetSec?: number;
};

const runtimeConfig =
  (globalThis as typeof globalThis & { __BAD_APPLE__?: RuntimeConfig })
    .__BAD_APPLE__ ?? {};

const frameCount = Number(runtimeConfig.frameCount ?? 120);
const fps = Number(runtimeConfig.fps ?? 24);
const baseUrl = runtimeConfig.baseUrl ?? 'http://localhost:4173';
const frameWidth = Number(runtimeConfig.frameWidth ?? 320);
const frameHeight = Number(runtimeConfig.frameHeight ?? 240);
const audioUrl = runtimeConfig.audioUrl ?? '';
const initialAudioOffsetSec = Number(runtimeConfig.audioOffsetSec ?? 0);

const frameDuration = 1000 / fps;
const padFrame = (value: number) => String(value).padStart(4, '0');

const App = () => {
  const stageRef = useRef<HTMLDivElement>(null);
  const stageShellRef = useRef<HTMLElement>(null);
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

      // Leave a little breathing room inside the panel.
      const pad = 36;
      const sx = (w - pad) / frameWidth;
      const sy = (h - pad) / frameHeight;
      const scale = Math.max(0.1, Math.min(8, Math.min(sx, sy)));

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
    const remoteUrl = `${baseUrl}/frame-${frameId}/mf-manifest.json?v=${manifestBustRef.current}`;

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
      <div className="app-card">
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
        <header className="app-header">
          <div>
            <div className="eyebrow">Bad Apple / Module Federation</div>
            <h1>Frame Swarm Host</h1>
            <p className="subhead">
              Every frame is a remote. Runtime loads + unloads CSS-only payloads.
            </p>
          </div>
          <div className="status">
            <div>{playing ? `Playing @ ${fps}fps` : 'Paused'}</div>
            <div>{loading ? 'Loading...' : 'Ready'}</div>
            {audioUrl ? (
              <div>{audioReady ? 'Audio: ready' : 'Audio: loading'}</div>
            ) : (
              <div>Audio: off</div>
            )}
          </div>
        </header>

        <section className="panel stage" ref={stageShellRef}>
          <div className="frame-stage" ref={stageRef} />
          {error ? (
            <div className="stage-hud">
              {error ? <div className="error">{error}</div> : null}
            </div>
          ) : null}
        </section>

        <section className="panel controls">
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
          <div className="scrub">
            <input
              type="range"
              min={1}
              max={frameCount}
              value={frameIndex + 1}
              onChange={onScrub}
            />
            <div className="scrub-meta">
              Frame {padFrame(frameIndex + 1)} / {padFrame(frameCount)}
            </div>
          </div>
          {audioUrl ? (
            <label className="volume">
              <div className="volume-label">Volume</div>
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
        </section>
      </div>
    </div>
  );
};

export default App;
