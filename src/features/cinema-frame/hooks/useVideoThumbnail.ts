import { useState, useEffect, useRef } from "react";

const STORAGE_KEY_PREFIX = "vid_thumb_";
const SEEK_TARGETS = [0, 0.1, 0.5, 1];
const MAX_RETRIES = 3;
const RETRY_DELAYS = [200, 500, 1000];
const THUMB_HEIGHT = 40;
const EXTRACT_TIMEOUT_MS = 10000;
const SEEK_TIMEOUT_MS = 3000;

const memoryCache = new Map<string, string>();

type InflightEntry = {
  promise: Promise<string>;
  controller: AbortController;
  subscribers: number;
};
const inflightRequests = new Map<string, InflightEntry>();

function getProxiedUrl(src: string): string {
  return `/api/media-proxy?url=${encodeURIComponent(src)}`;
}

function isProxied(src: string): boolean {
  return src.startsWith("/api/media-proxy");
}

function getAlternateUrl(src: string): string {
  if (!isProxied(src)) return getProxiedUrl(src);
  try {
    const raw = new URL(src, location.origin).searchParams.get("url");
    return raw || src;
  } catch {
    return src;
  }
}

function isBlankFrame(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  const sampleStep = Math.max(1, Math.floor(data.length / 4 / 200)) * 4;
  let total = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += sampleStep) {
    total += data[i] + data[i + 1] + data[i + 2];
    count++;
  }
  return count > 0 && total / count < 3;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function extractFrame(src: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;

    let seekIndex = 0;
    let resolved = false;
    let seekTimer: ReturnType<typeof setTimeout> | null = null;

    const globalTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        signal.removeEventListener("abort", onAbort);
        cleanup();
        reject(new Error("Extraction timeout"));
      }
    }, EXTRACT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(globalTimeout);
      if (seekTimer) clearTimeout(seekTimer);
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.src = "";
      video.load();
    };

    const onAbort = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const startSeekWatchdog = () => {
      if (seekTimer) clearTimeout(seekTimer);
      seekTimer = setTimeout(() => {
        if (resolved) return;
        if (seekIndex < SEEK_TARGETS.length - 1) {
          seekIndex++;
          video.currentTime = Math.min(SEEK_TARGETS[seekIndex], video.duration || 999);
          startSeekWatchdog();
        } else {
          resolved = true;
          signal.removeEventListener("abort", onAbort);
          cleanup();
          reject(new Error("All seek targets stalled"));
        }
      }, SEEK_TIMEOUT_MS);
    };

    const tryDraw = () => {
      if (seekTimer) clearTimeout(seekTimer);
      try {
        const aspect = video.videoWidth / video.videoHeight;
        const w = Math.round(THUMB_HEIGHT * aspect) || THUMB_HEIGHT;
        const h = THUMB_HEIGHT;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d ctx");
        ctx.drawImage(video, 0, 0, w, h);

        if (isBlankFrame(ctx, w, h) && seekIndex < SEEK_TARGETS.length - 1) {
          seekIndex++;
          video.currentTime = Math.min(SEEK_TARGETS[seekIndex], video.duration || 999);
          startSeekWatchdog();
          return;
        }

        const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
        resolved = true;
        signal.removeEventListener("abort", onAbort);
        cleanup();
        resolve(dataUrl);
      } catch (err) {
        resolved = true;
        signal.removeEventListener("abort", onAbort);
        cleanup();
        reject(err);
      }
    };

    video.onseeked = () => {
      if (resolved) return;
      tryDraw();
    };

    video.onloadeddata = () => {
      if (resolved) return;
      video.currentTime = SEEK_TARGETS[seekIndex];
      startSeekWatchdog();
    };

    video.onerror = () => {
      if (resolved) return;
      resolved = true;
      signal.removeEventListener("abort", onAbort);
      cleanup();
      reject(new Error("Video load error"));
    };

    video.src = src;
    video.load();
  });
}

async function extractWithRetries(originalSrc: string, signal: AbortSignal): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const src = attempt === 0 ? originalSrc : (attempt === 1 ? getAlternateUrl(originalSrc) : originalSrc);

    try {
      return await extractFrame(src, signal);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      lastError = err;
      if (attempt < MAX_RETRIES - 1) {
        await abortableSleep(RETRY_DELAYS[attempt], signal);
      }
    }
  }
  throw lastError;
}

function subscribe(src: string): { promise: Promise<string>; unsubscribe: () => void } {
  const existing = inflightRequests.get(src);
  if (existing) {
    existing.subscribers++;
    return {
      promise: existing.promise,
      unsubscribe: () => {
        existing.subscribers--;
        if (existing.subscribers <= 0) {
          existing.controller.abort();
          inflightRequests.delete(src);
        }
      },
    };
  }

  const controller = new AbortController();
  const promise = extractWithRetries(src, controller.signal).then(
    (dataUrl) => {
      inflightRequests.delete(src);
      return dataUrl;
    },
    (err) => {
      inflightRequests.delete(src);
      throw err;
    }
  );

  const entry: InflightEntry = { promise, controller, subscribers: 1 };
  inflightRequests.set(src, entry);

  return {
    promise,
    unsubscribe: () => {
      entry.subscribers--;
      if (entry.subscribers <= 0) {
        entry.controller.abort();
        inflightRequests.delete(src);
      }
    },
  };
}

function lookupCache(src: string): string | null {
  const cached = memoryCache.get(src);
  if (cached) return cached;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY_PREFIX + src);
    if (stored) {
      memoryCache.set(src, stored);
      return stored;
    }
  } catch {}
  return null;
}

export function useVideoThumbnail(src: string | undefined): string | null {
  const [thumbnail, setThumbnail] = useState<string | null>(() => {
    if (!src) return null;
    return lookupCache(src);
  });

  const srcRef = useRef(src);
  srcRef.current = src;

  useEffect(() => {
    if (!src) {
      setThumbnail(null);
      return;
    }

    const cached = lookupCache(src);
    if (cached) {
      setThumbnail(cached);
      return;
    }

    setThumbnail(null);

    const { promise, unsubscribe } = subscribe(src);

    let cancelled = false;

    promise
      .then((dataUrl) => {
        if (cancelled || srcRef.current !== src) return;
        memoryCache.set(src, dataUrl);
        try { sessionStorage.setItem(STORAGE_KEY_PREFIX + src, dataUrl); } catch {}
        setThumbnail(dataUrl);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [src]);

  return thumbnail;
}
