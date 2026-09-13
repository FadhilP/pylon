import { readComposerDrafts, COMPOSER_DRAFTS_KEY } from "../conversation/composer-drafts";
import { readExplorerStates, EXPLORER_STATE_KEY } from "../workspace/explorer-state";
import { readDatabaseDrafts, DATABASE_DRAFTS_KEY } from "../database/database-workspace";
import type { HostPreferencesInput, LegacyWebStateImportInput, LegacyWebStateImportResult } from "../../shared/settings/web-state";

const keys = [
  "pylon-theme",
  "pylon-syntax-theme",
  "pylon-hidden-models",
  "pylon-database-workspace-v1",
  EXPLORER_STATE_KEY,
  COMPOSER_DRAFTS_KEY,
  DATABASE_DRAFTS_KEY,
] as const;

function storage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}
function remove(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    /* Retry next launch. */
  }
}
function preferenceInput(store: Storage): HostPreferencesInput {
  const theme = store.getItem("pylon-theme");
  const syntax = store.getItem("pylon-syntax-theme");
  const workspace = store.getItem("pylon-database-workspace-v1");
  const hiddenModels: { provider: string; id: string }[] = [];
  const seen = new Set<string>();
  try {
    const raw: unknown = JSON.parse(store.getItem("pylon-hidden-models") ?? "[]");
    if (Array.isArray(raw)) {
      for (const value of raw) {
        if (typeof value !== "string" || hiddenModels.length >= 100) continue;
        const slash = value.indexOf("/");
        const provider = value.slice(0, slash);
        const id = value.slice(slash + 1);
        const key = `${provider}\0${id}`;
        if (
          slash <= 0 ||
          slash >= value.length - 1 ||
          provider.length > 256 ||
          id.length > 256 ||
          provider.includes("\0") ||
          id.includes("\0") ||
          seen.has(key)
        ) {
          continue;
        }
        seen.add(key);
        hiddenModels.push({ provider, id });
      }
    }
  } catch {
    /* An invalid legacy preference is an explicit default decision. */
  }
  return {
    initialized: true,
    theme: theme === "light" || theme === "dark" || theme === "warm" ? theme : "system",
    syntax:
      syntax === "one-dark-pro" ||
      syntax === "github-dark" ||
      syntax === "dracula" ||
      syntax === "nord" ||
      syntax === "github-light"
        ? syntax
        : "auto",
    hiddenModels,
    databaseWorkspace: workspace === "global" ? "global" : "session",
  };
}

/** Imports each domain independently. Authored browser drafts are removed only
 * after SQLite confirms that this exact domain was accepted. */
export async function importLegacyWebState(
  send: (input: LegacyWebStateImportInput) => Promise<LegacyWebStateImportResult>,
  projectForSession?: (sessionId: string) => string | undefined | Promise<string | undefined>,
): Promise<string | undefined> {
  const store = storage();
  if (!store) return undefined;
  remove(store, "pylon-legacy-import-warning-v1");
  const warnings: string[] = [];
  const call = async (input: LegacyWebStateImportInput): Promise<LegacyWebStateImportResult | undefined> => {
    try {
      return await send(input);
    } catch {
      warnings.push("Some browser state could not be moved to host storage yet.");
      return undefined;
    }
  };
  const resolveProject = async (sessionId: string): Promise<string | undefined> => {
    try {
      return await projectForSession?.(sessionId);
    } catch {
      return undefined;
    }
  };

  const preferences = await call({ preferences: preferenceInput(store) });
  if (preferences?.preferences) {
    for (const key of ["pylon-theme", "pylon-syntax-theme", "pylon-hidden-models", "pylon-database-workspace-v1"])
      remove(store, key);
  }

  const explorers = [...readExplorerStates(store)].flatMap(([projectId, value]) =>
    projectId &&
    value.open.length <= 500 &&
    value.open.every(
      path =>
        path.length > 0 &&
        path.length <= 4096 &&
        !path.startsWith("/") &&
        !path.includes("\\") &&
        path.split("/").every(part => part && part !== "." && part !== ".."),
    )
      ? [{ projectId, ...value }]
      : [],
  );
  const explorerResult = await call({ explorers });
  if (explorerResult?.explorers) remove(store, EXPLORER_STATE_KEY);

  const legacyComposers = [...readComposerDrafts(store).values()];
  const composers = [];
  for (const draft of legacyComposers) {
    const projectId = draft.projectId || (await resolveProject(draft.sessionId));
    if (
      projectId &&
      !draft.text.includes("\0") &&
      new TextEncoder().encode(draft.text).byteLength <= 64 * 1024
    ) {
      composers.push({ sessionId: draft.sessionId, projectId, text: draft.text });
    }
  }
  if (legacyComposers.length > 500 || composers.length !== legacyComposers.length) {
    warnings.push("Some legacy composer drafts are waiting for their session to be discovered or exceed the host limit.");
  } else {
    const composerResult = await call({ composers });
    if (composerResult?.composers && (composers.length === 0 || composerResult.composers.accepted)) {
      remove(store, COMPOSER_DRAFTS_KEY);
    } else if (composerResult?.composers) {
      warnings.push("Legacy composer drafts conflict with host drafts and remain in this browser.");
    }
  }

  const legacyDatabases = readDatabaseDrafts(store);
  const databases = [];
  for (const draft of legacyDatabases) {
    try {
      const tuple: unknown = JSON.parse(draft.scope);
      const owner = Array.isArray(tuple) && typeof tuple[2] === "string" ? tuple[2] : undefined;
      const projectId = owner ? await resolveProject(owner) : undefined;
      if (!owner || !projectId) continue;
      const tabs = draft.tabs
        .filter(tab => tab.saved === true)
        .map(({ id, title, text, driver }) => ({ id, title, text, driver, saved: true as const }));
      databases.push({ scope: draft.scope, sessionId: owner, projectId, tabs });
    } catch {
      /* Keep this authored legacy draft in the browser. */
    }
  }
  if (databases.length !== legacyDatabases.length) {
    warnings.push("Some legacy database drafts are waiting for their session to be discovered.");
  } else {
    const databaseResult = await call({ databases });
    if (databaseResult?.databases && (databases.length === 0 || databaseResult.databases.accepted)) {
      remove(store, DATABASE_DRAFTS_KEY);
    } else if (databaseResult?.databases) {
      warnings.push("Legacy database drafts conflict with host drafts and remain in this browser.");
    }
  }
  return [...new Set(warnings)].join(" ") || undefined;
}
export { keys as LEGACY_WEB_STATE_KEYS };
