import { useCallback, useEffect, useRef, useState } from "react";
import { IconChevronRight, IconDatabase } from "@tabler/icons-react";
import type { StateQLCatalogObject } from "pi-stateql/stateql-command";
import { runtimeStore } from "./runtime/event-store";
import "./database-workspace.css";

type CatalogKind = StateQLCatalogObject["kind"];
type Cursor = number | string;
type Group = { objects: StateQLCatalogObject[]; next: Cursor | null; loading: boolean; error?: string };

type Props = {
  scope: string;
  driver: "sqlite" | "postgres" | "mysql" | "mongodb" | "redis";
  connectionId: string;
  search: string;
  disabled?: boolean;
  refreshKey?: number;
  onOpen: (object: StateQLCatalogObject) => void;
};

const labels: Record<CatalogKind, string> = {
  table: "Tables",
  view: "Views",
  collection: "Collections",
  function: "Functions",
  trigger: "Triggers",
  enum: "Enums",
  key: "Keys",
};
const catalogKinds = new Set<CatalogKind>(["table", "view", "collection", "function", "trigger", "enum", "key"]);
const initialKind = (driver: Props["driver"]): CatalogKind =>
  driver === "mongodb" ? "collection" : driver === "redis" ? "key" : "table";
const identity = (object: StateQLCatalogObject) =>
  JSON.stringify([object.kind, object.schema ?? null, object.name, object.identity ?? null]);
const project = (value: unknown): StateQLCatalogObject | undefined => {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (!catalogKinds.has(item.kind as CatalogKind) || typeof item.name !== "string") return;
  return {
    kind: item.kind as CatalogKind,
    name: item.name,
    ...(typeof item.schema === "string" ? { schema: item.schema } : {}),
    ...(typeof item.identity === "string" ? { identity: item.identity } : {}),
  };
};
const message = (result: Awaited<ReturnType<typeof runtimeStore.stateqlCommand>>) =>
  result.status === "completed" && !result.response.ok
    ? `${result.response.error.code}: ${result.response.error.message}`
    : "Object request was declined.";

export function DatabaseObjectBrowser({
  scope,
  driver,
  connectionId,
  search,
  disabled = false,
  refreshKey,
  onOpen,
}: Props) {
  const [groups, setGroups] = useState<Partial<Record<CatalogKind, Group>>>({});
  const [kinds, setKinds] = useState<CatalogKind[]>([]);
  const [appliedSearch, setAppliedSearch] = useState("");
  const epoch = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const loading = useRef(new Set<CatalogKind>());
  const loaded = useRef(new Set<CatalogKind>());
  const loadRef = useRef<((kind: CatalogKind, offset?: Cursor, retry?: boolean) => Promise<void>) | null>(null);
  const abort = useCallback(() => {
    epoch.current += 1;
    controllers.current.forEach(controller => controller.abort());
    controllers.current.clear();
    loading.current.clear();
  }, []);

  const load = useCallback(
    async (kind: CatalogKind, offset?: Cursor, retry = false) => {
      if (disabled || loading.current.has(kind) || (offset === undefined && loaded.current.has(kind) && !retry)) return;
      const controller = new AbortController();
      const requestEpoch = epoch.current;
      controllers.current.add(controller);
      loading.current.add(kind);
      if (offset === undefined) loaded.current.add(kind);
      setGroups(current => ({
        ...current,
        [kind]: { ...(current[kind] ?? { objects: [], next: null }), loading: true, error: undefined },
      }));
      try {
        const result = await runtimeStore.stateqlCommand(
          {
            command: "objects.list",
            kind,
            ...(appliedSearch ? { search: appliedSearch } : {}),
            ...(offset !== undefined ? { offset } : {}),
            limit: 100,
          },
          controller.signal,
          connectionId,
        );
        if (controller.signal.aborted || requestEpoch !== epoch.current) return;
        if (result.status !== "completed" || !result.response.ok) throw new Error(message(result));
        const data = result.response.data;
        if (!data || typeof data !== "object") throw new Error("Invalid catalog response.");
        const page = data as Record<string, unknown>;
        const supported = Array.isArray(page.supported_kinds)
          ? page.supported_kinds.filter((value): value is CatalogKind => catalogKinds.has(value as CatalogKind))
          : [];
        const objects = Array.isArray(page.objects)
          ? page.objects.map(project).filter((item): item is StateQLCatalogObject => Boolean(item))
          : [];
        const next =
          typeof page.next_offset === "number" || typeof page.next_offset === "string" ? page.next_offset : null;
        setKinds(supported);
        setGroups(current => {
          const prior = offset === undefined ? [] : (current[kind]?.objects ?? []);
          const merged = [...prior, ...objects]
            .filter((item, index, all) => all.findIndex(other => identity(other) === identity(item)) === index)
            .slice(0, 1000);
          return {
            ...current,
            [kind]: { objects: merged, next: merged.length === 1000 ? null : next, loading: false },
          };
        });
        if (appliedSearch) supported.filter(other => other !== kind).forEach(other => void loadRef.current?.(other));
      } catch (cause) {
        if (!controller.signal.aborted && requestEpoch === epoch.current) {
          setGroups(current => ({
            ...current,
            [kind]: {
              ...(current[kind] ?? { objects: [], next: null }),
              loading: false,
              error: cause instanceof Error ? cause.message : "Object request failed.",
            },
          }));
        }
      } finally {
        controllers.current.delete(controller);
        if (requestEpoch === epoch.current) loading.current.delete(kind);
      }
    },
    [appliedSearch, connectionId, disabled],
  );
  loadRef.current = load;

  useEffect(() => {
    if (!search.trim()) {
      setAppliedSearch("");
      return;
    }
    const timer = window.setTimeout(() => setAppliedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search, abort]);
  useEffect(() => {
    abort();
    loaded.current.clear();
    setGroups({});
    setKinds([]);
    if (!disabled && scope && connectionId) void load(initialKind(driver));
    return abort;
  }, [scope, connectionId, driver, refreshKey, appliedSearch, disabled, abort, load]);

  const availableKinds = kinds.length
    ? kinds
    : (Object.keys(groups) as CatalogKind[]).filter(kind => catalogKinds.has(kind));
  const visibleKinds = availableKinds.filter(
    kind => !appliedSearch || groups[kind]?.objects.length || groups[kind]?.error || groups[kind]?.loading,
  );
  return (
    <aside className="database-object-browser" aria-label="Database objects">
      {!kinds.length && !Object.keys(groups).length && (
        <p className="database-muted">
          {disabled ? "Object browsing is unavailable during a transaction." : "Loading objects…"}
        </p>
      )}
      {visibleKinds.map(kind => {
        const group = groups[kind] ?? { objects: [], next: null, loading: false };
        const retry = () => void load(kind, group.objects.length && group.next !== null ? group.next : undefined, true);
        return (
          <details
            className="database-object-group"
            key={`${kind}:${Boolean(appliedSearch)}`}
            open={appliedSearch || kind === initialKind(driver) ? true : undefined}
            onToggle={event => {
              if (event.currentTarget.open && !appliedSearch) void load(kind);
            }}>
            <summary>
              <IconChevronRight size={13} aria-hidden="true" />
              {labels[kind]}
              <small>{group.objects.length || undefined}</small>
            </summary>
            {group.objects.map(object => (
              <button
                className="database-object"
                type="button"
                key={identity(object)}
                disabled={disabled}
                onClick={() =>
                  onOpen({
                    kind: object.kind,
                    name: object.name,
                    ...(object.schema !== undefined ? { schema: object.schema } : {}),
                    ...(object.identity !== undefined ? { identity: object.identity } : {}),
                  })
                }>
                <IconDatabase size={14} aria-hidden="true" />
                <span>{object.schema ? `${object.schema}.${object.name}` : object.name}</span>
                {object.identity && <small>{object.identity}</small>}
              </button>
            ))}
            {group.loading && <p className="database-muted">Loading…</p>}
            {group.error && (
              <p className="database-muted">
                {group.error}{" "}
                <button type="button" className="text-button" disabled={disabled} onClick={retry}>
                  Retry
                </button>
              </p>
            )}
            {!group.error && group.next !== null && (
              <button
                type="button"
                className="text-button"
                disabled={disabled || group.loading}
                onClick={() => void load(kind, group.next ?? undefined)}>
                Load more
              </button>
            )}
            {!group.loading && !group.error && !group.objects.length && (
              <p className="database-muted">No {labels[kind].toLocaleLowerCase()} found.</p>
            )}
            {group.objects.length === 1000 && (
              <p className="database-muted">Showing 1,000 objects. Refine search to see more.</p>
            )}
          </details>
        );
      })}
    </aside>
  );
}
