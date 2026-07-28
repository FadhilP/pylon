import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

export function UiDialog({ request }: { request: NonNullable<RuntimeStoreSnapshot["pendingUi"]> }) {
  const payload = request.payload;
  const rawOptions = Array.isArray(payload.options) ? payload.options : [];
  const questions = Array.isArray(payload.questions) ? payload.questions.map((raw) => {
    const item = typeof raw === "object" && raw ? raw as Record<string, unknown> : {};
    return {
      question: typeof item.question === "string" ? item.question : "Question",
      options: Array.isArray(item.options)
        ? item.options.filter((option): option is string => typeof option === "string")
        : [],
    };
  }) : [];
  const optionValue = (option: unknown, index: number) => {
    const item = typeof option === "object" && option ? option as Record<string, unknown> : {};
    return typeof option === "string" ? option : typeof item.value === "string" ? item.value : String(index);
  };
  const optionLabel = (option: unknown, index: number) => {
    const item = typeof option === "object" && option ? option as Record<string, unknown> : {};
    return typeof option === "string" ? option : typeof item.label === "string" ? item.label : optionValue(option, index);
  };
  const options = request.method === "confirm"
    ? [{ value: "confirm", label: "Confirm" }, { value: "cancel", label: "Cancel" }]
    : rawOptions;
  const allowOnce = options.findIndex((option, index) =>
    optionLabel(option, index).trim().toLowerCase() === "allow once");
  const [value, setValue] = useState(() => typeof payload.prefill === "string" ? payload.prefill : "");
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const actionLock = useRef(false);
  const title = typeof payload.title === "string" ? payload.title : "Input requested";
  const description = typeof payload.message === "string"
    ? payload.message
    : typeof payload.label === "string"
      ? payload.label
      : "The runtime needs a response.";
  const titleId = `ui-title-${request.requestId}`;
  const descriptionId = `ui-description-${request.requestId}`;

  useEffect(() => {
    if (!request.owned) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.querySelector<HTMLElement>("[data-autofocus], button:not([disabled]), input, textarea")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [request.owned]);

  const respond = async (body: Record<string, unknown>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    try {
      await runtimeStore.answerUi(request, body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Response was rejected");
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const ownership = async (action: "claim" | "release") => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    try {
      await runtimeStore.changeUiOwnership(request, action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ownership change was rejected");
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || busy) return;
    if (request.method === "confirm") {
      void respond({ confirmed: optionValue(option, index) === "confirm" });
      return;
    }
    void respond({ value: optionValue(option, index) });
  };
  const chooseAnswer = (answer: string) => {
    const questionIndex = answers.findIndex((current) => !current);
    if (questionIndex < 0 || !answer.trim() || busy) return;
    const next = answers.map((current, index) => index === questionIndex ? answer.trim() : current);
    setAnswers(next);
    setValue("");
    if (questionIndex === questions.length - 1) void respond({ answers: next });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) void respond({ cancelled: true });
      return;
    }
    if ((request.method === "select" || request.method === "confirm") && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      choose(Number(event.key) - 1);
      return;
    }
    if (request.method === "questionnaire"
      && !(event.target instanceof HTMLInputElement)
      && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      const questionIndex = answers.findIndex((current) => !current);
      const option = questions[questionIndex]?.options[Number(event.key) - 1];
      if (option) chooseAnswer(option);
      return;
    }
    if ((request.method === "select" || request.method === "confirm")
      && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const buttons = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-ui-option]") ?? [])];
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      buttons[(Math.max(0, current) + offset + buttons.length) % buttons.length]?.focus();
      return;
    }
    if (request.method === "input" && event.key === "Enter") {
      event.preventDefault();
      if (!busy) void respond({ value });
      return;
    }
    if (request.method === "questionnaire" && event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      chooseAnswer(value);
      return;
    }
    if (request.method === "editor" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!busy) void respond({ value });
    }
  };

  if (!request.owned) {
    return <div className="ui-request ui-request-observer" role="status" aria-live="polite">
      <strong>{title}</strong>
      <p>{request.ownershipAvailable ? "Response ownership is available." : "A response is pending in another tab."}</p>
      {request.ownershipAvailable
        ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void ownership("claim")}>Respond in this tab</button>
        : <button className="secondary-button" type="button" disabled>Awaiting owner response</button>}
      {error && <p className="ui-request-error" role="alert">{error}</p>}
    </div>;
  }

  return <div
    ref={rootRef}
    className="ui-request ui-request-inline"
    role={request.method === "confirm" ? "alertdialog" : "dialog"}
    aria-labelledby={titleId}
    aria-describedby={descriptionId}
    onKeyDown={onKeyDown}
  >
    <strong id={titleId}>{title}</strong>
    <p id={descriptionId}>{description}</p>
    {(request.method === "select" || request.method === "confirm") && <div className="ui-request-options" role="listbox" aria-label={title}>
      {options.map((option, index) => {
        const nextValue = optionValue(option, index);
        return <button
          key={nextValue}
          type="button"
          role="option"
          data-ui-option
          aria-selected={false}
          data-autofocus={index === allowOnce || allowOnce < 0 && index === 0 ? "" : undefined}
          disabled={busy}
          onClick={() => choose(index)}
        ><kbd>{index + 1}</kbd><span>{optionLabel(option, index)}</span></button>;
      })}
    </div>}
    {request.method === "questionnaire" && (() => {
      const questionIndex = answers.findIndex((answer) => !answer);
      const question = questions[questionIndex];
      if (!question) return null;
      return <div className="ui-questionnaire">
        <fieldset>
          <legend>{questionIndex + 1} of {questions.length}. {question.question}</legend>
          <div className="ui-request-options" role="listbox" aria-label={question.question}>
            {question.options.map((option, index) => <button
              key={option}
              type="button"
              role="option"
              aria-selected={false}
              data-autofocus={index === 0 ? "" : undefined}
              disabled={busy}
              onClick={() => chooseAnswer(option)}
            ><kbd>{index + 1}</kbd><span>{option}</span></button>)}
          </div>
          <input
            value={value}
            placeholder="Write a different answer"
            aria-label={`Custom answer for question ${questionIndex + 1}`}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          />
        </fieldset>
      </div>;
    })()}
    {request.method === "input" && <input
      data-autofocus
      value={value}
      placeholder={typeof payload.placeholder === "string" ? payload.placeholder : undefined}
      onChange={(event) => setValue(event.target.value)}
      disabled={busy}
    />}
    {request.method === "editor" && <textarea
      data-autofocus
      value={value}
      onChange={(event) => setValue(event.target.value)}
      disabled={busy}
    />}
    {(request.method === "input" || request.method === "editor") && <small className="ui-request-hint">
      {request.method === "editor" ? "Ctrl/Command + Enter to submit · Escape to cancel" : "Enter to submit · Escape to cancel"}
    </small>}
    {error && <p className="ui-request-error" role="alert">{error}</p>}
    <button className="text-button ui-transfer" type="button" disabled={busy} onClick={() => void ownership("release")}>Let another tab respond</button>
  </div>;
}
