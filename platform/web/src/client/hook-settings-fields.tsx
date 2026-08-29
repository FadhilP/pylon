import { IconArrowDown, IconArrowUp, IconFileText, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { HookReadModel, HookSettingsReadModel, HookSourceReadModel } from "../shared/protocol/snapshots";
import { OverviewOrb } from "./overview-primitives";

const MAX_SOURCES = 20;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024;
type HookKey = keyof HookSettingsReadModel;

const HOOKS: Array<{ key: HookKey; name: string; summary: string; detail: string }> = [
  {
    key: "sessionStart",
    name: "session_start",
    summary: "Once, when a logical session begins",
    detail: "Persisted once in session context. Individual sources can also be restored after compaction.",
  },
  {
    key: "beforeAgentStart",
    name: "before_agent_start",
    summary: "Before every prompt sent to the agent",
    detail: "Appended to the system prompt for the current run without accumulating in history.",
  },
];

export function HookSettingsFields({
  settings,
  loading,
  disabled,
  onUpdate,
}: {
  settings?: HookSettingsReadModel;
  loading: boolean;
  disabled: boolean;
  onUpdate: (settings: HookSettingsReadModel) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [hookKey, setHookKey] = useState<HookKey>("sessionStart");
  const [sourceId, setSourceId] = useState<string>();
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);
  useEffect(() => {
    const sources = draft?.[hookKey].sources ?? [];
    if (!sources.some(source => source.id === sourceId)) setSourceId(sources[0]?.id);
  }, [draft, hookKey, sourceId]);

  if (loading && !draft) return <div className="settings-empty">Loading hook settings…</div>;
  if (!draft)
    return (
      <div className="settings-empty">
        <strong>Hook settings unavailable</strong>
      </div>
    );

  const hook = draft[hookKey];
  const source = hook.sources.find(item => item.id === sourceId);
  const info = HOOKS.find(item => item.key === hookKey)!;
  const totalBytes = HOOKS.reduce(
    (total, item) => total + draft[item.key].sources.reduce((sum, entry) => sum + bytes(entry.content), 0),
    0,
  );

  const commit = async (next: HookSettingsReadModel) => {
    setDraft(next);
    setError("");
    try {
      await onUpdate(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save hook settings");
    }
  };

  const updateHook = (nextHook: HookReadModel) => commit({ ...draft, [hookKey]: nextHook });
  const updateSource = (nextSource: HookSourceReadModel, save: boolean) => {
    const next = {
      ...draft,
      [hookKey]: { ...hook, sources: hook.sources.map(item => (item.id === nextSource.id ? nextSource : item)) },
    };
    setDraft(next);
    if (save) void commit(next);
  };
  const saveSource = () => {
    if (!source) return;
    const normalized = { ...source, name: source.name.trim() || "Untitled source" };
    const next = {
      ...draft,
      [hookKey]: { ...hook, sources: hook.sources.map(item => (item.id === source.id ? normalized : item)) },
    };
    void commit(next);
  };

  const addWritten = () => {
    if (hook.sources.length >= MAX_SOURCES) return setError(`Each hook supports up to ${MAX_SOURCES} sources.`);
    const nextSource = {
      id: crypto.randomUUID(),
      name: `Written source ${hook.sources.length + 1}`,
      kind: "text" as const,
      content: "",
      reinjectOnCompaction: false,
    };
    setSourceId(nextSource.id);
    void updateHook({ ...hook, sources: [...hook.sources, nextSource] });
  };

  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = "";
    if (!files.length) return;
    if (hook.sources.length + files.length > MAX_SOURCES)
      return setError(`Each hook supports up to ${MAX_SOURCES} sources.`);
    const additions: HookSourceReadModel[] = [];
    let nextTotal = totalBytes;
    for (const file of files) {
      const content = await file.text();
      const size = bytes(content);
      if (size > MAX_SOURCE_BYTES) return setError(`${file.name} exceeds the 64 KiB source limit.`);
      nextTotal += size;
      if (nextTotal > MAX_TOTAL_BYTES) return setError("Hook sources exceed the 96 KiB workspace limit.");
      additions.push({
        id: crypto.randomUUID(),
        name: file.name.slice(0, 200) || "Imported source",
        kind: "file",
        content,
        reinjectOnCompaction: false,
      });
    }
    setSourceId(additions[0]?.id);
    void updateHook({ ...hook, sources: [...hook.sources, ...additions] });
  };

  const removeSource = (id: string) => {
    const index = hook.sources.findIndex(item => item.id === id);
    const sources = hook.sources.filter(item => item.id !== id);
    setSourceId(sources[Math.min(index, sources.length - 1)]?.id);
    void updateHook({ ...hook, sources });
  };

  const moveSource = (id: string, offset: -1 | 1) => {
    const index = hook.sources.findIndex(item => item.id === id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= hook.sources.length) return;
    const sources = [...hook.sources];
    [sources[index], sources[target]] = [sources[target]!, sources[index]!];
    void updateHook({ ...hook, sources });
  };

  return (
    <div className="hooks-editor">
      <aside className="hooks-list" aria-label="Lifecycle hooks">
        <div className="workbench-index-label">
          <span>Lifecycle hooks</span>
          <span>{HOOKS.filter(item => draft[item.key].enabled).length} enabled</span>
        </div>
        {HOOKS.map(item => {
          const enabled = draft[item.key].enabled;
          return (
            <button
              key={item.key}
              type="button"
              aria-selected={hookKey === item.key}
              className={`hook-choice${hookKey === item.key ? " is-selected" : ""}`}
              onClick={() => setHookKey(item.key)}>
              <OverviewOrb state={enabled ? "done" : "neutral"} label={enabled ? "enabled" : "disabled"} />
              <span>
                <strong>{item.name}</strong>
                <small>{item.summary}</small>
              </span>
              <b className={`package-state is-${enabled ? "active" : "disabled"}`}>{enabled ? "on" : "off"}</b>
            </button>
          );
        })}
      </aside>

      <div className="hook-detail">
        <header>
          <div>
            <strong>{info.name}</strong>
            <span>{info.detail}</span>
          </div>
          <label className="package-switch">
            <span className="sr-only">Enable {info.name}</span>
            <input
              type="checkbox"
              role="switch"
              checked={hook.enabled}
              disabled={disabled}
              onChange={event => void updateHook({ ...hook, enabled: event.target.checked })}
            />
          </label>
        </header>
        <div className="hook-source-toolbar">
          <div>
            <strong>Sources</strong>
            <span>
              {hook.sources.length} source{hook.sources.length === 1 ? "" : "s"} · combined in list order ·{" "}
              {totalBytes.toLocaleString()} / {MAX_TOTAL_BYTES.toLocaleString()} bytes
            </span>
          </div>
          <div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept=".md,.txt,text/markdown,text/plain"
              disabled={disabled}
              onChange={event => void addFiles(event)}
            />
            <button type="button" disabled={disabled} onClick={() => fileRef.current?.click()}>
              <IconPlus size={13} /> Add files
            </button>
            <button type="button" disabled={disabled} onClick={addWritten}>
              <IconPencil size={13} /> Write new
            </button>
          </div>
        </div>

        <div className="hook-source-list">
          {hook.sources.length === 0 && (
            <button className="hook-source-empty" type="button" disabled={disabled} onClick={addWritten}>
              Add a file or write instructions to enable this hook.
            </button>
          )}
          {hook.sources.map((item, index) => (
            <div
              key={item.id}
              className={`hook-source-row${item.id === sourceId ? " is-selected" : ""}`}
              onClick={() => setSourceId(item.id)}>
              {item.kind === "file" ? <IconFileText size={15} /> : <IconPencil size={15} />}
              <button type="button" onClick={() => setSourceId(item.id)}>
                <strong>{item.name}</strong>
                <small>
                  {item.kind === "file" ? "Imported snapshot" : "Written in Pylon"} ·{" "}
                  {bytes(item.content).toLocaleString()} bytes
                  {hookKey === "sessionStart" && item.reinjectOnCompaction ? " · restores after compaction" : ""}
                </small>
              </button>
              <span className="hook-source-order">
                <button
                  type="button"
                  aria-label={`Move ${item.name} up`}
                  disabled={disabled || index === 0}
                  onClick={event => {
                    event.stopPropagation();
                    moveSource(item.id, -1);
                  }}>
                  <IconArrowUp size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${item.name} down`}
                  disabled={disabled || index === hook.sources.length - 1}
                  onClick={event => {
                    event.stopPropagation();
                    moveSource(item.id, 1);
                  }}>
                  <IconArrowDown size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${item.name}`}
                  disabled={disabled}
                  onClick={event => {
                    event.stopPropagation();
                    removeSource(item.id);
                  }}>
                  <IconTrash size={13} />
                </button>
              </span>
            </div>
          ))}
        </div>

        {source && (
          <div className={`hook-source-editor${hookKey === "sessionStart" ? " has-reinject" : ""}`}>
            <label>
              Name
              <input
                value={source.name}
                maxLength={200}
                disabled={disabled}
                onChange={event => updateSource({ ...source, name: event.target.value }, false)}
                onBlur={saveSource}
              />
            </label>
            {hookKey === "sessionStart" && (
              <label className="hook-reinject">
                <input
                  type="checkbox"
                  checked={source.reinjectOnCompaction === true}
                  disabled={disabled}
                  onChange={event => updateSource({ ...source, reinjectOnCompaction: event.target.checked }, true)}
                />
                <span>
                  <strong>Restore after compaction</strong>
                  <small>Re-add this source after each successful context compaction.</small>
                </span>
              </label>
            )}
            <label>
              <span className="hook-source-count">
                Instructions{" "}
                <span>
                  {bytes(source.content).toLocaleString()} / {MAX_SOURCE_BYTES.toLocaleString()} bytes
                </span>
              </span>
              <textarea
                value={source.content}
                disabled={disabled}
                spellCheck={false}
                onChange={event => {
                  if (
                    bytes(event.target.value) <= MAX_SOURCE_BYTES &&
                    totalBytes - bytes(source.content) + bytes(event.target.value) <= MAX_TOTAL_BYTES
                  )
                    updateSource({ ...source, content: event.target.value }, false);
                }}
                onBlur={saveSource}
              />
            </label>
          </div>
        )}
        {error && (
          <p className="hook-settings-error" role="alert">
            {error}
          </p>
        )}
        {disabled && <p className="settings-note">Hook settings are available when every active session is idle.</p>}
      </div>
    </div>
  );
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
