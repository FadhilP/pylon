import type { CodeViewItem, FileDiffContentsLoader } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPierreCodeViewItem } from "../shared/pierre-code-viewer-model";

const ITEM_ID = "pylon-selected-file";

type ViewerMode = "file" | "diff";

export default function PierreCodeViewer({
  mode,
  path,
  text,
  revision,
  targetLine,
  loadDiffFiles,
}: {
  mode: ViewerMode;
  path: string;
  text: string;
  revision: string;
  targetLine?: number;
  loadDiffFiles?: FileDiffContentsLoader;
}) {
  const viewerRef = useRef<CodeViewHandle<undefined>>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const item = useMemo<CodeViewItem | undefined>(() => createPierreCodeViewItem({
    mode,
    id: ITEM_ID,
    path,
    text,
    revision,
  }), [mode, path, revision, text]);
  const selectedLines = useMemo(() => targetLine ? {
    id: ITEM_ID,
    range: {
      start: targetLine,
      end: targetLine,
      ...(mode === "diff" ? { side: "additions" as const, endSide: "additions" as const } : {}),
    },
  } : null, [mode, targetLine]);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(
      document.documentElement.dataset.theme === "light" ? "light" : "dark"));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!targetLine || !item) return;
    const frame = requestAnimationFrame(() => viewerRef.current?.scrollTo({
      type: "line",
      id: ITEM_ID,
      lineNumber: targetLine,
      ...(mode === "diff" ? { side: "additions" as const } : {}),
      align: "center",
    }));
    return () => cancelAnimationFrame(frame);
  }, [item, mode, targetLine]);

  if (!item) return <pre className={`file-code${mode === "diff" ? " is-diff" : ""}`}><code>{text}</code></pre>;
  return <CodeView
    ref={viewerRef}
    className="pierre-code-view"
    items={[item]}
    selectedLines={selectedLines}
    options={{
      theme: theme === "light" ? "pierre-light" : "pierre-dark",
      themeType: theme,
      disableFileHeader: true,
      diffStyle: "unified",
      hunkSeparators: "line-info",
      loadDiffFiles: mode === "diff" ? loadDiffFiles : undefined,
      expansionLineCount: 15,
      unsafeCSS: "[data-unmodified-lines] { font-size: 12px; }",
      overflow: "scroll",
      enableLineSelection: true,
      stickyHeaders: false,
    }}
    disableWorkerPool
  />;
}
