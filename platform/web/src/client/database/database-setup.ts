import type { StateQLCommandInput } from "../../shared/protocol/snapshots.ts";

export type DatabaseSetupAction = "connect" | "save" | "save-connect";
export type DatabaseSetupStep = "resolving" | "approving" | "saving" | "connecting";
// `preserve` remains available to the URL helper for callers that need a no-op edit;
// setup submissions always choose an explicit mode.
export type PostgresTlsMode = "preserve" | "verify-full" | "disable";
export type PostgresCaPreset = "aws-rds";

/** Explicit edits preserve unrelated options; TLS-off never causes certificate-file reads. */
export function postgresTlsTarget(
  target: string,
  mode: PostgresTlsMode,
  caFile?: string,
  caPreset?: PostgresCaPreset,
): string {
  if (mode === "preserve" && caFile === undefined && caPreset === undefined) return target;
  const url = new URL(target);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return target;
  if (mode !== "preserve") {
    for (const key of [...url.searchParams.keys()]) {
      if (["ssl", "sslmode", "rejectunauthorized", "uselibpqcompat", "sslnegotiation"].includes(key.toLowerCase()))
        url.searchParams.delete(key);
    }
    url.searchParams.set("sslmode", mode);
  }
  if (mode === "disable") {
    for (const key of [...url.searchParams.keys()])
      if (["sslrootcert", "sslcert", "sslkey", "pylon_tls_ca"].includes(key.toLowerCase()))
        url.searchParams.delete(key);
    return url.toString();
  }
  if (caFile !== undefined || caPreset !== undefined) {
    if (caFile !== undefined && (caFile.length > 4096 || /[\u0000-\u001f\u007f]/u.test(caFile)))
      throw new Error("Enter a CA certificate file path without control characters (at most 4,096 characters).");
    for (const key of [...url.searchParams.keys()])
      if (["sslrootcert", "pylon_tls_ca"].includes(key.toLowerCase())) url.searchParams.delete(key);
    if (caPreset === "aws-rds") url.searchParams.set("pylon_tls_ca", caPreset);
    else if (caFile?.trim()) url.searchParams.set("sslrootcert", caFile.trim());
  }
  return url.toString();
}

export class DatabaseSetupError extends Error {
  constructor(
    message: string,
    readonly connected = false,
  ) {
    super(message);
  }
}

/** Submit exactly one atomic setup command; profile discovery waits for it to settle. */
export async function submitDatabaseSetup(
  input: StateQLCommandInput,
  command: (input: StateQLCommandInput) => Promise<void>,
  refreshProfiles: () => void | Promise<void>,
): Promise<void> {
  try {
    await command(input);
  } finally {
    await refreshProfiles();
  }
}
