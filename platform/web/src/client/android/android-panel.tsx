import { useEffect, useRef, useState } from "react";
import { androidProjectForGeneration, androidStore, useAndroidStore } from "./android-store";
import "./android-panel.css";

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

export function AndroidPanel({
  workspaceLabel,
  sessionGeneration,
}: {
  workspaceLabel?: string;
  sessionGeneration?: number;
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
  const deviceHeading = useRef<HTMLHeadingElement>(null);
  const appHeading = useRef<HTMLHeadingElement>(null);
  const logsHeading = useRef<HTMLHeadingElement>(null);
  const selectionProjectId = useRef<string | undefined>(undefined);
  const projectRefreshKey = sessionGeneration ? `${sessionGeneration}:${service?.serviceRevision ?? 0}` : "";
  const busy = Boolean(state.busy) || !state.connected;
  const buildActive = !!build && ["queued", "running", "cancelling"].includes(build.state);
  const runActive = !!run && ["building", "inspecting", "installing", "launching"].includes(run.phase);
  const operationActive = buildActive || runActive;
  const selectedProjectCandidate = project?.candidates.find(candidate => candidate.candidateId === selectedCandidate);
  const cancellableOperation = runActive && run ? run : buildActive && build ? build : undefined;
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

  const act = (operation: Promise<void>, focusAfter?: () => HTMLElement | null) => {
    void operation
      .catch(() => undefined)
      .finally(() => {
        if (!focusAfter) return;
        setTimeout(() => {
          const active = document.activeElement;
          if (!active || active === document.body || !document.contains(active)) focusAfter()?.focus();
        }, 0);
      });
  };

  if (state.status === "idle" || state.status === "loading") {
    return (
      <p className="android-empty" aria-live="polite">
        Discovering the Android SDK and emulators…
      </p>
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

  return (
    <div className="android-panel">
      <div className="android-announcement" role="status" aria-live="polite" aria-atomic="true">
        {runner?.discovery === "refreshing"
          ? "Refreshing Android devices"
          : state.busy
            ? `Android ${state.busy} request accepted`
            : announcement || lifecycle}
      </div>

      <section aria-labelledby="android-device-heading">
        <div className="android-section-heading">
          <h3 id="android-device-heading" ref={deviceHeading} tabIndex={-1}>
            Device
          </h3>
          <button
            type="button"
            className="secondary"
            disabled={Boolean(state.busy)}
            onClick={() => act(androidStore.refresh())}>
            Refresh
          </button>
        </div>

        {runner?.discovery === "unavailable" || state.status === "error" || state.error || service?.lastError ? (
          <p className="android-warning">
            {service?.lastError ?? state.error ?? runner?.issue ?? "Android SDK discovery is unavailable."}
          </p>
        ) : undefined}

        <label className="android-field">
          Existing AVD
          <select
            value={selectedAvd}
            disabled={busy || !runner?.avds.length}
            onChange={event => setSelectedAvd(event.target.value)}>
            {(runner?.avds ?? []).map(avd => (
              <option key={avd} value={avd}>
                {avd}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy || runner?.discovery !== "ready" || !selectedAvd}
          onClick={() => act(androidStore.startEmulator(selectedAvd))}>
          Launch emulator
        </button>

        <div className="android-devices">
          {(runner?.devices ?? []).map(device => {
            const cancellable =
              device.ownership === "runner" && ["starting", "booting", "cancelled"].includes(device.state);
            const stoppable = device.ownership === "runner" && ["ready", "cleanup-required"].includes(device.state);
            return (
              <article className="android-device" key={device.deviceId}>
                <div>
                  <strong>{device.avd}</strong>
                  <span>{device.ownership === "runner" ? "Pylon-owned" : "External"}</span>
                </div>
                <p>
                  {device.serial ?? "Waiting for emulator identity"} · {device.state}
                </p>
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
              </article>
            );
          })}
          {runner?.discovery === "ready" && !runner.devices.length ? (
            <p className="android-empty">No running emulators.</p>
          ) : undefined}
        </div>
      </section>

      <label className="android-field">
        Deployment emulator
        <select
          value={selectedDevice}
          disabled={busy || runActive}
          onChange={event => setSelectedDevice(event.target.value)}>
          {(runner?.devices ?? [])
            .filter(device => device.state === "ready" && !!device.serial)
            .map(device => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.avd} · {device.ownership === "runner" ? "Pylon-owned" : "External"}
              </option>
            ))}
        </select>
      </label>

      <section aria-labelledby="android-app-heading">
        <div className="android-section-heading">
          <h3 id="android-app-heading" ref={appHeading} tabIndex={-1}>
            App
          </h3>
          {sessionGeneration ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => act(androidStore.refreshProject(sessionGeneration))}>
              Refresh project
            </button>
          ) : undefined}
        </div>
        <p>
          {project
            ? `Selected workspace: ${project.workspaceLabel}`
            : workspaceLabel
              ? `Selected workspace: ${workspaceLabel}`
              : "Select a ready workspace to configure an app."}
        </p>
        {project?.issue ? <p className="android-warning">{project.issue}</p> : undefined}
        {project?.discovery === "ready" ? (
          <>
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
                {!selectedCandidate || project.candidates.length > 1 ? (
                  <option value="">Choose a project…</option>
                ) : undefined}
                {project.candidates.map(candidate => (
                  <option
                    key={candidate.candidateId}
                    value={candidate.candidateId}
                    disabled={candidate.discovery !== "ready"}>
                    {candidate.label} · {candidate.kind === "flutter" ? "Flutter" : "Android"}
                  </option>
                ))}
              </select>
            </label>
            {selectedProjectCandidate?.issue ? (
              <p className="android-warning">{selectedProjectCandidate.issue}</p>
            ) : undefined}
            <label className="android-field">
              Application module
              <select
                value={selectedModule}
                disabled={busy || operationActive || !selectedProjectCandidate}
                onChange={event => {
                  const modulePath = event.target.value;
                  const module = selectedProjectCandidate?.modules.find(
                    candidate => candidate.modulePath === modulePath,
                  );
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
            <button
              type="button"
              className="secondary"
              disabled={
                busy ||
                operationActive ||
                !sessionGeneration ||
                !selectedCandidate ||
                !selectedModule ||
                !selectedVariant ||
                !configurationChanged
              }
              onClick={() =>
                act(
                  androidStore.saveRunConfiguration(
                    sessionGeneration!,
                    project.configuration?.revision ?? 0,
                    selectedCandidate,
                    selectedModule,
                    selectedVariant,
                  ),
                )
              }>
              Save configuration
            </button>

            <p className="android-trust-warning">
              Gradle, repository build logic, and any configured Flutter SDK run with your user permissions and may
              access files and the network.
            </p>
            <div className="android-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy || operationActive || !sessionGeneration || !project.configuration}
                onClick={() =>
                  act(
                    androidStore.setWorkspaceTrust(
                      sessionGeneration!,
                      project.configuration!.revision,
                      project.trust.revision,
                      project.trust.status !== "trusted",
                    ),
                  )
                }>
                {project.trust.status === "trusted" ? "Revoke build trust" : "Trust this wrapper"}
              </button>
              <span>Trust: {project.trust.status}</span>
            </div>
            {!buildActive && !runActive ? (
              <div className="android-actions">
                <button
                  type="button"
                  disabled={
                    busy ||
                    !sessionGeneration ||
                    !project.configuration ||
                    project.trust.status !== "trusted" ||
                    configurationChanged ||
                    !selectedDevice
                  }
                  onClick={() => {
                    const device = runner?.devices.find(candidate => candidate.deviceId === selectedDevice);
                    if (device)
                      act(
                        androidStore.buildAndRun(
                          sessionGeneration!,
                          project.configuration!.revision,
                          project.trust.revision,
                          device.deviceId,
                          device.revision,
                        ),
                        () => appHeading.current,
                      );
                  }}>
                  Build & Run
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={
                    busy ||
                    !sessionGeneration ||
                    !project.configuration ||
                    project.trust.status !== "trusted" ||
                    configurationChanged
                  }
                  onClick={() =>
                    act(
                      androidStore.build(sessionGeneration!, project.configuration!.revision, project.trust.revision),
                      () => appHeading.current,
                    )
                  }>
                  Build only
                </button>
              </div>
            ) : undefined}
          </>
        ) : (
          <p className="android-muted">
            Static discovery supports conventional, explicitly included Android application modules.
          </p>
        )}
        {cancellableOperation ? (
          <button
            type="button"
            disabled={!state.connected || state.busy === "cancelBuild" || build?.state === "cancelling"}
            onClick={() =>
              act(
                androidStore.cancelBuild(cancellableOperation.operationId, cancellableOperation.revision),
                () => appHeading.current,
              )
            }>
            Cancel build/run
          </button>
        ) : undefined}
        {run ? (
          <article className="android-device">
            <p>
              {run.workspaceLabel} · {run.avd} · {run.phase}
            </p>
            {run.artifact ? (
              <p>
                {run.artifact.packageName} · version {run.artifact.versionName ?? run.artifact.versionCode} ·{" "}
                {run.artifact.debuggable ? "debuggable" : "not debuggable"}
              </p>
            ) : undefined}
            {run.replacementInstall ? (
              <p className="android-warning">
                Replacement install preserves app data when Android permits it, but application migrations may still
                change stored data.
              </p>
            ) : undefined}
            {run.installUncertain ? (
              <p className="android-warning">Installation was interrupted; the device may have accepted the APK.</p>
            ) : undefined}
            {run.issue ? <p className="android-warning">{run.issue}</p> : undefined}
            <div className="android-actions">
              {run.phase === "running" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(androidStore.stopApp(run.runId, run.revision), () => appHeading.current)}>
                  Stop app
                </button>
              ) : undefined}
              {run.installed && ["stopped", "cancelled", "failed"].includes(run.phase) ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(androidStore.relaunchApp(run.runId, run.revision), () => appHeading.current)}>
                  Relaunch
                </button>
              ) : undefined}
            </div>
          </article>
        ) : undefined}
      </section>

      <section aria-labelledby="android-output-heading">
        <h3 id="android-output-heading">Build output</h3>
        {build ? (
          <>
            <p>
              {build.workspaceLabel} · {build.modulePath} · {build.variant} · {build.state}
            </p>
            {build.issue ? <p className="android-warning">{build.issue}</p> : undefined}
            <pre className="android-build-output" tabIndex={0} aria-label="Bounded Gradle build output">
              {build.output || "No build output."}
            </pre>
            {build.outputTruncated ? <p className="android-warning">Build output was truncated.</p> : undefined}
          </>
        ) : (
          <p className="android-empty">No build has run in this host.</p>
        )}
      </section>

      <section aria-labelledby="android-logs-heading">
        <div className="android-section-heading">
          <h3 id="android-logs-heading" ref={logsHeading} tabIndex={-1}>
            App logs
          </h3>
          {run ? (
            <div className="android-actions">
              {run.logs.state === "running" || run.logs.state === "starting" ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => act(androidStore.stopLogs(run.runId, run.revision), () => logsHeading.current)}>
                  Stop logs
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || run.phase !== "running"}
                  onClick={() => act(androidStore.startLogs(run.runId, run.revision), () => logsHeading.current)}>
                  Start logs
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={busy || !run.logs.output}
                onClick={() => act(androidStore.clearRetainedOutput(run.runId, run.revision))}>
                Clear retained logs
              </button>
            </div>
          ) : undefined}
        </div>
        <p className="android-trust-warning">
          App logs stay in local bounded memory but may contain secrets. Clearing here does not clear device Logcat.
        </p>
        {run ? (
          <>
            <pre className="android-build-output" tabIndex={0} aria-label="Bounded package-scoped Logcat output">
              {run.logs.output || "No retained app logs."}
            </pre>
            {run.logs.outputTruncated ? <p className="android-warning">App logs were truncated.</p> : undefined}
            {run.logs.issue ? <p className="android-warning">{run.logs.issue}</p> : undefined}
          </>
        ) : (
          <p className="android-empty">Run an app to collect package-scoped logs.</p>
        )}
      </section>
      <section aria-labelledby="android-setup-heading">
        <h3 id="android-setup-heading">Setup</h3>
        <dl className="android-setup">
          <div>
            <dt>SDK tools</dt>
            <dd>{runner?.discovery === "ready" ? "Ready" : (runner?.discovery ?? "Unavailable")}</dd>
          </div>
          <div>
            <dt>Gradle project</dt>
            <dd>{project?.discovery ?? "Not inspected"}</dd>
          </div>
          <div>
            <dt>Build Tools</dt>
            <dd>{run?.artifact ? "Ready" : "Checked at Build & Run"}</dd>
          </div>
          <div>
            <dt>Configured AVDs</dt>
            <dd>{runner?.avds.length ?? 0}</dd>
          </div>
          <div>
            <dt>Event connection</dt>
            <dd>{state.connected ? "Connected" : "Reconnecting"}</dd>
          </div>
        </dl>
        <p className="android-muted">
          Create and configure AVDs with Android Studio or the Android SDK tools before using Pylon.
        </p>
      </section>
    </div>
  );
}
