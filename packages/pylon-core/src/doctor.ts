import { constants } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION } from "./tools.ts";
import type { ToolRegistry } from "./tool-registry.ts";

export type Probe = { lines: string[]; warning: boolean };

const HEALTH_TIMEOUT_MS = 3_000;
const MAX_HEALTH_REPORTERS = 20;
const LOCK_AGE_MS = 30_000;
const THINKING_SUFFIXES = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const TOOL_SURFACES = [
  ["Advisor", ["advisor"]],
  ["Continuity", ["continuity_update"]],
  ["Grunt", ["grunt"]],
  ["Heartbeat", ["heartbeat_start", "heartbeat_status", "heartbeat_cancel"]],
  ["Scout", ["rg", "fd", "scout_checkpoint", "repo_scout", "web_scout"]],
  ["Verify", ["verify"]],
] as const;

const CHILD_CONFIGS = [
  ["Advisor", "pi-advisor", (value: any) => [["Advisor", value.advisorModel]]],
  ["Grunt", "pi-grunt", (value: any) => [["Grunt", value.model]]],
  ["Scout", "pi-scout", (value: any) => [["Scout", value.model]]],
  [
    "Continuity",
    "pi-continuity",
    (value: any) => [
      ["Continuity planner", value.planner?.model],
      ["Continuity executor", value.executor?.model],
      ["Memory Reviewer", value.memoryReviewer?.model],
      ["Compaction Reviewer", value.compactionReviewer?.model],
    ],
  ],
] as const;

const QUARANTINE_PACKAGES = [
  "pi-advisor",
  "pi-grunt",
  "pi-scout",
  "pi-continuity",
];
const QUARANTINE_MARKERS = [".corrupt-", ".reset-unsupported-"];

type JsonFile = { value: any } | { missing: true } | { invalid: true };

/** Distinguishes "no config yet" from "config is broken", which the doctor reports differently. */
async function readJsonFile(path: string): Promise<JsonFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error: any) {
    return error?.code === "ENOENT" ? { missing: true } : { invalid: true };
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { invalid: true };
  }
}

const listDir = (path: string) =>
  readdir(path, { recursive: true }).catch(() => [] as string[]);

function probeRuntime(pi: ExtensionAPI): Probe {
  const apiNames = [
    "getActiveTools",
    "setActiveTools",
    "on",
    "registerCommand",
  ] as const;
  const missingApi = apiNames.filter((name) => typeof pi[name] !== "function");
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeCompatible = major > 22 || (major === 22 && minor >= 19);
  return {
    lines: [
      `Node: ${process.versions.node} (${nodeCompatible ? "compatible" : "requires >=22.19.0"})`,
      `Pi API: ${missingApi.length ? `missing ${missingApi.join(", ")}` : "compatible"}`,
    ],
    warning: !nodeCompatible || missingApi.length > 0,
  };
}

async function probeExecutables(pi: ExtensionAPI): Promise<Probe> {
  const results = await Promise.all(
    (
      [
        ["Git", "git", true],
        ["ripgrep", "rg", false],
        ["fd", "fd", false],
      ] as const
    ).map(async ([label, command, required]) => {
      try {
        const result = await pi.exec(command, ["--version"], {
          timeout: HEALTH_TIMEOUT_MS,
        });
        return { label, required, available: result.code === 0 };
      } catch {
        return { label, required, available: false };
      }
    }),
  );
  return {
    lines: [
      "Executables:",
      ...results.map(
        ({ label, required, available }) =>
          `${label}: ${available ? "available" : `missing${required ? "" : " (optional)"}`}`,
      ),
    ],
    warning: results.some((item) => item.required && !item.available),
  };
}

async function probeStateRoot(agentDir: string): Promise<Probe> {
  let status = "missing (created on first persisted setting)";
  let warning = false;
  let oldLocks: string[] = [];
  try {
    await access(agentDir, constants.W_OK);
    status = "writable";
    const continuityDir = join(agentDir, "pi-continuity");
    const now = Date.now();
    const locks = await Promise.all(
      (await listDir(continuityDir))
        .filter((name) => name.endsWith(".lock"))
        .map(async (name) => {
          const info = await stat(join(continuityDir, name)).catch(
            () => undefined,
          );
          return info && now - info.mtimeMs > LOCK_AGE_MS ? name : undefined;
        }),
    );
    oldLocks = locks.filter((name): name is string => Boolean(name));
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      status = "inaccessible";
      warning = true;
    }
  }
  return {
    lines: [
      `State root: ${agentDir} (${status})`,
      `Locks older than ${LOCK_AGE_MS / 1_000}s: ${oldLocks.join(", ") || "none"}`,
    ],
    warning: warning || oldLocks.length > 0,
  };
}

async function probeQuarantine(agentDir: string): Promise<Probe> {
  const quarantined: string[] = [];
  for (const name of QUARANTINE_PACKAGES) {
    for (const entry of await listDir(join(agentDir, name)))
      if (
        QUARANTINE_MARKERS.some((marker) => entry.includes(marker)) &&
        quarantined.length < 8
      )
        quarantined.push(join(name, entry));
  }
  return {
    lines: [`Quarantined state: ${quarantined.join(", ") || "none"}`],
    warning: quarantined.length > 0,
  };
}

/** Resolves "provider/model[:thinking]" against the registry to report whether it can actually run. */
function describeModelReference(
  label: string,
  reference: string,
  ctx: any,
): { line: string; warning: boolean } {
  if (reference === "<invalid config>")
    return { line: `${label}: invalid config JSON`, warning: true };
  if (reference === "<not configured>")
    return {
      line: `${label}: not configured (memory proposals unavailable)`,
      warning: true,
    };
  const slash = reference.indexOf("/");
  const colon = reference.lastIndexOf(":");
  const idEnd =
    colon > slash && THINKING_SUFFIXES.has(reference.slice(colon + 1))
      ? colon
      : undefined;
  const provider = slash > 0 ? reference.slice(0, slash) : "";
  const id = slash > 0 ? reference.slice(slash + 1, idEnd) : "";
  const model =
    provider && id ? ctx.modelRegistry?.find?.(provider, id) : undefined;
  const available = Boolean(
    model && ctx.modelRegistry?.hasConfiguredAuth?.(model),
  );
  const state =
    !provider || !id
      ? "invalid reference"
      : !model
        ? "model unavailable"
        : available
          ? "available"
          : "credentials unavailable";
  return {
    line: `${label}: ${reference} (${state})`,
    warning: !provider || !id || !available,
  };
}

async function probeChildModels(agentDir: string, ctx: any): Promise<Probe> {
  const configured: Array<[string, string]> = [];
  let warning = false;
  let continuityConfig: any;
  for (const [name, directory, select] of CHILD_CONFIGS) {
    const file = await readJsonFile(join(agentDir, directory, "config.json"));
    if ("missing" in file) continue;
    if ("invalid" in file) {
      configured.push([name, "<invalid config>"]);
      warning = true;
      continue;
    }
    if (name === "Continuity") continuityConfig = file.value;
    for (const [label, model] of select(file.value))
      if (typeof model === "string" && model.trim())
        configured.push([label, model]);
  }
  if (
    continuityConfig?.memoryEnabled !== false &&
    !continuityConfig?.memoryReviewer?.model
  ) {
    configured.push(["Memory Reviewer", "<not configured>"]);
    warning = true;
  }
  const described = configured.map(([label, reference]) =>
    describeModelReference(label, reference, ctx),
  );
  return {
    lines: [
      "Configured child models:",
      ...(described.length
        ? described.map((item) => item.line)
        : ["none configured"]),
    ],
    warning: warning || described.some((item) => item.warning),
  };
}

async function probeMemoryMigration(agentDir: string): Promise<Probe> {
  const file = await readJsonFile(
    join(agentDir, "pi-continuity", "memory-v5", "migration.json"),
  );
  if ("missing" in file)
    return { lines: ["Memory migration: not started"], warning: false };
  if ("invalid" in file)
    return { lines: ["Memory migration: invalid journal"], warning: true };
  const { status, failureReason } = file.value;
  const reason = failureReason
    ? ` (${String(failureReason).slice(0, 200)})`
    : "";
  return {
    lines: [`Memory migration: ${String(status ?? "unknown")}${reason}`],
    warning: ["failed", "preparing", "prepared"].includes(status),
  };
}

function probeToolSurfaces(registry: ToolRegistry, pi: ExtensionAPI): Probe {
  const activeTools =
    typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
  const known = new Set([
    ...registry.baseline,
    ...registry.managedTools(),
    ...activeTools,
  ]);
  return {
    lines: [
      "Tool surfaces:",
      ...TOOL_SURFACES.map(([name, tools]) => {
        const found = tools.filter((tool) => known.has(tool));
        return `${name}: ${found.length === tools.length ? "registered" : found.length ? `partial (${found.join(", ")})` : "not observed"}`;
      }),
    ],
    warning: false,
  };
}

/** Collects health reports other Pylon packages volunteer, tolerating slow or malformed responders. */
async function probePackageHealth(pi: ExtensionAPI): Promise<Probe> {
  const pending: Promise<unknown>[] = [];
  pi.events.emit("pylon:health-request", {
    version: 1,
    respond(value: unknown | Promise<unknown>) {
      if (pending.length < MAX_HEALTH_REPORTERS)
        pending.push(Promise.resolve(value));
    },
  });
  const values = await Promise.all(
    pending.map(
      (report) =>
        new Promise<unknown>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), HEALTH_TIMEOUT_MS);
          const settle = (value: unknown) => {
            clearTimeout(timer);
            resolve(value);
          };
          report.then(settle, () => settle(undefined));
        }),
    ),
  );

  const reports: Array<{
    owner: string;
    label: string;
    lines: string[];
    warning: boolean;
  }> = [];
  let warning = false;
  const reject = (reason: string) => {
    warning = true;
    reports.push({
      owner: `invalid-${reports.length}`,
      label: "Unknown",
      lines: [reason],
      warning: true,
    });
  };
  for (const value of values) {
    const report = value as any;
    if (!report || typeof report !== "object") {
      reject("Health reporter failed or timed out");
      continue;
    }
    if (
      report.version !== 1 ||
      typeof report.owner !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(report.owner) ||
      typeof report.label !== "string" ||
      !Array.isArray(report.lines) ||
      report.lines.some((line: unknown) => typeof line !== "string")
    ) {
      reject("Invalid health report rejected");
      continue;
    }
    reports.push({
      owner: report.owner,
      label: report.label.slice(0, 80),
      lines: report.lines
        .slice(0, 20)
        .map((line: string) => line.replace(/[\r\n]+/g, " ").slice(0, 500)),
      warning: report.warning === true,
    });
  }

  const counts = new Map<string, number>();
  for (const report of reports)
    counts.set(report.owner, (counts.get(report.owner) ?? 0) + 1);
  if ([...counts.values()].some((value) => value > 1)) warning = true;
  reports.sort((a, b) => a.owner.localeCompare(b.owner));
  return {
    lines: [
      "Package health:",
      ...(reports.length
        ? reports.flatMap((report) => [
            `${report.label}${(counts.get(report.owner) ?? 0) > 1 ? " (duplicate responder)" : ""}:`,
            ...report.lines.map((line) => `  ${line}`),
          ])
        : ["none reported"]),
    ],
    warning: warning || reports.some((report) => report.warning),
  };
}

export type DoctorInput = {
  pi: ExtensionAPI;
  ctx: any;
  registry: ToolRegistry;
  lineEditMode: string;
  lineEditConfigError?: string;
};

/** Reports everything Pylon can observe about the current runtime through the extension API. */
export async function runDoctor({
  pi,
  ctx,
  registry,
  lineEditMode,
  lineEditConfigError,
}: DoctorInput): Promise<Probe> {
  const agentDir = getAgentDir();
  const probes = [
    probeRuntime(pi),
    {
      lines: [
        `Policy protocol: v${PROTOCOL_VERSION} (${registry.policies.size} registered, ${registry.rejected.length} rejected)`,
      ],
      warning: false,
    },
    await probeExecutables(pi),
    await probeStateRoot(agentDir),
    {
      lines: [
        `Numbered line edit: ${lineEditMode}${lineEditConfigError ? ` (config error: ${lineEditConfigError.slice(0, 200)})` : ""}`,
      ],
      warning: false,
    },
    await probeQuarantine(agentDir),
    await probeChildModels(agentDir, ctx),
    await probeMemoryMigration(agentDir),
    probeToolSurfaces(registry, pi),
    await probePackageHealth(pi),
  ];
  return {
    lines: [
      ...probes.flatMap((probe) => probe.lines),
      "Command-only surfaces (Focus, Guard, Timeline): not observable through ExtensionAPI",
    ],
    warning: probes.some((probe) => probe.warning),
  };
}
