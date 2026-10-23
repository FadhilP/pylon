import {
  IconAlertTriangle,
  IconChevronDown,
  IconChevronUp,
  IconDeviceFloppy,
  IconInfoCircle,
  IconPlayerStop,
  IconRefresh,
  IconShield,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AndroidBuildReadModel, AndroidRunReadModel } from "../../shared/protocol/android";
import { rememberSetting } from "../app/use-chrome";
import {
  ANDROID_OUTPUT_SPLIT_KEY,
  androidRunPhaseStep,
  clampAndroidOutputSplit,
  moveAndroidOutputSplit,
  readAndroidOutputSplit,
  type AndroidOutputKind,
} from "./android-layout";
import { androidProjectForGeneration, androidStore, useAndroidStore } from "./android-store";
import "./android-panel.css";

export type AndroidDockedOutputs = Record<AndroidOutputKind, boolean>;

type Notice = { key: string; tone: "danger" | "warning" | "info"; title?: string; body: string };
type OutputData = {
  summary: string;
  output: string;
  empty: string;
  state?: string;
  tone?: "success" | "danger" | "active";
  truncated: boolean;
  issue?: string;
};

function lifecycleAnnouncement(
  device: { avd: string; ownership: "runner" | "external"; state: string } | undefined,
): string {
  if (!device) return "";
  if (device.ownership === "external") return `External emulator ${device.avd} is ready`;
  switch (device.state) {
    case "starting":
      return `Starting ${device.avd}`;
    case "booting":
      return `${device.avd} is booting`;
    case "ready":
      return `${device.avd} is ready`;
    case "cancelled":
      return `${device.avd} startup was cancelled`;
    case "stopping":
      return `Stopping ${device.avd}`;
    case "cleanup-required":
      return `${device.avd} requires cleanup`;
    default:
      return "";
  }
}

function act(operation: Promise<void>, focusAfter?: () => HTMLElement | null): void {
  void operation
    .catch(() => undefined)
    .finally(() => {
      if (!focusAfter) return;
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !document.contains(active) || active.matches(":disabled")) {
          focusAfter()?.focus();
        }
      }, 0);
    });
}

function outputData(
  which: AndroidOutputKind,
  build: AndroidBuildReadModel | undefined,
  run: AndroidRunReadModel | undefined,
): OutputData {
  if (which === "build") {
    return build
      ? {
          summary: `${build.modulePath} · ${build.variant} · ${build.state}`,
          output: build.output,
          empty: "No build output.",
          state: build.state,
          tone:
            build.state === "succeeded"
              ? "success"
              : build.state === "failed" || build.state === "timed-out"
                ? "danger"
                : ["queued", "running", "cancelling"].includes(build.state)
                  ? "active"
                  : undefined,
          truncated: build.outputTruncated,
          issue: build.issue,
        }
      : { summary: "never run", output: "", empty: "No build has run in this host.", truncated: false };
  }
  const logs = run?.logs;
  return logs
    ? {
        summary: logs.state,
        output: logs.output,
        empty: "No retained app logs.",
        state: logs.state,
        tone: logs.state === "running" || logs.state === "starting" ? "active" : undefined,
        truncated: logs.outputTruncated,
        issue: logs.issue,
      }
    : { summary: "no run", output: "", empty: "Run an app to collect package-scoped logs.", truncated: false };
}

function AndroidOutputTools({
  run,
  busy,
  focusAfter,
}: {
  run: AndroidRunReadModel | undefined;
  busy: boolean;
  focusAfter: () => HTMLElement | null;
}) {
  if (!run) {
    return (
      <span className="android-output-tools">
        <button type="button" className="secondary" disabled>
          Start logs
        </button>
        <button type="button" className="icon-button" disabled aria-label="Clear retained logs">
          <IconTrash size={13} />
        </button>
      </span>
    );
  }
  const running = run.logs.state === "running" || run.logs.state === "starting";
  return (
    <span className="android-output-tools">
      <button
        type="button"
        className="secondary"
        disabled={busy || (!running && run.phase !== "running")}
        onClick={() =>
          act(
            running ? androidStore.stopLogs(run.runId, run.revision) : androidStore.startLogs(run.runId, run.revision),
            focusAfter,
          )
        }>
        {running ? "Stop logs" : "Start logs"}
      </button>
      <button
        type="button"
        className="icon-button"
        disabled={busy || !run.logs.output}
        onClick={() => act(androidStore.clearRetainedOutput(run.runId, run.revision), focusAfter)}
        aria-label="Clear retained logs"
        title="Clear retained logs">
        <IconTrash size={13} />
      </button>
    </span>
  );
}

function AndroidOutputBody({ which, data }: { which: AndroidOutputKind; data: OutputData }) {
  return (
    <div className="android-output-body">
      <pre
        className={`android-output-pane${data.output ? "" : " is-empty"}`}
        tabIndex={0}
        aria-label={which === "build" ? "Bounded Gradle build output" : "Bounded package-scoped Logcat output"}>
        {data.output || data.empty}
      </pre>
      {which === "logs" && (
        <p className="android-output-foot is-quiet">May contain secrets. Clearing here does not clear device Logcat.</p>
      )}
      {data.truncated && (
        <p className="android-output-foot">
          <IconAlertTriangle size={11} /> {which === "build" ? "Build output" : "App logs"} was truncated.
        </p>
      )}
      {data.issue && (
        <p className="android-output-foot">
          <IconAlertTriangle size={11} /> {data.issue}
        </p>
      )}
    </div>
  );
}

function AndroidOutputSection({
  which,
  build,
  run,
  busy,
  focused,
  docked,
  style,
  onFocus,
  onDock,
}: {
  which: AndroidOutputKind;
  build: AndroidBuildReadModel | undefined;
  run: AndroidRunReadModel | undefined;
  busy: boolean;
  focused: boolean;
  docked: boolean;
  style?: CSSProperties;
  onFocus: () => void;
  onDock: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const data = outputData(which, build, run);
  const label = which === "build" ? "Build output" : "App logs";
  return (
    <section
      className={`android-output${focused ? " is-focus" : " is-aside"}${docked ? " is-docked" : ""}`}
      style={style}>
      <header className="android-output-head">
        <h3 className="android-output-heading" ref={headingRef} tabIndex={-1}>
          <button
            type="button"
            className="android-output-title"
            disabled={docked}
            onClick={onFocus}
            aria-expanded={!docked && focused}
            aria-label={`${label}, ${docked ? "in bottom panel" : focused ? "expanded" : "collapsed"}`}>
            <strong>{label}</strong>
            <span className={`android-output-summary${data.tone ? ` is-${data.tone}` : ""}`}>{data.summary}</span>
          </button>
        </h3>
        <span className="android-spacer" />
        {docked ? (
          <span className="android-tag">Bottom panel</span>
        ) : which === "logs" ? (
          <AndroidOutputTools run={run} busy={busy} focusAfter={() => headingRef.current} />
        ) : undefined}
        <button
          id={`android-${which}-dock-control`}
          type="button"
          className="icon-button android-output-dock"
          onClick={onDock}
          aria-label={`${docked ? "Return" : "Move"} ${label.toLowerCase()} ${docked ? "to the inspector" : "to the bottom panel"}`}
          title={docked ? "Return to the inspector" : "Move to the bottom panel"}>
          {docked ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
        </button>
      </header>
      {!docked && <AndroidOutputBody which={which} data={data} />}
    </section>
  );
}

export function AndroidBottomOutput({
  which,
  active,
  panelId,
  tabId,
  onRestore,
}: {
  which: AndroidOutputKind;
  active: boolean;
  panelId: string;
  tabId: string;
  onRestore: (which: AndroidOutputKind) => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const state = useAndroidStore();
  const build = state.service?.build;
  const run = state.service?.run;
  const data = outputData(which, build, run);
  const label = which === "build" ? "Build output" : "App logs";
  const busy = Boolean(state.busy) || !state.connected;
  return (
    <section id={panelId} className="android-bottom-output" role="tabpanel" aria-labelledby={tabId} hidden={!active}>
      <header className="android-bottom-output-head">
        <h3 className="android-output-heading" ref={headingRef} tabIndex={-1}>
          {label}
        </h3>
        <span className={`android-output-summary${data.tone ? ` is-${data.tone}` : ""}`}>{data.summary}</span>
        <span className="android-spacer" />
        {which === "logs" && <AndroidOutputTools run={run} busy={busy} focusAfter={() => headingRef.current} />}
        <button
          type="button"
          className="secondary"
          onClick={() => onRestore(which)}
          aria-label={`Return ${label.toLowerCase()} to the inspector`}>
          <IconChevronUp size={13} /> Return to inspector
        </button>
      </header>
      <AndroidOutputBody which={which} data={data} />
    </section>
  );
}

export function AndroidPanelHeader() {
  const state = useAndroidStore();
  const refreshing = state.service?.runner.discovery === "refreshing";
  return (
    <>
      <span className={`android-connection${state.connected ? " is-ready" : " is-warning"}`} title="Event connection">
        <span className="android-orb" />
        {state.connected ? "Connected" : "Reconnecting"}
      </span>
      <button
        type="button"
        className="icon-button"
        disabled={Boolean(state.busy)}
        onClick={() => act(androidStore.refresh())}
        aria-label="Refresh Android devices and project"
        title="Refresh Android devices and project">
        <IconRefresh className={refreshing ? "feedback-spinner" : undefined} size={15} />
      </button>
    </>
  );
}

function AndroidRibbon({ notices }: { notices: Notice[] }) {
  if (!notices.length) return null;
  return (
    <div className="android-ribbon">
      {notices.map(notice => (
        <div key={notice.key} className={`android-ribbon-item is-${notice.tone}`}>
          {notice.tone === "info" ? <IconInfoCircle size={13} /> : <IconAlertTriangle size={13} />}
          <div>
            {notice.title && <strong>{notice.title}</strong>}
            <p>{notice.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

const PHASES = ["Build", "Inspect", "Install", "Launch", "Run"] as const;


function AndroidPhaseRail({ run, build }: { run: AndroidRunReadModel; build: AndroidBuildReadModel | undefined }) {
  if (run.phase === "stopped") return null;
  const phase = androidRunPhaseStep(run.phase, {
    buildSucceeded: build?.state === "succeeded",
    hasArtifact: Boolean(run.artifact),
    installed: Boolean(run.installed),
  });
  return (
    <div className="android-phases" role="group" aria-label="Run progress">
      {PHASES.map((name, index) => {
        const status = index < phase.at ? "done" : index === phase.at ? phase.tone : "pending";
        return (
          <span key={name} className={`android-phase is-${status}`}>
            <span />
            {name}
          </span>
        );
      })}
    </div>
  );
}

export function AndroidPanel({
  workspaceLabel,
  sessionGeneration,
  dockedOutputs,
  onDockOutput,
  onRestoreOutput,
}: {
  workspaceLabel?: string;
  sessionGeneration?: number;
  dockedOutputs: AndroidDockedOutputs;
  onDockOutput: (which: AndroidOutputKind) => void;
  onRestoreOutput: (which: AndroidOutputKind) => void;
}) {
  const state = useAndroidStore();
  const service = state.service;
  const runner = service?.runner;
  const reportedProject = service?.project;
  const project = androidProjectForGeneration(service, sessionGeneration);
  const build = service?.build;
  const run = service?.run;
  const [selectedAvd, setSelectedAvd] = useState("");
  const [selectedDevice, setSelectedDevice] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState("");
  const [selectedModule, setSelectedModule] = useState("");
  const [selectedVariant, setSelectedVariant] = useState("");
  const [projectRefreshAttempt, setProjectRefreshAttempt] = useState("");
  const [focusedOutput, setFocusedOutput] = useState<AndroidOutputKind>("build");
  const [outputSplit, setOutputSplit] = useState<number | undefined>(() => {
    try {
      return readAndroidOutputSplit(localStorage);
    } catch {
      return undefined;
    }
  });
  const deviceHeading = useRef<HTMLHeadingElement>(null);
  const appHeading = useRef<HTMLHeadingElement>(null);
  const outputsRef = useRef<HTMLDivElement>(null);
  const selectionProjectId = useRef<string | undefined>(undefined);
  const projectRefreshKey = sessionGeneration ? `${sessionGeneration}:${service?.serviceRevision ?? 0}` : "";
  const busy = Boolean(state.busy) || !state.connected;
  const buildActive = !!build && ["queued", "running", "cancelling"].includes(build.state);
  const runActive = !!run && ["building", "inspecting", "installing", "launching"].includes(run.phase);
  const operationActive = buildActive || runActive;
  const selectedProjectCandidate = project?.candidates.find(candidate => candidate.candidateId === selectedCandidate);
  const cancellableOperation = runActive && run ? run : buildActive && build ? build : undefined;
  const automaticFocus: AndroidOutputKind = buildActive || build?.state === "failed" || build?.state === "timed-out" ? "build" : run ? "logs" : "build";
  const lifecycle = lifecycleAnnouncement(
    runner?.devices.find(device => device.ownership === "runner" && device.state !== "ready") ??
      runner?.devices.find(device => device.ownership === "runner") ??
      runner?.devices[0],
  );

  useEffect(() => {
    const avds = runner?.avds ?? [];
    if (!avds.includes(selectedAvd)) setSelectedAvd(avds[0] ?? "");
  }, [runner?.avds, selectedAvd]);

  useEffect(() => {
    const devices = (runner?.devices ?? []).filter(device => device.state === "ready" && !!device.serial);
    if (!devices.some(device => device.deviceId === selectedDevice)) {
      setSelectedDevice(
        devices.find(device => device.deviceId === run?.deviceId)?.deviceId ?? devices[0]?.deviceId ?? "",
      );
    }
  }, [runner?.devices, run?.deviceId, selectedDevice]);

  useEffect(() => {
    if (outputSplit === undefined) setFocusedOutput(automaticFocus);
  }, [automaticFocus, outputSplit]);

  useEffect(() => {
    if (
      sessionGeneration &&
      state.status === "ready" &&
      state.connected &&
      !state.busy &&
      !state.error &&
      reportedProject?.sessionGeneration !== sessionGeneration &&
      projectRefreshAttempt !== projectRefreshKey
    ) {
      setProjectRefreshAttempt(projectRefreshKey);
      void androidStore.refreshProject(sessionGeneration).catch(() => undefined);
    }
  }, [
    sessionGeneration,
    state.status,
    state.connected,
    state.busy,
    state.error,
    reportedProject?.sessionGeneration,
    projectRefreshAttempt,
    projectRefreshKey,
  ]);

  useEffect(() => {
    const configured = project?.configuration;
    const projectChanged = selectionProjectId.current !== project?.projectId;
    if (projectChanged) selectionProjectId.current = project?.projectId;
    const candidate = projectChanged
      ? (project?.candidates.find(item => item.candidateId === configured?.candidateId) ??
        (project?.candidates.length === 1 ? project.candidates[0] : undefined))
      : (project?.candidates.find(item => item.candidateId === selectedCandidate) ??
        project?.candidates.find(item => item.candidateId === configured?.candidateId) ??
        (project?.candidates.length === 1 ? project.candidates[0] : undefined));
    if (!candidate) {
      setSelectedCandidate("");
      setSelectedModule("");
      setSelectedVariant("");
      return;
    }
    if (candidate.candidateId !== selectedCandidate) setSelectedCandidate(candidate.candidateId);
    const module = candidate.modules.find(item => item.modulePath === configured?.modulePath) ?? candidate.modules[0];
    if (!module) {
      setSelectedModule("");
      setSelectedVariant("");
      return;
    }
    if (selectedModule !== module.modulePath && !candidate.modules.some(item => item.modulePath === selectedModule)) {
      setSelectedModule(module.modulePath);
      setSelectedVariant(
        module.variants.includes(configured?.variant ?? "") ? configured!.variant : (module.variants[0] ?? ""),
      );
      return;
    }
    const current = candidate.modules.find(item => item.modulePath === selectedModule) ?? module;
    if (!current.variants.includes(selectedVariant)) {
      setSelectedVariant(
        current.variants.includes(configured?.variant ?? "") ? configured!.variant : (current.variants[0] ?? ""),
      );
    }
  }, [project, selectedCandidate, selectedModule, selectedVariant]);

  if (state.status === "idle" || state.status === "loading") {
    return (
      <div className="android-panel is-loading">
        <p className="android-empty" aria-live="polite">
          Discovering the Android SDK and emulators…
        </p>
      </div>
    );
  }

  const announcement =
    service?.lastError ??
    runner?.issue ??
    state.error ??
    (run ? `Android app ${run.phase}` : build ? `Android build ${build.state}` : lifecycle);
  const selectedModuleSuggestion = selectedProjectCandidate?.modules.find(
    candidate => candidate.modulePath === selectedModule,
  );
  const configurationChanged =
    project?.configuration?.candidateId !== selectedCandidate ||
    project?.configuration?.modulePath !== selectedModule ||
    project?.configuration?.variant !== selectedVariant;
  const notices: Notice[] = [];
  const seenNotices = new Set<string>();
  const addNotice = (notice: Omit<Notice, "key">) => {
    const key = `${notice.tone}:${notice.title ?? ""}:${notice.body}`;
    if (!seenNotices.has(key)) {
      seenNotices.add(key);
      notices.push({ ...notice, key });
    }
  };
  if (!state.connected)
    addNotice({ tone: "danger", title: "Reconnecting", body: "Showing the last known state until it returns." });
  if (service?.lastError || state.error || runner?.issue)
    addNotice({
      tone: "danger",
      title: "Android Runner unavailable",
      body: service?.lastError ?? state.error ?? runner?.issue ?? "Android SDK discovery is unavailable.",
    });
  else if (runner?.discovery === "unavailable")
    addNotice({
      tone: "danger",
      title: "Android SDK discovery is unavailable",
      body: "Install it with Android Studio, then refresh.",
    });
  if (project?.issue) addNotice({ tone: "warning", title: "Project discovery", body: project.issue });
  if (selectedProjectCandidate?.issue)
    addNotice({ tone: "warning", title: selectedProjectCandidate.label, body: selectedProjectCandidate.issue });
  if (project?.trust.status === "untrusted")
    addNotice({
      tone: "warning",
      title: "Workspace not trusted",
      body: "Gradle, build logic and any Flutter SDK run with your permissions, and can read files and reach the network.",
    });
  if (project?.trust.status === "stale")
    addNotice({
      tone: "warning",
      title: "Build trust is stale",
      body: "The selected configuration or Gradle wrapper changed since you trusted it.",
    });
  if (run?.replacementInstall)
    addNotice({
      tone: "warning",
      title: "Replacement install",
      body: "App data is kept where Android allows it. Migrations may still change it.",
    });
  if (run?.installUncertain)
    addNotice({ tone: "warning", title: "Install interrupted", body: "The device may still have accepted the APK." });
  if (build?.issue) addNotice({ tone: "danger", title: "Build issue", body: build.issue });
  if (run?.issue) addNotice({ tone: "danger", title: "Run issue", body: run.issue });

  const saveConfiguration = () => {
    if (!sessionGeneration || !project) return;
    act(
      androidStore.saveRunConfiguration(
        sessionGeneration,
        project.configuration?.revision ?? 0,
        selectedCandidate,
        selectedModule,
        selectedVariant,
      ),
    );
  };
  const setTrust = (trusted: boolean) => {
    if (!sessionGeneration || !project?.configuration) return;
    act(
      androidStore.setWorkspaceTrust(
        sessionGeneration,
        project.configuration.revision,
        project.trust.revision,
        trusted,
      ),
    );
  };
  const buildOnly = () => {
    if (!sessionGeneration || !project?.configuration) return;
    act(androidStore.build(sessionGeneration, project.configuration.revision, project.trust.revision), () => appHeading.current);
  };
  const buildAndRun = () => {
    if (!sessionGeneration || !project?.configuration) return;
    const device = runner?.devices.find(candidate => candidate.deviceId === selectedDevice);
    if (!device) return;
    act(
      androidStore.buildAndRun(
        sessionGeneration,
        project.configuration.revision,
        project.trust.revision,
        device.deviceId,
        device.revision,
      ),
      () => appHeading.current,
    );
  };
  const canBuild = Boolean(
    state.connected &&
      !state.busy &&
      sessionGeneration &&
      project?.configuration &&
      project.trust.status === "trusted" &&
      !configurationChanged,
  );
  const canRun = canBuild && Boolean(selectedDevice);
  const actionReason = !state.connected
    ? "Waiting for the Android Runner connection."
    : !project || project.discovery !== "ready"
      ? "Select a ready workspace with a supported Android application."
      : !project.configuration
        ? "Choose and save a project, module and variant."
        : configurationChanged
          ? "Save the configuration first."
          : !selectedDevice
            ? "Launch or select a ready emulator first."
            : undefined;
  const bothDocked = dockedOutputs.build && dockedOutputs.logs;
  const splitStyle = (which: AndroidOutputKind): CSSProperties | undefined => {
    if (outputSplit === undefined || dockedOutputs.build || dockedOutputs.logs) return undefined;
    return { flex: `${which === "build" ? outputSplit : 1 - outputSplit} 1 0` };
  };
  const applySplit = (ratio: number) => {
    const height = outputsRef.current?.getBoundingClientRect().height ?? 0;
    const next = clampAndroidOutputSplit(ratio, height > 0 ? 34 / height : 0.1);
    setOutputSplit(next);
    rememberSetting(ANDROID_OUTPUT_SPLIT_KEY, next);
  };

  let action: ReactNode;
  if (cancellableOperation) {
    action = (
      <button
        type="button"
        className="secondary android-danger-button"
        disabled={!state.connected || state.busy === "cancelBuild" || build?.state === "cancelling"}
        onClick={() =>
          act(androidStore.cancelBuild(cancellableOperation.operationId, cancellableOperation.revision), () => appHeading.current)
        }>
        <IconPlayerStop size={13} /> Cancel build/run
      </button>
    );
  } else if (run?.phase === "running") {
    action = (
      <button
        type="button"
        className="secondary android-danger-button"
        disabled={busy}
        onClick={() => act(androidStore.stopApp(run.runId, run.revision), () => appHeading.current)}>
        <IconPlayerStop size={13} /> Stop app
      </button>
    );
  } else if (project?.configuration && project.trust.status !== "trusted") {
    action = (
      <button type="button" disabled={busy || operationActive} onClick={() => setTrust(true)}>
        <IconShield size={13} /> Trust this wrapper
      </button>
    );
  } else if (run?.installed && ["stopped", "cancelled", "failed"].includes(run.phase)) {
    action = (
      <>
        <button
          type="button"
          disabled={busy}
          onClick={() => act(androidStore.relaunchApp(run.runId, run.revision), () => appHeading.current)}>
          Relaunch
        </button>
        <button type="button" className="secondary" disabled={!canRun} onClick={buildAndRun}>
          Build &amp; Run
        </button>
      </>
    );
  } else {
    action = (
      <>
        <button type="button" disabled={!canRun} onClick={buildAndRun}>
          Build &amp; Run
        </button>
        <button type="button" className="secondary" disabled={!canBuild} onClick={buildOnly}>
          Build only
        </button>
      </>
    );
  }

  return (
    <div className={`android-panel${bothDocked ? " has-docked-output" : ""}`}>
      <div className="android-announcement" role="status" aria-live="polite" aria-atomic="true">
        {runner?.discovery === "refreshing"
          ? "Refreshing Android devices"
          : state.busy
            ? `Android ${state.busy} request accepted`
            : announcement || lifecycle}
      </div>
      <AndroidRibbon notices={notices} />
      {run && <AndroidPhaseRail run={run} build={build} />}

      <div className="android-config-body">
        <section aria-labelledby="android-device-heading">
          <div className="android-group-heading">
            <h3 id="android-device-heading" ref={deviceHeading} tabIndex={-1}>
              Device
            </h3>
            <span className="android-count">{runner?.devices.length ?? 0} running</span>
            <span className="android-spacer" />
            <span className="android-fact">
              SDK <b className={runner?.discovery === "ready" ? "is-success" : "is-danger"}>{runner?.discovery === "ready" ? "Ready" : (runner?.discovery ?? "Unavailable")}</b>
            </span>
            <span className="android-fact">
              <b>{runner?.avds.length ?? 0}</b> AVDs
            </span>
            <button
              type="button"
              className="icon-button"
              disabled={Boolean(state.busy)}
              onClick={() => act(androidStore.refresh())}
              aria-label="Refresh Android devices"
              title="Refresh Android devices">
              <IconRefresh className={runner?.discovery === "refreshing" ? "feedback-spinner" : undefined} size={13} />
            </button>
          </div>
          <div className="android-section-body">
            <div className="android-devices">
              {(runner?.devices ?? []).map(device => {
                const selectable = device.state === "ready" && !!device.serial;
                const selected = selectedDevice === device.deviceId;
                const cancellable =
                  device.ownership === "runner" && ["starting", "booting", "cancelled"].includes(device.state);
                const stoppable =
                  device.ownership === "runner" && ["ready", "cleanup-required"].includes(device.state);
                return (
                  <article key={device.deviceId} className={`android-device${selected ? " is-target" : ""}`}>
                    <button
                      type="button"
                      className="android-device-target"
                      disabled={!selectable || busy || runActive}
                      onClick={() => setSelectedDevice(device.deviceId)}
                      aria-pressed={selected}
                      title={selectable ? `Deploy to ${device.avd}` : undefined}>
                      <span className={`android-orb is-${device.state}`} />
                      <strong>{device.avd}</strong>
                      <span className="android-device-meta">
                        {device.serial ?? "Waiting for emulator identity"} · {device.ownership === "runner" ? "Pylon-owned" : "External"} · {device.state}
                      </span>
                    </button>
                    <span className="android-device-actions">
                      {selected && <span className="android-tag is-target">Deploy target</span>}
                      {cancellable ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={!state.connected || state.busy === "cancelOperation"}
                          onClick={() =>
                            act(androidStore.cancelOperation(device.deviceId, device.revision), () => deviceHeading.current)
                          }>
                          Cancel startup
                        </button>
                      ) : stoppable ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            act(androidStore.stopEmulator(device.deviceId, device.revision), () => deviceHeading.current)
                          }>
                          {device.state === "cleanup-required" ? "Retry cleanup" : "Stop emulator"}
                        </button>
                      ) : undefined}
                    </span>
                  </article>
                );
              })}
              {runner?.discovery === "ready" && !runner.devices.length && (
                <p className="android-empty">No running emulators.</p>
              )}
            </div>
            <label className="android-field">
              Existing AVD
              <span className="android-with-button">
                <select
                  value={selectedAvd}
                  disabled={busy || !runner?.avds.length}
                  onChange={event => setSelectedAvd(event.target.value)}>
                  {(runner?.avds ?? []).map(avd => (
                    <option key={avd} value={avd}>
                      {avd}
                    </option>
                  ))}
                  {!runner?.avds.length && <option value="">No AVDs configured</option>}
                </select>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || runner?.discovery !== "ready" || !selectedAvd}
                  onClick={() => act(androidStore.startEmulator(selectedAvd))}>
                  Launch emulator
                </button>
              </span>
            </label>
          </div>
        </section>

        <section aria-labelledby="android-app-heading">
          <div className="android-group-heading">
            <h3 id="android-app-heading" ref={appHeading} tabIndex={-1}>
              App
            </h3>
            <span className="android-spacer" />
            <span className="android-fact">
              Gradle <b className={project?.discovery === "ready" ? "is-success" : undefined}>{project?.discovery ?? "Not inspected"}</b>
            </span>
            <span className="android-fact">
              Tools <b>{run?.artifact ? "Ready" : "at run"}</b>
            </span>
            {sessionGeneration && (
              <button
                type="button"
                className="icon-button"
                disabled={busy}
                onClick={() => act(androidStore.refreshProject(sessionGeneration))}
                aria-label="Refresh Android project"
                title="Refresh Android project">
                <IconRefresh size={13} />
              </button>
            )}
          </div>
          <div className="android-section-body">
            <p className="android-workspace">
              {project
                ? `Selected workspace: ${project.workspaceLabel} · ${project.workspaceKind}`
                : workspaceLabel
                  ? `Selected workspace: ${workspaceLabel}`
                  : "Select a ready workspace to configure an app."}
            </p>
            {run?.artifact && (
              <p className="android-artifact">
                <b>{run.artifact.packageName}</b> · {run.artifact.versionName ?? run.artifact.versionCode} · {run.artifact.debuggable ? "debuggable" : "not debuggable"}
              </p>
            )}
            {project?.discovery === "ready" ? (
              <>
                <div className="android-fields">
                  <label className="android-field">
                    Project
                    <select
                      value={selectedCandidate}
                      disabled={busy || operationActive}
                      onChange={event => {
                        const candidateId = event.target.value;
                        const candidate = project.candidates.find(item => item.candidateId === candidateId);
                        const module = candidate?.modules[0];
                        setSelectedCandidate(candidateId);
                        setSelectedModule(module?.modulePath ?? "");
                        setSelectedVariant(module?.variants[0] ?? "");
                      }}>
                      {!selectedCandidate || project.candidates.length > 1 ? <option value="">Choose a project…</option> : undefined}
                      {project.candidates.map(candidate => (
                        <option key={candidate.candidateId} value={candidate.candidateId} disabled={candidate.discovery !== "ready"}>
                          {candidate.label} · {candidate.kind === "flutter" ? "Flutter" : "Android"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="android-duo">
                    <label className="android-field">
                      Application module
                      <select
                        value={selectedModule}
                        disabled={busy || operationActive || !selectedProjectCandidate}
                        onChange={event => {
                          const modulePath = event.target.value;
                          const module = selectedProjectCandidate?.modules.find(candidate => candidate.modulePath === modulePath);
                          setSelectedModule(modulePath);
                          setSelectedVariant(module?.variants[0] ?? "");
                        }}>
                        {(selectedProjectCandidate?.modules ?? []).map(module => (
                          <option key={module.modulePath} value={module.modulePath}>
                            {module.modulePath}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="android-field">
                      Variant
                      <select
                        value={selectedVariant}
                        disabled={busy || operationActive || !selectedModuleSuggestion}
                        onChange={event => setSelectedVariant(event.target.value)}>
                        {(selectedModuleSuggestion?.variants ?? []).map(variant => (
                          <option key={variant} value={variant}>
                            {variant}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {configurationChanged && selectedCandidate && selectedModule && selectedVariant && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || operationActive || !sessionGeneration}
                      onClick={saveConfiguration}>
                      <IconDeviceFloppy size={13} /> Save configuration
                    </button>
                  )}
                </div>
                <div className="android-trust">
                  <IconShield size={13} />
                  <span>
                    Build trust: <b>{project.trust.status}</b>
                  </span>
                  <span className="android-spacer" />
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || operationActive || !sessionGeneration || !project.configuration}
                    onClick={() => setTrust(project.trust.status !== "trusted")}>
                    {project.trust.status === "trusted" ? "Revoke build trust" : "Trust this wrapper"}
                  </button>
                </div>
              </>
            ) : (
              <p className="android-empty">
                {project?.discovery === "unsupported"
                  ? "No conventional Android application module was found."
                  : "Looking for a project…"}
              </p>
            )}
          </div>
        </section>
      </div>

      <div
        ref={outputsRef}
        className={`android-outputs${!build && !run ? " is-quiet" : ""}${outputSplit === undefined ? "" : " is-split"}${dockedOutputs.build || dockedOutputs.logs ? " has-docked" : ""}${bothDocked ? " all-docked" : ""}`}>
        <AndroidOutputSection
          which="build"
          build={build}
          run={run}
          busy={busy}
          focused={focusedOutput === "build"}
          docked={dockedOutputs.build}
          style={splitStyle("build")}
          onFocus={() => setFocusedOutput("build")}
          onDock={() => (dockedOutputs.build ? onRestoreOutput("build") : onDockOutput("build"))}
        />
        {(build || run) && !dockedOutputs.build && !dockedOutputs.logs && (
          <div
            className="android-output-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize build output against app logs"
            aria-valuemin={10}
            aria-valuemax={90}
            aria-valuenow={Math.round((outputSplit ?? (focusedOutput === "build" ? 0.75 : 0.25)) * 100)}
            tabIndex={0}
            onPointerDown={event => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              event.currentTarget.classList.add("is-dragging");
            }}
            onPointerMove={event => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId) || !outputsRef.current) return;
              const box = outputsRef.current.getBoundingClientRect();
              applySplit((event.clientY - box.top) / box.height);
            }}
            onPointerUp={event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              event.currentTarget.classList.remove("is-dragging");
            }}
            onPointerCancel={event => event.currentTarget.classList.remove("is-dragging")}
            onKeyDown={event => {
              const next = moveAndroidOutputSplit(
                outputSplit ?? (focusedOutput === "build" ? 0.75 : 0.25),
                event.key,
                event.shiftKey,
                outputsRef.current ? 34 / outputsRef.current.getBoundingClientRect().height : 0.1,
              );
              if (next === undefined) return;
              event.preventDefault();
              applySplit(next);
            }}
          />
        )}
        <AndroidOutputSection
          which="logs"
          build={build}
          run={run}
          busy={busy}
          focused={focusedOutput === "logs"}
          docked={dockedOutputs.logs}
          style={splitStyle("logs")}
          onFocus={() => setFocusedOutput("logs")}
          onDock={() => (dockedOutputs.logs ? onRestoreOutput("logs") : onDockOutput("logs"))}
        />
      </div>

      <div className={`android-action-bar${project?.configuration && project.trust.status !== "trusted" ? " is-gate" : ""}`}>
        {action}
        {!cancellableOperation && run?.phase !== "running" && actionReason && <p>{actionReason}</p>}
      </div>
    </div>
  );
}