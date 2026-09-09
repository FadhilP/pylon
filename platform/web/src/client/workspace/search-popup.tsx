import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileContent, WorkspaceFileDiff, WorkspaceFileReadModel } from "../../shared/protocol/snapshots";
import type {
  WorkspaceSearchFile,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
  WorkspaceSymbolResult,
} from "../../shared/workspace/workspace-search";
import { rankFilePaths } from "../../shared/workspace/file-search";
import { parseDiff, sourceLines } from "../../shared/workspace/code-viewer-model";
import { runtimeStore, type RuntimeStoreSnapshot } from "../runtime/event-store";
import { FileTypeIcon } from "../rendering/file-icons";
import { SearchOptions, SearchResults, SearchStatus, useTextSearch } from "./workspace-search";
import { HighlightedLine } from "../rendering/code-viewer";
import { sourceLanguage } from "../rendering/markdown";
import { loadSyntaxLanguage, syntaxTokens } from "../rendering/syntax-highlighting";
import { useSyntaxHighlightingRevision } from "../app/use-chrome";

const TABS = ["all", "files", "text", "symbols", "actions"] as const;
type Tab = (typeof TABS)[number];
export interface PinnedSearch {
  scope: string;
  query: WorkspaceSearchQuery;
  result: WorkspaceSearchResult;
  incomplete: boolean;
}
export interface SearchAction {
  id: string;
  label: string;
  run: () => void | Promise<unknown>;
  disabled?: boolean;
  shortcut?: string;
}
type Item = {
  id: string;
  section: string;
  label: string;
  detail?: string;
  path?: string;
  line?: number;
  action?: SearchAction;
  more?: Tab;
};

function Preview({
  path,
  line,
  matches,
  changed,
  scope,
}: {
  path?: string;
  line?: number;
  matches?: WorkspaceSearchFile;
  changed: boolean;
  scope: string;
}) {
  const [loaded, setLoaded] = useState<{
    path: string;
    scope: string;
    content: WorkspaceFileContent;
    diff?: WorkspaceFileDiff;
  }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    setLoaded(undefined);
    if (!path) return;
    void Promise.all([
      runtimeStore.workspaceFile(path, "current"),
      changed ? runtimeStore.workspaceDiff(path).catch(() => undefined) : Promise.resolve(undefined),
    ])
      .then(([content, diff]) => {
        if (active) setLoaded({ path, scope, content, diff });
      })
      .catch(failure => {
        if (active) setError(failure instanceof Error ? failure.message : "Preview unavailable");
      });
    return () => {
      active = false;
    };
  }, [path, scope, changed]);
  const value = loaded && loaded.path === path && loaded.scope === scope ? loaded : undefined;
  const lines = useMemo(() => sourceLines(value?.content.text ?? ""), [value?.content.text]);
  const syntaxRevision = useSyntaxHighlightingRevision();
  const language = sourceLanguage(path ?? "");
  useEffect(() => { void loadSyntaxLanguage(language); }, [language]);
  const tokens = useMemo(() => syntaxTokens(value?.content.text ?? "", language), [value?.content.text, language, syntaxRevision]);
  const additions = useMemo(() => {
    if (!value?.diff?.text || value.diff.truncated || value.diff.revision !== value.content.revision)
      return new Set<number>();
    return new Set(
      parseDiff(value.diff.text).flatMap(file =>
        file.hunks.flatMap(hunk => hunk.filter(row => row.kind === "addition").map(row => row.newLine!)),
      ),
    );
  }, [value]);
  const start = Math.max(0, Math.min(lines.length - 30, (line ?? 1) - 15));
  return (
    <div className="workspace-search-preview">
      <header>
        <code>{path ?? "Preview"}</code>
        {path && <small>{changed ? "Changed since baseline" : "Working copy"}</small>}
      </header>
      {!path ? (
        <p>Select a result to preview it.</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !value ? (
        <p>Loading preview…</p>
      ) : value.content.state !== "available" ? (
        <p>Preview unavailable: {value.content.state}.</p>
      ) : (
        <>
          {value.content.truncated && <small className="search-warning">File preview is truncated.</small>}
          {!!line && line > lines.length && (
            <small className="search-warning">This location is no longer in the current preview.</small>
          )}
          {changed && (!value.diff || value.diff.truncated || value.diff.revision !== value.content.revision) && (
            <small>Line-change markers unavailable.</small>
          )}
          <div className="workspace-search-preview-lines">
            {lines.slice(start, start + 30).map((text, index) => {
              const number = start + index + 1;
              const match = matches?.matches.find(hit => hit.line === number && text.startsWith(hit.text));
              return (
                <div
                  key={number}
                  className={`${additions.has(number) ? "is-added " : ""}${number === line ? "is-target" : ""}`}>
                  <span>{number}</span>
                  <code>
                    <HighlightedLine line={{ kind: "context", text, changes: match?.ranges }} tokens={tokens[number - 1]} />
                  </code>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function SearchPopup({
  live,
  actions,
  onOpen,
  onPin,
  onError,
}: {
  live: RuntimeStoreSnapshot;
  actions: SearchAction[];
  onOpen: (path: string, line?: number, query?: WorkspaceSearchQuery) => void;
  onPin: (pinned: PinnedSearch) => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const runtime = live.runtime;
  const scope = `${runtime?.sessionId}:${runtime?.sessionGeneration}`;
  const available = live.connection === "connected" && !!runtime?.ready;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const [boxes, setBoxes] = useState<Record<Tab, string>>({ all: "", files: "", text: "", symbols: "", actions: "" });
  const [options, setOptions] = useState<WorkspaceSearchQuery>({ query: "" });
  const [inventory, setInventory] = useState<{ scope: string; files: WorkspaceFileReadModel[]; truncated: boolean }>();
  const [inventoryError, setInventoryError] = useState("");
  const [symbols, setSymbols] = useState<WorkspaceSymbolResult>();
  const [symbolError, setSymbolError] = useState("");
  const [symbolLoading, setSymbolLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useTextSearch(scope);
  const files = inventory?.scope === scope ? inventory.files : [];
  const changedPaths = useMemo(() => new Set(files.filter(file => file.status).map(file => file.path)), [files]);
  const query = boxes[tab];
  const close = () => {
    setOpen(false);
    search.cancel();
  };

  useEffect(() => {
    setOpen(false);
    setInventory(undefined);
    setSymbols(undefined);
    setSelectedId(undefined);
    setBoxes({ all: "", files: "", text: "", symbols: "", actions: "" });
    setOptions({ query: "" });
  }, [scope]);
  useEffect(() => {
    if (!available || live.pendingUi) {
      setOpen(false);
      search.cancel();
    }
  }, [available, live.pendingUi, search.cancel]);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) {
      element.showModal();
      input.current?.focus();
    } else if (!open && element?.open) element.close();
  }, [open]);
  useEffect(() => {
    const eventOpen = (event: Event) => {
      if (!available || live.pendingUi || document.querySelector("dialog[open], [role=dialog][aria-modal=true]")) return;
      const detail = (event as CustomEvent).detail;
      const value = typeof detail === "object" && detail ? detail.tab : detail;
      if (TABS.includes(value)) setTab(value);
      if (typeof detail === "object" && detail?.query) {
        setBoxes(previous => ({ ...previous, [value as Tab]: detail.query.query }));
        setOptions({ ...detail.query });
      }
      setOpen(true);
      setSelectedId(undefined);
    };
    window.addEventListener("pylon:search", eventOpen);
    return () => window.removeEventListener("pylon:search", eventOpen);
  }, [available, live.pendingUi]);

  useEffect(() => {
    if (!open || !available) return;
    const controller = new AbortController();
    setInventoryError("");
    void runtimeStore
      .workspaceInventory(
        false,
        controller.signal,
        (next, truncated) => {
          if (!controller.signal.aborted) setInventory({ scope, files: next, truncated });
        },
        () => {},
      )
      .catch(error => {
        if (!controller.signal.aborted) setInventoryError(error instanceof Error ? error.message : "Files unavailable");
      });
    return () => controller.abort();
  }, [open, available, scope, runtime?.workspace?.revision]);

  useEffect(() => {
    if (!open || !available || tab !== "text") {
      search.cancel();
      return;
    }
    search.reset();
    const timer = setTimeout(() => void search.run({ ...options, query: boxes.text }), 220);
    return () => {
      clearTimeout(timer);
      search.cancel();
    };
  }, [open, available, tab, boxes.text, options, scope, search.run, search.cancel, search.reset]);
  useEffect(() => {
    setSymbols(undefined);
    setSymbolError("");
    setSymbolLoading(false);
    if (!open || !available || (tab !== "symbols" && tab !== "all")) return;
    if (!runtime?.discoverIndex) {
      setSymbolError("Discover symbol indexing is unavailable.");
      return;
    }
    const controller = new AbortController();
    setSymbolLoading(true);
    const timer = setTimeout(() => {
      void runtimeStore
        .workspaceSymbols(query, controller.signal)
        .then(value => {
          if (!controller.signal.aborted) setSymbols(value);
        })
        .catch(error => {
          if (!controller.signal.aborted)
            setSymbolError(error instanceof Error ? error.message : "Symbols unavailable");
        })
        .finally(() => {
          if (!controller.signal.aborted) setSymbolLoading(false);
        });
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, available, tab, query, scope, !!runtime?.discoverIndex]);

  const fileItems: Item[] = useMemo(
    () =>
      rankFilePaths(
        files.filter(file => !file.kind && (!options.touched || file.status)).map(file => file.path),
        query,
      ).map(path => ({ id: `file:${path}`, section: "Files", label: path.split("/").at(-1)!, detail: path, path })),
    [files, options.touched, query],
  );
  const symbolItems: Item[] = (symbols?.symbols ?? [])
    .filter(symbol => !options.touched || changedPaths.has(symbol.path))
    .map(symbol => ({
      id: `symbol:${symbol.path}:${symbol.line}:${symbol.name}`,
      section: "Symbols",
      label: symbol.name,
      detail: `${symbol.kind} · ${symbol.path}:${symbol.line} · ${symbol.signature}`,
      path: symbol.path,
      line: symbol.line,
    }));
  const actionItems: Item[] = actions
    .filter(action => action.label.toLowerCase().includes(query.trim().toLowerCase()))
    .map(action => ({ id: `action:${action.id}`, section: "Actions", label: action.label, action }));
  let items: Item[];
  if (tab === "text")
    items = (search.result?.files ?? []).flatMap(file =>
      file.matches.map(match => ({
        id: `${file.path}:${match.line}`,
        section: "Text",
        label: match.text,
        path: file.path,
        line: match.line,
      })),
    );
  else if (tab === "files") items = fileItems.slice(0, 200);
  else if (tab === "symbols") items = symbolItems;
  else if (tab === "actions") items = actionItems;
  else {
    const exact = [...fileItems, ...symbolItems].filter(
      item => query.trim() && item.label.toLowerCase() === query.trim().toLowerCase(),
    );
    const exactIds = new Set(exact.map(item => item.id));
    const section = (source: Item[], value: Tab, limit: number): Item[] => {
      const remaining = source.filter(item => !exactIds.has(item.id));
      return [
        ...remaining.slice(0, limit),
        ...(remaining.length > limit
          ? [{ id: `more:${value}`, section: remaining[0].section, label: `More ${value}…`, more: value }]
          : []),
      ];
    };
    items = [
      ...exact.slice(0, 4).map(item => ({ ...item, section: "Exact matches" })),
      ...section(
        query.trim()
          ? fileItems
          : fileItems
              .filter(item => changedPaths.has(item.path!))
              .map(item => ({ ...item, section: "Changed since baseline" })),
        "files",
        4,
      ),
      ...section(symbolItems, "symbols", 4),
      ...section(actionItems, "actions", 3),
    ];
  }
  const selected = items.find(item => item.id === selectedId) ?? items[0];
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(
        `[data-search-id="${CSS.escape(selected?.id ?? "")}"], [data-search-hit="${CSS.escape(selected?.id ?? "")}"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  }, [selected?.id]);
  const chooseTab = (value: Tab) => {
    search.cancel();
    setTab(value);
    setSelectedId(undefined);
    input.current?.focus();
  };
  const activate = (item = selected) => {
    if (!item || item.action?.disabled) return;
    if (item.more) {
      setBoxes(previous => ({ ...previous, [item.more!]: query }));
      chooseTab(item.more);
      return;
    }
    close();
    if (item.action)
      void Promise.resolve()
        .then(item.action.run)
        .catch(error => onError(error, "Action failed"));
    else if (item.path) onOpen(item.path, item.line, tab === "text" ? search.submitted : undefined);
  };
  const pin = () => {
    if (!search.result || !search.submitted) return;
    onPin({
      scope,
      query: { ...search.submitted },
      result: structuredClone(search.result),
      incomplete: search.running || search.stopped || !!search.error,
    });
    close();
  };
  return (
    <>
      <dialog
        ref={dialog}
        className="workspace-search-popup"
        aria-labelledby="workspace-search-title"
        onCancel={event => {
          event.preventDefault();
          close();
        }}
        onClick={event => {
          if (event.target === dialog.current) {
            const rect = dialog.current.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              close();
          }
        }}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
          if (event.ctrlKey && event.key === "Tab") {
            event.preventDefault();
            chooseTab(TABS[(TABS.indexOf(tab) + (event.shiftKey ? 4 : 1)) % 5]);
          }
        }}>
        <header>
          <strong id="workspace-search-title">Search workspace</strong>
          <button type="button" aria-label="Close search" onClick={close}>
            ×
          </button>
        </header>
        <div
          className="workspace-search-tabs"
          role="tablist"
          aria-label="Search source"
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = TABS[(TABS.indexOf(tab) + (event.key === "ArrowLeft" ? 4 : 1)) % 5];
            chooseTab(next);
            (event.currentTarget.querySelector(`[data-tab="${next}"]`) as HTMLElement)?.focus();
          }}>
          {TABS.map(value => (
            <button
              type="button"
              role="tab"
              id={`workspace-search-tab-${value}`}
              aria-controls="workspace-search-panel"
              data-tab={value}
              key={value}
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => chooseTab(value)}>
              {value}
            </button>
          ))}
        </div>
        <div className="workspace-search-box">
          <input
            ref={input}
            aria-label={`Search ${tab}`}
            value={query}
            maxLength={2000}
            placeholder={
              tab === "text"
                ? "Search file contents"
                : tab === "symbols"
                  ? "Find symbol by name"
                  : "Files, symbols and actions"
            }
            onChange={event => {
              const value = event.target.value;
              setSelectedId(undefined);
              if (tab !== "symbols" && value.startsWith("#")) {
                setBoxes(previous => ({ ...previous, symbols: value.slice(1) }));
                chooseTab("symbols");
              } else setBoxes(previous => ({ ...previous, [tab]: value }));
            }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const at = items.findIndex(item => item.id === selected?.id);
                setSelectedId(
                  items[Math.max(0, Math.min(items.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]?.id,
                );
              }
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey && tab === "text") pin();
                else activate();
              }
            }}
          />
          {search.running && tab === "text" && (
            <button type="button" onClick={search.stop}>
              Stop
            </button>
          )}
        </div>
        {tab === "text" ? (
          <SearchOptions value={options} onChange={setOptions} />
        ) : (
          tab !== "actions" && (
            <div className="workspace-search-options">
              <button
                type="button"
                aria-pressed={!!options.touched}
                onClick={() => setOptions(previous => ({ ...previous, touched: !previous.touched }))}>
                Changed since baseline
              </button>
              {(tab === "symbols" || tab === "all") && (
                <small>{symbolLoading ? "Refreshing symbols…" : "Symbols are heuristic, not parsed"}</small>
              )}
            </div>
          )
        )}
        <div
          className="workspace-search-body"
          id="workspace-search-panel"
          role="tabpanel"
          aria-labelledby={`workspace-search-tab-${tab}`}>
          <div className="workspace-search-items" ref={list}>
            {tab === "text" ? (
              <SearchResults
                controls={false}
                key={JSON.stringify(search.submitted)}
                files={search.result?.files ?? []}
                query={search.submitted}
                selected={selected?.id}
                onPreview={(path, line) => setSelectedId(`${path}:${line}`)}
                onOpen={(path, line, submitted) => {
                  close();
                  onOpen(path, line, submitted);
                }}
              />
            ) : (
              items.map((item, index) => (
                <div key={item.id}>
                  {tab === "all" && items[index - 1]?.section !== item.section && <h3>{item.section}</h3>}
                  <button
                    type="button"
                    data-search-id={item.id}
                    className={`workspace-search-item${selected?.id === item.id ? " is-selected" : ""}`}
                    disabled={item.action?.disabled}
                    onClick={() => (item.more || item.action ? activate(item) : setSelectedId(item.id))}
                    onDoubleClick={() => activate(item)}
                    onKeyDown={event => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        activate(item);
                      }
                    }}>
                    {item.path && <FileTypeIcon path={item.path} size={16} />}
                    <span>
                      <b>{item.label}</b>
                      <small>{item.detail}</small>
                    </span>
                    {item.action?.shortcut && item.action.shortcut !== "Unbound" && <kbd>{item.action.shortcut}</kbd>}
                    {item.path && changedPaths.has(item.path) && <small title="Changed since baseline">changed</small>}
                  </button>
                </div>
              ))
            )}
            {tab !== "text" && !items.length && (
              <p>{symbolLoading ? "Loading…" : query ? "No results" : "Type to search"}</p>
            )}
            {inventoryError && tab !== "actions" && <p role="status">{inventoryError}</p>}
            {symbolError && (tab === "symbols" || tab === "all") && <p role="status">{symbolError}</p>}
          </div>
          <Preview
            scope={scope}
            path={selected?.path}
            line={selected?.line}
            changed={changedPaths.has(selected?.path ?? "")}
            matches={tab === "text" ? search.result?.files.find(file => file.path === selected?.path) : undefined}
          />
        </div>
        <footer>
          {tab === "text" ? (
            <SearchStatus search={search} />
          ) : (
            <small>
              {items.length} results
              {inventory?.truncated || (tab === "files" && fileItems.length > 200) || symbols?.moreAvailable
                ? " · limited"
                : ""}
            </small>
          )}
          {tab === "text" && (
            <button type="button" disabled={!search.result} onClick={pin}>
              Open in panel ⇧↵
            </button>
          )}
          <small>↑↓ preview · Enter open · Esc close</small>
        </footer>
      </dialog>
    </>
  );
}

export function PinnedSearchPanel({
  pinned,
  onOpen,
  onSearchAgain,
  onClose,
}: {
  pinned: PinnedSearch;
  onOpen: (path: string, line?: number, query?: WorkspaceSearchQuery) => void;
  onSearchAgain: () => void;
  onClose: () => void;
}) {
  return (
    <section className="workspace-search-pinned" aria-label="Pinned search results">
      <header className="panel-header">
        <strong>{pinned.query.query}</strong>
        <small>Snapshot{pinned.incomplete ? " · incomplete" : ""}</small>
        <button type="button" onClick={onSearchAgain}>
          Search again
        </button>
        <button type="button" aria-label="Close pinned search" onClick={onClose}>
          ×
        </button>
      </header>
      <SearchResults files={pinned.result.files} query={pinned.query} onOpen={onOpen} />
      <SearchStatus
        search={{
          result: pinned.result,
          submitted: pinned.query,
          running: false,
          stopped: pinned.incomplete,
          error: "",
        }}
      />
    </section>
  );
}
