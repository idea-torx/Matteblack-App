import { useCreditsContext } from "../contexts/CreditsContext";

type CreditBudgetResult = {
  remainingGenerations: number;
  unlimited: boolean;
};

export function useCreditBudget(totalCost: number, quantity: number = 1): CreditBudgetResult {
  const { balance, unlimited } = useCreditsContext();

  const safeQuantity = Math.max(1, quantity);
  const perUnitCost = totalCost / safeQuantity;

  if (perUnitCost <= 0) {
    return { remainingGenerations: 0, unlimited: false };
  }

  if (unlimited) {
    return { remainingGenerations: 0, unlimited: true };
  }

  if (balance < perUnitCost) {
    return { remainingGenerations: 0, unlimited: false };
  }

  return {
    remainingGenerations: Math.floor(balance / perUnitCost),
    unlimited: false,
  };
}
