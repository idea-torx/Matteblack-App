import { useEffect, useState } from "react";

const STORAGE_KEY = "show-generate-button-cost";
const EVENT_NAME = "show-generate-cost-changed";

/**
 * Defaults to ON. In the cloud build this hid an abstract credit number most
 * users didn't want; here the pill shows fal.ai's actual price in USD against
 * the user's own key, so it's real spend and should be visible unless they
 * explicitly turn it off.
 */
function read(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

export function getShowGenerateCost(): boolean {
  return read();
}

export function setShowGenerateCost(enabled: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: enabled }));
  } catch {}
}

export function useShowGenerateCost(): boolean {
  const [value, setValue] = useState<boolean>(read);

  useEffect(() => {
    const onCustom = () => setValue(read());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setValue(read());
    };
    window.addEventListener(EVENT_NAME, onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT_NAME, onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return value;
}
