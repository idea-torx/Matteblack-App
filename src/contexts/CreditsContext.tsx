import { createContext, useContext, type ReactNode } from "react";
import { useCredits } from "../hooks/useCredits";

type CreditsContextValue = {
  balance: number;
  totalReceived: number;
  periodAllotment: number;
  periodUsed: number;
  bonusCredits: number;
  loading: boolean;
  unlimited: boolean;
  isWorkspacePool: boolean;
  refetch: () => void;
  startPolling: () => void;
};

const CreditsContext = createContext<CreditsContextValue | null>(null);

export function CreditsProvider({ children }: { children: ReactNode }) {
  const credits = useCredits();
  return (
    <CreditsContext.Provider value={credits}>
      {children}
    </CreditsContext.Provider>
  );
}

export function useCreditsContext() {
  const ctx = useContext(CreditsContext);
  if (!ctx) throw new Error("useCreditsContext must be used within CreditsProvider");
  return ctx;
}
