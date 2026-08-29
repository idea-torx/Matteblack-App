import React, { useCallback } from "react";

interface NumericInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export default function NumericInput({ onKeyDown, ...props }: NumericInputProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const input = e.currentTarget;
        const currentValue = parseFloat(input.value) || 0;
        const step = parseFloat(String(props.step)) || 1;
        const increment = e.shiftKey ? step * 10 : step;
        const direction = e.key === "ArrowUp" ? 1 : -1;
        let newValue = currentValue + increment * direction;

        const min = props.min !== undefined ? parseFloat(String(props.min)) : undefined;
        const max = props.max !== undefined ? parseFloat(String(props.max)) : undefined;

        if (min !== undefined && !isNaN(min)) newValue = Math.max(min, newValue);
        if (max !== undefined && !isNaN(max)) newValue = Math.min(max, newValue);

        const stepStr = String(step);
        const decimals = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;
        const precision = e.shiftKey ? Math.max(0, decimals - 1) : decimals;
        newValue = parseFloat(newValue.toFixed(precision));

        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        )?.set;

        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(input, String(newValue));
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }

      onKeyDown?.(e);
    },
    [onKeyDown, props.step, props.min, props.max]
  );

  return <input type="number" {...props} onKeyDown={handleKeyDown} />;
}
