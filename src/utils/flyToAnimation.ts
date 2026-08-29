interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FlyToOptions {
  source: Rect;
  target: Rect;
  thumbnailSrc?: string;
  duration?: number;
  delay?: number;
  onComplete?: () => void;
}

function easeOutQuad(t: number): number {
  return t * (2 - t);
}

export function triggerFlyTo({
  source,
  target,
  thumbnailSrc,
  duration = 350,
  delay = 0,
  onComplete,
}: FlyToOptions) {
  const ghost = document.createElement("div");
  ghost.style.cssText = `
    position: fixed;
    z-index: 99999;
    pointer-events: none;
    left: ${source.x}px;
    top: ${source.y}px;
    width: ${source.width}px;
    height: ${source.height}px;
    opacity: 0.8;
    border-radius: 6px;
    overflow: hidden;
    will-change: transform, opacity;
    transition: none;
  `;

  if (thumbnailSrc) {
    const img = document.createElement("img");
    img.src = thumbnailSrc;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;";
    ghost.appendChild(img);
  } else {
    ghost.style.background = "rgba(120,120,120,0.5)";
  }

  document.body.appendChild(ghost);

  const dx = target.x + target.width / 2 - (source.x + source.width / 2);
  const dy = target.y + target.height / 2 - (source.y + source.height / 2);
  const scaleEnd = Math.min(target.width / source.width, target.height / source.height, 0.3);

  let start: number | null = null;

  function animate(timestamp: number) {
    if (start === null) start = timestamp;
    const elapsed = timestamp - start - delay;
    if (elapsed < 0) {
      requestAnimationFrame(animate);
      return;
    }
    const rawT = Math.min(elapsed / duration, 1);
    const t = easeOutQuad(rawT);

    const curX = dx * t;
    const curY = dy * t - Math.sin(Math.PI * rawT) * Math.min(80, Math.abs(dy) * 0.3);
    const curScale = 1 + (scaleEnd - 1) * t;

    let curOpacity: number;
    if (rawT < 0.5) {
      curOpacity = 0.8 - (rawT / 0.5) * 0.4;
    } else {
      curOpacity = 0.4 - ((rawT - 0.5) / 0.5) * 0.4;
    }

    ghost.style.transform = `translate(${curX}px, ${curY}px) scale(${curScale})`;
    ghost.style.opacity = String(Math.max(0, curOpacity));

    if (rawT < 1) {
      requestAnimationFrame(animate);
    } else {
      ghost.remove();
      onComplete?.();
    }
  }

  requestAnimationFrame(animate);
}

export function pulseLibraryIcon() {
  const tab = document.querySelector("[data-library-tab]") as HTMLElement | null;
  if (!tab) return;
  tab.style.transition = "filter 100ms ease-in";
  tab.style.filter = "brightness(1.15)";
  setTimeout(() => {
    tab.style.transition = "filter 100ms ease-out";
    tab.style.filter = "";
    setTimeout(() => {
      tab.style.transition = "";
    }, 100);
  }, 100);
}

export function highlightNewLibraryItem() {
  const panel = document.querySelector(".lib-panel");
  if (!panel) return;
  const grid = panel.querySelector(".lib-grid");
  if (!grid) return;
  const firstItem = grid.firstElementChild as HTMLElement | null;
  if (!firstItem) return;
  firstItem.style.boxShadow = "0 0 0 2px rgba(59, 130, 246, 0.3)";
  firstItem.style.transition = "box-shadow 800ms ease-out";
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      firstItem.style.boxShadow = "0 0 0 2px rgba(59, 130, 246, 0)";
      setTimeout(() => {
        firstItem.style.boxShadow = "";
        firstItem.style.transition = "";
      }, 800);
    });
  });
}

export function getLibraryTarget(): Rect & { isPanelOpen: boolean } {
  const panel = document.querySelector(".lib-panel");
  if (panel) {
    const grid = panel.querySelector(".lib-grid");
    if (grid) {
      const gridRect = grid.getBoundingClientRect();
      return {
        x: gridRect.left + gridRect.width / 2 - 20,
        y: gridRect.top,
        width: 40,
        height: 40,
        isPanelOpen: true,
      };
    }
    const panelRect = panel.getBoundingClientRect();
    return {
      x: panelRect.left + panelRect.width / 2 - 20,
      y: panelRect.top + 40,
      width: 40,
      height: 40,
      isPanelOpen: true,
    };
  }
  const tab = document.querySelector("[data-library-tab]") as HTMLElement | null;
  if (tab) {
    const rect = tab.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      isPanelOpen: false,
    };
  }
  return { x: 0, y: 60, width: 40, height: 40, isPanelOpen: false };
}

export function triggerLibrarySaveAnimation(
  sourceRects: Rect[],
  thumbnailSrc?: string,
) {
  const target = getLibraryTarget();
  const count = sourceRects.length;
  for (let i = 0; i < count; i++) {
    triggerFlyTo({
      source: sourceRects[i],
      target,
      thumbnailSrc: i === 0 ? thumbnailSrc : undefined,
      duration: 350,
      delay: i * 80,
      onComplete:
        i === count - 1
          ? () => {
              if (target.isPanelOpen) {
                setTimeout(() => highlightNewLibraryItem(), 50);
              } else {
                pulseLibraryIcon();
              }
            }
          : undefined,
    });
  }
}
