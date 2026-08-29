import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useCreditsContext } from "../contexts/CreditsContext";
import { useWorkspace } from "../contexts/WorkspaceContext";
import { AgentPanel, type AgentPanelHandle, type AgentHandoff } from "./AgentPanel";
import { applyTheme, getStoredTheme } from "../theme";
import logoImg from "@assets/Logo-medium_1776028819541.png";
import logoImgLight from "@assets/Logo-black_1777692939445.png";
import "./MobileChatShell.css";

function CreditChip() {
  const { balance, unlimited, loading } = useCreditsContext();
  if (loading) return <span className="mcs-credits mcs-credits--loading">…</span>;
  if (unlimited) return <span className="mcs-credits" title="Unlimited credits">∞</span>;
  return (
    <span className="mcs-credits" title="Credit balance">
      {Number.isFinite(balance) ? balance.toLocaleString() : 0}
      <span className="mcs-credits-label"> credits</span>
    </span>
  );
}

export function MobileChatShell() {
  const { user, signIn, logout, loading: authLoading } = useAuth();
  const { activeWorkspace } = useWorkspace();
  const isGuest = !user;

  const [menuOpen, setMenuOpen] = useState(false);
  const agentRef = useRef<AgentPanelHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Mobile view always renders in light mode. We apply the theme to the
  // <html> attribute directly (not via setTheme) so the user's stored
  // desktop preference is left untouched and restored on unmount when
  // the viewport grows back to desktop size.
  useEffect(() => {
    applyTheme("light");
    return () => {
      applyTheme(getStoredTheme());
    };
  }, []);

  // Track the iOS virtual keyboard via the VisualViewport API so the
  // sticky composer stays visible above the keyboard when typing on
  // browsers that don't fully honor `interactive-widget=resizes-content`
  // (also set in the viewport meta). We expose the keyboard height as a
  // CSS variable on the shell root, and on every change we also snap the
  // chat list to the bottom so the latest message stays in view as the
  // visible area shrinks (otherwise the bottom of the chat slides out
  // under the keyboard, leaving an empty band above the composer).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let raf = 0;
    // Only re-pin to the bottom when the user was already near the
    // bottom — otherwise scrolling them away from older messages they
    // were reading would be jarring. 80px tolerance accounts for the
    // textarea growth and small overshoot.
    const NEAR_BOTTOM_PX = 80;
    const findList = () =>
      rootRef.current?.querySelector<HTMLElement>(".agent-panel__messages") ?? null;
    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--mcs-kb-offset", `${offset}px`);
      const list = findList();
      if (!list) return;
      const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (distanceFromBottom <= NEAR_BOTTOM_PX) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight;
        });
      }
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      root.style.removeProperty("--mcs-kb-offset");
    };
  }, []);

  // When the user taps into the composer, snap the chat list to the
  // bottom so the just-typed area isn't visually buried by any pending
  // message that drifted off-screen during the resize. Scoped to the
  // shell so we don't react to focus events anywhere else on the page.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || t.tagName !== "TEXTAREA") return;
      requestAnimationFrame(() => {
        const list = root.querySelector<HTMLElement>(".agent-panel__messages");
        if (list) list.scrollTop = list.scrollHeight;
      });
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, []);

  // Lock background scrolling so swiping the chat surface doesn't bounce
  // the document body around (esp. on iOS).
  useEffect(() => {
    const prevHtml = document.documentElement.style.overflow;
    const prevBody = document.body.style.overflow;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
  }, []);

  const handleNewChat = useCallback(() => {
    setMenuOpen(false);
    agentRef.current?.newChat();
  }, []);

  const handleOpenHistory = useCallback(() => {
    setMenuOpen(false);
    agentRef.current?.openHistory();
  }, []);

  const handleSignIn = useCallback(() => {
    setMenuOpen(false);
    signIn();
  }, [signIn]);

  const handleSignOut = useCallback(async () => {
    setMenuOpen(false);
    await logout();
  }, [logout]);

  const handleHandoff = useCallback<(_: AgentHandoff) => void>(() => {
    // No canvas / Make panel exists in the mobile shell — handoff is a
    // no-op here. We surface a hint instead of silently swallowing it.
    if (typeof window !== "undefined") {
      window.alert("Open Fal Forge on a desktop browser to send this prompt to the Make panel.");
    }
  }, []);

  return (
    <div className="mcs-root" ref={rootRef}>
      <header className="mcs-topbar">
        <button
          type="button"
          className="mcs-icon-btn"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        <div className="mcs-topbar-center">
          <img src={logoImg} alt="Fal Forge" className="mcs-logo mcs-logo--dark" />
          <img src={logoImgLight} alt="" aria-hidden="true" className="mcs-logo mcs-logo--light" />
        </div>

        <button
          type="button"
          className="mcs-icon-btn"
          aria-label="New chat"
          onClick={handleNewChat}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
        </button>
      </header>

      <main className="mcs-body">
        <AgentPanel
          ref={agentRef}
          mobileMode
          workspaceId={activeWorkspace?.id || null}
          canvasId={null}
          canvasReferenceImages={[]}
          isGuest={isGuest}
          onClose={() => { /* no-op on mobile, the shell is the only surface */ }}
          onSignInRequest={handleSignIn}
          onHandoffToMake={handleHandoff}
        />
      </main>

      {menuOpen && (
        <>
          <div
            className="mcs-drawer-scrim"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="mcs-drawer" role="dialog" aria-label="Menu">
            <div className="mcs-drawer-header">
              <span className="mcs-drawer-title">Menu</span>
              <button
                type="button"
                className="mcs-icon-btn"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {!isGuest && (
              <div className="mcs-drawer-section">
                <div className="mcs-drawer-meta-label">Signed in as</div>
                <div className="mcs-drawer-meta-value">{user?.email || user?.displayName || "Account"}</div>
                <div className="mcs-drawer-meta-label" style={{ marginTop: 8 }}>Credits</div>
                <div className="mcs-drawer-meta-value"><CreditChip /></div>
              </div>
            )}

            <div className="mcs-drawer-section">
              <button
                type="button"
                className="mcs-drawer-row"
                onClick={handleNewChat}
              >
                New chat
              </button>
              <button
                type="button"
                className="mcs-drawer-row"
                onClick={handleOpenHistory}
                disabled={isGuest}
              >
                Chat history
              </button>
            </div>

            <div className="mcs-drawer-section mcs-drawer-section--bottom">
              {authLoading ? null : isGuest ? (
                <button
                  type="button"
                  className="mcs-drawer-row mcs-drawer-row--primary"
                  onClick={handleSignIn}
                >
                  Sign in
                </button>
              ) : (
                <button
                  type="button"
                  className="mcs-drawer-row mcs-drawer-row--danger"
                  onClick={() => void handleSignOut()}
                >
                  Sign out
                </button>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
