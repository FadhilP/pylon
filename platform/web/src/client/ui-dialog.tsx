import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

const SKIPPED_ANSWER = "Skipped by user";

export function UiDialog({
  request,
}: {
  request: NonNullable<RuntimeStoreSnapshot["pendingUi"]>;
}) {
  const payload = request.payload;
  const rawOptions = Array.isArray(payload.options) ? payload.options : [];
  const questions = Array.isArray(payload.questions)
    ? payload.questions.map((raw) => {
        const item =
          typeof raw === "object" && raw
            ? (raw as Record<string, unknown>)
            : {};
        return {
          question:
            typeof item.question === "string" ? item.question : "Question",
          options: Array.isArray(item.options)
            ? item.options.filter(
                (option): option is string => typeof option === "string",
              )
            : [],
        };
      })
    : [];
  const optionValue = (option: unknown, index: number) => {
    const item =
      typeof option === "object" && option
        ? (option as Record<string, unknown>)
        : {};
    return typeof option === "string"
      ? option
      : typeof item.value === "string"
        ? item.value
        : String(index);
  };
  const optionLabel = (option: unknown, index: number) => {
    const item =
      typeof option === "object" && option
        ? (option as Record<string, unknown>)
        : {};
    return typeof option === "string"
      ? option
      : typeof item.label === "string"
        ? item.label
        : optionValue(option, index);
  };
  const options =
    request.method === "confirm"
      ? [
          { value: "confirm", label: "Confirm" },
          { value: "cancel", label: "Cancel" },
        ]
      : rawOptions;
  const allowOnce = options.findIndex(
    (option, index) =>
      optionLabel(option, index).trim().toLowerCase() === "allow once",
  );
  const [value, setValue] = useState(() =>
    typeof payload.prefill === "string" ? payload.prefill : "",
  );
  const [answers, setAnswers] = useState<string[]>(() =>
    questions.map(() => ""),
  );
  const [customAnswers, setCustomAnswers] = useState<string[]>(() =>
    questions.map(() => ""),
  );
  const [questionIndex, setQuestionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focused, setFocused] = useState(
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  const [now, setNow] = useState(Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const actionLock = useRef(false);
  const title =
    typeof payload.title === "string" ? payload.title : "Input requested";
  const isStateQLCredential =
    payload.context === "stateql-credential" &&
    payload.inputType === "password";
  const description =
    typeof payload.message === "string"
      ? payload.message
      : typeof payload.label === "string"
        ? payload.label
        : "The runtime needs a response.";
  const titleId = `ui-title-${request.requestId}`;
  const descriptionId = `ui-description-${request.requestId}`;

  useEffect(() => {
    if (!request.owned) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    rootRef.current
      ?.querySelector<HTMLElement>(
        "[data-autofocus], button:not([disabled]), input, textarea",
      )
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [request.owned]);

  useEffect(() => {
    if (!request.owned) return;
    const renew = () => {
      const active =
        document.visibilityState === "visible" && document.hasFocus();
      setFocused(active);
      if (!active) return;
      void runtimeStore.keepUiRequestAlive(request).catch(() => undefined);
    };
    renew();
    const interval = window.setInterval(renew, 5_000);
    window.addEventListener("focus", renew);
    window.addEventListener("blur", renew);
    document.addEventListener("visibilitychange", renew);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", renew);
      window.removeEventListener("blur", renew);
      document.removeEventListener("visibilitychange", renew);
    };
  }, [request.requestId, request.owned]);

  useEffect(() => {
    if (!request.owned || request.timeoutSeconds === undefined || focused)
      return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [focused, request.owned, request.timeoutSeconds]);

  const respond = async (body: Record<string, unknown>) => {
    if (actionLock.current) return;
    if (payload.inputType === "password") setValue("");
    actionLock.current = true;
    setBusy(true);
    setError("");
    try {
      await runtimeStore.answerUi(request, body);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Response was rejected",
      );
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
      setError(
        cause instanceof Error
          ? cause.message
          : "Ownership change was rejected",
      );
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
  const chooseAnswer = (answer: string, advance = false) => {
    if (!answer.trim() || busy) return;
    const next = answers.map((current, index) =>
      index === questionIndex ? answer.trim() : current,
    );
    setAnswers(next);
    if (
      questions.length === 1 ||
      (advance && questionIndex === questions.length - 1)
    ) {
      void respond({ answers: next.map((value) => value || SKIPPED_ANSWER) });
      return;
    }
    if (advance) setQuestionIndex((current) => current + 1);
  };
  const previousQuestion = () => {
    if (busy) return;
    setQuestionIndex((current) => Math.max(0, current - 1));
  };
  const nextQuestion = () => {
    if (busy) return;
    if (questionIndex === questions.length - 1) {
      if (!answers[questionIndex]) return;
      void respond({
        answers: answers.map((value) => value || SKIPPED_ANSWER),
      });
      return;
    }
    setQuestionIndex((current) => Math.min(questions.length - 1, current + 1));
  };
  const skipQuestion = () => {
    if (busy) return;
    const next = answers.map((value, index) =>
      index === questionIndex ? SKIPPED_ANSWER : value,
    );
    setAnswers(next);
    setCustomAnswers((current) =>
      current.map((value, index) => (index === questionIndex ? "" : value)),
    );
    if (questionIndex === questions.length - 1) {
      void respond({ answers: next.map((value) => value || SKIPPED_ANSWER) });
      return;
    }
    setQuestionIndex((current) => current + 1);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) void respond({ cancelled: true });
      return;
    }
    if (
      (request.method === "select" || request.method === "confirm") &&
      /^[1-9]$/.test(event.key)
    ) {
      event.preventDefault();
      choose(Number(event.key) - 1);
      return;
    }
    if (
      request.method === "questionnaire" &&
      !(event.target instanceof HTMLInputElement) &&
      /^[1-9]$/.test(event.key)
    ) {
      event.preventDefault();
      const option = questions[questionIndex]?.options[Number(event.key) - 1];
      if (option) chooseAnswer(option, true);
      return;
    }
    if (
      request.method === "questionnaire" &&
      !(event.target instanceof HTMLInputElement) &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      if (event.key === "ArrowLeft") previousQuestion();
      else nextQuestion();
      return;
    }
    if (
      (request.method === "select" || request.method === "confirm") &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      const buttons = [
        ...(rootRef.current?.querySelectorAll<HTMLButtonElement>(
          "[data-ui-option]",
        ) ?? []),
      ];
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const offset = event.key === "ArrowDown" ? 1 : -1;
      buttons[
        (Math.max(0, current) + offset + buttons.length) % buttons.length
      ]?.focus();
      return;
    }
    if (request.method === "input" && event.key === "Enter") {
      event.preventDefault();
      if (!busy) void respond({ value });
      return;
    }
    if (
      request.method === "questionnaire" &&
      event.key === "Enter" &&
      event.target instanceof HTMLInputElement
    ) {
      event.preventDefault();
      chooseAnswer(customAnswers[questionIndex] ?? "", true);
      return;
    }
    if (
      request.method === "editor" &&
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      if (!busy) void respond({ value });
    }
  };

  if (!request.owned) {
    return (
      <div
        className="ui-request ui-request-observer"
        role="status"
        aria-live="polite"
      >
        <strong>{title}</strong>
        <p>
          {request.ownershipAvailable
            ? "Response ownership is available."
            : "A response is pending in another tab."}
        </p>
        {request.ownershipAvailable ? (
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => void ownership("claim")}
          >
            Respond in this tab
          </button>
        ) : (
          <button className="secondary-button" type="button" disabled>
            Awaiting owner response
          </button>
        )}
        {error && (
          <p className="ui-request-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="ui-request ui-request-inline"
      role={request.method === "confirm" ? "alertdialog" : "dialog"}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={onKeyDown}
    >
      <header className="ui-request-header">
        <strong id={titleId}>{title}</strong>
        {request.timeoutSeconds !== undefined && (
          <small className="ui-request-timer" role="timer">
            {focused
              ? `Paused · ${formatCountdown(request.timeoutSeconds)}`
              : formatCountdown(
                  Math.max(
                    0,
                    Math.ceil(
                      ((request.expiresAt
                        ? Date.parse(request.expiresAt)
                        : now) -
                        now) /
                        1_000,
                    ),
                  ),
                )}
          </small>
        )}
      </header>
      <p id={descriptionId}>{description}</p>
      {(request.method === "select" || request.method === "confirm") && (
        <div className="ui-request-options" role="listbox" aria-label={title}>
          {options.map((option, index) => {
            const nextValue = optionValue(option, index);
            return (
              <button
                key={nextValue}
                type="button"
                role="option"
                data-ui-option
                aria-selected={false}
                data-autofocus={
                  index === allowOnce || (allowOnce < 0 && index === 0)
                    ? ""
                    : undefined
                }
                disabled={busy}
                onClick={() => choose(index)}
              >
                <kbd>{index + 1}</kbd>
                <span>{optionLabel(option, index)}</span>
              </button>
            );
          })}
        </div>
      )}
      {request.method === "questionnaire" &&
        (() => {
          const question = questions[questionIndex];
          if (!question) return null;
          return (
            <div className="ui-questionnaire">
              <fieldset>
                <legend>
                  <span>{question.question}</span>
                  <small>
                    {questionIndex + 1} of {questions.length}
                  </small>
                </legend>
                <div
                  className="ui-request-options"
                  role="listbox"
                  aria-label={question.question}
                >
                  {question.options.map((option, index) => (
                    <button
                      key={option}
                      type="button"
                      role="option"
                      aria-selected={answers[questionIndex] === option}
                      data-autofocus={index === 0 ? "" : undefined}
                      disabled={busy}
                      onClick={() => chooseAnswer(option)}
                    >
                      <kbd>{index + 1}</kbd>
                      <span>{option}</span>
                    </button>
                  ))}
                </div>
                <div className="ui-questionnaire-answer">
                  <input
                    value={customAnswers[questionIndex] ?? ""}
                    placeholder="Write a different answer"
                    aria-label={`Custom answer for question ${questionIndex + 1}`}
                    disabled={busy}
                    onChange={(event) => {
                      const answer = event.target.value;
                      setCustomAnswers((current) =>
                        current.map((value, index) =>
                          index === questionIndex ? answer : value,
                        ),
                      );
                      setAnswers((current) =>
                        current.map((value, index) =>
                          index === questionIndex ? answer.trim() : value,
                        ),
                      );
                    }}
                  />
                  <button
                    className="ui-questionnaire-skip"
                    type="button"
                    aria-pressed={answers[questionIndex] === SKIPPED_ANSWER}
                    disabled={busy}
                    onClick={skipQuestion}
                  >
                    Skip
                  </button>
                </div>
                <div
                  className={`ui-questionnaire-nav${questions.length === 1 ? " is-single" : ""}`}
                >
                  <button
                    type="button"
                    aria-label="Previous question"
                    disabled={
                      busy || questions.length === 1 || questionIndex === 0
                    }
                    onClick={previousQuestion}
                  >
                    <IconChevronLeft size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Next question"
                    disabled={
                      busy ||
                      questions.length === 1 ||
                      (questionIndex === questions.length - 1 &&
                        !answers[questionIndex])
                    }
                    onClick={nextQuestion}
                  >
                    <IconChevronRight size={16} />
                  </button>
                </div>
              </fieldset>
            </div>
          );
        })()}
      {request.method === "input" && (
        <input
          data-autofocus
          type={payload.inputType === "password" ? "password" : "text"}
          autoComplete={payload.inputType === "password" ? "off" : undefined}
          spellCheck={payload.inputType === "password" ? false : undefined}
          value={value}
          placeholder={
            typeof payload.placeholder === "string"
              ? payload.placeholder
              : undefined
          }
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
        />
      )}
      {request.method === "input" && isStateQLCredential && (
        <button
          className="primary-button"
          type="button"
          disabled={busy || !value}
          onClick={() => void respond({ value })}
        >
          Allow temporary access
        </button>
      )}
      {request.method === "editor" && (
        <textarea
          data-autofocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
        />
      )}
      {(request.method === "input" || request.method === "editor") && (
        <small className="ui-request-hint">
          {request.method === "editor"
            ? "Ctrl/Command + Enter to submit · Escape to cancel"
            : isStateQLCredential
              ? "Enter to approve once for this session · Escape to cancel"
              : "Enter to submit · Escape to cancel"}
        </small>
      )}
      {error && (
        <p className="ui-request-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
