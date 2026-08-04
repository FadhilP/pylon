export interface PylonStorageResult {
  status: "override" | "already-present" | "no-legacy-data" | "migrated" | "legacy-fallback";
  agentDir: string;
  legacyDir: string;
  migrationError?: unknown;
}

export interface PylonStorageOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  stat?: typeof import("node:fs/promises").stat;
  copy?: typeof import("node:fs/promises").cp;
  rename?: typeof import("node:fs/promises").rename;
  remove?: typeof import("node:fs/promises").rm;
  open?: typeof import("node:fs/promises").open;
  randomId?: () => string;
}

export function migratePylonStorage(options?: PylonStorageOptions): Promise<PylonStorageResult>;
export function preparePylonStorage(options?: PylonStorageOptions): Promise<PylonStorageResult>;
