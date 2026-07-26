import { IconArrowUp, IconPhoto, IconTool, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { groupConversationMessages } from "../shared/transcript";
import type { PromptImage } from "../shared/protocol/commands";
import type { MessageReadModel } from "../shared/protocol/events";
import { thinkingLabel } from "./format";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

export function ConversationPanel({ live }: { live: RuntimeStoreSnapshot }) {
  const [message, setMessage] = useState("");
  const [images, setImages] = useState<Array<PromptImage & { id: string }>>([]);
  const [imageError, setImageError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [controlBusy, setControlBusy] = useState("");
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
  const connected = live.connection === "connected" && runtime?.ready === true;
  const streaming = runtime?.conversation.streaming === true;
  const visibleMessages = runtime?.conversation.messages.filter((item) => {
    const text = item.text.trim();
    return item.role !== "assistant" || !["", "...", "…"].includes(text);
  }) ?? [];
  const conversationBlocks = groupConversationMessages(visibleMessages, streaming);
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
        {conversationBlocks.map((block) => "tools" in block
          ? <ToolTurnGroup key={block.id} tools={block.tools} />
          : block.role === "tool"
            ? <ToolDisclosure key={block.id} name={block.tool?.name || "Tool"} status={block.tool?.status || "completed"} input={block.tool?.input} output={block.text} />
            : block.role === "system"
              ? <SystemDisclosure key={block.id} message={block} />
              : <article className={`conversation-message role-${block.role}`} key={block.id}>
                <small>{block.role}{block.streaming ? " · streaming" : ""}</small>
                {block.text && <p>{block.text}</p>}
                {Boolean(block.attachmentCount) && <span className="message-attachments"><IconPhoto size={14} />{block.attachmentCount} {block.attachmentCount === 1 ? "image" : "images"}</span>}
              </article>)}
        {runtime.conversation.tools.filter((tool) => tool.status === "running").map((tool) => <ToolDisclosure key={tool.id} name={tool.name || "Tool"} status={tool.status} input={tool.input} output={tool.summary} />)}
      </div>}
      {live.error && live.connection === "connected" && <p className="conversation-note">{live.error}</p>}
      {runtime?.conversation.retry.active && <p className="conversation-note">Retrying{runtime.conversation.retry.attempt ? ` (${runtime.conversation.retry.attempt})` : ""}…</p>}
      {runtime?.conversation.compaction.active && <p className="conversation-note">Compacting context…</p>}
      {runtime && <ExtensionUiSurface runtime={runtime} placement="aboveEditor" />}
      <form className="prompt-form" onSubmit={submit}>
        {images.length > 0 && <div className="prompt-images" aria-label="Attached images">
          {images.map((image, index) => <div className="prompt-image" key={image.id}>
            <img src={`data:${image.mimeType};base64,${image.data}`} alt={`Pasted image ${index + 1}`} />
            <button type="button" onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`Remove pasted image ${index + 1}`}><IconX size={13} /></button>
          </div>)}
        </div>}
        <label className="sr-only" htmlFor="runtime-prompt">Message</label>
        <textarea id="runtime-prompt" rows={1} value={message} onChange={(event) => setMessage(event.target.value)} onPaste={(event) => void onPaste(event)} onKeyDown={onPromptKeyDown} placeholder={connected ? (streaming ? "Send follow-up" : "Send a prompt") : "Runtime must be connected"} disabled={!connected || submitting} />
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
                {controls?.models.map((model) => <option value={`${model.provider}/${model.id}`} key={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}
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
          <div className="prompt-actions">
            {streaming && <button className="prompt-abort" type="button" onClick={() => void runtimeStore.abort().catch(() => undefined)} disabled={!connected} aria-label="Stop response"><IconX size={15} /></button>}
            <button className="prompt-send" disabled={!connected || submitting || (!message.trim() && images.length === 0) || !controls?.model} type="submit" aria-label={streaming ? "Send follow-up" : "Send message"}><IconArrowUp size={16} /></button>
          </div>
        </div>
      </form>
      {runtime && <ExtensionUiSurface runtime={runtime} placement="belowEditor" />}
    </section>
  );
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

function ExtensionUiSurface({ runtime, placement }: { runtime: NonNullable<RuntimeStoreSnapshot["runtime"]>; placement: "aboveEditor" | "belowEditor" }) {
  const widgets = runtime.extensionUi.widgets.filter((widget) => (widget.placement ?? "aboveEditor") === placement);
  if (placement === "belowEditor" && runtime.extensionUi.notifications.length === 0 && runtime.extensionUi.statuses.length === 0 && widgets.length === 0) return null;
  if (placement === "aboveEditor" && widgets.length === 0) return null;
  return <div className={`extension-ui extension-ui-${placement}`}>
    {widgets.map((widget) => <section className="extension-widget" key={widget.key} aria-label={widget.key}>{widget.lines.map((line, index) => <p key={index}>{line}</p>)}</section>)}
    {placement === "belowEditor" && runtime.extensionUi.statuses.length > 0 && <dl className="extension-statuses">{runtime.extensionUi.statuses.map((status) => <div key={status.key}><dt>{status.key}</dt><dd>{status.text}</dd></div>)}</dl>}
    {placement === "belowEditor" && <div className="extension-notifications" aria-live="polite" aria-atomic="true">{runtime.extensionUi.notifications.slice(-3).map((item) => <p className={`tone-${item.type}`} key={item.id}>{item.message}</p>)}</div>}
  </div>;
}
