import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowUp,
  IconBotId,
  IconBulb,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconFileText,
  IconGitBranch,
  IconFolder,
  IconGitFork,
  IconLoader2,
  IconPaperclip,
  IconPencil,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSquareFilled,
  IconX,
} from "@tabler/icons-react";
import DOMPurify from "dompurify";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  groupConversationMessages,
  includeLatestLoadedTurn,
  liveToolMessage,
  reconcileToolActivity,
  turnIdsInViewport,
} from "../shared/transcript";
import { pairAgentActivity } from "../shared/agent-activity";
import { messageToolCallViews, pairedToolCallViews } from "../shared/tool-calls";
import { formatCompactNumber, formatWorkDuration } from "../shared/format";
import { parseFileReference } from "../shared/file-reference";
import { renderMarkdown } from "../shared/markdown";
import {
  fileMentionAtCaret,
  insertFileMention,
  isExactSlashCommandSelection,
  isNearTranscriptBottom,
  scrollTopAfterPrepend,
  loginCommandProvider,
  replaceFileMention,
  WORKSPACE_FILE_DRAG_TYPE,
} from "../shared/composer-input";
import type { PromptImage, PromptTextFile } from "../shared/protocol/commands";
import type {
  DelegatedAgentKind,
  DelegatedAgentRunReadModel,
  MessageAttachmentReadModel,
  MessageReadModel,
  ModelOptionReadModel,
  QueuedPromptReadModel,
  SessionControlsReadModel,
  ThinkingLevelReadModel,
  TimelineCheckpointReadModel,
} from "../shared/protocol/events";
import type { ConversationTurnIndexItem, ConversationTurnIndexPage } from "../shared/protocol/snapshots";
import { agentRequestLabel, thinkingLabel } from "./format";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";
import { agentColor, type AgentColorMap } from "./agent-color";
import { modelThinkingLevels, moveRailSelection, railThinkingAxis } from "../shared/model-rail";
import { AnimatedDetails } from "./animated-details";
import { ToolCallGroup, ToolCallList, ToolCallTrack } from "./tool-calls";
import { RunSeam, SeamDisclosure, SeamLink } from "./run-seam";
import { UiDialog } from "./ui-dialog";
import { modelKey as toModelKey, useHiddenModels, visibleModels } from "./model-visibility";
import { exitDelay } from "./motion";
import { OverviewOrb } from "./overview-primitives";
import { useSyntaxHighlightingRevision } from "./use-chrome";
import { FileTypeIcon } from "./files-panel";

const markdownTags = [
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];
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
interface PendingSessionView {
  phase: "preparing" | "failed";
  projectLabel: string;
  cwd: string;
  /** Live socket state: setup stalls when it drops, and the step says so. */
  connected: boolean;
  error?: string;
  onRetry: () => void;
}
export interface ComposerSelection {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

DOMPurify.addHook("afterSanitizeAttributes", node => {
  if (node.nodeName !== "A") return;
  (node as HTMLAnchorElement).target = "_blank";
  (node as HTMLAnchorElement).rel = "noopener noreferrer";
});

function setTranscriptScrollTop(stream: HTMLElement, scrollTop: number): void {
  const scrollBehavior = stream.style.scrollBehavior;
  stream.style.scrollBehavior = "auto";
  stream.scrollTop = scrollTop;
  stream.style.scrollBehavior = scrollBehavior;
}

function scrollTranscriptToBottom(stream: HTMLElement): void {
  setTranscriptScrollTop(stream, stream.scrollHeight);
}

export function ConversationPanel({
  live,
  projectAvailable = true,
  initialDraft = "",
  restoreComposerFocus = false,
  restoreComposerSelection,
  onComposerFocusRestored,
  onDraftChange,
  pendingSession,
  onSelectAgent,
  agentColors,
  onOpenLogin,
  onOpenCompaction,
  onOpenAttachment,
  onOpenTurnDiff,
  openAttachment,
  openTurnDiffEntryId,
}: {
  live: RuntimeStoreSnapshot;
  projectAvailable?: boolean;
  initialDraft?: string;
  restoreComposerFocus?: boolean;
  restoreComposerSelection?: ComposerSelection;
  onComposerFocusRestored?: () => void;
  onDraftChange?: (draft: string) => void;
  pendingSession?: PendingSessionView;
  onSelectAgent?: (id?: string) => void;
  agentColors: AgentColorMap;
  onOpenLogin?: (provider?: string) => void;
  onOpenCompaction: (message: MessageReadModel) => void;
  onOpenAttachment: (attachments: MessageAttachmentReadModel[], index: number, trigger: HTMLButtonElement) => void;
  onOpenTurnDiff: (
    entryId: string,
    files: NonNullable<MessageReadModel["changedFiles"]>,
    trigger: HTMLButtonElement,
  ) => void;
  openAttachment?: { sourceEntryId: string; index: number };
  openTurnDiffEntryId?: string;
}) {
  const [message, setMessage] = useState(initialDraft);
  const [images, setImages] = useState<PastedImage[]>([]);
  const [files, setFiles] = useState<DroppedTextFile[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [edit, setEdit] = useState<PromptEdit>();
  const [undo, setUndo] = useState<PromptUndo>();
  const [fork, setFork] = useState<PromptFork>();
  const [visibleTurnIds, setVisibleTurnIds] = useState<Set<string>>(() => new Set());
  const [toolNow, setToolNow] = useState(Date.now());
  const [railPage, setRailPage] = useState<ConversationTurnIndexPage>();
  const [railLoading, setRailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [controlBusy, setControlBusy] = useState("");
  const [historyLoading, setHistoryLoading] = useState<"page" | "all" | "newer">();
  const [openMenu, setOpenMenu] = useState<"plus" | "model">();
  const [planMode, setPlanMode] = useState(false);
  const [queueBusy, setQueueBusy] = useState<{ id: string; action: "edit" | "steer" }>();
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [caretPosition, setCaretPosition] = useState(0);
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const suggestionListRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const followBottomRef = useRef(true);
  const prependScrollHeightRef = useRef<number | undefined>(undefined);
  const turnRefs = useRef(new Map<string, HTMLElement>());
  const draftingOnly = Boolean(pendingSession);
  const runtime = draftingOnly ? undefined : live.runtime;
  const controls = runtime?.sessionControls;
  const continuityPlanning = runtime?.operational.continuity.work?.mode === "planning";
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
    if (editorRevision > 0 && (!initialDraft || editorRevision !== initialEditorRevision.current))
      updateMessage(editorText);
  }, [editorRevision, editorText]);
  useLayoutEffect(() => {
    forceTranscriptBottom();
    const frame = requestAnimationFrame(forceTranscriptBottom);
    return () => cancelAnimationFrame(frame);
  }, [runtime?.sessionId, runtime?.sessionGeneration]);
  useLayoutEffect(() => {
    if (!restoreComposerFocus) return;
    const prompt = promptRef.current;
    if (!prompt) return;
    prompt.focus();
    if (restoreComposerSelection) {
      const start = Math.min(restoreComposerSelection.start, prompt.value.length);
      const end = Math.min(restoreComposerSelection.end, prompt.value.length);
      prompt.setSelectionRange(start, end, restoreComposerSelection.direction);
    }
    onComposerFocusRestored?.();
  }, [restoreComposerFocus, restoreComposerSelection, onComposerFocusRestored]);
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
    prependScrollHeightRef.current = undefined;
    setEdit(undefined);
    setUndo(undefined);
    setFork(undefined);
    setRailPage(undefined);
    setVisibleTurnIds(new Set());
    turnRefs.current.clear();
  }, [runtime?.sessionId, runtime?.sessionGeneration]);
  const connected = !draftingOnly && live.connection === "connected" && runtime?.ready === true && projectAvailable;
  const streaming = runtime?.conversation.streaming === true;
  const running = Boolean(runtime?.conversation.workStartedAt);
  const stopping = runtime?.conversation.stopping === true;
  const queuedItems = runtime?.conversation.queue.items ?? [];
  const pendingUi = live.pendingUi?.surface === "database" ? undefined : live.pendingUi;
  const composerBlocked = !draftingOnly && Boolean(pendingUi);
  const hasDraft = Boolean(message.trim() || images.length || files.length);
  const sending = submitting && !edit && !undo && !fork;
  const planAvailable =
    controls?.commands?.some(command => command.name === "plan" && command.source === "extension") === true;
  const activeHistoryWindow = live.historyWindow;
  const transcriptSourceMessages =
    activeHistoryWindow &&
    activeHistoryWindow.sessionId === runtime?.sessionId &&
    activeHistoryWindow.sessionGeneration === runtime?.sessionGeneration
      ? activeHistoryWindow.messages
      : (runtime?.conversation.messages ?? []);
  useLayoutEffect(() => {
    const previousScrollHeight = prependScrollHeightRef.current;
    const stream = streamRef.current;
    if (previousScrollHeight === undefined || !stream) return;
    setTranscriptScrollTop(stream, scrollTopAfterPrepend(stream, previousScrollHeight));
    prependScrollHeightRef.current = undefined;
    setHistoryLoading(undefined);
  }, [transcriptSourceMessages]);
  const liveTools = runtime?.conversation.tools ?? [];
  const liveToolsById = new Map(liveTools.map(tool => [tool.id, tool]));
  const transcriptMessages = transcriptSourceMessages.map(message => {
    const activity = message.tool?.id ? liveToolsById.get(message.tool.id) : undefined;
    return activity ? reconcileToolActivity(message, activity) : message;
  });
  const pendingMessages = (live.pendingMessages ?? []).filter(
    item => item.sessionId === runtime?.sessionId && item.sessionGeneration === runtime?.sessionGeneration,
  );
  const pendingById = new Map(pendingMessages.map(item => [item.id, item]));
  const queuedByCommand = new Map(queuedItems.map(item => [item.commandId, item]));
  const transcriptToolIds = new Set(transcriptMessages.flatMap(item => (item.tool?.id ? [item.tool.id] : [])));
  const transcriptMessageIds = new Set(transcriptMessages.map(item => item.id));
  const runningTools = liveTools.filter(tool => tool.status === "running");
  const hasRunningTools = runningTools.length > 0;
  useEffect(() => {
    if (!hasRunningTools) return;
    setToolNow(Date.now());
    const timer = window.setInterval(() => setToolNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningTools]);
  const liveToolMessages = runningTools.filter(tool => !transcriptToolIds.has(tool.id)).map(liveToolMessage);
  const pendingTranscriptMessages: MessageReadModel[] = pendingMessages
    .filter(item => !transcriptMessageIds.has(item.id))
    .map(item => ({
      id: item.id,
      role: "user",
      text: item.text,
      streaming: false,
      attachmentCount: item.attachmentCount,
      fileAttachmentCount: item.fileAttachmentCount,
    }));
  const visibleMessages =
    [...transcriptMessages, ...liveToolMessages, ...pendingTranscriptMessages].filter(item => {
      const text = item.text.trim();
      return item.role !== "assistant" || !["", "...", "…"].includes(text);
    }) ?? [];
  const conversationBlocks = useMemo(
    () => groupConversationMessages(visibleMessages),
    [transcriptMessages, runtime?.conversation.tools, live.pendingMessages],
  );
  const toolBlocksBeforeLaterPrompt = useMemo(() => {
    const ids = new Set<string>();
    let laterPrompt = false;
    for (let index = conversationBlocks.length - 1; index >= 0; index--) {
      const block = conversationBlocks[index]!;
      if ("tools" in block) {
        if (laterPrompt) ids.add(block.id);
      } else if (block.role === "user") laterPrompt = true;
    }
    return ids;
  }, [conversationBlocks]);
  const toolBlocksBeforeLaterAssistant = useMemo(() => {
    const ids = new Set<string>();
    let laterAssistant = false;
    for (let index = conversationBlocks.length - 1; index >= 0; index--) {
      const block = conversationBlocks[index]!;
      if ("tools" in block) {
        if (laterAssistant) ids.add(block.id);
      } else if (block.role === "assistant") laterAssistant = true;
    }
    return ids;
  }, [conversationBlocks]);
  const activeToolGroupId = running
    ? [...conversationBlocks].reverse().find(block => "tools" in block && !toolBlocksBeforeLaterAssistant.has(block.id))
        ?.id
    : undefined;
  const copyableAssistants = useMemo(() => finalAssistantIds(visibleMessages), [transcriptMessages]);
  /** The prompt a failed request can be sent from again. */
  const lastPrompt = useMemo(
    () => [...visibleMessages].reverse().find(item => item.role === "user" && item.entryId),
    [transcriptMessages],
  );
  const userTurns = useMemo(
    () => visibleMessages.filter(item => item.role === "user" && item.entryId),
    [transcriptMessages],
  );
  const userTurnKey = userTurns.map(item => item.entryId ?? item.id).join("\0");
  const latestUserTurn = userTurns.at(-1);
  const displayedRailPage = useMemo(() => {
    if (!railPage || !latestUserTurn?.entryId) return railPage;
    const preview =
      latestUserTurn.text.replace(/\s+/g, " ").trim() ||
      (latestUserTurn.attachmentCount
        ? `${latestUserTurn.attachmentCount} attached image${latestUserTurn.attachmentCount === 1 ? "" : "s"}`
        : "Empty prompt");
    return includeLatestLoadedTurn(
      railPage,
      {
        promptId: latestUserTurn.entryId,
        preview: preview.slice(0, 120),
        ...(latestUserTurn.createdAt ? { createdAt: latestUserTurn.createdAt } : {}),
      },
      activeHistoryWindow?.laterCursor === undefined,
    );
  }, [
    activeHistoryWindow?.laterCursor,
    latestUserTurn?.attachmentCount,
    latestUserTurn?.createdAt,
    latestUserTurn?.entryId,
    latestUserTurn?.text,
    railPage,
  ]);
  const railCheckpoints = useMemo(
    () =>
      new Map<string, TimelineCheckpointReadModel>(
        (runtime?.operational.timeline.checkpoints ?? [])
          .filter(checkpoint => checkpoint.ownerSessionId === runtime?.sessionId)
          .map(checkpoint => [checkpoint.promptEntryId, checkpoint]),
      ),
    [runtime?.operational.timeline.checkpoints, runtime?.sessionId],
  );
  useEffect(() => {
    const root = streamRef.current;
    if (!root || !userTurns.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rootRect = root.getBoundingClientRect();
      const turns = userTurns.flatMap(turn => {
        const id = turn.entryId ?? turn.id;
        const element = turnRefs.current.get(id);
        if (!element) return [];
        const rect = element.getBoundingClientRect();
        return [{ id, top: rect.top, bottom: rect.bottom }];
      });
      const visible = new Set(turnIdsInViewport(turns, rootRect));
      setVisibleTurnIds(current => (sameStringSet(current, visible) ? current : visible));
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
    void runtimeStore
      .conversationTurnIndex()
      .then(page => {
        if (active) setRailPage(page);
      })
      .catch(error => {
        if (!active) return;
        setRailPage(undefined);
        runtimeStore.reportError(error instanceof Error ? error.message : "Unable to load conversation turns");
      })
      .finally(() => {
        if (active) setRailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [live.connection, runtime?.ready, runtime?.sessionId, runtime?.sessionGeneration, runtime?.metrics.userMessages]);
  const activeAgents = useMemo(
    () => runtime?.conversation.delegatedRuns.filter(run => run.status === "running") ?? [],
    [runtime?.conversation.delegatedRuns],
  );
  const slashMatch = draftingOnly ? null : /^\/([^\s]*)$/.exec(message);
  const suggestions =
    slashMatch && !suggestionsDismissed
      ? [
          { name: "login", description: "Connect an AI provider", source: "extension" as const },
          ...(controls?.commands ?? []),
        ]
          .filter(
            (command, index, commands) => commands.findIndex(candidate => candidate.name === command.name) === index,
          )
          .filter(command => command.name.toLowerCase().startsWith(slashMatch[1]!.toLowerCase()))
          .slice(0, 8)
      : [];
  const fileMention = useMemo(
    () => (slashMatch || suggestionsDismissed ? undefined : fileMentionAtCaret(message, caretPosition)),
    [caretPosition, message, slashMatch, suggestionsDismissed],
  );
  useEffect(() => {
    if (!fileMention || !connected) {
      setFileSuggestions([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void runtimeStore
        .fileSuggestions(fileMention.query)
        .then(result => {
          if (active) setFileSuggestions(result.available ? result.paths : []);
        })
        .catch(() => {
          if (active) setFileSuggestions([]);
        });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [connected, fileMention?.query, runtime?.sessionId]);
  useEffect(() => {
    setSuggestionIndex(0);
  }, [message, controls?.commands, fileSuggestions.join("\0")]);
  useEffect(() => {
    suggestionListRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
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
    if (draftingOnly || (!value && images.length === 0 && files.length === 0) || !connected || composerBlocked) return;
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
    } catch {
      /* Store exposes the command error in the live connection state. */
    } finally {
      setSubmitting(false);
    }
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
    const workspacePath = event.dataTransfer.getData(WORKSPACE_FILE_DRAG_TYPE);
    if (workspacePath) {
      const start = promptRef.current?.selectionStart ?? message.length;
      const end = promptRef.current?.selectionEnd ?? start;
      const next = insertFileMention(message, start, end, workspacePath);
      updateMessage(next.value);
      setCaretPosition(next.caret);
      requestAnimationFrame(() => {
        promptRef.current?.focus();
        promptRef.current?.setSelectionRange(next.caret, next.caret);
      });
      return;
    }
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
    try {
      await runtimeStore.setSessionControls(model.provider, model.id, level);
    } finally {
      setControlBusy("");
    }
  };
  const controlsDisabled = !connected || submitting || Boolean(controlBusy);
  const restoreQueued = async (queued: QueuedPromptReadModel) => {
    if (queued.state !== "queued") return;
    setQueueBusy({ id: queued.id, action: "edit" });
    try {
      const restored = await runtimeStore.restoreQueuedPrompt(queued.id);
      updateMessage(restored.message);
      setImages((restored.images ?? []).map(image => ({ ...image, id: crypto.randomUUID() })));
      setFiles((restored.files ?? []).map(file => ({ ...file, id: crypto.randomUUID() })));
      setPlanMode(restored.planMode);
      requestAnimationFrame(() => promptRef.current?.focus());
    } catch {
      // Store routes the failure through the application toast.
    } finally {
      setQueueBusy(undefined);
    }
  };
  const steerQueued = async (queued: QueuedPromptReadModel) => {
    if (queued.state !== "queued") return;
    setQueueBusy({ id: queued.id, action: "steer" });
    try {
      await runtimeStore.steerQueuedPrompt(queued.id);
    } catch {
      /* Store routes the failure through the application toast. */
    } finally {
      setQueueBusy(undefined);
    }
  };
  const loadHistory = async (all: boolean, preservePosition = false) => {
    const stream = streamRef.current;
    if (preservePosition && (!stream || prependScrollHeightRef.current !== undefined)) return;
    followBottomRef.current = false;
    if (preservePosition && stream) prependScrollHeightRef.current = stream.scrollHeight;
    setHistoryLoading(all ? "all" : "page");
    try {
      await runtimeStore.loadEarlierMessages(all);
      if (!preservePosition) {
        requestAnimationFrame(() => {
          if (stream) setTranscriptScrollTop(stream, 0);
          setHistoryLoading(undefined);
        });
      }
    } catch {
      prependScrollHeightRef.current = undefined;
      setHistoryLoading(undefined);
      // Store routes the failure through the application toast.
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
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          turnRefs.current.get(turn.promptId)?.scrollIntoView({ behavior: "auto", block: "start" });
        }),
      );
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
  /** Re-runs a prompt unchanged, which is what editing it without an edit does. */
  const resendPrompt = async (item: MessageReadModel) => {
    if (!item.entryId) return;
    setSubmitting(true);
    try {
      await runtimeStore.editPrompt(item.entryId, item.text, [], false);
    } catch {
      // The store routes the failure through the application toast.
    } finally {
      setSubmitting(false);
    }
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
    if (draftingOnly) return;
    const activeSuggestions = suggestions.length ? suggestions : fileSuggestions;
    if (activeSuggestions.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSuggestionIndex(
          current =>
            (current + (event.key === "ArrowDown" ? 1 : -1) + activeSuggestions.length) % activeSuggestions.length,
        );
        return;
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing &&
        suggestions.length &&
        slashMatch &&
        isExactSlashCommandSelection(slashMatch[1]!, suggestions[suggestionIndex]?.name)
      ) {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
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
      {pendingSession ? (
        <PendingSessionShell pending={pendingSession} />
      ) : (
        live.connection === "loading" && <div className="conversation-state">Loading runtime…</div>
      )}
      {!draftingOnly && (
        <ActiveAgents runs={activeAgents} colors={agentColors} onSelect={onSelectAgent} />
      )}
      {runtime && (
        <div
          ref={streamRef}
          className={`message-stream${prependScrollHeightRef.current === undefined ? "" : " is-prepending-history"}`}
          aria-live="polite"
          onScroll={event => {
            followBottomRef.current = isNearTranscriptBottom(event.currentTarget);
            if (!historyLoading && event.currentTarget.scrollTop < 64 && live.historyWindow?.earlierCursor) {
              void loadHistory(false, true);
            } else if (
              !historyLoading &&
              isNearTranscriptBottom(event.currentTarget, 64) &&
              live.historyWindow?.laterCursor
            ) {
              void loadNewerHistory();
            }
          }}>
          <div className="transcript-layout">
            <div ref={transcriptRef} className="transcript-column">
              {live.historyWindow?.earlierCursor && (
                <div className="history-loader">
                  <span>{runtime.conversation.historyRemaining?.toLocaleString()} earlier entries</span>
                  <div>
                    <button type="button" disabled={Boolean(historyLoading)} onClick={() => void loadHistory(false)}>
                      {historyLoading === "page" ? "Loading…" : "Load 100 earlier"}
                    </button>
                    <button type="button" disabled={Boolean(historyLoading)} onClick={() => void loadHistory(true)}>
                      {historyLoading === "all" ? "Loading all…" : "Load all"}
                    </button>
                  </div>
                </div>
              )}
              {conversationBlocks.length === 0 && live.connection === "connected" && (
                <div className="conversation-state">No messages yet. Start the conversation below.</div>
              )}
              {conversationBlocks.map(block => {
                if ("tools" in block) {
                  return (
                    <ToolCallGroup
                      key={block.id}
                      calls={messageToolCallViews(block.tools, toolNow)}
                      running={block.id === activeToolGroupId}
                      onExpand={toolBlocksBeforeLaterPrompt.has(block.id) ? undefined : forceTranscriptBottom}
                    />
                  );
                }
                if (block.role === "tool")
                  return <ToolCallList key={block.id} calls={messageToolCallViews([block], toolNow)} />;
                if (block.compaction)
                  return <CompactionDisclosure key={block.id} message={block} onOpen={onOpenCompaction} />;
                if (block.role === "system") return <SystemDisclosure key={block.id} message={block} />;
                const editing = edit?.messageId === block.id;
                const pending = pendingById.get(block.id);
                const queued = pending ? queuedByCommand.get(pending.commandId) : undefined;
                const queueIndex = queued ? queuedItems.indexOf(queued) : -1;
                const busy = queued && queueBusy?.id === queued.id ? queueBusy.action : undefined;
                return (
                  <div
                    className={`message-block role-${block.role}${pending ? ` is-pending is-${pending.state}` : ""}`}
                    key={block.id}>
                    <article
                      className={`conversation-message role-${block.role}${editing ? " is-editing" : ""}${pending ? " is-pending" : ""}`}
                      data-turn-id={block.role === "user" && !pending ? block.id : undefined}
                      ref={
                        block.role === "user" && !pending
                          ? element => {
                              const turnId = block.entryId ?? block.id;
                              if (element) turnRefs.current.set(turnId, element);
                              else turnRefs.current.delete(turnId);
                            }
                          : undefined
                      }>
                      <small>
                        {block.role}
                        {pending?.state === "queued" ? " - pending" : block.streaming ? " · streaming" : ""}
                      </small>
                      {editing && edit ? (
                        <PromptEditor
                          edit={edit}
                          disabled={submitting}
                          onChange={setEdit}
                          onCancel={() => setEdit(undefined)}
                          onSubmit={() => void submitEdit()}
                        />
                      ) : (
                        block.text && <MarkdownContent text={block.text} />
                      )}
                    </article>
                    {!editing && (
                      <MessageAttachments
                        message={block}
                        thumbnailReloadKey={`${live.connection}:${runtime?.sessionGeneration ?? ""}`}
                        openAttachment={openAttachment}
                        onOpen={onOpenAttachment}
                      />
                    )}
                    {block.role === "assistant" && Boolean(block.changedFiles?.length) && (
                      <ChangedFiles
                        files={block.changedFiles!}
                        entryId={block.entryId}
                        open={block.entryId === openTurnDiffEntryId}
                        onOpen={onOpenTurnDiff}
                      />
                    )}
                    {pending ? (
                      <div className="pending-message-footer" role="status">
                        <span>
                          <IconLoader2 className="pending-message-spinner" size={12} />
                          {pending.state === "queued" ? "Waiting to send" : "Sending"}
                        </span>
                        {pending.planMode && <span>Plan mode</span>}
                        {queued?.state === "queued" && (
                          <span className="pending-message-actions">
                            <button
                              type="button"
                              disabled={Boolean(queueBusy) || hasDraft}
                              title={
                                hasDraft
                                  ? "Finish or clear the current draft before editing this message"
                                  : "Edit in composer"
                              }
                              onClick={() => void restoreQueued(queued)}
                              aria-label={`Edit queued message ${queueIndex + 1}`}>
                              {busy === "edit" ? (
                                <IconLoader2 className="prompt-send-spinner" size={13} />
                              ) : (
                                <IconPencil size={13} />
                              )}
                              Edit
                            </button>
                            <button
                              type="button"
                              disabled={Boolean(queueBusy)}
                              onClick={() => void steerQueued(queued)}
                              aria-label={`Steer with queued message ${queueIndex + 1}`}>
                              {busy === "steer" ? (
                                <IconLoader2 className="prompt-send-spinner" size={13} />
                              ) : (
                                <IconArrowBackUp size={13} />
                              )}
                              Steer
                            </button>
                          </span>
                        )}
                      </div>
                    ) : (
                      !editing &&
                      (block.role === "user" ||
                        copyableAssistants.has(block.id) ||
                        (block.role === "assistant" && block.workDurationMs !== undefined)) && (
                        <MessageFooter
                          message={block}
                          canCopy={Boolean(block.text) && (block.role === "user" || copyableAssistants.has(block.id))}
                          disabled={!connected || streaming || submitting || Boolean(edit)}
                          onEdit={block.role === "user" && block.entryId ? () => startEdit(block) : undefined}
                          onUndo={
                            block.role === "user" && block.entryId
                              ? () =>
                                  setUndo({
                                    entryId: block.entryId!,
                                    text: block.text,
                                    attachmentCount: block.attachmentCount ?? 0,
                                  })
                              : undefined
                          }
                          onFork={block.role === "user" && block.entryId ? () => startFork(block) : undefined}
                        />
                      )
                    )}
                  </div>
                );
              })}
              {runtime.conversation.retry.active && (
                <RunSeam
                  state="attention"
                  label="Retrying request"
                  value={retryLabel(runtime.conversation.retry.attempt, runtime.conversation.retry.maxAttempts)}
                />
              )}
              {runtime.conversation.compaction.active && (
                <RunSeam
                  state="running"
                  label="Compacting context"
                  value={`${formatCompactNumber(runtime.metrics.contextTokens)} used · ${Math.round(runtime.metrics.contextPercent)}% of the window`}
                />
              )}
              {runtime.conversation.workStartedAt ? (
                <WorkTimer
                  startedAt={runtime.conversation.workStartedAt}
                  modelName={runtime.conversation.workModelName}
                  thinkingLevel={runtime.conversation.workThinkingLevel}
                />
              ) : (
                runtime.conversation.stoppedRun && (
                  <WorkTimer
                    durationMs={runtime.conversation.stoppedRun.durationMs}
                    modelName={runtime.conversation.stoppedRun.modelName}
                    thinkingLevel={runtime.conversation.stoppedRun.thinkingLevel}
                    stopped
                  />
                )
              )}
              {runtime.conversation.agentError && (
                <SeamDisclosure
                  state="failed"
                  label="Request failed"
                  action="Error"
                  actions={
                    <>
                      {lastPrompt && (
                        <button
                          className="icon-button"
                          type="button"
                          title="Send again"
                          aria-label="Send again"
                          disabled={submitting}
                          onClick={() => void resendPrompt(lastPrompt)}>
                          <IconRefresh size={14} />
                        </button>
                      )}
                      {lastPrompt && (
                        <button
                          className="icon-button"
                          type="button"
                          title="Edit prompt"
                          aria-label="Edit prompt"
                          onClick={() => startEdit(lastPrompt)}>
                          <IconPencil size={14} />
                        </button>
                      )}
                      <CopyMessageButton text={runtime.conversation.agentError} label="Copy error" />
                    </>
                  }>
                  <pre className="seam-error">{runtime.conversation.agentError}</pre>
                </SeamDisclosure>
              )}
              {live.historyWindow?.laterCursor && (
                <div className="history-loader is-later">
                  <button type="button" disabled={Boolean(historyLoading)} onClick={() => void loadNewerHistory()}>
                    {historyLoading === "newer" ? "Loading…" : "Load 100 newer"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {runtime && (
        <HistoryRail
          page={live.treeChanging ? undefined : displayedRailPage}
          checkpoints={railCheckpoints}
          visibleIds={visibleTurnIds}
          loading={railLoading}
          onPage={(direction, cursor) => void loadRailPage(direction, cursor)}
          onSelect={turn => void selectRailTurn(turn)}
        />
      )}
      {undo && (
        <UndoConfirmDialog
          undo={undo}
          submitting={submitting}
          onCancel={() => setUndo(undefined)}
          onConfirm={() => void submitUndo()}
        />
      )}
      {fork && (
        <ForkDialog
          fork={fork}
          submitting={submitting}
          onCancel={() => setFork(undefined)}
          onConfirm={(name, mode) => void submitFork(name, mode)}
        />
      )}
      {runtime && <ExtensionUiSurface runtime={runtime} />}
      {runtime?.commandResult && (
        <div className={`composer-surface command-result is-${runtime.commandResult.severity}`} role="status">
          <div>
            <strong>/{runtime.commandResult.command}</strong>
            <span>{runtime.commandResult.output || "Command completed with no output."}</span>
          </div>
          <button
            type="button"
            aria-label="Close command result"
            onClick={() => void runtimeStore.dismissCommandResult(runtime.commandResult!.id).catch(() => undefined)}>
            <IconX size={15} />
          </button>
        </div>
      )}
      {(suggestions.length > 0 || fileSuggestions.length > 0) && (
        <div
          ref={suggestionListRef}
          className={`composer-surface slash-suggestions${suggestions.length ? "" : " file-suggestions"}`}
          id={suggestions.length ? "slash-command-suggestions" : "file-mention-suggestions"}
          role="listbox"
          aria-label={suggestions.length ? "Slash commands" : "Project files and directories"}>
          {suggestions.map((command, index) => (
            <button
              className={index === suggestionIndex ? "is-selected" : ""}
              type="button"
              role="option"
              aria-selected={index === suggestionIndex}
              key={`${command.source}-${command.name}`}
              onPointerDown={event => event.preventDefault()}
              onClick={() => chooseSuggestion(index)}>
              <strong>/{command.name}</strong>
              {command.description && <span>{command.description}</span>}
            </button>
          ))}
          {suggestions.length === 0 &&
            fileSuggestions.map((path, index) => {
              const isDirectory = path.endsWith("/");
              const displayPath = isDirectory ? path.slice(0, -1) : path;
              const separator = displayPath.lastIndexOf("/");
              const name = separator >= 0 ? displayPath.slice(separator + 1) : displayPath;
              const directory = separator >= 0 ? displayPath.slice(0, separator) : "";
              return (
                <button
                  className={index === suggestionIndex ? "is-selected" : ""}
                  type="button"
                  role="option"
                  aria-selected={index === suggestionIndex}
                  key={path}
                  onPointerDown={event => event.preventDefault()}
                  onClick={() => chooseFileSuggestion(index)}>
                  <strong>
                    {isDirectory ? <IconFolder size={13} aria-hidden /> : <FileTypeIcon path={path} size={13} />}
                    {name}
                  </strong>
                  {directory && <span>{directory}</span>}
                </button>
              );
            })}
        </div>
      )}
      <RetainedUiDialog request={draftingOnly ? undefined : pendingUi} />
      {pendingSession && (
        <div className={`pending-session-draft-note is-${pendingSession.phase}`} role="status">
          <strong>{pendingSession.phase === "failed" ? "Setup failed" : "Write while setup finishes"}</strong>
          <span>Draft is kept</span>
        </div>
      )}
      <form
        className={`prompt-form${draftingOnly ? " is-drafting-only" : ""}${dropActive ? " is-drop-active" : ""}${(!draftingOnly && pendingUi) || runtime?.commandResult || suggestions.length > 0 || fileSuggestions.length > 0 ? " is-joined" : ""}`}
        onSubmit={submit}
        onDragEnter={event => {
          event.preventDefault();
          if (!draftingOnly) setDropActive(true);
        }}
        onDragOver={event => event.preventDefault()}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
        }}
        onDrop={event => {
          if (draftingOnly) event.preventDefault();
          else void onDrop(event);
        }}>
        {dropActive && (
          <div className="composer-drop-overlay">
            <IconFileText size={18} />
            Drop workspace files to reference, or external files to attach
          </div>
        )}
        {images.length > 0 && (
          <ImageStrip
            images={images}
            label="Attached images"
            onRemove={id => setImages(current => current.filter(item => item.id !== id))}
          />
        )}
        {files.length > 0 && (
          <FileStrip files={files} onRemove={id => setFiles(current => current.filter(item => item.id !== id))} />
        )}
        <label className="sr-only" htmlFor="runtime-prompt">
          Message
        </label>
        <div className="prompt-input-wrap">
          <textarea
            ref={promptRef}
            id="runtime-prompt"
            rows={1}
            value={message}
            onChange={event => {
              updateMessage(event.target.value);
              setCaretPosition(event.target.selectionStart);
              setSuggestionsDismissed(false);
            }}
            onSelect={event => setCaretPosition(event.currentTarget.selectionStart)}
            onPaste={draftingOnly ? undefined : event => void onPaste(event)}
            onKeyDown={onPromptKeyDown}
            placeholder={
              draftingOnly
                ? "Write your first prompt"
                : !projectAvailable
                  ? "Add a project to start"
                  : connected
                    ? running || queuedItems.length > 0
                      ? "Queue a follow-up"
                      : "Send a prompt"
                    : "Runtime must be connected"
            }
            disabled={(!connected && !draftingOnly) || submitting || composerBlocked}
            aria-autocomplete="list"
            aria-controls={
              suggestions.length
                ? "slash-command-suggestions"
                : fileSuggestions.length
                  ? "file-mention-suggestions"
                  : undefined
            }
            aria-expanded={suggestions.length > 0 || fileSuggestions.length > 0}
          />
        </div>
        <div className="prompt-toolbar">
          <div className="prompt-left">
            <PlusMenu
              open={openMenu === "plus"}
              active={planMode}
              disabled={!connected || submitting || composerBlocked}
              available={planAvailable}
              onToggle={() => setOpenMenu(current => (current === "plus" ? undefined : "plus"))}
              onClose={() => setOpenMenu(undefined)}
              onChange={setPlanMode}
              onFiles={addFiles}
            />
            {planMode && (
              <button
                className="plan-mode-indicator"
                type="button"
                onClick={() => setPlanMode(false)}
                aria-label="Turn off Plan mode"
                title="Turn off Plan mode">
                <IconBulb size={14} />
                Plan mode
              </button>
            )}
            {continuityPlanning && (
              <span className="continuity-planning-indicator" role="status" aria-live="polite">
                <IconBulb size={14} />
                Planning
              </span>
            )}
          </div>
          <div className="prompt-right">
            <div className="prompt-metrics" aria-label="Session usage">
              <span
                title={`${runtime?.metrics.contextTokens.toLocaleString() ?? 0} of ${runtime?.metrics.contextLimit.toLocaleString() ?? 0} tokens`}>
                {runtime ? `${runtime.metrics.contextPercent.toFixed(2)}%` : "—"}
              </span>
              <span>{runtime ? `$${runtime.metrics.cost.toFixed(2)}` : "—"}</span>
            </div>
            <ModelControl
              controls={controls}
              open={openMenu === "model"}
              disabled={controlsDisabled}
              busy={controlBusy === "controls"}
              onToggle={() => setOpenMenu(current => (current === "model" ? undefined : "model"))}
              onClose={() => setOpenMenu(undefined)}
              onApply={setSessionControls}
            />
            {running && !hasDraft ? (
              <button
                className="prompt-abort"
                type="button"
                onClick={() => void runtimeStore.abort().catch(() => undefined)}
                disabled={!connected || stopping}
                aria-label={stopping ? "Stopping response" : "Stop response"}
                aria-busy={stopping}>
                <IconSquareFilled size={13} />
              </button>
            ) : (
              <button
                className="prompt-send"
                disabled={!connected || composerBlocked || submitting || !hasDraft || !controls?.model}
                type="submit"
                aria-label={sending ? "Sending message" : running ? "Queue message" : "Send message"}>
                {sending ? <IconLoader2 className="prompt-send-spinner" size={16} /> : <IconArrowUp size={16} />}
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}

/** Counts up while setup runs, so the wait shows a real number. */
function useElapsedSeconds(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setSeconds(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return seconds;
}

function elapsedLabel(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * What a new session can actually report while it opens: the project it is
 * opening in, how long it has taken, and the one step that is running. The
 * screen used to centre a scanning bar that measured nothing.
 */
function PendingSessionShell({ pending }: { pending: PendingSessionView }) {
  const failed = pending.phase === "failed";
  const elapsed = useElapsedSeconds(!failed);
  const state = failed ? "is-failed" : pending.connected ? "is-running" : "is-attention";
  const stateLabel = failed ? "failed" : pending.connected ? "working" : "stalled";
  return (
    <div className="pending-session-shell" role={failed ? "alert" : "status"} aria-live="polite">
      <div className="pending-session-head">
        <span className="pending-session-mark" aria-hidden="true">
          <img src="/pylon-mark.svg" alt="" />
        </span>
        <div>
          <span className="section-kicker">New session</span>
          <h2>{pending.projectLabel}</h2>
        </div>
        {!failed && <time className="pending-session-elapsed">{elapsedLabel(elapsed)}</time>}
      </div>
      <code className="pending-session-path">{pending.cwd}</code>
      <div className="pending-session-step">
        <span className={`status-orb ${state}`} aria-hidden="true" />
        <strong>Loading the runtime</strong>
        <span className={`pending-session-state ${state}`}>{stateLabel}</span>
      </div>
      {failed ? (
        <>
          <p className="pending-session-error">{pending.error || "Pylon could not prepare this session."}</p>
          <button type="button" onClick={pending.onRetry}>
            Retry
          </button>
        </>
      ) : (
        <p className="pending-session-note">
          {pending.connected ? "Your first message sends once the runtime is ready." : "Connection lost. Retrying."}
        </p>
      )}
    </div>
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
    const timer = window.setTimeout(() => setDisplayed(undefined), exitDelay(140));
    return () => window.clearTimeout(timer);
  }, [request, displayed]);

  if (!displayed || displayed.payload.context === "provider-auth") return null;
  return (
    <div className={exiting ? "ui-request-motion is-exiting" : "ui-request-motion"}>
      <UiDialog key={displayed.requestId} request={displayed} />
    </div>
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
  return (
    <div ref={rootRef} className="composer-popover-root">
      <button
        ref={triggerRef}
        className={`composer-plus${active ? " is-active" : ""}`}
        type="button"
        disabled={disabled}
        aria-label="Add prompt option"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}>
        <IconPlus size={17} />
      </button>
      {open && (
        <div className="plus-menu composer-popover" role="menu">
          <button type="button" role="menuitem" onClick={() => fileRef.current?.click()}>
            <IconPaperclip size={16} />
            <span>
              <strong>Files and images</strong>
              <small>Select one or more attachments</small>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!available}
            onClick={() => {
              onChange(!active);
              onClose();
              triggerRef.current?.focus();
            }}>
            <IconBulb size={16} />
            <span>
              <strong>Plan mode</strong>
              <small>{available ? "Plan the next prompt" : "Continuity /plan is unavailable"}</small>
            </span>
            {active && <IconCheck size={15} />}
          </button>
        </div>
      )}
      <input
        ref={fileRef}
        className="sr-only"
        type="file"
        multiple
        tabIndex={-1}
        aria-label="Select files and images"
        onChange={event => {
          const selected = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          onClose();
          void onFiles(selected).finally(() => triggerRef.current?.focus());
        }}
      />
    </div>
  );
}

function railThinkingLabel(level: ThinkingLevelReadModel): string {
  if (level === "minimal") return "Min";
  if (level === "medium") return "Med";
  if (level === "xhigh") return "X-Hi";
  return thinkingLabel(level);
}

function contextLabel(tokens?: number): string {
  if (!tokens) return "—";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1_000)}K`;
}

/** USD per million tokens, input then output, trimmed of trailing zeros. */
function priceLabel(cost?: { input: number; output: number }): string {
  if (!cost) return "—";
  const money = (value: number) =>
    value < 1 ? value.toFixed(2).replace(/0$/, "") : String(Math.round(value * 100) / 100);
  return `${money(cost.input)} / ${money(cost.output)}`;
}

/** Percentages that stop the rail's track at the first and last level the model runs. */
function railTrackStyle(model: ModelOptionReadModel, axis: ThinkingLevelReadModel[]): CSSProperties {
  const supported = modelThinkingLevels(model);
  const half = 100 / axis.length / 2;
  const first = Math.max(0, axis.indexOf(supported[0]));
  const last = Math.max(0, axis.indexOf(supported[supported.length - 1]));
  return {
    "--rail-from": `${(first / axis.length) * 100 + half}%`,
    "--rail-to": `${100 - ((last / axis.length) * 100 + half)}%`,
  } as CSSProperties;
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
  const listRef = useRef<HTMLDivElement>(null);
  const applyingRef = useRef(false);
  const queuedSelectionRef = useRef<{ model: ModelOptionReadModel; level: ThinkingLevelReadModel } | undefined>(
    undefined,
  );
  const [modelKey, setModelKey] = useState("");
  const [level, setLevel] = useState<ThinkingLevelReadModel>("off");
  const [modelQuery, setModelQuery] = useState("");
  const hiddenModels = useHiddenModels();
  const models = useMemo(() => {
    const base = visibleModels(controls?.models ?? [], hiddenModels);
    for (const applied of [controls?.model, controls?.pending?.model]) {
      if (applied && !base.some(model => toModelKey(model) === toModelKey(applied))) {
        const original = (controls?.models ?? []).find(model => toModelKey(model) === toModelKey(applied));
        if (original) base.push(original);
      }
    }
    const query = modelQuery.trim().toLowerCase();
    if (!query) return base;
    const matched = base.filter(model => `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query));
    const selected = base.find(model => toModelKey(model) === modelKey);
    if (selected && !matched.includes(selected)) matched.push(selected);
    return matched;
  }, [controls?.models, controls?.model, controls?.pending?.model, hiddenModels, modelKey, modelQuery]);
  const axisLevels = useMemo(() => railThinkingAxis(models), [models]);
  /* The provider is the group heading, so it never repeats on a row. */
  const groups = useMemo(() => {
    const built: { provider: string; models: ModelOptionReadModel[] }[] = [];
    for (const model of models) {
      const last = built[built.length - 1];
      if (last && last.provider === model.provider) last.models.push(model);
      else built.push({ provider: model.provider, models: [model] });
    }
    return built;
  }, [models]);
  const selectedModelIndex = Math.max(
    0,
    models.findIndex(model => toModelKey(model) === modelKey),
  );
  const selectedModel = models[selectedModelIndex];
  const selectedLevelIndex = Math.max(0, axisLevels.indexOf(level));
  const selectedStopId = `model-stop-${selectedModelIndex}-${selectedLevelIndex}`;

  useEffect(() => {
    if (!open) {
      setModelQuery("");
      return;
    }
    const selectedControls = controls?.pending ?? controls;
    const currentKey = selectedControls?.model ? toModelKey(selectedControls.model) : "";
    const currentModel = models.find(model => toModelKey(model) === currentKey) ?? models[0];
    const availableLevels = currentModel?.thinkingLevels ?? [];
    const currentLevel = availableLevels.includes(selectedControls?.thinkingLevel ?? "off")
      ? (selectedControls?.thinkingLevel ?? "off")
      : (availableLevels[0] ?? "off");
    setModelKey(currentModel ? toModelKey(currentModel) : "");
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
    requestAnimationFrame(() => listRef.current?.focus());
    return () => {
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("keydown", keyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(selectedStopId)?.scrollIntoView({ block: "nearest" });
  }, [open, selectedStopId]);

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
  const select = (model: ModelOptionReadModel, nextLevel: ThinkingLevelReadModel) => {
    setModelKey(toModelKey(model));
    setLevel(nextLevel);
    applySelection(model, nextLevel);
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
    const next = moveRailSelection(models, axisLevels, selectedModelIndex, level, move[0], move[1]);
    if (!next) return;
    if (toModelKey(next.model) !== modelKey || next.level !== level) select(next.model, next.level);
  };

  const appliedLevel = controls?.pending?.thinkingLevel ?? controls?.thinkingLevel;
  return (
    <div ref={rootRef} className="composer-popover-root model-control">
      <button
        ref={triggerRef}
        className="model-trigger"
        data-thinking={appliedLevel}
        type="button"
        disabled={disabled || !models.length}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onToggle}>
        <span>{(controls?.pending?.model ?? controls?.model)?.name ?? "No model"}</span>
        {appliedLevel && <small>{railThinkingLabel(appliedLevel)}</small>}
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div className="model-popover composer-popover" role="dialog" aria-label="Model and thinking" aria-busy={busy}>
          <div className="model-search">
            <IconSearch size={13} />
            <input
              value={modelQuery}
              onChange={event => setModelQuery(event.target.value)}
              placeholder="Filter models…"
              aria-label="Filter models"
              autoComplete="off"
              spellCheck={false}
            />
            {modelQuery && (
              <button type="button" onClick={() => setModelQuery("")} aria-label="Clear filter">
                <IconX size={12} />
              </button>
            )}
          </div>
          {/* One rail per model, drawn only across the levels it runs, against a shared axis. */}
          <div
            ref={listRef}
            className="model-list"
            role="grid"
            tabIndex={0}
            aria-label="Model and thinking selector"
            aria-rowcount={models.length + 1}
            aria-colcount={axisLevels.length + 1}
            aria-activedescendant={selectedStopId}
            aria-describedby="model-rail-help"
            style={{ "--rail-stop-count": axisLevels.length } as CSSProperties}
            onKeyDown={moveSelection}>
            <div className="model-axis" role="row">
              <span role="columnheader">Model</span>
              <span role="columnheader">Context</span>
              <span role="columnheader" title="US dollars per million tokens, input then output">
                $/M in · out
              </span>
              <div className="model-rail-scale">
                {axisLevels.map(item => (
                  <span role="columnheader" key={item} title={thinkingLabel(item)}>
                    {railThinkingLabel(item)}
                  </span>
                ))}
              </div>
            </div>
            {!models.length && (
              <p className="model-list-empty">
                No matching models. Clear the filter or hide fewer models in Settings → Models.
              </p>
            )}
            {groups.map(group => (
              <div className="model-group" role="rowgroup" aria-label={group.provider} key={group.provider}>
                <p className="model-group-name" role="presentation">
                  {group.provider}
                </p>
                {group.models.map(model => {
                  const key = toModelKey(model);
                  const modelIndex = models.indexOf(model);
                  const supported = modelThinkingLevels(model);
                  return (
                    <div className="model-row" role="row" key={key} data-active-model={key === modelKey}>
                      <span className="model-row-name" role="rowheader">
                        {model.name}
                      </span>
                      <span className="model-row-fact">{contextLabel(model.contextWindow)}</span>
                      <span className="model-row-fact">{priceLabel(model.cost)}</span>
                      <div className="model-rail" style={railTrackStyle(model, axisLevels)}>
                        {axisLevels.map((item, axisIndex) => {
                          const available = supported.includes(item);
                          const active = key === modelKey && item === level;
                          return (
                            <span
                              className={`model-stop${available ? "" : " is-empty"}${active ? " is-on" : ""}`}
                              data-thinking={item}
                              role="gridcell"
                              id={`model-stop-${modelIndex}-${axisIndex}`}
                              aria-selected={active}
                              aria-disabled={!available}
                              aria-label={
                                available
                                  ? `${model.name}, ${thinkingLabel(item)} thinking`
                                  : `${model.name}, ${thinkingLabel(item)} thinking unavailable`
                              }
                              title={available ? `${model.name}, ${thinkingLabel(item)}` : undefined}
                              onClick={available ? () => select(model, item) : undefined}
                              key={item}>
                              {available && (active ? <b>{railThinkingLabel(item)}</b> : <i />)}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {controls?.pending && (
            <p className="model-note">
              <IconAlertTriangle size={13} />
              Applies to your next message. This turn finishes on {controls.model?.name ?? "the current model"}.
            </p>
          )}
          <div className="model-foot" aria-live="polite">
            <span>
              <strong>{selectedModel?.name ?? "No model"}</strong>{" "}
              {level === "off" ? "without thinking" : `with ${thinkingLabel(level)} thinking`}
            </span>
            <small>{busy ? "Applying" : "Current session"}</small>
          </div>
          <p className="model-help" id="model-rail-help">
            Pick a stop to set model and thinking together. Arrow keys move one option at a time.
          </p>
        </div>
      )}
    </div>
  );
}

const comparableRailText = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .toLocaleLowerCase();

function HistoryRail({
  page,
  checkpoints,
  visibleIds,
  loading,
  onPage,
  onSelect,
}: {
  page?: ConversationTurnIndexPage;
  checkpoints: Map<string, TimelineCheckpointReadModel>;
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
    promptId?: string;
  }>();
  if (!page || page.totalCount < 3) return null;
  const turns = [...page.turns].reverse();
  const tooltipCheckpoint = tooltip?.promptId ? checkpoints.get(tooltip.promptId) : undefined;
  const showTooltip = (
    element: HTMLButtonElement,
    preview: string,
    label: string,
    createdAt?: string,
    promptId?: string,
  ) => {
    const container = element.closest(".conversation-panel");
    if (!container) return;
    const buttonRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const middle = buttonRect.top + buttonRect.height / 2 - containerRect.top;
    setTooltip({ top: Math.max(52, Math.min(containerRect.height - 52, middle)), preview, label, createdAt, promptId });
  };
  const hideTooltip = () => setTooltip(undefined);
  return (
    <>
      <nav className="history-rail" aria-label="Conversation turns">
        {page.earlierCursor && (
          <button
            className="history-tick is-loader"
            type="button"
            disabled={loading}
            onClick={() => onPage("earlier", page.earlierCursor)}
            onMouseEnter={event =>
              showTooltip(
                event.currentTarget,
                loading ? "Loading earlier turns…" : "Show earlier turns",
                "Earlier conversation turns",
              )
            }
            onFocus={event =>
              showTooltip(
                event.currentTarget,
                loading ? "Loading earlier turns…" : "Show earlier turns",
                "Earlier conversation turns",
              )
            }
            onMouseLeave={hideTooltip}
            onBlur={hideTooltip}
            aria-label="Show earlier conversation turns">
            <i />
          </button>
        )}
        {turns.map(turn => {
          const timestamp = formatMessageDateTime(turn.createdAt);
          const checkpoint = checkpoints.get(turn.promptId);
          const accessibleTitle = checkpoint ? `${checkpoint.title}. Prompt: ${turn.preview}` : turn.preview;
          return (
            <button
              className={`history-tick${visibleIds.has(turn.promptId) ? " is-active" : ""}`}
              type="button"
              key={turn.promptId}
              onClick={() => onSelect(turn)}
              onMouseEnter={event =>
                showTooltip(event.currentTarget, turn.preview, `Prompt: ${turn.preview}`, turn.createdAt, turn.promptId)
              }
              onFocus={event =>
                showTooltip(event.currentTarget, turn.preview, `Prompt: ${turn.preview}`, turn.createdAt, turn.promptId)
              }
              onMouseLeave={hideTooltip}
              onBlur={hideTooltip}
              aria-label={`Jump to prompt: ${accessibleTitle}${timestamp ? `, ${timestamp}` : ""}`}>
              <i />
            </button>
          );
        })}
        {page.laterCursor && (
          <button
            className="history-tick is-loader"
            type="button"
            disabled={loading}
            onClick={() => onPage("later", page.laterCursor)}
            onMouseEnter={event =>
              showTooltip(
                event.currentTarget,
                loading ? "Loading later turns…" : "Show later turns",
                "Later conversation turns",
              )
            }
            onFocus={event =>
              showTooltip(
                event.currentTarget,
                loading ? "Loading later turns…" : "Show later turns",
                "Later conversation turns",
              )
            }
            onMouseLeave={hideTooltip}
            onBlur={hideTooltip}
            aria-label="Show later conversation turns">
            <i />
          </button>
        )}
      </nav>
      {tooltip && (
        <div
          className="history-rail-tooltip"
          role="tooltip"
          aria-label={
            tooltipCheckpoint ? `Checkpoint: ${tooltipCheckpoint.title}. Prompt: ${tooltip.preview}` : tooltip.label
          }
          style={{ top: `${tooltip.top}px` }}>
          <strong>{tooltipCheckpoint?.title ?? tooltip.preview}</strong>
          {tooltipCheckpoint && comparableRailText(tooltipCheckpoint.title) !== comparableRailText(tooltip.preview) && (
            <span className="history-rail-prompt">Prompt: {tooltip.preview}</span>
          )}
          {tooltipCheckpoint && (
            <span className="history-rail-metrics">
              {tooltipCheckpoint.changes && (
                <>
                  <span>
                    {formatCompactNumber(tooltipCheckpoint.changes.fileCount)}{" "}
                    {tooltipCheckpoint.changes.fileCount === 1 ? "file · " : "files ·"}
                  </span>
                  <span className="is-addition">+{formatCompactNumber(tooltipCheckpoint.changes.additions)}</span>
                  <span className="is-deletion">-{formatCompactNumber(tooltipCheckpoint.changes.deletions)}</span> ·
                  {tooltipCheckpoint.changes.binaryCount > 0 && (
                    <span>{formatCompactNumber(tooltipCheckpoint.changes.binaryCount)} binary · </span>
                  )}
                </>
              )}
              {tooltipCheckpoint.verificationState === "passed" && <span className="is-verified">Verified</span>}
              {tooltipCheckpoint.verificationState === "failed" && <span className="is-failed">Checks failed</span>}
              {tooltipCheckpoint.verificationState === "unverified" && <span>Unverified</span>}
            </span>
          )}
          {tooltip.createdAt && <time dateTime={tooltip.createdAt}>{formatMessageDateTime(tooltip.createdAt)}</time>}
        </div>
      )}
    </>
  );
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
      onChange({ ...edit, imageError: error instanceof Error ? error.message : "The pasted image could not be read." });
    }
  };
  return (
    <div className="prompt-editor">
      {edit.images.length > 0 && (
        <ImageStrip
          images={edit.images}
          label="Replacement images"
          onRemove={id => onChange({ ...edit, images: edit.images.filter(image => image.id !== id) })}
        />
      )}
      <label className="sr-only" htmlFor={`edit-${edit.messageId}`}>
        Edit prompt
      </label>
      <textarea
        autoFocus
        id={`edit-${edit.messageId}`}
        value={edit.text}
        rows={Math.min(12, Math.max(3, edit.text.split(/\r?\n/).length))}
        disabled={disabled}
        onChange={event => onChange({ ...edit, text: event.target.value })}
        onPaste={event => void onPaste(event)}
        onKeyDown={event => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (edit.text.trim() || edit.images.length) onSubmit();
          }
        }}
      />
      {edit.imageError && (
        <p className="prompt-error" role="alert">
          {edit.imageError}
        </p>
      )}
      <div className="prompt-editor-actions">
        <button type="button" disabled={disabled} onClick={onCancel}>
          Cancel
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={disabled || (!edit.text.trim() && edit.images.length === 0)}
          onClick={onSubmit}>
          Send
        </button>
      </div>
    </div>
  );
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
    return () => {
      if (previous?.isConnected) previous.focus();
    };
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
  return (
    <div
      className="edit-confirm-backdrop"
      onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget && !submitting) onCancel();
      }}>
      <div
        ref={dialogRef}
        className="edit-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-confirm-title"
        onKeyDown={onKeyDown}>
        <header>
          <strong id="edit-confirm-title">Undo to this prompt?</strong>
          <button className="icon-button" type="button" onClick={onCancel} disabled={submitting} aria-label="Close">
            <IconX size={16} />
          </button>
        </header>
        <div>
          <p>
            Files and conversation history will return to immediately before this prompt. The prompt text will be
            restored to the composer without sending.
          </p>
          {undo.attachmentCount > 0 && (
            <p className="edit-confirm-warning">
              Historical {undo.attachmentCount === 1 ? "image cannot" : "images cannot"} be restored. Paste replacement
              images before sending again.
            </p>
          )}
        </div>
        <footer>
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button data-autofocus className="primary-button" type="button" onClick={onConfirm} disabled={submitting}>
            {submitting ? "Undoing…" : "Undo"}
          </button>
        </footer>
      </div>
    </div>
  );
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
    return () => {
      if (previous?.isConnected) previous.focus();
    };
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
  return (
    <div
      className="edit-confirm-backdrop fork-dialog-backdrop"
      onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
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
        onSubmit={event => {
          event.preventDefault();
          if (validName && !submitting) onConfirm(name.trim(), withTimeline ? "timeline" : "conversation");
        }}>
        <header>
          <strong id="fork-dialog-title">Fork from this prompt</strong>
          <button className="icon-button" type="button" onClick={onCancel} disabled={submitting} aria-label="Close">
            <IconX size={16} />
          </button>
        </header>
        <div>
          <p id="fork-dialog-description">Create a separate session from this point in the conversation.</p>
          <label className="fork-name">
            Session name
            <input
              data-autofocus
              value={name}
              maxLength={200}
              disabled={submitting}
              onChange={event => setName(event.target.value)}
            />
          </label>
          <label className={`fork-timeline ${fork.canUseTimeline ? "" : "is-disabled"}`}>
            <input
              type="checkbox"
              checked={withTimeline}
              disabled={!fork.canUseTimeline || submitting}
              onChange={event => setWithTimeline(event.target.checked)}
            />
            <span>Restore files from Timeline checkpoint</span>
          </label>
          {fork.timelineReason && <p className="fork-timeline-reason">{fork.timelineReason}</p>}
        </div>
        <footer>
          <button type="button" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button className="primary-button" type="submit" disabled={!validName || submitting}>
            {submitting ? "Forking…" : "Fork session"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function ImageStrip({
  images,
  label,
  onRemove,
}: {
  images: PastedImage[];
  label: string;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="prompt-images" aria-label={label}>
      {images.map((image, index) => (
        <div className="prompt-image" key={image.id}>
          <img src={`data:${image.mimeType};base64,${image.data}`} alt={`Pasted image ${index + 1}`} />
          <button type="button" onClick={() => onRemove(image.id)} aria-label={`Remove pasted image ${index + 1}`}>
            <IconX size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

function FileStrip({ files, onRemove }: { files: DroppedTextFile[]; onRemove: (id: string) => void }) {
  return (
    <div className="prompt-files" aria-label="Attached text files">
      {files.map(file => (
        <span className="prompt-file" key={file.id}>
          <IconFileText size={14} />
          <span title={file.name}>{file.name}</span>
          <small>{formatBytes(file.size)}</small>
          <button type="button" onClick={() => onRemove(file.id)} aria-label={`Remove ${file.name}`}>
            <IconX size={13} />
          </button>
        </span>
      ))}
    </div>
  );
}

export const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  const syntaxRevision = useSyntaxHighlightingRevision();
  const html = useMemo(
    () => DOMPurify.sanitize(renderMarkdown(text), { ALLOWED_ATTR: markdownAttributes, ALLOWED_TAGS: markdownTags }),
    [syntaxRevision, text],
  );

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

export function CopyMessageButton({ text, label }: { text: string; label: string }) {
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
  return (
    <button
      className={`message-copy ${state !== "idle" ? `is-${state}` : ""}`}
      type="button"
      onClick={() => void copy()}
      aria-label={state === "error" ? `${label} failed` : label}
      title={state === "copied" ? "Copied" : label}>
      {state === "copied" ? <IconCheck size={14} /> : <IconCopy size={14} />}
    </button>
  );
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
  return (
    <footer className="message-footer">
      {timestamp && <time dateTime={message.createdAt}>{timestamp}</time>}
      {canCopy && (
        <CopyMessageButton text={message.text} label={`Copy ${message.role === "user" ? "prompt" : "response"}`} />
      )}
      {message.role === "assistant" && message.workDurationMs !== undefined && (
        <WorkTimer
          durationMs={message.workDurationMs}
          modelName={message.modelName}
          thinkingLevel={message.thinkingLevel}
          turn={message.turn}
          gitBranch={message.gitBranch}
        />
      )}
      {onEdit && (
        <button type="button" disabled={disabled} onClick={onEdit} aria-label="Edit prompt" title="Edit prompt">
          <IconPencil size={14} />
        </button>
      )}
      {onUndo && (
        <button
          type="button"
          disabled={disabled || !message.canUndo}
          onClick={onUndo}
          aria-label="Undo to this prompt"
          title={
            message.canUndo
              ? "Undo to this prompt and restore files"
              : "No compatible Timeline checkpoint exists before this prompt"
          }>
          <IconArrowBackUp size={14} />
        </button>
      )}
      {onFork && (
        <button
          type="button"
          disabled={disabled}
          onClick={onFork}
          aria-label="Fork from this prompt"
          title="Fork from this prompt">
          <IconGitFork size={14} />
        </button>
      )}
    </footer>
  );
}

function formatMessageTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function formatMessageDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value));
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

function ChangedFiles({
  files,
  entryId,
  open,
  onOpen,
}: {
  files: NonNullable<MessageReadModel["changedFiles"]>;
  entryId?: string;
  open: boolean;
  onOpen: (entryId: string, files: NonNullable<MessageReadModel["changedFiles"]>, trigger: HTMLButtonElement) => void;
}) {
  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
  return (
    <SeamDisclosure
      state="set"
      label={`${files.length} ${files.length === 1 ? "file" : "files"} changed`}
      value={
        <>
          <ins>+{additions}</ins>
          <del>-{deletions}</del>
        </>
      }
      action="Files">
      <div className="file-list" aria-label="Files changed in this turn">
        {files.map(file => (
          <button
            className="file-row"
            type="button"
            key={file.path}
            onClick={() =>
              window.dispatchEvent(new CustomEvent("pylon:open-file", { detail: { path: file.path, view: "diff" } }))
            }>
            <code>{file.path}</code>
            <span>
              {file.binary ? (
                <small>binary</small>
              ) : (
                <>
                  <ins>+{file.additions ?? 0}</ins>
                  <del>-{file.deletions ?? 0}</del>
                </>
              )}
            </span>
          </button>
        ))}
      </div>
      {entryId && (
        <button
          className="seam-toggle"
          type="button"
          aria-expanded={open}
          aria-controls={open ? "turn-diff-panel" : undefined}
          onClick={event => onOpen(entryId, files, event.currentTarget)}>
          {open ? "Hide turn diff" : "Show turn diff"}
          <IconChevronRight size={13} />
        </button>
      )}
    </SeamDisclosure>
  );
}

export function WorkTimer({
  startedAt,
  durationMs,
  modelName,
  thinkingLevel,
  gitBranch,
  turn,
  stopped = false,
}: {
  startedAt?: string;
  durationMs?: number;
  modelName?: string;
  thinkingLevel?: MessageReadModel["thinkingLevel"];
  gitBranch?: string;
  turn?: number;
  stopped?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const elapsed = durationMs ?? (Number.isNaN(started) ? 0 : Math.max(0, now - started));
  return (
    <span className={`work-timer ${startedAt ? "is-active" : ""}`} role="status">
      <span className="work-timer-stats">
        {stopped ? "Stopped after" : startedAt ? "Working for" : "Worked for"} {formatWorkDuration(elapsed)}
        {modelName && <> · {modelName}</>}
        {thinkingLevel && <> · {thinkingLabel(thinkingLevel)}</>}
      </span>
      {(turn || gitBranch) && (
        <span className="work-timer-context">
          {gitBranch && (
            <span className="work-timer-branch">
              <IconGitBranch aria-hidden="true" size={14} />
              {gitBranch} ·
            </span>
          )}
          {turn && <span>Turn {turn}</span>}
        </span>
      )}
    </span>
  );
}

function ActiveAgents({
  runs,
  colors,
  onSelect,
}: {
  runs: DelegatedAgentRunReadModel[];
  colors: AgentColorMap;
  onSelect?: (id?: string) => void;
}) {
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
    }, exitDelay(140));
    return () => window.clearTimeout(timer);
  }, [runs]);
  if (!displayed.length) return null;

  const ordered = [...displayed].sort((a, b) => (agentCost(b) ?? -1) - (agentCost(a) ?? -1));
  const knownCosts = ordered.flatMap(run => {
    const cost = agentCost(run);
    return cost === undefined ? [] : [cost];
  });
  const totalCost = knownCosts.length ? `$${knownCosts.reduce((sum, cost) => sum + cost, 0).toFixed(4)}` : "—";

  return (
    <aside className={`agent-dock${exiting ? " is-exiting" : ""}`} aria-label="Active delegated agents">
      <header className="agent-dock-head">
        <span>
          <b>{ordered.length}</b> {ordered.length === 1 ? "agent" : "agents"} working
        </span>
        <span className="mono">{totalCost}</span>
      </header>
      {ordered.slice(0, 5).map(run => {
        const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
        const elapsed = Number.isNaN(started) ? (run.durationMs ?? 0) : Math.max(0, now - started);
        const calls = pairedToolCallViews(pairAgentActivity(run.activity), true, now);
        const cost = agentCost(run);
        const hot = cost !== undefined && run.costLimitUsd !== undefined && cost >= run.costLimitUsd;
        return (
          <button
            className="agent-dock-entry agent-lane"
            type="button"
            key={run.id}
            style={agentColor(run, colors)}
            onClick={() => onSelect?.(run.id)}>
            <span className="agent-dock-name">
              <OverviewOrb state={hot ? "attention" : "running"} label={hot ? "Cost limit reached" : "Working"} />
              {run.agentName ? (
                <>
                  <span className="agent-name">{run.agentName}</span>
                  <span className="agent-kind-chip">{agentKindLabel(run.kind)}</span>
                </>
              ) : (
                agentKindLabel(run.kind)
              )}
            </span>
            <span className={`agent-dock-cost mono${hot ? " is-hot" : ""}`}>
              {cost === undefined ? "—" : `$${cost.toFixed(4)}`}
            </span>
            <span className="agent-dock-task">{agentRequestLabel(run)}</span>
            <span className="agent-lane-base">
              <ToolCallTrack calls={calls} slots="auto" variant="lane" />
              <small className="mono">
                {calls.length} {calls.length === 1 ? "call" : "calls"} · {formatWorkDuration(elapsed)}
              </small>
            </span>
          </button>
        );
      })}
      {ordered.length > 5 && (
        <button className="agent-dock-more" type="button" onClick={() => onSelect?.()}>
          +{ordered.length - 5} more in the agent drawer
        </button>
      )}
    </aside>
  );
}

function agentCost(run: DelegatedAgentRunReadModel): number | undefined {
  const usage =
    (run.kind === "spawn_agent" || run.kind === "spawn_session" ? run.sessionUsage : undefined) ?? run.usage;
  return usage?.cost;
}

function agentKindLabel(kind: DelegatedAgentKind): string {
  if (kind === "repo_scout") return "Repo Scout";
  if (kind === "web_scout") return "Web Scout";
  if (kind === "spawn_agent") return "Private Agent";
  if (kind === "spawn_session") return "Spawned Session";
  return kind === "advisor" ? "Advisor" : "Grunt";
}

function MessageAttachments({
  message,
  thumbnailReloadKey,
  openAttachment,
  onOpen,
}: {
  message: MessageReadModel;
  thumbnailReloadKey: string;
  openAttachment?: { sourceEntryId: string; index: number };
  onOpen: (attachments: MessageAttachmentReadModel[], index: number, trigger: HTMLButtonElement) => void;
}) {
  const attachments = message.attachments ?? [];
  const imageDescriptors = attachments.filter(attachment => attachment.kind === "image").length;
  const fileDescriptors = attachments.filter(attachment => attachment.kind === "file").length;
  const legacyImages = Math.max(0, (message.attachmentCount ?? 0) - imageDescriptors);
  const legacyFiles = Math.max(0, (message.fileAttachmentCount ?? 0) - fileDescriptors);
  return (
    <>
      {attachments.length > 0 && (
        <div className="message-attachment-list" aria-label={`${attachments.length} viewable attachments`}>
          {attachments.map((attachment, index) => (
            <button
              className="message-attachment-row"
              type="button"
              key={`${attachment.sourceEntryId}:${attachment.index}`}
              onClick={event => onOpen(attachments, index, event.currentTarget)}
              aria-current={
                openAttachment?.sourceEntryId === attachment.sourceEntryId && openAttachment.index === attachment.index
              }
              aria-label={`Open ${attachment.name}`}>
              <AttachmentThumbnail attachment={attachment} reloadKey={thumbnailReloadKey} />
              <span className="message-attachment-copy">
                <strong title={attachment.name}>{attachment.name}</strong>
                <small>
                  {attachment.mimeType} · {formatBytes(attachment.size)}
                </small>
              </span>
              <IconChevronRight className="message-attachment-chevron" size={15} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      {Boolean(legacyImages) && (
        <span className="message-attachments">
          <IconPhoto size={14} />
          {legacyImages} historical {legacyImages === 1 ? "image" : "images"}
        </span>
      )}
      {Boolean(legacyFiles) && (
        <span className="message-attachments">
          <IconFileText size={14} />
          {legacyFiles} historical {legacyFiles === 1 ? "file" : "files"}
        </span>
      )}
    </>
  );
}

export function AttachmentThumbnail({
  attachment,
  reloadKey,
}: {
  attachment: MessageAttachmentReadModel;
  reloadKey: string;
}) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [source, setSource] = useState("");

  useEffect(() => {
    if (attachment.kind !== "image") return;
    const controller = new AbortController();
    const load = () => {
      void runtimeStore
        .conversationAttachment(attachment.sourceEntryId, attachment.index, controller.signal)
        .then(content => {
          if (content.kind === "image") setSource(`data:${content.mimeType};base64,${content.data}`);
        })
        .catch(() => undefined);
    };
    const element = elementRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      load();
      return () => controller.abort();
    }
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        load();
      },
      { rootMargin: "120px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [attachment.kind, attachment.sourceEntryId, attachment.index, reloadKey]);

  return (
    <span ref={elementRef} className={`message-attachment-kind${source ? " has-preview" : ""}`}>
      {source ? (
        <img src={source} alt="" />
      ) : attachment.kind === "image" ? (
        <IconPhoto size={15} />
      ) : (
        <IconFileText size={15} />
      )}
    </span>
  );
}

function retryLabel(attempt?: number, maxAttempts?: number): string {
  if (!attempt) return "retrying";
  return `attempt ${attempt}${maxAttempts ? ` of ${maxAttempts}` : ""}`;
}

function CompactionDisclosure({
  message,
  onOpen,
}: {
  message: MessageReadModel;
  onOpen: (message: MessageReadModel) => void;
}) {
  const compaction = message.compaction!;
  const facts = [
    compaction.contextBeforeTokens === undefined
      ? `${formatCompactNumber(compaction.contextAfterTokens)} after`
      : `${formatCompactNumber(compaction.contextBeforeTokens)} → ${formatCompactNumber(compaction.contextAfterTokens)}`,
    formatMessageTime(message.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SeamLink
      state="neutral"
      label="Context compacted"
      value={facts}
      action="Details"
      onClick={() => onOpen(message)}
    />
  );
}

function SystemDisclosure({ message }: { message: MessageReadModel }) {
  return (
    <SeamDisclosure state="neutral" label="System context" value={message.systemSource} action="Text">
      <pre className="seam-text">{message.text}</pre>
    </SeamDisclosure>
  );
}

async function readPastedImages(
  event: ReactClipboardEvent<HTMLTextAreaElement>,
  current: PastedImage[],
): Promise<PastedImage[] | undefined> {
  const files = [...event.clipboardData.items]
    .filter(item => item.kind === "file" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.type))
    .flatMap(item => item.getAsFile() ?? []);
  if (!files.length) return undefined;
  event.preventDefault();
  if (files.length > 4 - current.length) throw new Error("You can attach up to 4 images.");
  if (
    files.some(file => file.size > 5 * 1024 * 1024) ||
    files.reduce((total, file) => total + file.size, 0) + imageBytes(current) > 15 * 1024 * 1024
  ) {
    throw new Error("Images must be 5 MB each and 15 MB total.");
  }
  try {
    const pasted = await Promise.all(
      files.map(async file => ({
        id: crypto.randomUUID(),
        mimeType: file.type as PromptImage["mimeType"],
        data: await fileBase64(file),
      })),
    );
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
  const imageFiles = dropped.filter(file => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type));
  const textFiles = dropped.filter(file => !imageFiles.includes(file));
  const images = imageFiles.length ? await readImageFiles(imageFiles, currentImages) : currentImages;
  if (!textFiles.length) return { images, files: currentFiles };
  if (currentFiles.length + textFiles.length > 100) throw new Error("You can attach up to 100 text files.");
  if (textFiles.some(file => file.size === 0)) throw new Error("Empty files cannot be attached.");
  const totalBytes =
    currentFiles.reduce((total, file) => total + file.size, 0) +
    textFiles.reduce((total, file) => total + file.size, 0);
  if (totalBytes > 10 * 1024 * 1024) throw new Error("Text files cannot exceed 10 MB total.");
  if (
    (currentFiles.length + textFiles.length > 4 || totalBytes > 512 * 1024) &&
    !window.confirm("These files may use substantial model context. Attach them anyway?")
  ) {
    return { images: currentImages, files: currentFiles };
  }
  const decoded = await Promise.all(
    textFiles.map(async (file): Promise<DroppedTextFile> => {
      if (/[\/\\\0]/.test(file.name)) throw new Error(`${file.name || "This file"} has an unsupported name.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.includes(0)) throw new Error(`${file.name} appears to be binary.`);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error(`${file.name} is not valid UTF-8 text.`);
      }
      return {
        id: crypto.randomUUID(),
        name: file.name.slice(0, 255),
        text,
        size: bytes.byteLength,
        ...(file.type ? { mimeType: file.type.slice(0, 120) } : {}),
      };
    }),
  );
  return { images, files: [...currentFiles, ...decoded] };
}

async function readImageFiles(files: File[], current: PastedImage[]): Promise<PastedImage[]> {
  if (files.length > 4 - current.length) throw new Error("You can attach up to 4 images.");
  if (
    files.some(file => file.size > 5 * 1024 * 1024) ||
    files.reduce((total, file) => total + file.size, 0) + imageBytes(current) > 15 * 1024 * 1024
  ) {
    throw new Error("Images must be 5 MB each and 15 MB total.");
  }
  const added = await Promise.all(
    files.map(async file => ({
      id: crypto.randomUUID(),
      mimeType: file.type as PromptImage["mimeType"],
      data: await fileBase64(file),
    })),
  );
  return [...current, ...added];
}

function imageBytes(images: PromptImage[]): number {
  return images.reduce((total, image) => total + Math.floor((image.data.length * 3) / 4), 0);
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

function ExtensionUiSurface({ runtime }: { runtime: NonNullable<RuntimeStoreSnapshot["runtime"]> }) {
  const widgets = runtime.extensionUi.widgets.filter(widget => (widget.placement ?? "aboveEditor") === "aboveEditor");
  if (widgets.length === 0) return null;
  return (
    <div className="extension-ui extension-ui-aboveEditor">
      {widgets.map(widget => (
        <section className="extension-widget" key={widget.key} aria-label={widget.key}>
          {widget.lines.map((line, index) => (
            <p key={index}>{line}</p>
          ))}
        </section>
      ))}
    </div>
  );
}
