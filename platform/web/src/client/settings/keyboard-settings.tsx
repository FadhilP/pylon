import { useEffect, useRef, useState } from "react";
import {
  assignBinding,
  bindingLabel,
  bindingProblem,
  browserVerdict,
  defaultBinding,
  DoubleShift,
  effectiveBinding,
  eventBinding,
  KEY_COMMANDS,
  PRESETS,
  validateKeymap,
  type Binding,
  type CommandId,
  type KeyboardSettings,
  type Keymap,
  type KeymapPreset,
  type Modifier,
} from "../../shared/settings/keyboard";
import { runtimeStore, useRuntimeStore } from "../runtime/event-store";
import { isMacKeyboard } from "../ui/keyboard-shortcuts";
import "./keyboard-settings.css";

type Editing = { id: CommandId; base: KeyboardSettings; candidate?: Binding | null };
export function KeyboardSettingsPanel() {
  const live = useRuntimeStore();
  const settings = live.keyboardSettings;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [editing, setEditing] = useState<Editing>();
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lost, setLost] = useState<CommandId[]>([]);
  const [replace, setReplace] = useState<KeymapPreset>();
  const recorder = useRef<HTMLDivElement>(null);
  const mac = isMacKeyboard();
  const browser = /Firefox\//.test(navigator.userAgent)
    ? "Firefox"
    : /Edg\//.test(navigator.userAgent)
      ? "Edge"
      : /Chrome\//.test(navigator.userAgent)
        ? "Chrome"
        : /Safari\//.test(navigator.userAgent)
          ? "Safari"
          : "this browser";
  const closeRecorder = () => {
    setListening(false);
    setEditing(undefined);
  };
  useEffect(() => {
    if (!listening) return;
    const taps = new DoubleShift();
    const stop = () => setListening(false);
    const outside = (event: PointerEvent) => {
      if (!recorder.current?.contains(event.target as Node)) stop();
    };
    const record = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        stop();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        closeRecorder();
        return;
      }
      // The recorder owns the event, so pass its original key state, not the prevented flag.
      const stroke = {
        key: event.key,
        keyCode: event.keyCode,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.isComposing,
        getModifierState: event.getModifierState.bind(event),
      };
      const doubled = taps.handle(stroke, event.type as "keydown" | "keyup", Date.now());
      const binding = doubled
        ? ({ kind: "double-shift" } as const)
        : event.type === "keydown"
          ? eventBinding(stroke, mac)
          : undefined;
      if (binding) {
        setEditing(current => current && { ...current, candidate: binding });
        stop();
      }
    };
    document.addEventListener("keydown", record, true);
    document.addEventListener("keyup", record, true);
    window.addEventListener("blur", stop);
    window.addEventListener("compositionstart", stop);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("keydown", record, true);
      document.removeEventListener("keyup", record, true);
      window.removeEventListener("blur", stop);
      window.removeEventListener("compositionstart", stop);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [listening, mac]);
  useEffect(() => {
    if (editing) recorder.current?.scrollIntoView({ block: "nearest" });
  }, [editing?.id]);

  const save = async (map: Keymap, revision: number, evicted: CommandId[] = []) => {
    const problem = validateKeymap(map);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    setListening(false);
    try {
      await runtimeStore.saveKeyboardSettings(revision, map);
      setLost(previous => (replace ? [] : [...new Set([...previous, ...evicted])]));
      closeRecorder();
      setReplace(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save keyboard settings");
    } finally {
      setBusy(false);
    }
  };
  const edit = (id: CommandId) => {
    if (!settings) return;
    setEditing({ id, base: structuredClone(settings) });
    setListening(true);
    setError("");
    setReplace(undefined);
    setQuery("");
    setFilter("all");
  };
  const assign = (id: CommandId, binding: Binding | null, reset = false) => {
    const base = editing?.id === id ? editing.base : settings;
    if (!base) return;
    try {
      const result = assignBinding(base.keymap, id, binding);
      if (reset) delete result.keymap.overrides[id];
      void save(result.keymap, base.revision, result.lost);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid shortcut");
    }
  };
  if (!settings)
    return (
      <section className="keyboard-settings">
        <h2>Keyboard</h2>
        <p>Keyboard settings are unavailable until the server has connected.</p>
        <button
          type="button"
          onClick={() => void runtimeStore.refreshKeyboardSettings().catch(cause => setError(String(cause)))}>
          Retry
        </button>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  const { keymap } = settings;
  const disabled = busy || live.connection !== "connected";
  const unresolved = lost.filter(id => !effectiveBinding(keymap, id));
  const currentCommand = KEY_COMMANDS.find(command => command.id === editing?.id);
  const problem =
    currentCommand && editing?.candidate !== undefined ? bindingProblem(currentCommand, editing.candidate) : undefined;
  const willLose =
    editing?.candidate !== undefined && !problem
      ? assignBinding(editing.base.keymap, editing.id, editing.candidate).lost
      : [];
  const rows = KEY_COMMANDS.filter(command => {
    const binding = effectiveBinding(keymap, command.id);
    const verdict = browserVerdict(binding, { mac, browser });
    return (
      (filter === "all" ||
        (filter === "changed" && Object.hasOwn(keymap.overrides, command.id)) ||
        (filter === "unbound" && !binding) ||
        (filter === "costs" && verdict.kind === "costs")) &&
      `${command.label} ${command.group} ${command.scope} ${bindingLabel(binding, mac)}`
        .toLowerCase()
        .includes(query.toLowerCase().trim())
    );
  });
  const manual =
    editing?.candidate?.kind === "chord"
      ? editing.candidate
      : { kind: "chord" as const, key: "", modifiers: [] as Modifier[] };
  return (
    <section className="keyboard-settings" aria-label="Keyboard settings">
      <header>
        <h2>Keyboard</h2>
        <p>
          Shared across browsers connected to this Pylon server. Record then Apply; Clear and Reset save immediately.
        </p>
      </header>
      <div className="keyboard-controls">
        <label>
          Keymap{" "}
          <select
            value={keymap.preset}
            disabled={disabled}
            onChange={event => {
              closeRecorder();
              setReplace(event.target.value as KeymapPreset);
            }}>
            {PRESETS.map(preset => (
              <option key={preset} value={preset}>
                {preset === "pylon"
                  ? "Pylon"
                  : preset === "vscode"
                    ? "VS Code · browser-adapted"
                    : "JetBrains · browser-adapted"}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={disabled || !Object.keys(keymap.overrides).length}
          onClick={() => {
            closeRecorder();
            setReplace(keymap.preset);
          }}>
          Reset all overrides…
        </button>
      </div>
      {replace && (
        <div className="keyboard-notice" role="group" aria-label="Confirm keymap replacement">
          <p>
            Use {replace} defaults? This removes all custom bindings and explicitly unbound overrides. Browser-reserved
            IDE shortcuts remain unbound.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void save({ preset: replace, overrides: {} }, settings.revision)}>
            Replace keymap
          </button>{" "}
          <button type="button" disabled={busy} onClick={() => setReplace(undefined)}>
            Cancel
          </button>
        </div>
      )}
      <p className="keyboard-help">
        Global shortcuts yield to dialogs, terminals and editors. Search shortcuts also work in text inputs. Composer
        and explorer shortcuts require focus in that area. Use Ctrl on Windows/Linux and Cmd on macOS for the primary
        modifier.
      </p>
      <p className="keyboard-help">
        Compatibility in {browser}: browser costs below are warnings, not capability detection. Your browser, OS, layout
        or extensions may reserve additional keys. Escape cancels recording; Tab stops recording and moves focus.
      </p>
      {error && (
        <p className="keyboard-notice" role="alert">
          {error}
        </p>
      )}
      {live.connection !== "connected" && <p role="status">Disconnected. Reconnect before changing bindings.</p>}
      {!!unresolved.length && (
        <div className="keyboard-notice" role="status">
          <strong>These actions lost a conflicting shortcut:</strong>
          {unresolved.map(id => (
            <div key={id}>
              {KEY_COMMANDS.find(command => command.id === id)!.label}{" "}
              <button type="button" disabled={disabled} onClick={() => edit(id)}>
                Reassign
              </button>{" "}
              <button type="button" onClick={() => setLost(previous => previous.filter(value => value !== id))}>
                Leave unbound
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="keyboard-controls">
        <label>
          Find a shortcut{" "}
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Action, context or key…"
          />
        </label>
        <label>
          Show{" "}
          <select value={filter} onChange={event => setFilter(event.target.value)}>
            <option value="all">All bindings</option>
            <option value="changed">Overrides</option>
            <option value="unbound">Unbound</option>
            <option value="costs">Browser costs</option>
          </select>
        </label>
      </div>
      {!rows.length && <p>No matching shortcuts.</p>}
      {rows.map(command => {
        const binding = effectiveBinding(keymap, command.id);
        const verdict = browserVerdict(binding, { mac, browser });
        const changed = Object.hasOwn(keymap.overrides, command.id);
        return (
          <div className="keyboard-row" key={command.id} data-settings-search-target={`keyboard-${command.id}`}>
            <div className="keyboard-action">
              <strong>{command.label}</strong>
              <small>
                {command.group} · {command.scope} · {changed ? "Override" : "Inherited"}
              </small>
            </div>
            <button
              type="button"
              className="keyboard-binding"
              disabled={disabled}
              aria-label={`Record shortcut for ${command.label}`}
              onClick={() => edit(command.id)}>
              {bindingLabel(binding, mac)}
            </button>
            <small className={`keyboard-verdict is-${verdict.kind}`}>{verdict.message || "No shortcut"}</small>
            <div className="keyboard-row-actions">
              <button type="button" disabled={disabled || !binding} onClick={() => assign(command.id, null)}>
                Clear
              </button>
              <button
                type="button"
                disabled={disabled || !changed}
                onClick={() => assign(command.id, defaultBinding(command.id, keymap.preset), true)}>
                Reset
              </button>
            </div>
            {editing?.id === command.id && (
              <div
                className="keyboard-recorder"
                ref={recorder}
                data-keyboard-recording={listening ? "true" : undefined}>
                <p role="status">
                  {listening
                    ? "Listening… press a combination, or tap Shift twice."
                    : `Candidate: ${editing.candidate === undefined ? "None" : bindingLabel(editing.candidate, mac)}`}
                </p>
                <button type="button" disabled={busy} onClick={() => setListening(true)}>
                  Record again
                </button>
                <details
                  onToggle={event => {
                    if (event.currentTarget.open) setListening(false);
                  }}>
                  <summary>Enter keys manually</summary>
                  <label>
                    Key{" "}
                    <input
                      aria-label="Shortcut key"
                      value={manual.key === " " ? "Space" : manual.key}
                      onChange={event => {
                        const value = event.target.value;
                        setEditing({
                          ...editing,
                          candidate: {
                            ...manual,
                            key: value === "Space" ? " " : value.length === 1 ? value.toUpperCase() : value,
                          },
                        });
                      }}
                      placeholder="A, Enter, F8, Space…"
                    />
                  </label>
                  <div className="keyboard-modifiers">
                    {(["Mod", "Ctrl", "Alt", "Shift", "Meta"] as Modifier[]).map(mod => (
                      <label key={mod}>
                        <input
                          type="checkbox"
                          checked={manual.modifiers.includes(mod)}
                          onChange={event =>
                            setEditing({
                              ...editing,
                              candidate: {
                                ...manual,
                                modifiers: event.target.checked
                                  ? [...manual.modifiers, mod]
                                  : manual.modifiers.filter(value => value !== mod),
                              },
                            })
                          }
                        />
                        {mod === "Mod" ? "Primary (Ctrl/Cmd)" : mod}
                      </label>
                    ))}
                  </div>
                  <button type="button" onClick={() => setEditing({ ...editing, candidate: { kind: "double-shift" } })}>
                    Double Shift
                  </button>
                </details>
                {problem && <p role="alert">{problem}</p>}
                {!problem && editing.candidate && <p>{browserVerdict(editing.candidate, { mac, browser }).message}</p>}
                {!!willLose.length && (
                  <p>
                    This will unbind{" "}
                    {willLose.map(id => KEY_COMMANDS.find(command => command.id === id)!.label).join(", ")} in
                    overlapping contexts.
                  </p>
                )}
                {editing.base.revision !== settings.revision && (
                  <p role="status">
                    Settings changed in another window. Cancel and reopen this recorder to use the latest bindings.
                  </p>
                )}
                <div className="keyboard-controls">
                  <button
                    type="button"
                    disabled={
                      disabled ||
                      listening ||
                      editing.candidate === undefined ||
                      !!problem ||
                      editing.base.revision !== settings.revision
                    }
                    onClick={() => assign(editing.id, editing.candidate!)}>
                    Apply shortcut
                  </button>
                  <button type="button" disabled={busy} onClick={closeRecorder}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
