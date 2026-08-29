import { useCallback, useEffect, useRef } from "react";

const START_URL = "/sounds/generation-start.mp3";
const COMPLETE_URL = "/sounds/generation-complete.mp3";
const ERROR_URL = "/sounds/generation-error.mp3";
const STORAGE_KEY = "generation-sounds-enabled";

function isSoundEnabled(): boolean {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    return val !== "false";
  } catch {
    return true;
  }
}

export function setSoundEnabled(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {}
}

export function getSoundEnabled(): boolean {
  return isSoundEnabled();
}

export function useGenerationSound() {
  const startRef = useRef<HTMLAudioElement | null>(null);
  const completeRef = useRef<HTMLAudioElement | null>(null);
  const errorRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const start = new Audio(START_URL);
    start.volume = 0.3;
    startRef.current = start;

    const complete = new Audio(COMPLETE_URL);
    complete.volume = 0.3;
    completeRef.current = complete;

    const error = new Audio(ERROR_URL);
    error.volume = 0.3;
    errorRef.current = error;

    return () => {
      [start, complete, error].forEach((a) => {
        a.pause();
        a.src = "";
      });
      startRef.current = null;
      completeRef.current = null;
      errorRef.current = null;
    };
  }, []);

  const play = useCallback((ref: React.RefObject<HTMLAudioElement | null>) => {
    if (!isSoundEnabled()) return;
    const audio = ref.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.play().catch(() => {});
    }
  }, []);

  const playStart = useCallback(() => play(startRef), [play]);
  const playComplete = useCallback(() => play(completeRef), [play]);
  const playError = useCallback(() => play(errorRef), [play]);

  return { playStart, playComplete, playError };
}
