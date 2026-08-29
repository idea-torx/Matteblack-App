import { useShowGenerateCost } from "../hooks/useShowGenerateCost";
import { useFalCost, formatUsd } from "../hooks/useFalCost";
import type { EstimateParams } from "../hooks/useEstimateCost";

type Props = {
  /** Retail credit cost — the fallback when fal has no at-cost rule for the model. */
  cost: number;
  /**
   * The same params object the panel passes to `useEstimateCost`. When present
   * and fal prices the model, the pill shows what fal actually charges in USD
   * instead of credits. This is the local build's whole point: the user pays
   * fal directly with their own key, so a credit number would be fiction.
   */
  params?: EstimateParams | null;
  visible?: boolean;
  // When true, ignore the global "show generate cost" preference and always
  // render the cost pill. Used by panels where the price varies enough
  // (per-second video upscale, etc.) that hiding it leaves the user guessing.
  forceShow?: boolean;
};

export function GenerateButtonCost({ cost, params, visible = true, forceShow = false }: Props) {
  const show = useShowGenerateCost();
  // Hooks must run unconditionally, so resolve the price before any early return.
  const { estimate } = useFalCost(params);

  if ((!show && !forceShow) || !visible) return null;

  if (estimate && estimate.usd > 0) {
    return (
      <span className="rpanel-action-btn-credits" title={`fal cost: ${estimate.basis}`}>
        {/* "~" marks an estimate that can't be exact until fal reports billable
            units — token-billed video, GPU compute-second models. */}
        {estimate.accuracy === "approx" ? "~" : ""}
        {formatUsd(estimate.usd)}
      </span>
    );
  }

  if (!cost || cost <= 0) return null;
  return (
    <span className="rpanel-action-btn-credits">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M14.5 9a3.5 3.5 0 1 0 0 6" />
      </svg>
      {cost}
    </span>
  );
}
