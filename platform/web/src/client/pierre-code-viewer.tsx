import type { CodeViewItem, FileDiffContentsLoader } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { Component, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPierreCodeViewItem, createPierreDiffItems } from "../shared/pierre-code-viewer-model";

const ITEM_ID_PREFIX = "pylon-selected-file";
const UNMODIFIED_LINE_CSS = "[data-unmodified-lines] { font-size: 12px; }";
const HIDE_CHANGE_ICON_CSS = "[data-change-icon] { display: none; }";

class PierreViewerErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Pierre CodeView failed; using raw text fallback", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type ViewerMode = "file" | "diff";

export default function PierreCodeViewer({
  mode,
  path,
  text,
  revision,
  targetLine,
  loadDiffFiles,
  unifiedDiff,
  showFileHeaders = false,
  renderHeaderIcon,
  scrollToFile,
}: {
  mode: ViewerMode;
  path: string;
  text: string;
  revision: string;
  targetLine?: number;
  loadDiffFiles?: FileDiffContentsLoader;
  /** Raw multi-file unified diff; replaces `text` rendering in diff mode. */
  unifiedDiff?: string;
  /** Show each parsed file's path above its diff. */
  showFileHeaders?: boolean;
  /** Replaces Pierre's change-type glyph in the file header with an element of our own. */
  renderHeaderIcon?: (path: string) => Element | undefined;
  /** Scrolls a multi-file diff to `path`; `token` changes to re-run the same request. */
  scrollToFile?: { path: string; token: number };
}) {
  const viewerRef = useRef<CodeViewHandle<undefined>>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const itemId = useMemo(() => `${ITEM_ID_PREFIX}:${mode}:${path}`, [mode, path]);
  const item = useMemo<CodeViewItem | undefined>(
    () => createPierreCodeViewItem({ mode, id: itemId, path, text, revision }),
    [itemId, mode, path, revision, text],
  );
  const items = useMemo<CodeViewItem[]>(() => {
    if (mode === "diff" && unifiedDiff !== undefined) {
      return createPierreDiffItems({ id: itemId, text: unifiedDiff, revision });
    }
    return item ? [item] : [];
  }, [item, itemId, mode, revision, unifiedDiff]);
  const activeItemId = items.length === 1 ? items[0]!.id : undefined;
  const selectedLines = useMemo(
    () =>
      targetLine && activeItemId
        ? {
            id: activeItemId,
            range: {
              start: targetLine,
              end: targetLine,
              ...(mode === "diff" ? { side: "additions" as const, endSide: "additions" as const } : {}),
            },
          }
        : null,
    [activeItemId, mode, targetLine],
  );

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!targetLine || !activeItemId) return;
    const frame = requestAnimationFrame(() =>
      viewerRef.current?.scrollTo({
        type: "line",
        id: activeItemId,
        lineNumber: targetLine,
        ...(mode === "diff" ? { side: "additions" as const } : {}),
        align: "center",
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [activeItemId, mode, targetLine]);

  const scrollPath = scrollToFile?.path;
  const scrollToken = scrollToFile?.token;
  useEffect(() => {
    if (!scrollPath) return;
    const target = items.find(item => item.type === "diff" && item.fileDiff.name === scrollPath);
    if (!target) return;
    const frame = requestAnimationFrame(() =>
      viewerRef.current?.scrollTo({ type: "item", id: target.id, align: "start" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [items, scrollPath, scrollToken]);

  const fallback = (
    <pre className={`file-code${mode === "diff" ? " is-diff" : ""}`}>
      <code>{mode === "diff" && unifiedDiff !== undefined ? unifiedDiff : text}</code>
    </pre>
  );
  if (!items.length) return fallback;
  const viewerKey = `${itemId}:${revision}`;
  return (
    <PierreViewerErrorBoundary key={viewerKey} fallback={fallback}>
      <CodeView
        key={viewerKey}
        ref={viewerRef}
        className="pierre-code-view"
        items={items}
        selectedLines={selectedLines}
        options={{
          theme: theme === "light" ? "pierre-light" : "pierre-dark",
          themeType: theme,
          disableFileHeader: !showFileHeaders,
          diffStyle: "unified",
          hunkSeparators: "line-info",
          loadDiffFiles: mode === "diff" ? loadDiffFiles : undefined,
          expansionLineCount: 15,
          unsafeCSS: renderHeaderIcon ? `${UNMODIFIED_LINE_CSS} ${HIDE_CHANGE_ICON_CSS}` : UNMODIFIED_LINE_CSS,
          renderHeaderPrefix: renderHeaderIcon ? file => renderHeaderIcon(file.name) ?? null : undefined,
          overflow: "scroll",
          enableLineSelection: true,
          stickyHeaders: false,
        }}
        disableWorkerPool
      />
    </PierreViewerErrorBoundary>
  );
}
