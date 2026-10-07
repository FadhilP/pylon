/** Public GitHub integration state. Credentials and device codes never cross this boundary. */
export interface GitHubAccount {
  id: number;
  login: string;
}
export interface GitHubAuthSnapshot {
  revision: number;
  phase: "disconnected" | "starting" | "authorizing" | "checking" | "connected";
  clientId: string;
  account?: GitHubAccount;
  expiresAt?: number;
  verifiedAt?: number;
  error?: string;
  /** Only the browser tab that initiated authorization receives these instructions. */
  device?: { userCode: string; verificationUri: string; expiresAt: number };
  repository?: { fullName: string; private: boolean; checkedAt: number };
}
export type GitHubAuthInput =
  | { action: "start"; clientId: string }
  | { action: "cancel" | "reconnect" | "disconnect" }
  | { action: "repository"; repository: string };
export type GitHubAuthAction = GitHubAuthInput & { expectedRevision: number };
export function validGitHubClientId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value);
}
export function validGitHubRepository(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 201 &&
    value.split("/").length === 2 &&
    value.split("/").every(part => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(part))
  );
}
export function validGitHubAuthAction(value: unknown): value is GitHubAuthAction {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!Number.isSafeInteger(item.expectedRevision) || (item.expectedRevision as number) < 0) return false;
  const keys = ["expectedRevision", "action"];
  if (item.action === "start") {
    if (!validGitHubClientId(item.clientId)) return false;
    keys.push("clientId");
  } else if (item.action === "repository") {
    if (!validGitHubRepository(item.repository)) return false;
    keys.push("repository");
  } else if (!["cancel", "reconnect", "disconnect"].includes(item.action as string)) return false;
  return Object.keys(item).every(key => keys.includes(key));
}
