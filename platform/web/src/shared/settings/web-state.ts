/** Durable, synchronizable web state. These validators intentionally accept only
 * the small allowlist that is safe to store on the server. */
export type ThemePreference = "system" | "light" | "dark" | "warm";
export type SyntaxPreference = "auto" | "one-dark-pro" | "github-dark" | "dracula" | "nord" | "github-light";
export type DatabaseWorkspacePreference = "session" | "global";

export interface HiddenModel {
  provider: string;
  id: string;
}
export interface HostPreferences {
  revision: number;
  initialized: boolean;
  theme: ThemePreference;
  syntax: SyntaxPreference;
  hiddenModels: HiddenModel[];
  databaseWorkspace: DatabaseWorkspacePreference;
}
export interface HostPreferencesInput extends Omit<HostPreferences, "revision"> {}

export interface ExplorerRecord {
  projectId: string;
  open: string[];
  changesOnly: boolean;
  revision: number;
  updatedAt: number;
}
export interface ExplorerInput extends Omit<ExplorerRecord, "revision" | "updatedAt"> {}

export interface ComposerDraft {
  sessionId: string;
  projectId: string;
  text: string;
  revision: number;
  updatedAt: number;
}
export interface ComposerDraftInput extends Omit<ComposerDraft, "revision" | "updatedAt"> {}

export type DatabaseDriver = "sqlite" | "postgres" | "mysql" | "mongodb" | "redis";
export interface DatabaseTab {
  id: string;
  title: string;
  text: string;
  driver: DatabaseDriver;
  saved: true;
}
/** projectId is server ownership metadata, not part of the legacy browser draft. */
export interface DatabaseDraft {
  scope: string;
  sessionId: string;
  projectId: string;
  tabs: DatabaseTab[];
  revision: number;
  updatedAt: number;
}
export interface DatabaseDraftInput extends Omit<DatabaseDraft, "revision" | "updatedAt"> {}

export interface ExplorerStateResponse { projectId: string; state?: ExplorerRecord }
export interface ComposerDraftResponse { sessionId: string; draft?: ComposerDraft }
export interface ComposerDraftListResponse { projectId: string; drafts: ComposerDraft[] }
export interface DatabaseDraftResponse { scope: string; draft?: DatabaseDraft }
export interface DatabaseDraftListResponse { sessionId: string; drafts: DatabaseDraft[] }
/** The allowlisted, one-time migration payload accepted from older browsers. */
export interface LegacyWebStateImportInput {
  preferences?: HostPreferencesInput;
  explorers?: ExplorerInput[];
  composers?: ComposerDraftInput[];
  databases?: DatabaseDraftInput[];
}
export interface LegacyImportDomain<T> {
  accepted: boolean;
  values: T[];
}
export interface LegacyWebStateImportResult {
  preferences?: { accepted: boolean; value: HostPreferences };
  explorers?: LegacyImportDomain<ExplorerRecord>;
  composers?: LegacyImportDomain<ComposerDraft>;
  databases?: LegacyImportDomain<DatabaseDraft>;
}

export const DEFAULT_HOST_PREFERENCES: HostPreferences = {
  revision: 0,
  initialized: false,
  theme: "system",
  syntax: "auto",
  hiddenModels: [],
  databaseWorkspace: "session",
};

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const revision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isWebStateIdentifier = (value: unknown): value is string => text(value);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const relativePath = (value: unknown): value is string => {
  if (!text(value, 4096) || value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every(part => part !== "" && part !== "." && part !== "..");
};

const themes: readonly ThemePreference[] = ["system", "light", "dark", "warm"];
const syntaxThemes: readonly SyntaxPreference[] = [
  "auto",
  "one-dark-pro",
  "github-dark",
  "dracula",
  "nord",
  "github-light",
];
const databaseWorkspaces: readonly DatabaseWorkspacePreference[] = ["session", "global"];
const databaseDrivers: readonly DatabaseDriver[] = ["sqlite", "postgres", "mysql", "mongodb", "redis"];
const isTheme = (value: unknown): value is ThemePreference =>
  typeof value === "string" && themes.some(theme => theme === value);
const isSyntax = (value: unknown): value is SyntaxPreference =>
  typeof value === "string" && syntaxThemes.some(theme => theme === value);
const isDatabaseWorkspace = (value: unknown): value is DatabaseWorkspacePreference =>
  typeof value === "string" && databaseWorkspaces.some(workspace => workspace === value);
const isDatabaseDriver = (value: unknown): value is DatabaseDriver =>
  typeof value === "string" && databaseDrivers.some(driver => driver === value);

function validPreferences(value: unknown, withRevision: boolean): boolean {
  if (!object(value)) return false;
  const keys = withRevision
    ? ["revision", "initialized", "theme", "syntax", "hiddenModels", "databaseWorkspace"]
    : ["initialized", "theme", "syntax", "hiddenModels", "databaseWorkspace"];
  if (
    !exact(value, keys) ||
    (withRevision && !revision(value.revision)) ||
    typeof value.initialized !== "boolean" ||
    !isTheme(value.theme) ||
    !isSyntax(value.syntax) ||
    !isDatabaseWorkspace(value.databaseWorkspace) ||
    !Array.isArray(value.hiddenModels)
  ) {
    return false;
  }
  const seen = new Set<string>();
  return value.hiddenModels.every(item => {
    if (!object(item) || !exact(item, ["provider", "id"]) || !text(item.provider) || !text(item.id)) {
      return false;
    }
    const key = `${item.provider}\u0000${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export const isHostPreferences = (value: unknown): value is HostPreferences => validPreferences(value, true);
export const isHostPreferencesInput = (value: unknown): value is HostPreferencesInput => validPreferences(value, false);

function validExplorer(value: unknown, full: boolean): boolean {
  if (!object(value)) return false;
  const keys = full ? ["projectId", "open", "changesOnly", "revision", "updatedAt"] : ["projectId", "open", "changesOnly"];
  return (
    exact(value, keys) &&
    text(value.projectId) &&
    Array.isArray(value.open) &&
    value.open.length <= 500 &&
    value.open.every(relativePath) &&
    new Set(value.open).size === value.open.length &&
    typeof value.changesOnly === "boolean" &&
    (!full || (revision(value.revision) && timestamp(value.updatedAt)))
  );
}
export const isExplorerRecord = (value: unknown): value is ExplorerRecord => validExplorer(value, true);
export const isExplorerInput = (value: unknown): value is ExplorerInput => validExplorer(value, false);

function validComposer(value: unknown, full: boolean): boolean {
  if (!object(value)) return false;
  const keys = full ? ["sessionId", "projectId", "text", "revision", "updatedAt"] : ["sessionId", "projectId", "text"];
  return (
    exact(value, keys) &&
    text(value.sessionId) &&
    text(value.projectId) &&
    typeof value.text === "string" &&
    !value.text.includes("\0") &&
    bytes(value.text) <= 64 * 1024 &&
    (!full || (revision(value.revision) && timestamp(value.updatedAt)))
  );
}
export const isComposerDraft = (value: unknown): value is ComposerDraft => validComposer(value, true);
export const isComposerDraftInput = (value: unknown): value is ComposerDraftInput => validComposer(value, false);

export function databaseScopeSession(scope: unknown): string | undefined {
  if (typeof scope !== "string") return undefined;
  let tuple: unknown;
  try {
    tuple = JSON.parse(scope);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(tuple) ||
    tuple.length !== 4 ||
    !tuple.every(part => text(part)) ||
    (tuple[0] !== "session" && tuple[0] !== "global") ||
    (tuple[0] === "session" ? tuple[1] !== tuple[2] : tuple[1] !== "pylon:stateql:global:ui:v1")
  ) {
    return undefined;
  }
  return tuple[2];
}


function validDatabase(value: unknown, full: boolean): boolean {
  if (!object(value)) return false;
  const keys = full
    ? ["scope", "sessionId", "projectId", "tabs", "revision", "updatedAt"]
    : ["scope", "sessionId", "projectId", "tabs"];
  if (
    !exact(value, keys) ||
    !text(value.scope) ||
    !text(value.sessionId) ||
    databaseScopeSession(value.scope) !== value.sessionId ||
    !text(value.projectId) ||
    !Array.isArray(value.tabs) ||
    value.tabs.length > 20
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const tab of value.tabs) {
    if (
      !object(tab) ||
      !exact(tab, ["id", "title", "text", "driver", "saved"]) ||
      !text(tab.id) ||
      tab.id === "history" ||
      ids.has(tab.id) ||
      !text(tab.title, 100) ||
      typeof tab.text !== "string" ||
      tab.text.includes("\0") ||
      bytes(tab.text) > 64 * 1024 ||
      !isDatabaseDriver(tab.driver) ||
      tab.saved !== true
    ) {
      return false;
    }
    ids.add(tab.id);
  }
  return !full || (revision(value.revision) && timestamp(value.updatedAt));
}
export const isDatabaseDraft = (value: unknown): value is DatabaseDraft => validDatabase(value, true);
export const isDatabaseDraftInput = (value: unknown): value is DatabaseDraftInput => validDatabase(value, false);

export interface ExplorerWebStateEvent {
  projectId: string;
  state?: ExplorerRecord;
}
export interface ComposerWebStateEvent {
  sessionId: string;
  draft?: ComposerDraft;
}
export interface DatabaseWebStateEvent {
  scope: string;
  draft?: DatabaseDraft;
}
export function isExplorerWebStateEvent(value: unknown): value is ExplorerWebStateEvent {
  return (
    object(value) &&
    exact(value, ["projectId", ...(value.state === undefined ? [] : ["state"])]) &&
    isWebStateIdentifier(value.projectId) &&
    (value.state === undefined || isExplorerRecord(value.state))
  );
}
export function isComposerWebStateEvent(value: unknown): value is ComposerWebStateEvent {
  return (
    object(value) &&
    exact(value, ["sessionId", ...(value.draft === undefined ? [] : ["draft"])]) &&
    isWebStateIdentifier(value.sessionId) &&
    (value.draft === undefined || isComposerDraft(value.draft))
  );
}
export function isDatabaseWebStateEvent(value: unknown): value is DatabaseWebStateEvent {
  return (
    object(value) &&
    exact(value, ["scope", ...(value.draft === undefined ? [] : ["draft"])]) &&
    isWebStateIdentifier(value.scope) &&
    (value.draft === undefined || isDatabaseDraft(value.draft))
  );
}

export function isLegacyWebStateImportInput(value: unknown): value is LegacyWebStateImportInput {
  if (!object(value) || !Object.keys(value).every(key => ["preferences", "explorers", "composers", "databases"].includes(key))) return false;
  if (value.preferences !== undefined && !isHostPreferencesInput(value.preferences)) return false;
  if (value.explorers !== undefined && (!Array.isArray(value.explorers) || value.explorers.length > 500 || !value.explorers.every(isExplorerInput))) return false;
  if (value.composers !== undefined && (!Array.isArray(value.composers) || value.composers.length > 500 || !value.composers.every(isComposerDraftInput))) return false;
  if (value.databases !== undefined && (!Array.isArray(value.databases) || value.databases.length > 20 || !value.databases.every(isDatabaseDraftInput))) return false;
  return value.preferences !== undefined || value.explorers !== undefined || value.composers !== undefined || value.databases !== undefined;
}

export const utf8Bytes = (value: string) => bytes(value);
