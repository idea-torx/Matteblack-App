import { useState, useEffect } from 'react';

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    if (mql.addEventListener) {
      mql.addEventListener('change', handler);
    } else {
      mql.addListener(handler);
    }
    return () => {
      if (mql.removeEventListener) {
        mql.removeEventListener('change', handler);
      } else {
        mql.removeListener(handler);
      }
    };
  }, []);

  return isMobile;
}
