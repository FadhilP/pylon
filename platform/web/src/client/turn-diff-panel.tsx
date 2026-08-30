import { IconFiles, IconX } from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { MessageReadModel } from "../shared/protocol/events";
import { FileTypeIcon } from "./files-panel";
import { runtimeStore } from "./runtime/event-store";

const PierreCodeViewer = lazy(() => import("./pierre-code-viewer"));

type ChangedFiles = NonNullable<MessageReadModel["changedFiles"]>;
type TurnDiffState = { loading: boolean; error?: string; text?: string; truncated?: boolean; binary?: boolean };

export function TurnDiffPanel({
  entryId,
  files,
  onClose,
}: {
  entryId: string;
  files: ChangedFiles;
  onClose: () => void;
}) {
  const [state, setState] = useState<TurnDiffState>({ loading: true });
  const [scrollToFile, setScrollToFile] = useState<{ path: string; token: number }>();
  // Pierre builds its file headers as plain DOM, so the icons are rendered once in a hidden
  // React node and cloned into each header in place of Pierre's change-type glyph.
  const icons = useRef<HTMLDivElement>(null);
  const renderHeaderIcon = useCallback((path: string) => {
    const source =
      icons.current?.querySelector(`[data-icon-path="${CSS.escape(path)}"] svg`) ??
      icons.current?.querySelector(`[data-icon-path=""] svg`);
    return source?.cloneNode(true) as Element | undefined;
  }, []);

  useEffect(() => {
    let active = true;
    setState({ loading: true });
    void runtimeStore
      .turnDiff(entryId)
      .then(result => {
        if (!active) return;
        if (result.state === "binary") setState({ loading: false, binary: true });
        else setState({ loading: false, text: result.text, truncated: result.truncated === true });
      })
      .catch(error => {
        if (active) setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      active = false;
    };
  }, [entryId]);

  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);

  return (
    <aside id="turn-diff-panel" className="inspector turn-diff-panel is-open" aria-labelledby="turn-diff-title">
      <header className="inspector-header">
        <div>
          <IconFiles size={17} />
          <strong id="turn-diff-title">Turn diff</strong>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close turn diff">
          <IconX size={17} />
        </button>
      </header>
      <div className="turn-diff-summary">
        <span>
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
        <span>
          <ins>+{additions}</ins>
          <del>-{deletions}</del>
        </span>
      </div>
      <div className="turn-diff-files" aria-label="Files changed in this turn">
        {files.map(file => (
          <button
            type="button"
            key={file.path}
            onClick={() => setScrollToFile(current => ({ path: file.path, token: (current?.token ?? 0) + 1 }))}>
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
      <div className="turn-diff-icons" ref={icons} hidden>
        {files.map(file => (
          <span key={file.path} data-icon-path={file.path}>
            <FileTypeIcon path={file.path} size={14} />
          </span>
        ))}
        <span data-icon-path="">
          <FileTypeIcon path="" size={14} />
        </span>
      </div>
      <div className="turn-diff-view">
        {state.loading && <p role="status">Loading turn diff…</p>}
        {state.error && (
          <p className="changed-file-error" role="alert">
            {state.error}
          </p>
        )}
        {state.binary && <p role="status">This turn contains binary changes that cannot be displayed.</p>}
        {state.text !== undefined && (
          <>
            {state.truncated && <p role="note">Turn diff is too large — showing the first portion.</p>}
            {state.text ? (
              <Suspense fallback={<p role="status">Rendering turn diff…</p>}>
                <PierreCodeViewer
                  mode="diff"
                  path={`turn:${entryId}`}
                  text={state.text}
                  revision={entryId}
                  unifiedDiff={state.text}
                  showFileHeaders
                  renderHeaderIcon={renderHeaderIcon}
                  scrollToFile={scrollToFile}
                />
              </Suspense>
            ) : (
              <p role="status">No textual changes in this turn.</p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
