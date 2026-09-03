import { useEffect, useRef, useState, type FocusEvent as ReactFocusEvent } from "react";
import type { DialogTimeoutSeconds } from "../shared/protocol/snapshots";
import { timeoutParts, timeoutUnitSeconds, type TimeoutUnit } from "../shared/runtime-policy-format";

export function RuntimePolicyTimeoutControl({
  label,
  description,
  value,
  searchTarget,
  inherited = false,
  inheritedFrom,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  description?: string;
  value: DialogTimeoutSeconds;
  searchTarget?: string;
  inherited?: boolean;
  inheritedFrom?: string;
  disabled: boolean;
  onChange(value: DialogTimeoutSeconds): void;
  onReset?: () => void;
}) {
  const initial = timeoutParts(value ?? 60);
  const [amount, setAmount] = useState(String(initial.amount));
  const [unit, setUnit] = useState<TimeoutUnit>(initial.unit);
  const [error, setError] = useState("");
  const pendingValue = useRef<DialogTimeoutSeconds | undefined>(undefined);
  const lastFiniteValue = useRef(value ?? 60);

  useEffect(() => {
    const next = timeoutParts(value ?? lastFiniteValue.current);
    setAmount(String(next.amount));
    setUnit(next.unit);
    setError("");
    pendingValue.current = undefined;
    if (value !== null) lastFiniteValue.current = value;
  }, [value]);

  const changeValue = (next: DialogTimeoutSeconds) => {
    if (disabled || next === value || next === pendingValue.current) return;
    pendingValue.current = next;
    onChange(next);
  };

  const commit = (nextAmount = amount, nextUnit = unit) => {
    if (disabled) return;
    const seconds = Number(nextAmount) * timeoutUnitSeconds[nextUnit];
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 86_400) {
      setError("Enter a timeout between 15 seconds and 24 hours.");
      return;
    }
    setError("");
    changeValue(seconds);
  };

  const onControlsBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (value !== null) commit();
  };

  return (
    <div className="policy-timeout" data-override={!inherited} data-settings-search-target={searchTarget}>
      <div className="policy-label-row">
        <span className="policy-timeout-copy">
          <span>{label}</span>
          {description && <small>{description}</small>}
        </span>
        <span className="policy-field-state">
          {inherited && inheritedFrom && <small>From {inheritedFrom}</small>}
          {inherited ? (
            <button className="text-button" type="button" disabled={disabled} onClick={() => onChange(value)}>
              Override
            </button>
          ) : (
            onReset && (
              <button className="text-button" type="button" disabled={disabled} onClick={onReset}>
                Use {inheritedFrom}
              </button>
            )
          )}
        </span>
      </div>
      <div className="policy-timeout-controls" onBlur={onControlsBlur}>
        {value === null ? (
          <span className="policy-timeout-never">Never</span>
        ) : (
          <>
            <input
              type="number"
              min={unit === "seconds" ? 15 : 1}
              max={unit === "hours" ? 24 : unit === "minutes" ? 1_440 : 86_400}
              step="1"
              value={amount}
              disabled={disabled}
              aria-label={`${label} duration`}
              onChange={event => setAmount(event.target.value)}
              onKeyDown={event => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commit();
              }}
            />
            <select
              value={unit}
              disabled={disabled}
              aria-label={`${label} unit`}
              onChange={event => setUnit(event.target.value as TimeoutUnit)}>
              <option value="seconds">Seconds</option>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
            </select>
          </>
        )}
        <button
          className="text-button"
          type="button"
          disabled={disabled}
          onClick={() => changeValue(value === null ? lastFiniteValue.current : null)}>
          {value === null ? "Use timeout" : "Never"}
        </button>
      </div>
      {error && (
        <small className="policy-timeout-error" role="alert">
          {error}
        </small>
      )}
      <small>Paused while the response tab is visible and focused.</small>
    </div>
  );
}
