import type { spawn, ChildProcess } from "node:child_process";

export interface AndroidExecOptions {
  signal?: AbortSignal;
  timeout?: number;
  cwd?: string;
  maxOutputBytes?: number;
}

export interface AndroidExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export type AndroidExec = (command: string, args: string[], options?: AndroidExecOptions) => Promise<AndroidExecResult>;

export type AndroidSpawn = typeof spawn;

export type AndroidProcessTerminator = (
  child: ChildProcess,
  label: string,
  gracefulMs?: number,
  forceMs?: number,
) => Promise<void>;
