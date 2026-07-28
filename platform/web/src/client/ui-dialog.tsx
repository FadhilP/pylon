import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

export function UiDialog({ request }: { request: NonNullable<RuntimeStoreSnapshot["pendingUi"]> }) {
  const payload = request.payload;
  const options = Array.isArray(payload.options) ? payload.options : [];
  const optionValue = (option: unknown, index: number) => {
    const item = typeof option === "object" && option ? option as Record<string, unknown> : {};
    return typeof option === "string" ? option : typeof item.value === "string" ? item.value : String(index);
  };
  const optionLabel = (option: unknown, index: number) => {
    const item = typeof option === "object" && option ? option as Record<string, unknown> : {};
    return typeof option === "string" ? option : typeof item.label === "string" ? item.label : optionValue(option, index);
  };
  const allowOnce = options.findIndex((option, index) =>
    optionLabel(option, index).trim().toLowerCase() === "allow once");
  const [value, setValue] = useState(() =>
    typeof payload.prefill === "string"
      ? payload.prefill
      : allowOnce >= 0 ? optionValue(options[allowOnce], allowOnce) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(() => request.expiresAt ? Math.max(0, Date.parse(request.expiresAt) - Date.now()) : undefined);
  const dialogRef = useRef<HTMLDivElement>(null);
  const actionLock = useRef(false);
  const title = typeof payload.title === "string" ? payload.title : "Input requested";
  const description = typeof payload.message === "string" ? payload.message : typeof payload.label === "string" ? payload.label : "The runtime needs a response.";
  const titleId = `ui-title-${request.requestId}`;
  const descriptionId = `ui-description-${request.requestId}`;
  const expired = remaining !== undefined && remaining <= 0;

  useEffect(() => {
    if (!request.expiresAt) return;
    const update = () => setRemaining(Math.max(0, Date.parse(request.expiresAt!) - Date.now()));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [request.expiresAt]);

  useEffect(() => {
    if (!request.owned) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus], button:not([disabled])")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [request.owned]);

  const respond = async (body: Record<string, unknown>) => {
    if (actionLock.current || expired) return;
    actionLock.current = true; setBusy(true); setError("");
    try { await runtimeStore.answerUi(request, body); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Response was rejected"); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const ownership = async (action: "claim" | "release") => {
    if (actionLock.current || expired) return;
    actionLock.current = true; setBusy(true); setError("");
    try { await runtimeStore.changeUiOwnership(request, action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Ownership change was rejected"); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const submit = () => request.method === "confirm" ? respond({ confirmed: true }) : respond({ value });
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy && !expired) void respond({ cancelled: true }); return; }
    if (event.key === "Enter" && request.method === "input" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); if (!busy && !expired) void submit(); return; }
  };

  if (!request.owned) return <div className="ui-request ui-request-observer" role="status" aria-live="polite">
    <strong>{title}</strong>
    <p>{request.ownershipAvailable ? "Response ownership is available." : "A response is pending in another tab."}</p>
    {request.ownershipAvailable ? <button className="secondary-button" type="button" disabled={busy || expired} onClick={() => void ownership("claim")}>Respond in this tab</button> : <button className="secondary-button" type="button" disabled>Awaiting owner response</button>}
    {error && <p className="ui-request-error" role="alert">{error}</p>}
  </div>;

  return <div ref={dialogRef} className="ui-request ui-request-inline" role={request.method === "confirm" ? "alertdialog" : "dialog"} aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={onKeyDown}>
      <strong id={titleId}>{title}</strong><p id={descriptionId}>{description}</p>
      {request.method === "select" && <div className="ui-request-options" role="listbox" aria-label={title}>
        {options.map((option, index) => {
          const nextValue = optionValue(option, index);
          const label = optionLabel(option, index);
          return <button
            key={nextValue}
            type="button"
            role="option"
            aria-selected={value === nextValue}
            className={value === nextValue ? "is-selected" : ""}
            data-autofocus={index === allowOnce || allowOnce < 0 && index === 0 ? "" : undefined}
            disabled={busy || expired}
            onClick={() => setValue(nextValue)}
          >{label}</button>;
        })}
      </div>}
      {(request.method === "input" || request.method === "editor") && (request.method === "editor" ? <textarea data-autofocus value={value} onChange={(event) => setValue(event.target.value)} disabled={busy || expired} /> : <input data-autofocus value={value} placeholder={typeof payload.placeholder === "string" ? payload.placeholder : undefined} onChange={(event) => setValue(event.target.value)} disabled={busy || expired} />)}
      {remaining !== undefined && <p className="ui-request-expiry" aria-live="polite">{expired ? "Request expired. Waiting for runtime closure." : `Expires in ${Math.ceil(remaining / 1_000)} seconds.`}</p>}
      {error && <p className="ui-request-error" role="alert">{error}</p>}
      <div className="ui-request-actions">
        {request.method === "confirm" ? <button data-autofocus className="primary-button" type="button" disabled={busy || expired} onClick={() => void submit()}>Confirm</button> : <button className="primary-button" type="button" disabled={busy || expired || (request.method === "select" && !value)} onClick={() => void submit()}>Submit</button>}
        <button className="secondary-button" type="button" disabled={busy || expired} onClick={() => void respond({ cancelled: true })}>Cancel</button>
        <button className="text-button ui-transfer" type="button" disabled={busy || expired} onClick={() => void ownership("release")}>Let another tab respond</button>
      </div>
  </div>;
}
