import { IconArrowBackUp, IconArrowUp, IconBulb, IconCheck, IconChevronDown, IconCopy, IconFileText, IconGitFork, IconLoader2, IconPaperclip, IconPencil, IconPhoto, IconPlus, IconBotId, IconSquareFilled, IconTool, IconX } from "@tabler/icons-react";
import DOMPurify from "dompurify";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { groupConversationMessages, includeLatestLoadedTurn, turnIdsInViewport } from "../shared/transcript";
import { formatWorkDuration } from "../shared/format";
import { parseFileReference } from "../shared/file-reference";
import { renderMarkdown } from "../shared/markdown";
import { fileMentionAtCaret, isNearTranscriptBottom, loginCommandProvider, replaceFileMention } from "../shared/composer-input";
import type { PromptImage, PromptTextFile } from "../shared/protocol/commands";
import type { DelegatedAgentKind, DelegatedAgentRunReadModel, MessageReadModel, ModelOptionReadModel, SessionControlsReadModel, ThinkingLevelReadModel } from "../shared/protocol/events";
import type { ConversationTurnIndexItem, ConversationTurnIndexPage } from "../shared/protocol/snapshots";
import { thinkingLabel } from "./format";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";
import { agentColor } from "./agent-color";
import { matrixSelectionAtPoint, matrixThinkingAxis, moveMatrixSelection } from "../shared/model-matrix";
import { AnimatedDetails } from "./animated-details";
import { UiDialog } from "./ui-dialog";

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
interface PromptFork {
  entryId: string;
  name: string;
  canUseTimeline: boolean;
  timelineReason?: string;
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeName !== "A") return;
  (node as HTMLAnchorElement).target = "_blank";
  (node as HTMLAnchorElement).rel = "noopener noreferrer";
});

function scrollTranscriptToBottom(stream: HTMLElement): void {
  const scrollBehavior = stream.style.scrollBehavior;
  stream.style.scrollBehavior = "auto";
  stream.scrollTop = stream.scrollHeight;
  stream.style.scrollBehavior = scrollBehavior;
}

export function ConversationPanel({
  live,
  projectAvailable = true,
  initialDraft = "",
  onDraftChange,
  onSelectAgent,
  onOpenLogin,
}: {
  live: RuntimeStoreSnapshot;
  projectAvailable?: boolean;
  initialDraft?: string;
  onDraftChange?: (draft: string) => void;
  onSelectAgent?: (id: string) => void;
  onOpenLogin?: (provider?: string) => void;
}) {
  const [message, setMessage] = useState(initialDraft);
  const [images, setImages] = useState<PastedImage[]>([]);
  const [files, setFiles] = useState<DroppedTextFile[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [edit, setEdit] = useState<PromptEdit>();
  const [undo, setUndo] = useState<PromptUndo>();
  const [fork, setFork] = useState<PromptFork>();
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
  const suggestionListRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const followBottomRef = useRef(true);
  const turnRefs = useRef(new Map<string, HTMLElement>());
  const runtime = live.runtime;
  const controls = runtime?.sessionControls;
  const updateMessage = (value: string) => {
    setMessage(value);
    onDraftChange?.(value);
  };
  const editorRevision = runtime?.extensionUi.editorRevision ?? 0;
  const editorText = runtime?.extensionUi.editorText ?? "";
  const initialEditorRevision = useRef(editorRevision);
  const forceTranscriptBottom = () => {
    followBottomRef.current = true;
    if (streamRef.current) scrollTranscriptToBottom(streamRef.current);
  };
  useEffect(() => {
    if (editorRevision > 0 && (!initialDraft || editorRevision !== initialEditorRevision.current)) updateMessage(editorText);
  }, [editorRevision, editorText]);
  useLayoutEffect(() => {
    forceTranscriptBottom();
    const frame = requestAnimationFrame(forceTranscriptBottom);
    return () => cancelAnimationFrame(frame);
  }, [runtime?.sessionId, runtime?.sessionGeneration]);
  useEffect(() => {
    if (!live.treeChanging) return;
    setRailPage(undefined);
    setVisibleTurnIds(new Set());
  }, [live.treeChanging]);
  useEffect(() => {
    const stream = streamRef.current;
    const transcript = transcriptRef.current;
    if (!stream || !transcript || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followBottomRef.current) scrollTranscriptToBottom(stream);
    });
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [runtime?.sessionId, runtime?.sessionGeneration]);
  useEffect(() => {
    setHistoryLoading(undefined);
    setEdit(undefined);
    setUndo(undefined);
    setFork(undefined);
    setRailPage(undefined);
    setVisibleTurnIds(new Set());
    turnRefs.current.clear();
  }, [runtime?.sessionId, runtime?.sessionGeneration]);
  const connected = live.connection === "connected" && runtime?.ready === true && projectAvailable;
  const streaming = runtime?.conversation.streaming === true;
  const running = Boolean(runtime?.conversation.workStartedAt);
  const stopping = runtime?.conversation.stopping === true;
  const queued = runtime?.conversation.queue.pending;
  const composerBlocked = Boolean(live.pendingUi);
  const hasDraft = Boolean(message.trim() || images.length || files.length);
  const sending = submitting && !edit && !undo && !fork;
  const planAvailable = controls?.commands?.some((command) => command.name === "plan" && command.source === "extension") === true;
  const activeHistoryWindow = live.historyWindow;
  const transcriptMessages = activeHistoryWindow
    && activeHistoryWindow.sessionId === runtime?.sessionId
    && activeHistoryWindow.sessionGeneration === runtime?.sessionGeneration
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
  const latestUserTurn = userTurns.at(-1);
  const displayedRailPage = useMemo(() => {
    if (!railPage || !latestUserTurn?.entryId) return railPage;
    const preview = latestUserTurn.text.replace(/\s+/g, " ").trim()
      || (latestUserTurn.attachmentCount
        ? `${latestUserTurn.attachmentCount} attached image${latestUserTurn.attachmentCount === 1 ? "" : "s"}`
        : "Empty prompt");
    return includeLatestLoadedTurn(railPage, {
      promptId: latestUserTurn.entryId,
      preview: preview.slice(0, 120),
      ...(latestUserTurn.createdAt ? { createdAt: latestUserTurn.createdAt } : {}),
    }, activeHistoryWindow?.laterCursor === undefined);
  }, [activeHistoryWindow?.laterCursor, latestUserTurn?.attachmentCount, latestUserTurn?.createdAt, latestUserTurn?.entryId, latestUserTurn?.text, railPage]);
  useEffect(() => {
    const root = streamRef.current;
    if (!root || !userTurns.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rootRect = root.getBoundingClientRect();
      const turns = userTurns.flatMap((turn) => {
        const id = turn.entryId ?? turn.id;
        const element = turnRefs.current.get(id);
        if (!element) return [];
        const rect = element.getBoundingClientRect();
        return [{ id, top: rect.top, bottom: rect.bottom }];
      });
      const visible = new Set(turnIdsInViewport(turns, rootRect));
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
  const activeAgents = useMemo(
    () => runtime?.conversation.delegatedRuns.filter((run) => run.status === "running") ?? [],
    [runtime?.conversation.delegatedRuns],
  );
  const slashMatch = /^\/([^\s]*)$/.exec(message);
  const suggestions = slashMatch && !suggestionsDismissed
    ? [{ name: "login", description: "Connect an AI provider", source: "extension" as const }, ...(controls?.commands ?? [])]
        .filter((command, index, commands) => commands.findIndex((candidate) => candidate.name === command.name) === index)
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
  useEffect(() => {
    suggestionListRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [suggestionIndex]);
  const chooseSuggestion = (index: number) => {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    updateMessage(`/${suggestion.name} `);
    setSuggestionIndex(0);
  };
  const chooseFileSuggestion = (index: number) => {
    const path = fileSuggestions[index];
    if (!path || !fileMention) return;
    const next = replaceFileMention(message, fileMention, path);
    updateMessage(next.value);
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
    if ((!value && images.length === 0 && files.length === 0) || !connected || queued || composerBlocked) return;
    const loginProvider = !images.length && !files.length ? loginCommandProvider(value) : null;
    if (loginProvider !== null) {
      onOpenLogin?.(loginProvider);
      updateMessage("");
      return;
    }
    setSubmitting(true);
    try {
      await runtimeStore.sendMessage(
        value,
        images.map(({ data, mimeType }) => ({ data, mimeType })),
        files.map(({ name, text, size, mimeType }) => ({ name, text, size, ...(mimeType ? { mimeType } : {}) })),
        planMode,
      );
      updateMessage("");
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
      updateMessage(restored.message);
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
          !element.classList.contains("history-loader")
          && element.getBoundingClientRect().bottom > viewportTop) as HTMLElement | undefined
      : undefined;
    const anchorTop = anchor?.getBoundingClientRect().top;
    setHistoryLoading(all ? "all" : "page");
    try {
      await runtimeStore.loadEarlierMessages(all);
      requestAnimationFrame(() => {
        if (!stream) return;
        if (preserveAnchor) {
          if (anchor?.isConnected && anchorTop !== undefined) {
            stream.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
          }
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
    if (turn.cursor.startsWith("loaded:")) return;
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
    setRailPage(undefined);
    setVisibleTurnIds(new Set());
    setSubmitting(true);
    try {
      await runtimeStore.editPrompt(
        edit.entryId,
        edit.text.trim(),
        edit.images.map(({ data, mimeType }) => ({ data, mimeType })),
        false,
      );
      setEdit(undefined);
    } catch {
      // The store routes the failure through the application toast.
    } finally {
      setSubmitting(false);
    }
  };
  const submitUndo = async () => {
    if (!undo) return;
    setRailPage(undefined);
    setVisibleTurnIds(new Set());
    setSubmitting(true);
    try {
      await runtimeStore.rewindPrompt(undo.entryId);
      updateMessage(undo.text);
      setImages([]);
      setFiles([]);
      setPlanMode(false);
      setUndo(undefined);
      requestAnimationFrame(() => promptRef.current?.focus());
    } catch {
      // The store routes the failure through the application toast.
    } finally {
      setSubmitting(false);
    }
  };
  const startFork = (item: MessageReadModel) => {
    if (!item.entryId) return;
    const timelineEnabled = runtime?.runtimePolicy.effective.timelineEnabled === true;
    const timelineAvailable = runtime?.operational.timeline.availability === "available";
    const canUseTimeline = timelineEnabled && timelineAvailable && item.canForkWithTimeline === true;
    const timelineReason = !timelineEnabled
      ? "Timeline is disabled by the effective runtime policy."
      : !timelineAvailable
        ? "Timeline is unavailable or still initializing for this session."
        : !item.canForkWithTimeline
          ? "No compatible Timeline checkpoint exists for this prompt."
          : undefined;
    const sourceName = runtime?.sessionName?.trim();
    setFork({
      entryId: item.entryId,
      name: sourceName ? `${sourceName} (fork)`.slice(0, 200) : "Forked session",
      canUseTimeline,
      timelineReason,
    });
  };
  const submitFork = async (name: string, mode: "conversation" | "timeline") => {
    if (!fork) return;
    setRailPage(undefined);
    setVisibleTurnIds(new Set());
    setSubmitting(true);
    try {
      await runtimeStore.forkPrompt(fork.entryId, name, mode);
    } catch {
      // The store routes the failure through the application toast.
    } finally {
      setFork(undefined);
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
      <ActiveAgents runs={activeAgents} onSelect={onSelectAgent} />
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
        {conversationBlocks.map((block, index) => {
          if ("tools" in block) {
            const laterPrompt = conversationBlocks.slice(index + 1).some((item) => !("tools" in item) && item.role === "user");
            return <ToolTurnGroup key={block.id} tools={block.tools} onExpand={laterPrompt ? undefined : forceTranscriptBottom} />;
          }
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
            {!editing && (block.role === "user" || copyableAssistants.has(block.id) || (block.role === "assistant" && block.workDurationMs !== undefined)) && <MessageFooter
              message={block}
              canCopy={Boolean(block.text) && (block.role === "user" || copyableAssistants.has(block.id))}
              disabled={!connected || streaming || submitting || Boolean(edit)}
              onEdit={block.role === "user" && block.entryId ? () => startEdit(block) : undefined}
              onUndo={block.role === "user" && block.entryId ? () => setUndo({
                entryId: block.entryId!,
                text: block.text,
                attachmentCount: block.attachmentCount ?? 0,
              }) : undefined}
              onFork={block.role === "user" && block.entryId ? () => startFork(block) : undefined}
            />}
          </div>;
        })}
        {runtime.conversation.retry.active && <p className="conversation-note transcript-note" role="status">Retrying{runtime.conversation.retry.attempt ? ` (${runtime.conversation.retry.attempt})` : ""}…</p>}
        {runtime.conversation.compaction.active && <p className="conversation-note transcript-note" role="status">Compacting context…</p>}
        {runtime.conversation.workStartedAt ? <WorkTimer
          startedAt={runtime.conversation.workStartedAt}
          modelName={runtime.conversation.workModelName}
          thinkingLevel={runtime.conversation.workThinkingLevel}
        /> : runtime.conversation.stoppedRun && <WorkTimer
          durationMs={runtime.conversation.stoppedRun.durationMs}
          modelName={runtime.conversation.stoppedRun.modelName}
          thinkingLevel={runtime.conversation.stoppedRun.thinkingLevel}
          stopped
        />}
        {runtime.conversation.agentError && <div className="agent-error" role="alert">
          <strong>Model request failed</strong>
          <span>{runtime.conversation.agentError}</span>
        </div>}
        {live.historyWindow?.laterCursor && <div className="history-loader is-later">
          <button type="button" disabled={Boolean(historyLoading)} onClick={() => void loadNewerHistory()}>
            {historyLoading === "newer" ? "Loading…" : "Load 100 newer"}
          </button>
        </div>}
          </div>
        </div>
      </div>}
      {runtime && <HistoryRail
        page={live.treeChanging ? undefined : displayedRailPage}
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
      {fork && <ForkDialog
        fork={fork}
        submitting={submitting}
        onCancel={() => setFork(undefined)}
        onConfirm={(name, mode) => void submitFork(name, mode)}
      />}
      {runtime && <ExtensionUiSurface runtime={runtime} />}
      {runtime?.commandResult && <div className={`composer-surface command-result is-${runtime.commandResult.severity}`} role="status">
        <div><strong>/{runtime.commandResult.command}</strong><span>{runtime.commandResult.output || "Command completed with no output."}</span></div>
        <button type="button" aria-label="Close command result" onClick={() => void runtimeStore.dismissCommandResult(runtime.commandResult!.id).catch(() => undefined)}><IconX size={15} /></button>
      </div>}
      {(suggestions.length > 0 || fileSuggestions.length > 0) && <div
        ref={suggestionListRef}
        className={`composer-surface slash-suggestions${suggestions.length ? "" : " file-suggestions"}`}
        id={suggestions.length ? "slash-command-suggestions" : "file-mention-suggestions"}
        role="listbox"
        aria-label={suggestions.length ? "Slash commands" : "Project files"}
      >
        {suggestions.map((command, index) => <button
          className={index === suggestionIndex ? "is-selected" : ""}
          type="button"
          role="option"
          aria-selected={index === suggestionIndex}
          key={`${command.source}-${command.name}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => chooseSuggestion(index)}
        ><strong>/{command.name}</strong>{command.description && <span>{command.description}</span>}</button>)}
        {suggestions.length === 0 && fileSuggestions.map((path, index) => {
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
          ><strong><IconFileText size={13} />{name}</strong>{directory && <span>{directory}</span>}</button>;
        })}
      </div>}
      <RetainedUiDialog request={live.pendingUi} />
      <form
        className={`prompt-form${dropActive ? " is-drop-active" : ""}${live.pendingUi || runtime?.commandResult || suggestions.length > 0 || fileSuggestions.length > 0 ? " is-joined" : ""}`}
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
          <textarea
            ref={promptRef}
            id="runtime-prompt"
            rows={1}
            value={message}
            onChange={(event) => {
              updateMessage(event.target.value);
              setCaretPosition(event.target.selectionStart);
              setSuggestionsDismissed(false);
            }}
            onSelect={(event) => setCaretPosition(event.currentTarget.selectionStart)}
            onPaste={(event) => void onPaste(event)}
            onKeyDown={onPromptKeyDown}
            placeholder={!projectAvailable ? "Add a project to start" : connected ? (queued ? "A message is already queued" : running ? "Queue a follow-up" : "Send a prompt") : "Runtime must be connected"}
            disabled={!connected || submitting || Boolean(queued) || composerBlocked}
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
              disabled={!connected || submitting || Boolean(queued) || composerBlocked}
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
              {runtime ? `${runtime.metrics.contextPercent.toFixed(2)}%` : "—"}
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
            ? <button
                className="prompt-abort"
                type="button"
                onClick={() => void runtimeStore.abort().catch(() => undefined)}
                disabled={!connected || stopping}
                aria-label={stopping ? "Stopping response" : "Stop response"}
                aria-busy={stopping}
              >
                <IconSquareFilled size={13} />
              </button>
            : <button
                className="prompt-send"
                disabled={!connected || composerBlocked || submitting || Boolean(queued) || !hasDraft || !controls?.model}
                type="submit"
                aria-label={sending ? "Sending message" : running ? "Queue message" : "Send message"}
              >
                {sending ? <IconLoader2 className="prompt-send-spinner" size={16} /> : <IconArrowUp size={16} />}
              </button>}
          </div>
        </div>
      </form>
    </section>
  );
}

function RetainedUiDialog({ request }: { request: RuntimeStoreSnapshot["pendingUi"] }) {
  const [displayed, setDisplayed] = useState(request);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (request) {
      setDisplayed(request);
      setExiting(false);
      return;
    }
    if (!displayed) return;
    setExiting(true);
    const timer = window.setTimeout(() => setDisplayed(undefined), 140);
    return () => window.clearTimeout(timer);
  }, [request, displayed]);

  if (!displayed || displayed.payload.context === "provider-auth") return null;
  return <div className={exiting ? "ui-request-motion is-exiting" : "ui-request-motion"}>
    <UiDialog key={displayed.requestId} request={displayed} />
  </div>;
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
      <button type="button" role="menuitem" onClick={() => fileRef.current?.click()}>
        <IconPaperclip size={16} />
        <span><strong>Files and images</strong><small>Select one or more attachments</small></span>
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={!available}
        onClick={() => { onChange(!active); onClose(); triggerRef.current?.focus(); }}
      >
        <IconBulb size={16} />
        <span><strong>Plan mode</strong><small>{available ? "Plan the next prompt" : "Continuity /plan is unavailable"}</small></span>
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

function matrixThinkingLabel(level: ThinkingLevelReadModel): string {
  if (level === "minimal") return "Min";
  if (level === "medium") return "Med";
  if (level === "xhigh") return "XH";
  return thinkingLabel(level);
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
  const matrixRef = useRef<HTMLDivElement>(null);
  const matrixBodyRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  const dragStartRef = useRef<{ modelKey: string; level: ThinkingLevelReadModel } | undefined>(undefined);
  const applyingRef = useRef(false);
  const queuedSelectionRef = useRef<{ model: ModelOptionReadModel; level: ThinkingLevelReadModel } | undefined>(undefined);
  const [modelKey, setModelKey] = useState("");
  const [level, setLevel] = useState<ThinkingLevelReadModel>("off");
  const [dragging, setDragging] = useState(false);
  const models = controls?.models ?? [];
  const axisLevels = useMemo(() => matrixThinkingAxis(models), [controls?.models]);
  const selectedModelIndex = Math.max(0, models.findIndex((model) => `${model.provider}/${model.id}` === modelKey));
  const selectedModel = models[selectedModelIndex];
  const selectedLevelIndex = Math.max(0, axisLevels.indexOf(level));
  const selectedCellId = `model-matrix-cell-${selectedModelIndex}-${selectedLevelIndex}`;

  useEffect(() => {
    if (!open) return;
    const selectedControls = controls?.pending ?? controls;
    const currentKey = selectedControls?.model ? `${selectedControls.model.provider}/${selectedControls.model.id}` : "";
    const currentModel = models.find((model) => `${model.provider}/${model.id}` === currentKey) ?? models[0];
    const availableLevels = currentModel?.thinkingLevels ?? [];
    const currentLevel = availableLevels.includes(selectedControls?.thinkingLevel ?? "off")
      ? selectedControls?.thinkingLevel ?? "off"
      : availableLevels[0] ?? "off";
    setModelKey(currentModel ? `${currentModel.provider}/${currentModel.id}` : "");
    setLevel(currentLevel);
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
    requestAnimationFrame(() => {
      rootRef.current?.querySelector<HTMLElement>('[data-active-model="true"]')?.scrollIntoView({ block: "nearest" });
      matrixRef.current?.focus();
    });
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", keyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !thumbRef.current || !matrixBodyRef.current) return;
    const positionThumb = () => {
      const cell = document.getElementById(selectedCellId);
      const thumb = thumbRef.current;
      const body = matrixBodyRef.current;
      if (!cell || !thumb || !body) return;
      if (!dragging) cell.scrollIntoView({ block: "nearest", inline: "nearest" });
      const cellRect = cell.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const transform = `translate3d(${cellRect.left - bodyRect.left + cellRect.width / 2}px, ${cellRect.top - bodyRect.top + cellRect.height / 2}px, 0) translate(-50%, -50%)`;
      if (!thumb.dataset.positioned) {
        thumb.style.transition = "none";
        thumb.style.transform = transform;
        thumb.dataset.positioned = "true";
        requestAnimationFrame(() => thumb.style.removeProperty("transition"));
        return;
      }
      thumb.style.transform = transform;
    };
    positionThumb();
    const resize = new ResizeObserver(positionThumb);
    resize.observe(matrixBodyRef.current);
    return () => resize.disconnect();
  }, [dragging, open, selectedCellId]);

  const applySelection = (model: ModelOptionReadModel, nextLevel: ThinkingLevelReadModel) => {
    queuedSelectionRef.current = { model, level: nextLevel };
    if (applyingRef.current) return;
    applyingRef.current = true;
    void (async () => {
      try {
        while (queuedSelectionRef.current) {
          const next = queuedSelectionRef.current;
          queuedSelectionRef.current = undefined;
          try {
            await onApply(next.model, next.level);
          } catch {
            // The shared toast reports the rejected mutation.
          }
        }
      } finally {
        applyingRef.current = false;
      }
    })();
  };
  const select = (model: ModelOptionReadModel, nextLevel: ThinkingLevelReadModel, apply: boolean) => {
    setModelKey(`${model.provider}/${model.id}`);
    setLevel(nextLevel);
    if (apply) applySelection(model, nextLevel);
  };
  const selectionFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const body = matrixBodyRef.current;
    if (!body) return undefined;
    const rect = body.getBoundingClientRect();
    const firstCell = document.getElementById("model-matrix-cell-0-0")?.getBoundingClientRect();
    const lastCell = document.getElementById(`model-matrix-cell-0-${axisLevels.length - 1}`)?.getBoundingClientRect();
    if (!firstCell || !lastCell) return undefined;
    return matrixSelectionAtPoint(
      models,
      axisLevels,
      (event.clientX - firstCell.left) / (lastCell.right - firstCell.left),
      (event.clientY - rect.top) / rect.height,
    );
  };
  const cancelDrag = () => {
    const start = dragStartRef.current;
    dragStartRef.current = undefined;
    setDragging(false);
    if (!start) return;
    const model = models.find((item) => `${item.provider}/${item.id}` === start.modelKey);
    if (model) select(model, start.level, false);
  };
  const moveSelection = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, [number, number]> = {
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      ArrowUp: [-1, 0],
    };
    const move = moves[event.key];
    if (!move || !selectedModel) return;
    event.preventDefault();
    const next = moveMatrixSelection(models, axisLevels, selectedModelIndex, level, move[0], move[1]);
    if (!next) return;
    const nextKey = `${next.model.provider}/${next.model.id}`;
    if (nextKey !== modelKey || next.level !== level) select(next.model, next.level, true);
  };

  return <div ref={rootRef} className="composer-popover-root model-control">
    <button
      ref={triggerRef}
      className="model-trigger"
      type="button"
      disabled={disabled || !models.length}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onToggle}
    >
      <span>{controls?.pending ? `Next: ${controls.pending.model.name}` : controls?.model?.name ?? "No model"}</span>
      {(controls?.pending?.thinkingLevel ?? controls?.thinkingLevel) && <small>{thinkingLabel(controls?.pending?.thinkingLevel ?? controls?.thinkingLevel ?? "off")}</small>}
      <IconChevronDown size={14} />
    </button>
    {open && <div className="model-popover composer-popover" role="dialog" aria-label="Model and thinking" aria-busy={busy}>
      <div
        ref={matrixRef}
        className={`model-matrix${dragging ? " is-dragging" : ""}`}
        role="grid"
        tabIndex={0}
        aria-label="Model and thinking selector"
        aria-rowcount={models.length + 1}
        aria-colcount={axisLevels.length + 1}
        aria-activedescendant={selectedCellId}
        aria-describedby="model-matrix-help"
        style={{ "--matrix-level-count": axisLevels.length } as CSSProperties}
        onKeyDown={moveSelection}
      >
        <div className="model-matrix-header" role="row">
          <span role="columnheader">Model</span>
          {axisLevels.map((item) => <span role="columnheader" key={item} title={thinkingLabel(item)}>{matrixThinkingLabel(item)}</span>)}
        </div>
        <div
          ref={matrixBodyRef}
          className="model-matrix-body"
          role="rowgroup"
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest(".model-matrix-name")) return;
            if (event.pointerType === "mouse" && event.button !== 0) return;
            event.preventDefault();
            const next = selectionFromPointer(event);
            if (!next) return;
            dragStartRef.current = { modelKey, level };
            setDragging(true);
            matrixRef.current?.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            select(next.model, next.level, false);
          }}
          onPointerMove={(event) => {
            if (!dragStartRef.current) return;
            const next = selectionFromPointer(event);
            if (next) select(next.model, next.level, false);
          }}
          onPointerUp={(event) => {
            if (!dragStartRef.current) return;
            const next = selectionFromPointer(event);
            const start = dragStartRef.current;
            dragStartRef.current = undefined;
            setDragging(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            if (!next) return;
            select(next.model, next.level, false);
            if (`${next.model.provider}/${next.model.id}` !== start.modelKey || next.level !== start.level) applySelection(next.model, next.level);
          }}
          onPointerCancel={cancelDrag}
          onLostPointerCapture={() => {
            if (dragStartRef.current) cancelDrag();
          }}
        >
          {models.map((model, modelIndex) => {
            const key = `${model.provider}/${model.id}`;
            return <div className="model-matrix-row" role="row" key={key} data-active-model={key === modelKey}>
              <span className="model-matrix-name" role="rowheader">
                <strong>{model.name}</strong>
                <small>{model.provider}</small>
              </span>
              {axisLevels.map((item, axisIndex) => {
                const available = model.thinkingLevels?.includes(item) ?? item === "off";
                const active = key === modelKey && item === level;
                return <span
                  className={`model-matrix-cell${available ? "" : " is-unavailable"}${active ? " is-active" : ""}`}
                  role="gridcell"
                  id={`model-matrix-cell-${modelIndex}-${axisIndex}`}
                  aria-selected={active}
                  aria-disabled={!available}
                  aria-label={available ? `${model.name}, ${thinkingLabel(item)} thinking` : `${model.name}, ${thinkingLabel(item)} thinking unavailable`}
                  title={available ? `${model.name}, ${thinkingLabel(item)}` : `${thinkingLabel(item)} unavailable for ${model.name}`}
                  key={item}
                />;
              })}
            </div>;
          })}
          <span ref={thumbRef} className="model-matrix-thumb" aria-hidden="true" />
        </div>
      </div>
      <div className="model-matrix-footer" aria-live="polite">
        <span><strong>{selectedModel?.name ?? "No model"}</strong> with <strong>{thinkingLabel(level)}</strong> thinking</span>
        <small>{dragging ? "Release to apply" : busy ? "Applying" : controls?.pending ? "Applies after current response" : "Current session"}</small>
      </div>
      <p className="model-matrix-help" id="model-matrix-help">Drag across thinking and between models. Arrow keys move one option at a time.</p>
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
  const [tooltip, setTooltip] = useState<{
    top: number;
    preview: string;
    label: string;
    createdAt?: string;
  }>();
  if (!page || page.totalCount < 3) return null;
  const turns = [...page.turns].reverse();
  const showTooltip = (
    element: HTMLButtonElement,
    preview: string,
    label: string,
    createdAt?: string,
  ) => {
    const container = element.closest(".conversation-panel");
    if (!container) return;
    const buttonRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const middle = buttonRect.top + buttonRect.height / 2 - containerRect.top;
    setTooltip({
      top: Math.max(52, Math.min(containerRect.height - 52, middle)),
      preview,
      label,
      createdAt,
    });
  };
  const hideTooltip = () => setTooltip(undefined);
  return <>
    <nav className="history-rail" aria-label="Conversation turns">
    {page.earlierCursor && <button
      className="history-tick is-loader"
      type="button"
      disabled={loading}
      onClick={() => onPage("earlier", page.earlierCursor)}
      onMouseEnter={(event) => showTooltip(event.currentTarget, loading ? "Loading earlier turns…" : "Show earlier turns", "Earlier conversation turns")}
      onFocus={(event) => showTooltip(event.currentTarget, loading ? "Loading earlier turns…" : "Show earlier turns", "Earlier conversation turns")}
      onMouseLeave={hideTooltip}
      onBlur={hideTooltip}
      aria-label="Show earlier conversation turns"
    ><i /></button>}
    {turns.map((turn) => {
      const timestamp = formatMessageTime(turn.createdAt);
      return <button
        className={`history-tick${visibleIds.has(turn.promptId) ? " is-active" : ""}`}
        type="button"
        key={turn.promptId}
        onClick={() => onSelect(turn)}
        onMouseEnter={(event) => showTooltip(event.currentTarget, turn.preview, `Prompt: ${turn.preview}`, turn.createdAt)}
        onFocus={(event) => showTooltip(event.currentTarget, turn.preview, `Prompt: ${turn.preview}`, turn.createdAt)}
        onMouseLeave={hideTooltip}
        onBlur={hideTooltip}
        aria-label={`Jump to prompt: ${turn.preview}${timestamp ? `, ${timestamp}` : ""}`}
      ><i /></button>;
    })}
    {page.laterCursor && <button
      className="history-tick is-loader"
      type="button"
      disabled={loading}
      onClick={() => onPage("later", page.laterCursor)}
      onMouseEnter={(event) => showTooltip(event.currentTarget, loading ? "Loading later turns…" : "Show later turns", "Later conversation turns")}
      onFocus={(event) => showTooltip(event.currentTarget, loading ? "Loading later turns…" : "Show later turns", "Later conversation turns")}
      onMouseLeave={hideTooltip}
      onBlur={hideTooltip}
      aria-label="Show later conversation turns"
    ><i /></button>}
    </nav>
    {tooltip && <div
      className="history-rail-tooltip"
      role="tooltip"
      aria-label={tooltip.label}
      style={{ top: `${tooltip.top}px` }}
    >
      <strong>{tooltip.preview}</strong>
      {tooltip.createdAt && <time dateTime={tooltip.createdAt}>{formatMessageTime(tooltip.createdAt)}</time>}
    </div>}
  </>;
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

function ForkDialog({
  fork,
  submitting,
  onCancel,
  onConfirm,
}: {
  fork: PromptFork;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: (name: string, mode: "conversation" | "timeline") => void;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState(fork.name);
  const [withTimeline, setWithTimeline] = useState(fork.canUseTimeline);
  const validName = name.trim().length > 0 && name.trim().length <= 200;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLInputElement>("[data-autofocus]")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
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
  return <div className="edit-confirm-backdrop fork-dialog-backdrop" onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && !submitting) onCancel();
  }}>
    <form
      ref={dialogRef}
      className="edit-confirm-dialog fork-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fork-dialog-title"
      aria-describedby="fork-dialog-description"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        if (validName && !submitting) onConfirm(name.trim(), withTimeline ? "timeline" : "conversation");
      }}
    >
      <header>
        <strong id="fork-dialog-title">Fork from this prompt</strong>
        <button className="icon-button" type="button" onClick={onCancel} disabled={submitting} aria-label="Close"><IconX size={16} /></button>
      </header>
      <div>
        <p id="fork-dialog-description">Create a separate session from this point in the conversation.</p>
        <label className="fork-name">Session name
          <input
            data-autofocus
            value={name}
            maxLength={200}
            disabled={submitting}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className={`fork-timeline ${fork.canUseTimeline ? "" : "is-disabled"}`}>
          <input
            type="checkbox"
            checked={withTimeline}
            disabled={!fork.canUseTimeline || submitting}
            onChange={(event) => setWithTimeline(event.target.checked)}
          />
          <span>Restore files from Timeline checkpoint</span>
        </label>
        {fork.timelineReason && <p className="fork-timeline-reason">{fork.timelineReason}</p>}
      </div>
      <footer>
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <button className="primary-button" type="submit" disabled={!validName || submitting}>
          {submitting ? "Forking…" : "Fork session"}
        </button>
      </footer>
    </form>
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

  const onClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const reference = parseFileReference(anchor.getAttribute("href") ?? "");
    if (!reference) return;
    event.preventDefault();
    window.dispatchEvent(new CustomEvent("pylon:open-file", { detail: reference }));
  };

  return <div className="markdown-content" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
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
  onFork,
}: {
  message: MessageReadModel;
  canCopy: boolean;
  disabled: boolean;
  onEdit?: () => void;
  onUndo?: () => void;
  onFork?: () => void;
}) {
  const timestamp = formatMessageTime(message.createdAt);
  return <footer className="message-footer">
    {timestamp && <time dateTime={message.createdAt}>{timestamp}</time>}
    {canCopy && <CopyMessageButton text={message.text} label={`Copy ${message.role === "user" ? "prompt" : "response"}`} />}
    {message.role === "assistant" && message.workDurationMs !== undefined && <WorkTimer durationMs={message.workDurationMs} modelName={message.modelName} thinkingLevel={message.thinkingLevel} />}
    {onEdit && <button type="button" disabled={disabled} onClick={onEdit} aria-label="Edit prompt" title="Edit prompt"><IconPencil size={14} /></button>}
    {onUndo && <button
      type="button"
      disabled={disabled || !message.canUndo}
      onClick={onUndo}
      aria-label="Undo to this prompt"
      title={message.canUndo ? "Undo to this prompt and restore files" : "No compatible Timeline checkpoint exists before this prompt"}
    ><IconArrowBackUp size={14} /></button>}
    {onFork && <button
      type="button"
      disabled={disabled}
      onClick={onFork}
      aria-label="Fork from this prompt"
      title="Fork from this prompt"
    ><IconGitFork size={14} /></button>}
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
      window.dispatchEvent(new CustomEvent("pylon:open-file", { detail: { path: file.path, view: "diff" } }))}>
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

function WorkTimer({ startedAt, durationMs, modelName, thinkingLevel, stopped = false }: { startedAt?: string; durationMs?: number; modelName?: string; thinkingLevel?: MessageReadModel["thinkingLevel"]; stopped?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const elapsed = durationMs ?? (Number.isNaN(started) ? 0 : Math.max(0, now - started));
  return <span className={`work-timer ${startedAt ? "is-active" : ""}`} role="status">
    {stopped ? "Stopped after" : startedAt ? "Working for" : "Worked for"} {formatWorkDuration(elapsed)}
    {startedAt && modelName && <> · {modelName}</>}
    {startedAt && thinkingLevel && <> · {thinkingLabel(thinkingLevel)}</>}
  </span>;
}

function ActiveAgents({ runs, onSelect }: { runs: DelegatedAgentRunReadModel[]; onSelect?: (id: string) => void }) {
  const [now, setNow] = useState(Date.now());
  const [displayed, setDisplayed] = useState(runs);
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (!displayed.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [displayed.length]);
  useEffect(() => {
    if (runs.length) {
      setDisplayed(runs);
      setExiting(false);
      return;
    }
    if (!displayed.length) return;
    setExiting(true);
    const timer = window.setTimeout(() => {
      setDisplayed([]);
      setExiting(false);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [runs]);
  if (!displayed.length) return null;
  return <aside className={`active-agents${exiting ? " is-exiting" : ""}`} aria-label="Active delegated agents">
    {displayed.slice(0, 3).map((run) => {
      const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
      const elapsed = Number.isNaN(started) ? run.durationMs ?? 0 : Math.max(0, now - started);
      return <button type="button" key={run.id} style={agentColor(run)} onClick={() => onSelect?.(run.id)}>
        <span className="agent-state is-working" aria-hidden="true" />
        <IconBotId size={14} />
        <span><strong>{run.agentName ? <span className="agent-instance-name">{run.agentName}</span> : agentKindLabel(run.kind)}</strong><small>{run.agentName ? agentKindLabel(run.kind) : "Agent"}</small></span>
        <time>{formatWorkDuration(elapsed)}</time>
      </button>;
    })}
    {displayed.length > 3 && <span className="active-agent-overflow">+{displayed.length - 3} more</span>}
  </aside>;
}

function agentKindLabel(kind: DelegatedAgentKind): string {
  if (kind === "repo_scout") return "Repo Scout";
  if (kind === "web_scout") return "Web Scout";
  if (kind === "spawn_agent") return "Private Agent";
  if (kind === "spawn_session") return "Spawned Session";
  return kind === "advisor" ? "Advisor" : "Grunt";
}

function ToolTurnGroup({ tools, onExpand }: { tools: MessageReadModel[]; onExpand?: () => void }) {
  const names = [...new Set(tools.map((tool) => tool.tool?.name || "Tool"))];
  return <AnimatedDetails
    className="tool-turn-group"
    summary={<><IconTool size={15} /><strong>{tools.length} tool {tools.length === 1 ? "call" : "calls"}</strong><span>{names.slice(-3).join(", ")}{names.length > 3 ? "…" : ""}</span></>}
    onExpand={onExpand}
  >
    <div className="tool-turn-items">
      {tools.map((tool) => <ToolDisclosure key={tool.id} name={tool.tool?.name || "Tool"} status={tool.tool?.status || "completed"} input={tool.tool?.input} output={tool.text} />)}
    </div>
  </AnimatedDetails>;
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
