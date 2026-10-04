import { basename } from "node:path";

export type ExtensionLoadTiming = {
  extension: string;
  operation: "module import" | "factory";
  durationMs: number;
};

type PrintTimings = () => void;

function parseExtensionTimings(output: string): ExtensionLoadTiming[] {
  const timings: ExtensionLoadTiming[] = [];
  let inExtensions = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^--- Startup Timings: extensions ---$/.test(line.trim())) {
      inExtensions = true;
      continue;
    }
    if (!inExtensions) continue;
    if (/^-{3,}$/.test(line.trim())) break;
    const match = /^\s{2}(.+) (module import|factory): (\d+)ms$/.exec(line);
    if (!match) continue;
    const durationMs = Number(match[3]);
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) continue;
    const path = match[1]!;
    timings.push({
      extension: path.startsWith("<") ? path : basename(path),
      operation: match[2] as ExtensionLoadTiming["operation"],
      durationMs,
    });
  }
  return timings;
}

export function captureExtensionLoadTimings(printTimings: PrintTimings): ExtensionLoadTiming[] {
  const output: string[] = [];
  const previous = console.error;
  console.error = (...values: unknown[]) => output.push(values.map(String).join(" "));
  try {
    printTimings();
  } finally {
    console.error = previous;
  }
  return parseExtensionTimings(output.join("\n"));
}

async function loadPiPrintTimings(): Promise<PrintTimings | undefined> {
  try {
    const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const module = (await import(/* @vite-ignore */ new URL("./core/timings.js", piEntry).href)) as {
      printTimings?: unknown;
    };
    return typeof module.printTimings === "function" ? (module.printTimings as PrintTimings) : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort adapter for Pi's diagnostic-only timing output. */
export async function collectExtensionLoadTimings(): Promise<ExtensionLoadTiming[]> {
  const printTimings = await loadPiPrintTimings();
  if (!printTimings) return [];
  try {
    return captureExtensionLoadTimings(printTimings);
  } catch {
    return [];
  }
}
