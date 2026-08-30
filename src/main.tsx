import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './contexts/AuthContext'
import { CreditsProvider } from './contexts/CreditsContext'
import { WorkspaceProvider } from './contexts/WorkspaceContext'
import { VerifyEmailPage } from './components/VerifyEmailPage'
import { InvitePage } from './components/InvitePage'
import { SharePage } from './components/SharePage'
import { PaymentResult } from './components/PaymentResult'
import { MobileGate } from './components/MobileGate'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useIsMobile } from './hooks/useIsMobile'
import { MobileChatShell } from './components/MobileChatShell'
import './index.css'
import App from './App.tsx'
import { applyTheme, getStoredTheme } from './theme'
import { isDesktopApp } from './desktop'

// Mark the desktop app so the layout can reserve space for the frameless
// window's title bar strip (--titlebar-h). The web build keeps 0.
// macOS draws its traffic lights top-LEFT instead of a top-RIGHT overlay, so it
// reserves that space on the other side of the window (see html.is-mac in
// index.css). Gated on isDesktopApp() so a Mac *browser* is unaffected.
if (isDesktopApp()) {
  document.documentElement.classList.add('is-desktop')
  if (navigator.userAgent.includes('Mac')) document.documentElement.classList.add('is-mac')
}

// Apply the stored theme (dark by default) before React renders.
//
// This MUST live in the bundle, not in the inline <script> in index.html: the
// Electron renderer's CSP has no 'unsafe-inline' in script-src, so that inline
// bootstrap is blocked in the desktop app and `data-theme` would never be set —
// leaving the shell on the dark base CSS but the agent panel on its light
// "paper" base rule (a dark app with a light chat panel). The inline script
// still runs on the web build; this makes the desktop app correct too.
applyTheme(getStoredTheme())

const StyleGuidePage = import.meta.env.DEV
  ? lazy(() => import('./components/StyleGuidePage').then(m => ({ default: m.StyleGuidePage })))
  : null;

function ChatRoute() {
  const isMobile = useIsMobile();
  return (
    <WorkspaceProvider>
      <CreditsProvider>
        {isMobile ? <MobileChatShell /> : <App />}
      </CreditsProvider>
    </WorkspaceProvider>
  );
}

function Root() {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  if (path.startsWith("/auth/")) {
    return null;
  }

  if (path === "/verify-email") {
    const token = params.get("token");
    if (token) {
      return <MobileGate><VerifyEmailPage token={token} /></MobileGate>;
    }
  }

  if (path === "/invite") {
    const token = params.get("token");
    if (token) {
      return <MobileGate><InvitePage token={token} /></MobileGate>;
    }
  }

  if (path.startsWith("/share/")) {
    const token = decodeURIComponent(path.slice("/share/".length));
    if (token) {
      return <MobileGate><SharePage token={token} /></MobileGate>;
    }
  }

  if (path === "/payment/success") {
    return (
      <MobileGate>
        <WorkspaceProvider>
          <CreditsProvider>
            <PaymentResult type="success" />
          </CreditsProvider>
        </WorkspaceProvider>
      </MobileGate>
    );
  }

  if (path === "/payment/canceled") {
    return (
      <MobileGate>
        <WorkspaceProvider>
          <CreditsProvider>
            <PaymentResult type="canceled" />
          </CreditsProvider>
        </WorkspaceProvider>
      </MobileGate>
    );
  }

  const inviteRedirect = localStorage.getItem("invite_redirect");
  if (inviteRedirect) {
    localStorage.removeItem("invite_redirect");
    window.location.href = inviteRedirect;
    return null;
  }

  return <ChatRoute />;
}

function AppShell() {
  if (import.meta.env.DEV && window.location.pathname === "/dev/style-guide" && StyleGuidePage) {
    return (
      <MobileGate>
        <Suspense fallback={<div style={{ background: "#0c0c0e", minHeight: "100vh" }} />}>
          <StyleGuidePage />
        </Suspense>
      </MobileGate>
    );
  }

  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary what="The app" reloadOnly>
      <AppShell />
    </ErrorBoundary>
  </StrictMode>,
)
