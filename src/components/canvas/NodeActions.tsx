import type { CanvasNode } from "../../types/canvas";

/**
 * The node mini-menu: download, save, prompt, delete.
 *
 * Lives in its own file because it now has two homes — the floating toolbar
 * under a selected canvas node, and the full-size preview modal (which is
 * where you actually decide you want to keep something). The buttons keep the
 * canvas's own class names in both places: the glass toolbar's styling already
 * reads correctly on the modal's dark cover, and a second visual language for
 * the same five buttons would be the bug, not the saving.
 *
 * Every action is optional and a button only renders when its handler is
 * given, so a surface that can't do something (deleting from the gallery, with
 * no canvas undo stack in reach) simply doesn't offer it.
 */
export type NodeActionHandlers = {
  onDownload?: (node: CanvasNode) => void | Promise<void>;
  onSaveToLibrary?: (node: CanvasNode) => Promise<{ ok: boolean }>;
  onOpenFullscreen?: (node: CanvasNode) => void;
  onSavePrompt?: (node: CanvasNode) => Promise<{ ok: boolean }>;
  onReusePrompt?: (node: CanvasNode) => void;
  onDelete?: (node: CanvasNode) => void;
};

/** Flash the button as saved, and back to normal — or to error and back. */
function flash(btn: HTMLButtonElement, run: Promise<{ ok: boolean }>) {
  if (btn.hasAttribute("disabled")) return;
  btn.classList.add("freeform-canvas__toolbar-btn--saved");
  btn.setAttribute("disabled", "true");
  run.then((result) => {
    if (!result.ok) {
      btn.classList.remove("freeform-canvas__toolbar-btn--saved");
      btn.classList.add("freeform-canvas__toolbar-btn--error");
    }
    setTimeout(() => {
      btn.classList.remove("freeform-canvas__toolbar-btn--saved");
      btn.classList.remove("freeform-canvas__toolbar-btn--error");
      btn.removeAttribute("disabled");
    }, result.ok ? 1500 : 2000);
  });
}

export function NodeActions({ node, ...on }: { node: CanvasNode } & NodeActionHandlers) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <>
      {on.onDownload && (
        <button
          type="button"
          className="freeform-canvas__toolbar-btn"
          title="Download"
          aria-label="Download"
          onClick={async (e) => { stop(e); await on.onDownload!(node); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </button>
      )}
      {on.onSaveToLibrary && (
        <button
          type="button"
          className="freeform-canvas__toolbar-btn"
          title="Save to library"
          aria-label="Save to library"
          onClick={(e) => { stop(e); flash(e.currentTarget, on.onSaveToLibrary!(node)); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      )}
      {on.onOpenFullscreen && (
        <button
          type="button"
          className="freeform-canvas__toolbar-btn"
          title="Fullscreen"
          aria-label="Fullscreen"
          onClick={(e) => { stop(e); on.onOpenFullscreen!(node); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      )}
      {on.onSavePrompt && node.label && (
        <button
          type="button"
          className="freeform-canvas__toolbar-btn"
          title="Save prompt"
          aria-label="Save prompt"
          onClick={(e) => { stop(e); flash(e.currentTarget, on.onSavePrompt!(node)); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}
      {on.onReusePrompt && node.label && (
        <button
          type="button"
          className="freeform-canvas__toolbar-btn"
          title="Reuse prompt"
          aria-label="Reuse prompt"
          onClick={(e) => { stop(e); on.onReusePrompt!(node); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" /><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
          </svg>
        </button>
      )}
      {on.onDelete && (
        <button
          type="button"
          className="freeform-canvas__toolbar-btn freeform-canvas__toolbar-btn--danger"
          title="Delete"
          aria-label="Delete"
          onClick={(e) => { stop(e); on.onDelete!(node); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          </svg>
        </button>
      )}
    </>
  );
}
