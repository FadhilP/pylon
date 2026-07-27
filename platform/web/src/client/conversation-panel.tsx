import { IconArrowBackUp, IconArrowUp, IconBulb, IconCheck, IconChevronDown, IconCopy, IconFileText, IconPencil, IconPhoto, IconPlus, IconRobot, IconSquareFilled, IconTool, IconX } from "@tabler/icons-react";
import DOMPurify from "dompurify";
import { memo, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { groupConversationMessages, latestTimedAssistant } from "../shared/transcript";
import { formatWorkDuration } from "../shared/format";
import { renderMarkdown } from "../shared/markdown";
import { fileMentionAtCaret, isNearTranscriptBottom, replaceFileMention } from "../shared/composer-input";
import type { PromptImage, PromptTextFile } from "../shared/protocol/commands";
import type { DelegatedAgentKind, DelegatedAgentRunReadModel, MessageReadModel, ModelOptionReadModel, SessionControlsReadModel, ThinkingLevelReadModel } from "../shared/protocol/events";
import type { ConversationTurnIndexItem, ConversationTurnIndexPage } from "../shared/protocol/snapshots";
import { thinkingLabel } from "./format";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";
import { agentColor } from "./agent-color";

const markdownTags = ["a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul"];
const markdownAttributes = ["alt", "checked", "class", "data-language", "disabled", "href", "src", "title", "type"];
type PastedImage = PromptImage & { id: string };
type DroppedTextFile = PromptTextFile & { id: string };
interface PromptEdit {
  messageId: string;
  entryId: string;
  text: string;
  images: PastedImage[];
  imageError: string;
  attachmentCount: number;
}
interface PromptUndo {
  entryId: string;
  text: string;
  attachmentCount: number;
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName !== "A") return;
  (node as HTMLAnchorElement).target = "_blank";
  (node as HTMLAnchorElement).rel = "noopener noreferrer";
});

export function ConversationPanel({
  live,
  projectAvailable = true,
  onSelectAgent,
}: {
  live: RuntimeStoreSnapshot;
  projectAvailable?: boolean;
  onSelectAgent?: (id: string) => void;
}) {
  const [message, setMessage] = useState("");
  const [images, setImages] = useState<PastedImage[]>([]);
  const [files, setFiles] = useState<DroppedTextFile[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [edit, setEdit] = useState<PromptEdit>();
  const [undo, setUndo] = useState<PromptUndo>();
  const [visibleTurnIds, setVisibleTurnIds] = useState<Set<string>>(() => new Set());
  const [railPage, setRailPage] = useState<ConversationTurnIndexPage>();
  const [railLoading, setRailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [controlBusy, setControlBusy] = useState("");
  const [historyLoading, setHistoryLoading] = useState<"page" | "all" | "newer">();
  const [openMenu, setOpenMenu] = useState<"plus" | "model">();
  const [planMode, setPlanMode] = useState(false);
  const [queueBusy, setQueueBusy] = useState<"edit" | "steer">();
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [caretPosition, setCaretPosition] = useState(0);
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const streamRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const followBottomRef = useRef(true);
  const turnRefs = useRef(new Map<string, HTMLElement>());
  const runtime = live.runtime;
  const controls = runtime?.sessionControls;
  const editorRevision = runtime?.extensionUi.editorRevision ?? 0;
  const editorText = runtime?.extensionUi.editorText ?? "";
  useEffect(() => { if (editorRevision > 0) setMessage(editorText); }, [editorRevision, editorText]);
  useEffect(() => {
    followBottomRef.current = true;
    const frame = requestAnimationFrame(() => {
      if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [runtime?.sessionId, runtime?.sessionGeneration]);
  useEffect(() => {
    const stream = streamRef.current;
    const transcript = transcriptRef.current;
    if (!stream || !transcript || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followBottomRef.current) stream.scrollTop = stream.scrollHeight;
    });
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [runtime?.sessionId]);
  useEffect(() => {
    setHistoryLoading(undefined);
    setEdit(undefined);
    setUndo(undefined);
    setRailPage(undefined);
    setVisibleTurnIds(new Set());
    turnRefs.current.clear();
  }, [runtime?.sessionId]);
  const connected = live.connection === "connected" && runtime?.ready === true && projectAvailable;
  const streaming = runtime?.conversation.streaming === true;
  const running = Boolean(runtime?.conversation.workStartedAt);
  const queued = runtime?.conversation.queue.pending;
  const hasDraft = Boolean(message.trim() || images.length || files.length);
  const planAvailable = controls?.commands?.some((command) => command.name === "plan" && command.source === "extension") === true;
  const activeHistoryWindow = live.historyWindow;
  const transcriptMessages = activeHistoryWindow && activeHistoryWindow.sessionId === runtime?.sessionId
    ? activeHistoryWindow.messages
    : runtime?.conversation.messages ?? [];
  const transcriptToolIds = new Set(transcriptMessages.flatMap((item) => item.tool?.id ? [item.tool.id] : []));
  const runningTools = runtime?.conversation.tools.filter((tool) => tool.status === "running") ?? [];
  const liveToolMessages: MessageReadModel[] = runningTools
    .filter((tool) => !transcriptToolIds.has(tool.id))
    .map((tool) => ({
      id: `live-tool-${tool.id}`,
      role: "tool",
      text: tool.summary ?? "",
      streaming: true,
      tool: { id: tool.id, name: tool.name || "Tool", input: tool.input, status: tool.status },
    }));
  const visibleMessages = [...transcriptMessages, ...liveToolMessages].filter((item) => {
    const text = item.text.trim();
    return item.role !== "assistant" || !["", "...", "…"].includes(text);
  }) ?? [];
  const conversationBlocks = useMemo(
    () => groupConversationMessages(visibleMessages),
    [transcriptMessages, runtime?.conversation.tools],
  );
  const copyableAssistants = useMemo(() => finalAssistantIds(visibleMessages), [transcriptMessages]);
  const userTurns = useMemo(
    () => visibleMessages.filter((item) => item.role === "user" && item.entryId),
    [transcriptMessages],
  );
  const userTurnKey = userTurns.map((item) => item.entryId ?? item.id).join("\0");
  useEffect(() => {
    const root = streamRef.current;
    if (!root || !userTurns.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const viewport = root.getBoundingClientRect();
      const visible = new Set<string>();
      for (const turn of userTurns) {
        const id = turn.entryId ?? turn.id;
        const element = turnRefs.current.get(id);
        if (!element) continue;
        const bounds = element.getBoundingClientRect();
        if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) visible.add(id);
      }
      setVisibleTurnIds((current) => sameStringSet(current, visible) ? current : visible);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    if (transcriptRef.current) observer?.observe(transcriptRef.current);
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [runtime?.sessionId, userTurnKey]);
  useEffect(() => {
    if (!runtime || runtime.metrics.userMessages < 3) {
      setRailPage(undefined);
      return;
    }
    if (live.connection !== "connected" || !runtime.ready) return;
    let active = true;
    setRailLoading(true);
    void runtimeStore.conversationTurnIndex().then((page) => {
      if (active) setRailPage(page);
    }).catch((error) => {
      if (!active) return;
      setRailPage(undefined);
      runtimeStore.reportError(error instanceof Error ? error.message : "Unable to load conversation turns");
    }).finally(() => {
      if (active) setRailLoading(false);
    });
    return () => { active = false; };
  }, [live.connection, runtime?.ready, runtime?.sessionId, runtime?.sessionGeneration, runtime?.metrics.userMessages]);
  const latestTurnTimer = latestTimedAssistant(visibleMessages);
  const activeAgents = runtime?.conversation.delegatedRuns.filter((run) => run.status === "running") ?? [];
  const slashMatch = /^\/([^\s]*)$/.exec(message);
  const suggestions = slashMatch && !suggestionsDismissed
    ? (controls?.commands ?? [])
        .filter((command) => command.name.toLowerCase().startsWith(slashMatch[1]!.toLowerCase()))
        .slice(0, 8)
    : [];
  const fileMention = useMemo(
    () => slashMatch || suggestionsDismissed ? undefined : fileMentionAtCaret(message, caretPosition),
    [caretPosition, message, slashMatch, suggestionsDismissed],
  );
  useEffect(() => {
    if (!fileMention || !connected) {
      setFileSuggestions([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void runtimeStore.fileSuggestions(fileMention.query).then((result) => {
        if (active) setFileSuggestions(result.available ? result.paths : []);
      }).catch(() => {
        if (active) setFileSuggestions([]);
      });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [connected, fileMention?.query, runtime?.sessionId]);
  useEffect(() => { setSuggestionIndex(0); }, [message, controls?.commands, fileSuggestions.join("\0")]);
  const chooseSuggestion = (index: number) => {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    setMessage(`/${suggestion.name} `);
    setSuggestionIndex(0);
  };
  const chooseFileSuggestion = (index: number) => {
    const path = fileSuggestions[index];
    if (!path || !fileMention) return;
    const next = replaceFileMention(message, fileMention, path);
    setMessage(next.value);
    setCaretPosition(next.caret);
    setFileSuggestions([]);
    setSuggestionsDismissed(true);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = message.trim();
    if ((!value && images.length === 0 && files.length === 0) || !connected || queued) return;
    setSubmitting(true);
    try {
      await runtimeStore.sendMessage(
        value,
        images.map(({ data, mimeType }) => ({ data, mimeType })),
        files.map(({ name, text, size, mimeType }) => ({ name, text, size, ...(mimeType ? { mimeType } : {}) })),
        planMode,
      );
      setMessage("");
      setImages([]);
      setFiles([]);
      setPlanMode(false);
    }
    catch { /* Store exposes the command error in the live connection state. */ }
    finally { setSubmitting(false); }
  };
  const onPaste = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    try {
      const pasted = await readPastedImages(event, images);
      if (!pasted) return;
      setImages(pasted);
    } catch (error) {
      runtimeStore.reportError(error instanceof Error ? error.message : "The pasted image could not be read.");
    }
  };
  const onDrop = async (event: ReactDragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDropActive(false);
    try {
      const dropped = [...event.dataTransfer.files];
      if (!dropped.length) throw new Error("No files were dropped.");
      const next = await readDroppedFiles(dropped, images, files);
      setImages(next.images);
      setFiles(next.files);
    } catch (error) {
      runtimeStore.reportError(error instanceof Error ? error.message : "The dropped files could not be read.");
    }
  };
  const addFiles = async (selected: File[]) => {
    if (!selected.length) return;
    try {
      const next = await readDroppedFiles(selected, images, files);
      setImages(next.images);
      setFiles(next.files);
    } catch (error) {
      runtimeStore.reportError(error instanceof Error ? error.message : "The selected files could not be read.");
    }
  };
  const setSessionControls = async (model: ModelOptionReadModel, level: ThinkingLevelReadModel) => {
    setControlBusy("controls");
    try { await runtimeStore.setSessionControls(model.provider, model.id, level); }
    finally { setControlBusy(""); }
  };
  const controlsDisabled = !connected || submitting || Boolean(controlBusy);
  const restoreQueued = async () => {
    if (!queued || queued.state !== "queued") return;
    setQueueBusy("edit");
    try {
      const restored = await runtimeStore.restoreQueuedPrompt(queued.id);
      setMessage(restored.message);
      setImages((restored.images ?? []).map((image) => ({ ...image, id: crypto.randomUUID() })));
      setFiles((restored.files ?? []).map((file) => ({ ...file, id: crypto.randomUUID() })));
      setPlanMode(restored.planMode);
    } catch {
      // Store routes the failure through the application toast.
    } finally {
      setQueueBusy(undefined);
    }
  };
  const steerQueued = async () => {
    if (!queued || queued.state !== "queued") return;
    setQueueBusy("steer");
    try { await runtimeStore.steerQueuedPrompt(queued.id); }
    catch { /* Store routes the failure through the application toast. */ }
    finally { setQueueBusy(undefined); }
  };
  const loadHistory = async (all: boolean, preserveAnchor = false) => {
    const stream = streamRef.current;
    followBottomRef.current = false;
    const viewportTop = stream?.getBoundingClientRect().top ?? 0;
    const anchor = preserveAnchor
      ? [...(transcriptRef.current?.children ?? [])].find((element) =>
          element.getBoundingClientRect().bottom > viewportTop) as HTMLElement | undefined
      : undefined;
    const anchorTop = anchor?.getBoundingClientRect().top;
    setHistoryLoading(all ? "all" : "page");
    try {
      await runtimeStore.loadEarlierMessages(all);
      requestAnimationFrame(() => {
        if (!stream) return;
        if (preserveAnchor && anchor?.isConnected && anchorTop !== undefined) {
          stream.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
          return;
        }
        stream.scrollTop = 0;
      });
    } catch {
      // Store routes the failure through the application toast.
    } finally {
      setHistoryLoading(undefined);
    }
  };
  const loadNewerHistory = async () => {
    if (historyLoading) return;
    setHistoryLoading("newer");
    try {
      await runtimeStore.loadLaterMessages();
    } catch {
      // Store routes the failure through the application toast.
    } finally {
      setHistoryLoading(undefined);
    }
  };
  const loadRailPage = async (direction: "earlier" | "later", cursor?: string) => {
    if (!cursor || railLoading) return;
    setRailLoading(true);
    try {
      setRailPage(await runtimeStore.conversationTurnIndex({ cursor, direction }));
    } catch {
      // Keep the current rail segment when paging fails.
    } finally {
      setRailLoading(false);
    }
  };
  const selectRailTurn = async (turn: ConversationTurnIndexItem) => {
    const loaded = turnRefs.current.get(turn.promptId);
    if (loaded) {
      loaded.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setHistoryLoading("page");
    try {
      await runtimeStore.jumpToHistory(turn.cursor);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        turnRefs.current.get(turn.promptId)?.scrollIntoView({ behavior: "auto", block: "start" });
      }));
    } catch {
      // Store routes the failure through the application toast.
    } finally {
      setHistoryLoading(undefined);
    }
  };
  const startEdit = (item: MessageReadModel) => {
    if (!item.entryId) return;
    setEdit({
      messageId: item.id,
      entryId: item.entryId,
      text: item.text,
      images: [],
      imageError: "",
      attachmentCount: item.attachmentCount ?? 0,
    });
  };
  const submitEdit = async () => {
    if (!edit || (!edit.text.trim() && edit.images.length === 0)) return;
    setSubmitting(true);
    try {
      await runtimeStore.editPrompt(
        edit.entryId,
        edit.text.trim(),
        edit.images.map(({ data, mimeType }) => ({ data, mimeType })),
        false,
      );
      setEdit(undefined);
    } finally {
      setSubmitting(false);
    }
  };
  const submitUndo = async () => {
    if (!undo) return;
    setSubmitting(true);
    try {
      await runtimeStore.rewindPrompt(undo.entryId);
      setMessage(undo.text);
      setImages([]);
      setFiles([]);
      setPlanMode(false);
      setUndo(undefined);
      requestAnimationFrame(() => promptRef.current?.focus());
    } finally {
      setSubmitting(false);
    }
  };
  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const activeSuggestions = suggestions.length ? suggestions : fileSuggestions;
    if (activeSuggestions.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSuggestionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + activeSuggestions.length) % activeSuggestions.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (suggestions.length) chooseSuggestion(suggestionIndex);
        else chooseFileSuggestion(suggestionIndex);
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
      {activeAgents.length > 0 && <ActiveAgents runs={activeAgents} onSelect={onSelectAgent} />}
      {runtime && <div
        ref={streamRef}
        className="message-stream"
        aria-live="polite"
        onScroll={(event) => {
          followBottomRef.current = isNearTranscriptBottom(event.currentTarget);
          if (!historyLoading && event.currentTarget.scrollTop < 64 && live.historyWindow?.earlierCursor) {
            void loadHistory(false, true);
          } else if (!historyLoading && isNearTranscriptBottom(event.currentTarget, 64)
            && live.historyWindow?.laterCursor) {
            void loadNewerHistory();
          }
        }}
      >
        <div className="transcript-layout">
          <div ref={transcriptRef} className="transcript-column">
        {live.historyWindow?.earlierCursor && <div className="history-loader">
          <span>{runtime.conversation.historyRemaining?.toLocaleString()} earlier entries</span>
          <div>
            <button type="button" disabled={Boolean(historyLoading)} onClick={() => void loadHistory(false)}>
              {historyLoading === "page" ? "Loading…" : "Load 100 earlier"}
            </button>
            <button type="button" disabled={Boolean(historyLoading)} onClick={() => void loadHistory(true)}>
              {historyLoading === "all" ? "Loading all…" : "Load all"}
            </button>
          </div>
        </div>}
        {conversationBlocks.length === 0 && live.connection === "connected" && <div className="conversation-state">No messages yet. Start the conversation below.</div>}
        {conversationBlocks.map((block) => {
          if ("tools" in block) return <ToolTurnGroup key={block.id} tools={block.tools} />;
          if (block.role === "tool") return <ToolDisclosure key={block.id} name={block.tool?.name || "Tool"} status={block.tool?.status || "completed"} input={block.tool?.input} output={block.text} />;
          if (block.role === "system") return <SystemDisclosure key={block.id} message={block} />;
          const editing = edit?.messageId === block.id;
          return <div className={`message-block role-${block.role}`} key={block.id}>
            <article
              className={`conversation-message role-${block.role}${editing ? " is-editing" : ""}`}
              data-turn-id={block.role === "user" ? block.id : undefined}
              ref={block.role === "user" ? (element) => {
                const turnId = block.entryId ?? block.id;
                if (element) turnRefs.current.set(turnId, element);
                else turnRefs.current.delete(turnId);
              } : undefined}
            >
              <small>{block.role}{block.streaming ? " · streaming" : ""}</small>
              {editing && edit
                ? <PromptEditor edit={edit} disabled={submitting} onChange={setEdit} onCancel={() => setEdit(undefined)} onSubmit={() => void submitEdit()} />
                : <>
                  {block.text && <MarkdownContent text={block.text} />}
                  {Boolean(block.attachmentCount) && <span className="message-attachments"><IconPhoto size={14} />{block.attachmentCount} {block.attachmentCount === 1 ? "image" : "images"}</span>}
                  {Boolean(block.fileAttachmentCount) && <span className="message-attachments"><IconFileText size={14} />{block.fileAttachmentCount} {block.fileAttachmentCount === 1 ? "file" : "files"}</span>}
                </>}
            </article>
            {block.role === "assistant" && Boolean(block.changedFiles?.length) && <ChangedFiles files={block.changedFiles!} />}
            {!editing && (block.role === "user" || copyableAssistants.has(block.id)) && <MessageFooter
              message={block}
              canCopy={Boolean(block.text)}
              disabled={!connected || streaming || submitting || Boolean(edit)}
              onEdit={block.role === "user" && block.entryId ? () => startEdit(block) : undefined}
              onUndo={block.role === "user" && block.entryId ? () => setUndo({
                entryId: block.entryId!,
                text: block.text,
                attachmentCount: block.attachmentCount ?? 0,
              }) : undefined}
            />}
            {block.role === "assistant" && block.id !== latestTurnTimer?.id && block.workDurationMs !== undefined && <WorkTimer
              durationMs={block.workDurationMs}
              modelName={block.modelName}
              thinkingLevel={block.thinkingLevel}
            />}
          </div>;
        })}
        {runtime.conversation.workStartedAt ? <WorkTimer
          startedAt={runtime.conversation.workStartedAt}
          modelName={runtime.conversation.workModelName}
          thinkingLevel={runtime.conversation.workThinkingLevel}
        /> : latestTurnTimer && <WorkTimer
          durationMs={latestTurnTimer.workDurationMs}
          modelName={latestTurnTimer.modelName}
          thinkingLevel={latestTurnTimer.thinkingLevel}
        />}
        {live.historyWindow?.laterCursor && <div className="history-loader is-later">
          <button type="button" disabled={Boolean(historyLoading)} onClick={() => void loadNewerHistory()}>
            {historyLoading === "newer" ? "Loading…" : "Load 100 newer"}
          </button>
        </div>}
          </div>
        </div>
      </div>}
      {runtime && <HistoryRail
        page={railPage}
        visibleIds={visibleTurnIds}
        loading={railLoading}
        onPage={(direction, cursor) => void loadRailPage(direction, cursor)}
        onSelect={(turn) => void selectRailTurn(turn)}
      />}
      {undo && <UndoConfirmDialog
        undo={undo}
        submitting={submitting}
        onCancel={() => setUndo(undefined)}
        onConfirm={() => void submitUndo()}
      />}
      {runtime?.conversation.retry.active && <p className="conversation-note">Retrying{runtime.conversation.retry.attempt ? ` (${runtime.conversation.retry.attempt})` : ""}…</p>}
      {runtime?.conversation.compaction.active && <p className="conversation-note">Compacting context…</p>}
      {runtime && <ExtensionUiSurface runtime={runtime} />}
      <form
        className={`prompt-form${dropActive ? " is-drop-active" : ""}`}
        onSubmit={submit}
        onDragEnter={(event) => { event.preventDefault(); setDropActive(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
        }}
        onDrop={(event) => void onDrop(event)}
      >
        {dropActive && <div className="composer-drop-overlay"><IconFileText size={18} />Drop images, text, or code files</div>}
        {images.length > 0 && <ImageStrip
          images={images}
          label="Attached images"
          onRemove={(id) => setImages((current) => current.filter((item) => item.id !== id))}
        />}
        {files.length > 0 && <FileStrip files={files} onRemove={(id) => setFiles((current) => current.filter((item) => item.id !== id))} />}
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
          {suggestions.length === 0 && fileSuggestions.length > 0 && <div className="slash-suggestions file-suggestions" id="file-mention-suggestions" role="listbox" aria-label="Project files">
            {fileSuggestions.map((path, index) => {
              const separator = path.lastIndexOf("/");
              const name = separator >= 0 ? path.slice(separator + 1) : path;
              const directory = separator >= 0 ? path.slice(0, separator) : "";
              return <button
                className={index === suggestionIndex ? "is-selected" : ""}
                type="button"
                role="option"
                aria-selected={index === suggestionIndex}
                key={path}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => chooseFileSuggestion(index)}
              >
                <strong><IconFileText size={13} />{name}</strong>
                {directory && <span>{directory}</span>}
              </button>;
            })}
          </div>}
          <textarea
            ref={promptRef}
            id="runtime-prompt"
            rows={1}
            value={message}
            onChange={(event) => {
              setMessage(event.target.value);
              setCaretPosition(event.target.selectionStart);
              setSuggestionsDismissed(false);
            }}
            onSelect={(event) => setCaretPosition(event.currentTarget.selectionStart)}
            onPaste={(event) => void onPaste(event)}
            onKeyDown={onPromptKeyDown}
            placeholder={!projectAvailable ? "Add a project to start" : connected ? (queued ? "A message is already queued" : running ? "Queue a follow-up" : "Send a prompt") : "Runtime must be connected"}
            disabled={!connected || submitting || Boolean(queued)}
            aria-autocomplete="list"
            aria-controls={suggestions.length ? "slash-command-suggestions" : fileSuggestions.length ? "file-mention-suggestions" : undefined}
            aria-expanded={suggestions.length > 0 || fileSuggestions.length > 0}
          />
        </div>
        {queued && <div className="queued-prompt" role="status">
          <div>
            <strong>{queued.state === "delivering" ? "Sending next" : "Queued next"}</strong>
            <span>{queued.preview || `${queued.attachmentCount + queued.fileAttachmentCount} attached files`}</span>
            {(queued.attachmentCount > 0 || queued.fileAttachmentCount > 0 || queued.planMode) && <small>
              {queued.attachmentCount > 0 && `${queued.attachmentCount} image${queued.attachmentCount === 1 ? "" : "s"}`}
              {queued.attachmentCount > 0 && queued.fileAttachmentCount > 0 && " · "}
              {queued.fileAttachmentCount > 0 && `${queued.fileAttachmentCount} file${queued.fileAttachmentCount === 1 ? "" : "s"}`}
              {(queued.attachmentCount > 0 || queued.fileAttachmentCount > 0) && queued.planMode && " · "}
              {queued.planMode && "Plan mode"}
            </small>}
          </div>
          <div>
            <button type="button" disabled={queued.state !== "queued" || Boolean(queueBusy)} onClick={() => void restoreQueued()}>{queueBusy === "edit" ? "Restoring…" : "Edit"}</button>
            <button type="button" disabled={queued.state !== "queued" || Boolean(queueBusy)} onClick={() => void steerQueued()}>{queueBusy === "steer" ? "Steering…" : "Steer now"}</button>
          </div>
        </div>}
        <div className="prompt-toolbar">
          <div className="prompt-left">
            <PlusMenu
              open={openMenu === "plus"}
              active={planMode}
              disabled={!connected || submitting || Boolean(queued)}
              available={planAvailable}
              onToggle={() => setOpenMenu((current) => current === "plus" ? undefined : "plus")}
              onClose={() => setOpenMenu(undefined)}
              onChange={setPlanMode}
              onFiles={addFiles}
            />
            {planMode && <button className="plan-mode-indicator" type="button" onClick={() => setPlanMode(false)} aria-label="Turn off Plan mode" title="Turn off Plan mode"><IconBulb size={14} />Plan mode</button>}
          </div>
          <div className="prompt-right">
          <div className="prompt-metrics" aria-label="Session usage">
            <span title={`${runtime?.metrics.contextTokens.toLocaleString() ?? 0} of ${runtime?.metrics.contextLimit.toLocaleString() ?? 0} tokens`}>
              {runtime ? `${runtime.metrics.contextPercent.toLocaleString(undefined, { maximumFractionDigits: 2 })}%` : "—"}
            </span>
            <span>{runtime ? `$${runtime.metrics.cost.toFixed(2)}` : "—"}</span>
          </div>
          <ModelControl
            controls={controls}
            open={openMenu === "model"}
            disabled={controlsDisabled}
            busy={controlBusy === "controls"}
            onToggle={() => setOpenMenu((current) => current === "model" ? undefined : "model")}
            onClose={() => setOpenMenu(undefined)}
            onApply={setSessionControls}
          />
          {running && !hasDraft
            ? <button className="prompt-abort" type="button" onClick={() => void runtimeStore.abort().catch(() => undefined)} disabled={!connected} aria-label="Stop response"><IconSquareFilled size={13} /></button>
            : <button className="prompt-send" disabled={!connected || submitting || Boolean(queued) || !hasDraft || !controls?.model} type="submit" aria-label={running ? "Queue message" : "Send message"}><IconArrowUp size={16} /></button>}
          </div>
        </div>
      </form>
    </section>
  );
}

function PlusMenu({
  open,
  active,
  disabled,
  available,
  onToggle,
  onClose,
  onChange,
  onFiles,
}: {
  open: boolean;
  active: boolean;
  disabled: boolean;
  available: boolean;
  onToggle: () => void;
  onClose: () => void;
  onChange: (active: boolean) => void;
  onFiles: (files: File[]) => Promise<void>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", keyDown);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus());
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", keyDown);
    };
  }, [open]);
  return <div ref={rootRef} className="composer-popover-root">
    <button
      ref={triggerRef}
      className={`composer-plus${active ? " is-active" : ""}`}
      type="button"
      disabled={disabled}
      aria-label="Add prompt option"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onToggle}
    ><IconPlus size={17} /></button>
    {open && <div className="plus-menu composer-popover" role="menu">
      <span>Add</span>
      <button type="button" role="menuitem" onClick={() => fileRef.current?.click()}>
        <strong>Files and images</strong>
        <small>Select one or more attachments</small>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!available}
        onClick={() => { onChange(!active); onClose(); triggerRef.current?.focus(); }}
      >
        <strong>Plan mode</strong>
        <small>{available ? "Plan the next prompt" : "Continuity /plan is unavailable"}</small>
        {active && <IconCheck size={15} />}
      </button>
    </div>}
    <input
      ref={fileRef}
      className="sr-only"
      type="file"
      multiple
      tabIndex={-1}
      aria-label="Select files and images"
      onChange={(event) => {
        const selected = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = "";
        onClose();
        void onFiles(selected).finally(() => triggerRef.current?.focus());
      }}
    />
  </div>;
}

function ModelControl({
  controls,
  open,
  disabled,
  busy,
  onToggle,
  onClose,
  onApply,
}: {
  controls?: SessionControlsReadModel;
  open: boolean;
  disabled: boolean;
  busy: boolean;
  onToggle: () => void;
  onClose: () => void;
  onApply: (model: ModelOptionReadModel, level: ThinkingLevelReadModel) => Promise<void>;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [modelKey, setModelKey] = useState("");
  const [level, setLevel] = useState<ThinkingLevelReadModel>("off");
  const selectedModel = controls?.models.find((model) => `${model.provider}/${model.id}` === modelKey);
  const levels = selectedModel?.thinkingLevels ?? [];
  const levelIndex = Math.max(0, levels.indexOf(level));

  useEffect(() => {
    if (!open) return;
    const selectedControls = controls?.pending ?? controls;
    const currentKey = selectedControls?.model ? `${selectedControls.model.provider}/${selectedControls.model.id}` : "";
    const currentModel = controls?.models.find((model) => `${model.provider}/${model.id}` === currentKey);
    const availableLevels = currentModel?.thinkingLevels ?? [];
    setModelKey(currentKey);
    setLevel(availableLevels.includes(selectedControls?.thinkingLevel ?? "off")
      ? selectedControls?.thinkingLevel ?? "off"
      : availableLevels[0] ?? "off");
    const pointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    };
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("keydown", keyDown);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>("[aria-current=true]")?.focus());
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", keyDown);
    };
  }, [open]);

  const applySelection = (model: ModelOptionReadModel, nextLevel: ThinkingLevelReadModel) => {
    void onApply(model, nextLevel).catch(() => {
      // The shared toast reports the rejected mutation.
    });
  };
  const chooseModel = (model: ModelOptionReadModel) => {
    const nextLevels = model.thinkingLevels ?? [];
    const nextLevel = nextLevels.includes(level) ? level : nextLevels[0] ?? "off";
    setModelKey(`${model.provider}/${model.id}`);
    setLevel(nextLevel);
    applySelection(model, nextLevel);
  };
  const navigateModels = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || event.target instanceof HTMLInputElement) return;
    const buttons = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-model-option]") ?? [])];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    buttons[(Math.max(0, current) + offset + buttons.length) % buttons.length]?.focus();
  };

  return <div ref={rootRef} className="composer-popover-root model-control">
    <button
      ref={triggerRef}
      className="model-trigger"
      type="button"
      disabled={disabled || !controls?.models.length}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span>{controls?.pending ? `Next: ${controls.pending.model.name}` : controls?.model?.name ?? "No model"}</span>
      {(controls?.pending?.thinkingLevel ?? controls?.thinkingLevel) && <small>{thinkingLabel(controls?.pending?.thinkingLevel ?? controls?.thinkingLevel ?? "off")}</small>}
      <IconChevronDown size={14} />
    </button>
    {open && <div className="model-popover composer-popover" role="dialog" aria-label="Model and thinking" aria-busy={busy} onKeyDown={navigateModels}>
      <div className="model-options" role="listbox" aria-label="Models">
        {controls?.models.map((model) => {
          const key = `${model.provider}/${model.id}`;
          return <button
            type="button"
            role="option"
            data-model-option
            aria-selected={key === modelKey}
            aria-current={key === modelKey}
            key={key}
            onClick={() => chooseModel(model)}
          >
            <span>{model.name}</span>
            {key === modelKey && <IconCheck size={15} />}
          </button>;
        })}
      </div>
      <div className="thinking-slider">
        <span>Thinking</span>
        <strong>{thinkingLabel(levels[levelIndex] ?? "off")}</strong>
        <input
          type="range"
          min={0}
          max={Math.max(0, levels.length - 1)}
          step={1}
          value={levelIndex}
          disabled={levels.length < 2}
          aria-label="Thinking level"
          aria-valuetext={thinkingLabel(levels[levelIndex] ?? "off")}
          onChange={(event) => {
            const nextLevel = levels[Number(event.target.value)] ?? "off";
            setLevel(nextLevel);
            if (selectedModel) applySelection(selectedModel, nextLevel);
          }}
        />
        <div>{levels.map((item) => <i key={item} aria-hidden="true" />)}</div>
      </div>
    </div>}
  </div>;
}

function HistoryRail({
  page,
  visibleIds,
  loading,
  onPage,
  onSelect,
}: {
  page?: ConversationTurnIndexPage;
  visibleIds: Set<string>;
  loading: boolean;
  onPage: (direction: "earlier" | "later", cursor?: string) => void;
  onSelect: (turn: ConversationTurnIndexItem) => void;
}) {
  if (!page || page.totalCount < 3) return null;
  const turns = [...page.turns].reverse();
  return <nav className="history-rail" aria-label="Conversation turns">
    {page.earlierCursor && <button
      className="history-tick is-loader"
      type="button"
      disabled={loading}
      onClick={() => onPage("earlier", page.earlierCursor)}
      aria-label="Show earlier conversation turns"
    ><i /><span>{loading ? "Loading earlier turns…" : "Show earlier turns"}</span></button>}
    {turns.map((turn) => {
      const timestamp = formatMessageTime(turn.createdAt);
      return <button
        className={`history-tick${visibleIds.has(turn.promptId) ? " is-active" : ""}`}
        type="button"
        key={turn.promptId}
        onClick={() => onSelect(turn)}
        aria-label={`Jump to prompt: ${turn.preview}${timestamp ? `, ${timestamp}` : ""}`}
      ><i /><span><strong>{turn.preview}</strong>{timestamp && <time dateTime={turn.createdAt}>{timestamp}</time>}</span></button>;
    })}
    {page.laterCursor && <button
      className="history-tick is-loader"
      type="button"
      disabled={loading}
      onClick={() => onPage("later", page.laterCursor)}
      aria-label="Show later conversation turns"
    ><i /><span>{loading ? "Loading later turns…" : "Show later turns"}</span></button>}
  </nav>;
}

function PromptEditor({
  edit,
  disabled,
  onChange,
  onCancel,
  onSubmit,
}: {
  edit: PromptEdit;
  disabled: boolean;
  onChange: (value: PromptEdit) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const onPaste = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    try {
      const images = await readPastedImages(event, edit.images);
      if (images) onChange({ ...edit, images, imageError: "" });
    } catch (error) {
      onChange({
        ...edit,
        imageError: error instanceof Error ? error.message : "The pasted image could not be read.",
      });
    }
  };
  return <div className="prompt-editor">
    {edit.images.length > 0 && <ImageStrip
      images={edit.images}
      label="Replacement images"
      onRemove={(id) => onChange({ ...edit, images: edit.images.filter((image) => image.id !== id) })}
    />}
    <label className="sr-only" htmlFor={`edit-${edit.messageId}`}>Edit prompt</label>
    <textarea
      autoFocus
      id={`edit-${edit.messageId}`}
      value={edit.text}
      rows={Math.min(12, Math.max(3, edit.text.split(/\r?\n/).length))}
      disabled={disabled}
      onChange={(event) => onChange({ ...edit, text: event.target.value })}
      onPaste={(event) => void onPaste(event)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          if (edit.text.trim() || edit.images.length) onSubmit();
        }
      }}
    />
    {edit.imageError && <p className="prompt-error" role="alert">{edit.imageError}</p>}
    <div className="prompt-editor-actions">
      <button type="button" disabled={disabled} onClick={onCancel}>Cancel</button>
      <button
        className="primary-button"
        type="button"
        disabled={disabled || (!edit.text.trim() && edit.images.length === 0)}
        onClick={onSubmit}
      >Send</button>
    </div>
  </div>;
}

function UndoConfirmDialog({
  undo,
  submitting,
  onCancel,
  onConfirm,
}: {
  undo: PromptUndo;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !submitting) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])");
    if (!focusable?.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return <div className="edit-confirm-backdrop" onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !submitting) onCancel();
  }}>
    <div ref={dialogRef} className="edit-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-confirm-title" onKeyDown={onKeyDown}>
      <header>
        <strong id="edit-confirm-title">Undo to this prompt?</strong>
        <button className="icon-button" type="button" onClick={onCancel} disabled={submitting} aria-label="Close"><IconX size={16} /></button>
      </header>
      <div>
        <p>Files and conversation history will return to immediately before this prompt. The prompt text will be restored to the composer without sending.</p>
        {undo.attachmentCount > 0 && <p className="edit-confirm-warning">Historical {undo.attachmentCount === 1 ? "image cannot" : "images cannot"} be restored. Paste replacement images before sending again.</p>}
      </div>
      <footer>
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button data-autofocus className="primary-button" type="button" onClick={onConfirm} disabled={submitting}>
          {submitting ? "Undoing…" : "Undo"}
        </button>
      </footer>
    </div>
  </div>;
}

function ImageStrip({ images, label, onRemove }: { images: PastedImage[]; label: string; onRemove: (id: string) => void }) {
  return <div className="prompt-images" aria-label={label}>
    {images.map((image, index) => <div className="prompt-image" key={image.id}>
      <img src={`data:${image.mimeType};base64,${image.data}`} alt={`Pasted image ${index + 1}`} />
      <button type="button" onClick={() => onRemove(image.id)} aria-label={`Remove pasted image ${index + 1}`}><IconX size={13} /></button>
    </div>)}
  </div>;
}

function FileStrip({ files, onRemove }: { files: DroppedTextFile[]; onRemove: (id: string) => void }) {
  return <div className="prompt-files" aria-label="Attached text files">
    {files.map((file) => <span className="prompt-file" key={file.id}>
      <IconFileText size={14} />
      <span title={file.name}>{file.name}</span>
      <small>{formatBytes(file.size)}</small>
      <button type="button" onClick={() => onRemove(file.id)} aria-label={`Remove ${file.name}`}><IconX size={13} /></button>
    </span>)}
  </div>;
}

export const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
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

function MessageFooter({
  message,
  canCopy,
  disabled,
  onEdit,
  onUndo,
}: {
  message: MessageReadModel;
  canCopy: boolean;
  disabled: boolean;
  onEdit?: () => void;
  onUndo?: () => void;
}) {
  const timestamp = formatMessageTime(message.createdAt);
  return <footer className="message-footer">
    {timestamp && <time dateTime={message.createdAt}>{timestamp}</time>}
    {canCopy && <CopyMessageButton text={message.text} label={`Copy ${message.role === "user" ? "prompt" : "response"}`} />}
    {onEdit && <button type="button" disabled={disabled} onClick={onEdit} aria-label="Edit prompt" title="Edit prompt"><IconPencil size={14} /></button>}
    {onUndo && <button
      type="button"
      disabled={disabled || !message.canUndo}
      onClick={onUndo}
      aria-label="Undo to this prompt"
      title={message.canUndo ? "Undo to this prompt and restore files" : "No compatible Timeline checkpoint exists before this prompt"}
    ><IconArrowBackUp size={14} /></button>}
  </footer>;
}

function formatMessageTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
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
    {visible.map((file) => <button className="changed-file" type="button" key={file.path} onClick={() =>
      window.dispatchEvent(new CustomEvent("pylon:open-file", { detail: file.path }))}>
      <code>{file.path}</code>
      <span>{file.binary
        ? <small>binary</small>
        : <><ins>+{file.additions ?? 0}</ins><del>-{file.deletions ?? 0}</del></>}</span>
    </button>)}
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

function ActiveAgents({ runs, onSelect }: { runs: DelegatedAgentRunReadModel[]; onSelect?: (id: string) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <aside className="active-agents" aria-label="Active delegated agents">
    {runs.slice(0, 3).map((run) => {
      const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
      const elapsed = Number.isNaN(started) ? run.durationMs ?? 0 : Math.max(0, now - started);
      return <button type="button" key={run.id} style={agentColor(run.id)} onClick={() => onSelect?.(run.id)}>
        <span className="agent-state is-running" aria-hidden="true" />
        <IconRobot size={14} />
        <span><strong>{run.agentName || agentKindLabel(run.kind)}</strong><small>{run.agentName ? agentKindLabel(run.kind) : "Agent"}</small></span>
        <time>{formatWorkDuration(elapsed)}</time>
      </button>;
    })}
    {runs.length > 3 && <span className="active-agent-overflow">+{runs.length - 3} more</span>}
  </aside>;
}

function agentKindLabel(kind: DelegatedAgentKind): string {
  if (kind === "repo_scout") return "Repo Scout";
  if (kind === "web_scout") return "Web Scout";
  return kind === "advisor" ? "Advisor" : "Grunt";
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

async function readPastedImages(
  event: ReactClipboardEvent<HTMLTextAreaElement>,
  current: PastedImage[],
): Promise<PastedImage[] | undefined> {
  const files = [...event.clipboardData.items]
    .filter((item) => item.kind === "file"
      && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.type))
    .flatMap((item) => item.getAsFile() ?? []);
  if (!files.length) return undefined;
  event.preventDefault();
  if (files.length > 4 - current.length) throw new Error("You can attach up to 4 images.");
  if (files.some((file) => file.size > 5 * 1024 * 1024)
    || files.reduce((total, file) => total + file.size, 0) + imageBytes(current) > 15 * 1024 * 1024) {
    throw new Error("Images must be 5 MB each and 15 MB total.");
  }
  try {
    const pasted = await Promise.all(files.map(async (file) => ({
      id: crypto.randomUUID(),
      mimeType: file.type as PromptImage["mimeType"],
      data: await fileBase64(file),
    })));
    return [...current, ...pasted];
  } catch {
    throw new Error("The pasted image could not be read.");
  }
}

async function readDroppedFiles(
  dropped: File[],
  currentImages: PastedImage[],
  currentFiles: DroppedTextFile[],
): Promise<{ images: PastedImage[]; files: DroppedTextFile[] }> {
  const imageFiles = dropped.filter((file) => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type));
  const textFiles = dropped.filter((file) => !imageFiles.includes(file));
  const images = imageFiles.length
    ? await readImageFiles(imageFiles, currentImages)
    : currentImages;
  if (!textFiles.length) return { images, files: currentFiles };
  if (currentFiles.length + textFiles.length > 100) throw new Error("You can attach up to 100 text files.");
  if (textFiles.some((file) => file.size === 0)) throw new Error("Empty files cannot be attached.");
  const totalBytes = currentFiles.reduce((total, file) => total + file.size, 0)
    + textFiles.reduce((total, file) => total + file.size, 0);
  if (totalBytes > 10 * 1024 * 1024) throw new Error("Text files cannot exceed 10 MB total.");
  if ((currentFiles.length + textFiles.length > 4 || totalBytes > 512 * 1024)
    && !window.confirm("These files may use substantial model context. Attach them anyway?")) {
    return { images: currentImages, files: currentFiles };
  }
  const decoded = await Promise.all(textFiles.map(async (file): Promise<DroppedTextFile> => {
    if (/[\/\\\0]/.test(file.name)) throw new Error(`${file.name || "This file"} has an unsupported name.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.includes(0)) throw new Error(`${file.name} appears to be binary.`);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error(`${file.name} is not valid UTF-8 text.`); }
    return {
      id: crypto.randomUUID(),
      name: file.name.slice(0, 255),
      text,
      size: bytes.byteLength,
      ...(file.type ? { mimeType: file.type.slice(0, 120) } : {}),
    };
  }));
  return { images, files: [...currentFiles, ...decoded] };
}

async function readImageFiles(files: File[], current: PastedImage[]): Promise<PastedImage[]> {
  if (files.length > 4 - current.length) throw new Error("You can attach up to 4 images.");
  if (files.some((file) => file.size > 5 * 1024 * 1024)
    || files.reduce((total, file) => total + file.size, 0) + imageBytes(current) > 15 * 1024 * 1024) {
    throw new Error("Images must be 5 MB each and 15 MB total.");
  }
  const added = await Promise.all(files.map(async (file) => ({
    id: crypto.randomUUID(),
    mimeType: file.type as PromptImage["mimeType"],
    data: await fileBase64(file),
  })));
  return [...current, ...added];
}

function imageBytes(images: PromptImage[]): number {
  return images.reduce((total, image) => total + Math.floor(image.data.length * 3 / 4), 0);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
