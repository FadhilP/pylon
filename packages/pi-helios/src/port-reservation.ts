import { open, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STALE_LOCK_MS = 10 * 60 * 1000;

export interface PortReservation {
  port: number;
  release(): Promise<void>;
}

export async function reserveHeliosPort(port: number): Promise<PortReservation | undefined> {
  const path = join(tmpdir(), `pi-helios-port-${port}.lock`);
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = await stat(path)
      .then(info => Date.now() - info.mtimeMs)
      .catch(() => 0);
    if (age <= STALE_LOCK_MS) return undefined;
    await rm(path, { force: true }).catch(() => {});
    try {
      handle = await open(path, "wx", 0o600);
    } catch {
      return undefined;
    }
  }
  await handle.writeFile(`${process.pid}\n`);
  let released = false;
  return {
    port,
    async release() {
      if (released) return;
      released = true;
      await handle.close().catch(() => {});
      await rm(path, { force: true }).catch(() => {});
    },
  };
}
