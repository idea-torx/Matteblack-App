import { useAuth } from "../contexts/AuthContext";
import { useCreditsContext } from "../contexts/CreditsContext";

export type GenerateButtonState = "sign-in-required" | "credits-required" | "ready";

export function useGenerateButton(
  _userBalance: number,
  _unlimited: boolean,
  totalCost: number
): {
  state: GenerateButtonState;
  label: (readyLabel: string) => string;
  className: (base: string) => string;
  handleClick: (readyAction: () => void) => void;
} {
  const { user, signIn } = useAuth();
  const { balance, unlimited } = useCreditsContext();

  const state: GenerateButtonState = !user
    ? "sign-in-required"
    : !unlimited && balance < totalCost
      ? "credits-required"
      : "ready";

  const label = (readyLabel: string): string => {
    if (state === "sign-in-required") return "Sign In to Generate";
    if (state === "credits-required") return "Get Credits";
    return readyLabel;
  };

  const className = (base: string): string => {
    if (state === "sign-in-required") return `${base} rpanel-action-btn--signin`;
    if (state === "credits-required") return `${base} rpanel-action-btn--credits`;
    return base;
  };

  const handleClick = (readyAction: () => void) => {
    if (state === "sign-in-required") {
      signIn();
      return;
    }
    if (state === "credits-required") {
      const event = new CustomEvent("open-settings", { detail: { section: "subscription" } });
      window.dispatchEvent(event);
      return;
    }
    readyAction();
  };

  return { state, label, className, handleClick };
}
