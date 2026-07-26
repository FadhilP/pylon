import { IconArrowUp, IconCheck, IconChevronDown, IconCopy, IconPhoto, IconTool, IconX } from "@tabler/icons-react";
import DOMPurify from "dompurify";
import { Fragment, memo, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { groupConversationMessages, latestTimedAssistant } from "../shared/transcript";
import { formatWorkDuration } from "../shared/format";
import { renderMarkdown } from "../shared/markdown";
import type { PromptImage } from "../shared/protocol/commands";
import type { MessageReadModel } from "../shared/protocol/events";
import { thinkingLabel } from "./format";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

const markdownTags = ["a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"];
const markdownAttributes = ["alt", "checked", "class", "data-language", "disabled", "href", "src", "title", "type"];

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName !== "A") return;
  (node as HTMLAnchorElement).target = "_blank";
  (node as HTMLAnchorElement).rel = "noopener noreferrer";
});

export function ConversationPanel({ live, projectAvailable = true }: { live: RuntimeStoreSnapshot; projectAvailable?: boolean }) {
  const [message, setMessage] = useState("");
  const [images, setImages] = useState<Array<PromptImage & { id: string }>>([]);
  const [imageError, setImageError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [controlBusy, setControlBusy] = useState("");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const runtime = live.runtime;
  const controls = runtime?.sessionControls;
  const editorRevision = runtime?.extensionUi.editorRevision ?? 0;
  const editorText = runtime?.extensionUi.editorText ?? "";
  useEffect(() => { if (editorRevision > 0) setMessage(editorText); }, [editorRevision, editorText]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [runtime?.sessionId]);
  const connected = live.connection === "connected" && runtime?.ready === true && projectAvailable;
  const streaming = runtime?.conversation.streaming === true;
  const visibleMessages = runtime?.conversation.messages.filter((item) => {
    const text = item.text.trim();
    return item.role !== "assistant" || !["", "...", "…"].includes(text);
  }) ?? [];
  const conversationBlocks = useMemo(
    () => groupConversationMessages(visibleMessages, Boolean(runtime?.conversation.workStartedAt)),
    [runtime?.conversation.messages, runtime?.conversation.workStartedAt],
  );
  const copyableAssistants = useMemo(() => finalAssistantIds(visibleMessages), [runtime?.conversation.messages]);
  const latestTurnTimer = latestTimedAssistant(visibleMessages);
  const runningTools = runtime?.conversation.tools.filter((tool) => tool.status === "running") ?? [];
  const slashMatch = /^\/([^\s]*)$/.exec(message);
  const suggestions = slashMatch && !suggestionsDismissed
    ? (controls?.commands ?? [])
        .filter((command) => command.name.toLowerCase().startsWith(slashMatch[1]!.toLowerCase()))
        .slice(0, 8)
    : [];
  useEffect(() => { setSuggestionIndex(0); }, [message, controls?.commands]);
  const chooseSuggestion = (index: number) => {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    setMessage(`/${suggestion.name} `);
    setSuggestionIndex(0);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = message.trim();
    if ((!value && images.length === 0) || !connected) return;
    setSubmitting(true);
    try {
      await runtimeStore.sendMessage(value, images.map(({ data, mimeType }) => ({ data, mimeType })));
      setMessage("");
      setImages([]);
      setImageError("");
    }
    catch { /* Store exposes the command error in the live connection state. */ }
    finally { setSubmitting(false); }
  };
  const onPaste = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.type))
      .flatMap((item) => item.getAsFile() ?? []);
    if (!files.length) return;
    event.preventDefault();
    const available = 4 - images.length;
    if (files.length > available) {
      setImageError("You can attach up to 4 images.");
      return;
    }
    if (files.some((file) => file.size > 5 * 1024 * 1024)
      || files.reduce((total, file) => total + file.size, 0) + imageBytes(images) > 15 * 1024 * 1024) {
      setImageError("Images must be 5 MB each and 15 MB total.");
      return;
    }
    try {
      const pasted = await Promise.all(files.map(async (file) => ({
        id: crypto.randomUUID(),
        mimeType: file.type as PromptImage["mimeType"],
        data: await fileBase64(file),
      })));
      setImages((current) => [...current, ...pasted]);
      setImageError("");
    } catch {
      setImageError("The pasted image could not be read.");
    }
  };
  const setModel = async (value: string) => {
    const model = controls?.models.find((item) => `${item.provider}/${item.id}` === value);
    if (!model) return;
    setControlBusy("model");
    try { await runtimeStore.setModel(model.provider, model.id); }
    catch { /* Store exposes the command error in the live connection state. */ }
    finally { setControlBusy(""); }
  };
  const setThinking = async (level: NonNullable<typeof controls>["thinkingLevels"][number]) => {
    setControlBusy("thinking");
    try { await runtimeStore.setThinkingLevel(level); }
    catch { /* Store exposes the command error in the live connection state. */ }
    finally { setControlBusy(""); }
  };
  const controlsDisabled = !connected || streaming || submitting || Boolean(controlBusy);
  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSuggestionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        chooseSuggestion(suggestionIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggestionsDismissed(true);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
  return (
    <section className="conversation-panel" aria-label="Live conversation">
      {live.connection === "loading" && <div className="conversation-state">Loading runtime…</div>}
      {live.connection === "error" && <div className="conversation-state error">{live.error || "Unable to load runtime."}</div>}
      {live.connection === "disconnected" && <div className="conversation-state">Disconnected. Waiting to reconnect…</div>}
      {runtime && <div ref={streamRef} className="message-stream" aria-live="polite">
        {conversationBlocks.length === 0 && live.connection === "connected" && <div className="conversation-state">No messages yet. Start the conversation below.</div>}
        {conversationBlocks.map((block) => {
          if ("tools" in block) return <ToolTurnGroup key={block.id} tools={block.tools} />;
          if (block.role === "tool") return <ToolDisclosure key={block.id} name={block.tool?.name || "Tool"} status={block.tool?.status || "completed"} input={block.tool?.input} output={block.text} />;
          if (block.role === "system") return <SystemDisclosure key={block.id} message={block} />;
          return <Fragment key={block.id}>
            <article className={`conversation-message role-${block.role}`}>
              <small>{block.role}{block.streaming ? " · streaming" : ""}</small>
              {block.text && <MarkdownContent text={block.text} />}
              {Boolean(block.attachmentCount) && <span className="message-attachments"><IconPhoto size={14} />{block.attachmentCount} {block.attachmentCount === 1 ? "image" : "images"}</span>}
              {block.text && (block.role === "user" || copyableAssistants.has(block.id)) && <CopyMessageButton text={block.text} label={`Copy ${block.role === "user" ? "prompt" : "response"}`} />}
            </article>
            {block.role === "assistant" && Boolean(block.changedFiles?.length) && <ChangedFiles files={block.changedFiles!} />}
            {block.role === "assistant" && block.id !== latestTurnTimer?.id && block.workDurationMs !== undefined && <WorkTimer
              durationMs={block.workDurationMs}
              modelName={block.modelName}
              thinkingLevel={block.thinkingLevel}
            />}
          </Fragment>;
        })}
        {runningTools.map((tool) => <ToolDisclosure key={tool.id} name={tool.name || "Tool"} status={tool.status} input={tool.input} output={tool.summary} />)}
        {runtime.conversation.workStartedAt ? <WorkTimer
          startedAt={runtime.conversation.workStartedAt}
          modelName={runtime.conversation.workModelName}
          thinkingLevel={runtime.conversation.workThinkingLevel}
        /> : latestTurnTimer && <WorkTimer
          durationMs={latestTurnTimer.workDurationMs}
          modelName={latestTurnTimer.modelName}
          thinkingLevel={latestTurnTimer.thinkingLevel}
        />}
      </div>}
      {runtime?.conversation.retry.active && <p className="conversation-note">Retrying{runtime.conversation.retry.attempt ? ` (${runtime.conversation.retry.attempt})` : ""}…</p>}
      {runtime?.conversation.compaction.active && <p className="conversation-note">Compacting context…</p>}
      {runtime && <ExtensionUiSurface runtime={runtime} />}
      <form className="prompt-form" onSubmit={submit}>
        {images.length > 0 && <div className="prompt-images" aria-label="Attached images">
          {images.map((image, index) => <div className="prompt-image" key={image.id}>
            <img src={`data:${image.mimeType};base64,${image.data}`} alt={`Pasted image ${index + 1}`} />
            <button type="button" onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`Remove pasted image ${index + 1}`}><IconX size={13} /></button>
          </div>)}
        </div>}
        <label className="sr-only" htmlFor="runtime-prompt">Message</label>
        <div className="prompt-input-wrap">
          {suggestions.length > 0 && <div className="slash-suggestions" id="slash-command-suggestions" role="listbox" aria-label="Slash commands">
            {suggestions.map((command, index) => <button
              className={index === suggestionIndex ? "is-selected" : ""}
              type="button"
              role="option"
              aria-selected={index === suggestionIndex}
              key={`${command.source}-${command.name}`}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => chooseSuggestion(index)}
            >
              <strong>/{command.name}</strong>
              {command.description && <span>{command.description}</span>}
            </button>)}
          </div>}
          <textarea
            id="runtime-prompt"
            rows={1}
            value={message}
            onChange={(event) => { setMessage(event.target.value); setSuggestionsDismissed(false); }}
            onPaste={(event) => void onPaste(event)}
            onKeyDown={onPromptKeyDown}
            placeholder={!projectAvailable ? "Add a project to start" : connected ? (streaming ? "Send follow-up" : "Send a prompt") : "Runtime must be connected"}
            disabled={!connected || submitting}
            aria-autocomplete="list"
            aria-controls={suggestions.length ? "slash-command-suggestions" : undefined}
            aria-expanded={suggestions.length > 0}
          />
        </div>
        {imageError && <p className="prompt-error" role="alert">{imageError}</p>}
        <div className="prompt-toolbar">
          <div className="prompt-controls">
            <label>
              <span className="sr-only">Model</span>
              <select
                aria-label="Model"
                value={controls?.model ? `${controls.model.provider}/${controls.model.id}` : ""}
                onChange={(event) => void setModel(event.target.value)}
                disabled={controlsDisabled || !controls?.models.length}
              >
                {!controls?.model && <option value="">No model</option>}
                {controls?.models.map((model) => <option value={`${model.provider}/${model.id}`} key={`${model.provider}/${model.id}`}>{model.name}</option>)}
              </select>
            </label>
            <label>
              <span className="sr-only">Thinking level</span>
              <select
                aria-label="Thinking level"
                value={controls?.thinkingLevel ?? ""}
                onChange={(event) => void setThinking(event.target.value as NonNullable<typeof controls>["thinkingLevels"][number])}
                disabled={controlsDisabled || !controls?.thinkingLevels.length}
              >
                {!controls?.thinkingLevels.length && <option value="">Thinking unavailable</option>}
                {controls?.thinkingLevels.map((level) => <option value={level} key={level}>{thinkingLabel(level)}</option>)}
              </select>
            </label>
          </div>
          <div className="prompt-metrics" aria-label="Session usage">
            <span title={`${runtime?.metrics.contextTokens.toLocaleString() ?? 0} of ${runtime?.metrics.contextLimit.toLocaleString() ?? 0} tokens`}>
              {runtime ? `${runtime.metrics.contextPercent.toLocaleString(undefined, { maximumFractionDigits: 2 })}%` : "—"}
            </span>
            <span>{runtime ? `$${runtime.metrics.cost.toFixed(2)}` : "—"}</span>
          </div>
          <div className="prompt-actions">
            {streaming && <button className="prompt-abort" type="button" onClick={() => void runtimeStore.abort().catch(() => undefined)} disabled={!connected} aria-label="Stop response"><IconX size={15} /></button>}
            <button className="prompt-send" disabled={!connected || submitting || (!message.trim() && images.length === 0) || !controls?.model} type="submit" aria-label={streaming ? "Send follow-up" : "Send message"}><IconArrowUp size={16} /></button>
          </div>
        </div>
      </form>
    </section>
  );
}

const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(renderMarkdown(text), {
    ALLOWED_ATTR: markdownAttributes,
    ALLOWED_TAGS: markdownTags,
  }), [text]);

  return <div className="markdown-content" dangerouslySetInnerHTML={{ __html: html }} />;
});

function CopyMessageButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1_500);
    } catch {
      setState("error");
    }
  };
  return <button className={`message-copy ${state !== "idle" ? `is-${state}` : ""}`} type="button" onClick={() => void copy()} aria-label={state === "error" ? `${label} failed` : label} title={state === "copied" ? "Copied" : label}>
    {state === "copied" ? <IconCheck size={14} /> : <IconCopy size={14} />}
  </button>;
}

function finalAssistantIds(messages: MessageReadModel[]): Set<string> {
  const result = new Set<string>();
  let final: MessageReadModel | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      if (final) result.add(final.id);
      final = undefined;
    } else if (message.role === "assistant" && message.text.trim()) {
      final = message;
    }
  }
  if (final) result.add(final.id);
  return result;
}

function ChangedFiles({ files }: { files: NonNullable<MessageReadModel["changedFiles"]> }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? files : files.slice(0, 3);
  const remaining = files.length - 3;
  return <section className="changed-files" aria-label="Files changed in this turn">
    {visible.map((file) => <div className="changed-file" key={file.path}>
      <code>{file.path}</code>
      <span>{file.binary
        ? <small>binary</small>
        : <><ins>+{file.additions ?? 0}</ins><del>-{file.deletions ?? 0}</del></>}</span>
    </div>)}
    {files.length > 3 && <button type="button" onClick={() => setExpanded((current) => !current)}>
      {expanded ? "Show less" : `Show ${remaining} more`}
      <IconChevronDown className={expanded ? "is-expanded" : ""} size={14} />
    </button>}
  </section>;
}

function WorkTimer({ startedAt, durationMs, modelName, thinkingLevel }: { startedAt?: string; durationMs?: number; modelName?: string; thinkingLevel?: MessageReadModel["thinkingLevel"] }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const elapsed = durationMs ?? (Number.isNaN(started) ? 0 : Math.max(0, now - started));
  return <div className={`work-timer ${startedAt ? "is-active" : ""}`} role="status">
    {startedAt ? "Working for" : "Worked for"} {formatWorkDuration(elapsed)}
    {modelName && <> · {modelName}</>}
    {thinkingLevel && <> · {thinkingLabel(thinkingLevel)}</>}
  </div>;
}

function ToolTurnGroup({ tools }: { tools: MessageReadModel[] }) {
  const names = [...new Set(tools.map((tool) => tool.tool?.name || "Tool"))];
  return <details className="tool-turn-group">
    <summary><IconTool size={15} /><strong>{tools.length} tool {tools.length === 1 ? "call" : "calls"}</strong><span>{names.slice(0, 3).join(", ")}{names.length > 3 ? "…" : ""}</span></summary>
    <div className="tool-turn-items">
      {tools.map((tool) => <ToolDisclosure key={tool.id} name={tool.tool?.name || "Tool"} status={tool.tool?.status || "completed"} input={tool.tool?.input} output={tool.text} />)}
    </div>
  </details>;
}

function SystemDisclosure({ message }: { message: MessageReadModel }) {
  return <details className="system-disclosure">
    <summary><strong>System context</strong>{message.systemSource && <span>{message.systemSource}</span>}</summary>
    <p>{message.text}</p>
  </details>;
}

function imageBytes(images: PromptImage[]): number {
  return images.reduce((total, image) => total + Math.floor(image.data.length * 3 / 4), 0);
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function ToolDisclosure({ name, status, input, output }: { name: string; status: "running" | "completed" | "failed"; input?: string; output?: string }) {
  const inputPreview = input?.replace(/\s+/g, " ").trim();

  return <details className={`tool-disclosure is-${status}`}>
    <summary>
      <IconTool size={15} />
      <span className="tool-summary-copy">
        <strong>{name}</strong>
        {inputPreview && <code>{inputPreview}</code>}
      </span>
      <span className="tool-status">{status}</span>
    </summary>
    <div className="tool-details">
      <section><small>Input</small><pre>{input || "No input"}</pre></section>
      <section><small>Output</small><pre>{output || (status === "running" ? "Waiting for output…" : "No output")}</pre></section>
    </div>
  </details>;
}

function ExtensionUiSurface({ runtime }: { runtime: NonNullable<RuntimeStoreSnapshot["runtime"]> }) {
  const widgets = runtime.extensionUi.widgets.filter((widget) => (widget.placement ?? "aboveEditor") === "aboveEditor");
  if (widgets.length === 0) return null;
  return <div className="extension-ui extension-ui-aboveEditor">
    {widgets.map((widget) => <section className="extension-widget" key={widget.key} aria-label={widget.key}>{widget.lines.map((line, index) => <p key={index}>{line}</p>)}</section>)}
  </div>;
}
