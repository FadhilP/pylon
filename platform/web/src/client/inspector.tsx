import {
  IconActivityHeartbeat,
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconDatabase,
  IconFile,
  IconGitBranch,
  IconGitFork,
  IconListCheck,
  IconLoader2,
  IconSearch,
  IconRestore,
  IconRefresh,
  IconTimeline,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import DOMPurify from "dompurify";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { formatCacheHitRate, formatCompactNumber, formatWorkDuration } from "../shared/format";
import {
  DEFAULT_GUARD_RULES,
  GUARD_ACTIONS,
  GUARD_RISK_CATEGORIES,
  GUARD_RULE_DESCRIPTIONS,
  GUARD_RULE_LABELS,
  mergeGuardRules,
  resolveGuardRule,
  type GuardAction,
  type GuardRuleOverrides,
} from "../shared/guard-policy";
import { highlightSource } from "../shared/markdown";
import type {
  ContinuityMemoryNoteReadModel,
  JobReadModel,
  SessionMetricsReadModel,
  VerificationReadModel,
} from "../shared/protocol/events";
import type {
  DialogTimeoutSeconds,
  PapercutListPage,
  PapercutRecordReadModel,
  PapercutStatusReadModel,
  StateQLRowsPage,
  StateQLSnapshot,
  TimelineCheckpointDiff,
  TimelineCheckpointFiles,
  ToolExposureMode,
  VerifyPolicyReadModel,
  WorkspacePolicyMode,
} from "../shared/protocol/snapshots";
import {
  LedBar,
  OverviewOrb,
  OverviewStateLabel,
  useResponsiveUsageLedCells,
  type OverviewState,
} from "./overview-primitives";
import { displayTime, displayTimelineTime, formatDuration } from "./format";
import { ActionDialog } from "./action-dialog";
import { RuntimePolicyTimeoutControl } from "./runtime-policy-timeout";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";
import type { ReferenceId } from "./navigation";
import {
  buildStateQLActivity,
  filterStateQLActivity,
  selectStateQLActivity,
  stateqlActivityStatus,
  type StateQLActivityItem,
  type StateQLActivityTag,
  type StateQLActivityTone,
} from "../shared/stateql-notebook";

/** The session-scoped reference views. The rail owns choosing between them. */
export type ViewId = Extract<ReferenceId, "overview" | "policy" | "timeline" | "memory" | "tools">;
type Tone = "success" | "warning" | "danger" | "neutral" | "active";
const PierreCodeViewer = lazy(() => import("./pierre-code-viewer"));

interface SessionReferenceProps {
  view: ViewId;
  live: RuntimeStoreSnapshot;
  timelineEnabled: boolean;
  memoryReviewerConfigured?: boolean;
  memoryEnabled: boolean;
  papercutEnabled: boolean;
  onOpenGlobalPolicy: () => void;
  onOpenMemoryReviewerSettings: () => void;
}

/**
 * One session reference view, with no chrome of its own. The panel header,
 * the description and the choice of view all belong to the rail that opened
 * it — this renders only the body.
 */
export function SessionReference({
  view,
  live,
  timelineEnabled,
  memoryReviewerConfigured,
  memoryEnabled,
  papercutEnabled,
  onOpenGlobalPolicy,
  onOpenMemoryReviewerSettings,
}: SessionReferenceProps) {
  switch (view) {
    case "overview":
      return <Overview live={live} />;
    case "policy":
      return live.runtime ? <RuntimePolicy live={live} onOpenGlobalPolicy={onOpenGlobalPolicy} /> : null;
    case "timeline":
      return <Timeline live={live} enabled={timelineEnabled} />;
    case "memory":
      return (
        <Memory
          live={live}
          memoryEnabled={memoryEnabled}
          papercutEnabled={papercutEnabled}
          reviewerConfigured={memoryReviewerConfigured}
          onOpenReviewerSettings={onOpenMemoryReviewerSettings}
        />
      );
    case "tools":
      return <Tools live={live} />;
  }
}

function Overview({ live }: { live: RuntimeStoreSnapshot }) {
  const runtime = live.runtime;
  const operational = runtime?.operational;
  const work = operational?.continuity.work;
  const completedTodos = work?.todos.filter(todo => todo.status === "done").length ?? 0;
  const progress = work?.todos.length ? (completedTodos / work.todos.length) * 100 : 0;
  const workState: OverviewState =
    work?.mode === "executing"
      ? "running"
      : work?.mode === "completed"
        ? "done"
        : work?.mode === "cancelled"
          ? "failed"
          : work
            ? "attention"
            : "neutral";
  return (
    <div className="page-grid">
      <SessionUsage key={runtime?.sessionId ?? "empty"} metrics={runtime?.metrics} />
      <div className="overview-columns">
        {operational?.continuity.availability === "available" && (
          <InspectorSection
            title="Task list"
            meta={work ? `updated ${displayTime(work.updatedAt)}` : undefined}
            className="run-panel">
            {work ? (
              <>
                <div className="overview-run-goal">
                  <h2 title={work.goal}>{oneLine(work.goal)}</h2>
                  <p className="mono">{work.runId || "Current turn"}</p>
                </div>
                <div className="overview-run-status">
                  <OverviewStateLabel state={workState}>{work.mode}</OverviewStateLabel>
                  {/* <LedBar a={progress} responsive tone={workState} running={workState === "running"} label={`${completedTodos} of ${work.todos.length} tasks complete`} /> */}
                  <small>
                    {completedTodos} of {work.todos.length}
                  </small>
                </div>
                {work.latestFailure && (
                  <div className="overview-run-callout" role="alert">
                    <OverviewOrb state="failed" label="Latest failure" />
                    <div>
                      <strong>Latest failure</strong>
                      <span>{work.latestFailure}</span>
                    </div>
                  </div>
                )}
                {work.nextAction && (
                  <div className="overview-run-callout" role="status">
                    <OverviewOrb state="attention" label="Next up" />
                    <div>
                      <strong>Next up</strong>
                      <span>{work.nextAction}</span>
                    </div>
                  </div>
                )}
                <TodoList work={work} />
              </>
            ) : (
              <div className="empty-state">
                <IconListCheck size={20} />
                <strong>No active work</strong>
                <span>Continuity has no plan for this session.</span>
              </div>
            )}
          </InspectorSection>
        )}
      </div>
      <div className="overview-lower">
        {operational && (
          <InspectorSection
            title="Verification"
            meta={operational.verification.scope ? `${operational.verification.scope} scope` : "No run"}
            indicator={verificationSummary(operational.verification)}
            className="verification-panel">
            <Verification verification={operational.verification} />
          </InspectorSection>
        )}
        {operational?.jobs.availability === "available" && <HeartbeatJobs jobs={operational.jobs.items} />}
      </div>
    </div>
  );
}

function verificationSummary(verification: VerificationReadModel): { state: OverviewState; label: string } | undefined {
  const passed = verification.checks.filter(check => check.status === "passed").length;
  const failed = verification.checks.length - passed;
  switch (verification.state) {
    case "running":
      return { state: "running", label: "Running" };
    case "passed":
      return { state: "done", label: "Passed" };
    case "failed":
      return passed > 0 && failed > 0 ? { state: "attention", label: "Partial" } : { state: "failed", label: "Failed" };
    case "stale":
      return failed > 0 ? { state: "failed", label: "Failed" } : { state: "attention", label: "Stale" };
    case "cancelled":
      return { state: "attention", label: "Cancelled" };
    case "error":
      return { state: "failed", label: "Error" };
    case "clean":
      return { state: "neutral", label: "Clean" };
    case "no_checks":
      return { state: "neutral", label: "No checks" };
    default:
      return undefined;
  }
}

function Verification({ verification }: { verification: VerificationReadModel }) {
  if (verification.availability !== "available") {
    return (
      <div className="empty-state">
        <IconCheck size={20} />
        <strong>Verification unavailable</strong>
        <span>Verify is unavailable for this runtime.</span>
      </div>
    );
  }

  return (
    <div className="overview-list">
      {verification.checks.map(check => {
        const state: OverviewState =
          check.status === "running" ? "running" : check.status === "passed" ? "done" : "failed";
        return (
          <div className="overview-list-row" key={check.id}>
            <OverviewOrb state={state} label={check.status} />
            <div>
              <strong>{check.label}</strong>
              <small className="mono">{check.command || check.status}</small>
            </div>
            <OverviewStateLabel state={state}>{check.status}</OverviewStateLabel>
            <time className="mono">{formatDuration(check.durationMs)}</time>
          </div>
        );
      })}
      {verification.checks.length === 0 && (
        <div className="empty-state">
          <IconCheck size={20} />
          <strong>No verification checks</strong>
          <span>{verification.message || "Results will appear after Verify runs."}</span>
        </div>
      )}
    </div>
  );
}

type EditablePolicyScope = "project" | "session";
type TogglePolicyDraft = "inherit" | "enabled" | "disabled";
type TimeoutPolicyDraft = DialogTimeoutSeconds | "inherit";

const workspaceLabels: Record<WorkspacePolicyMode, string> = {
  local: "Local",
  checkout: "Project folder",
  worktree: "Session worktree",
};

function verifyPolicyLabel(value: VerifyPolicyReadModel): string {
  return value.mode === "auto"
    ? "Automatic detection"
    : `${value.checks.length} selected check${value.checks.length === 1 ? "" : "s"}`;
}

function togglePolicyLabel(value: boolean): string {
  return value ? "Enabled" : "Disabled";
}

function guardActionLabel(value: GuardAction): string {
  return value === "allow" ? "Allow" : value === "confirm" ? "Confirm" : "Block";
}

function RuntimePolicy({ live, onOpenGlobalPolicy }: { live: RuntimeStoreSnapshot; onOpenGlobalPolicy: () => void }) {
  const runtime = live.runtime!;
  const policy = runtime.runtimePolicy;
  const [scope, setScope] = useState<EditablePolicyScope>("project");
  const [verify, setVerify] = useState<VerifyPolicyReadModel | "inherit">({ mode: "auto" });
  const [timeline, setTimeline] = useState<TogglePolicyDraft>("inherit");
  const [guard, setGuard] = useState<TogglePolicyDraft>("inherit");
  const [guardRules, setGuardRules] = useState<GuardRuleOverrides>({});
  const [workspace, setWorkspace] = useState<WorkspacePolicyMode | "inherit">("inherit");
  const [guardTimeout, setGuardTimeout] = useState<TimeoutPolicyDraft>("inherit");
  const [clarifyTimeout, setClarifyTimeout] = useState<TimeoutPolicyDraft>("inherit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saveInFlight = useRef(false);
  const saveRequest = useRef(0);

  const resetDraft = () => {
    setVerify(scope === "project" ? policy.project.verify : (policy.session.verify ?? "inherit"));
    setTimeline(
      scope === "project"
        ? policy.project.timelineEnabled === undefined
          ? "inherit"
          : policy.project.timelineEnabled
            ? "enabled"
            : "disabled"
        : policy.session.timelineEnabled === undefined
          ? "inherit"
          : policy.session.timelineEnabled
            ? "enabled"
            : "disabled",
    );
    setGuard(
      scope === "project"
        ? policy.project.guardEnabled === undefined
          ? "inherit"
          : policy.project.guardEnabled
            ? "enabled"
            : "disabled"
        : policy.session.guardEnabled === undefined
          ? "inherit"
          : policy.session.guardEnabled
            ? "enabled"
            : "disabled",
    );
    setGuardRules({ ...(scope === "project" ? policy.project.guardRules : policy.session.guardRules) });
    setWorkspace(
      scope === "project" ? (policy.project.workspace ?? "inherit") : (policy.session.workspace ?? "inherit"),
    );
    setGuardTimeout(
      scope === "project"
        ? policy.project.guardTimeoutSeconds === undefined
          ? "inherit"
          : policy.project.guardTimeoutSeconds
        : policy.session.guardTimeoutSeconds === undefined
          ? "inherit"
          : policy.session.guardTimeoutSeconds,
    );
    setClarifyTimeout(
      scope === "project"
        ? policy.project.clarifyTimeoutSeconds === undefined
          ? "inherit"
          : policy.project.clarifyTimeoutSeconds
        : policy.session.clarifyTimeoutSeconds === undefined
          ? "inherit"
          : policy.session.clarifyTimeoutSeconds,
    );
    setError("");
  };

  useEffect(() => {
    resetDraft();
  }, [policy.revision, scope]);

  const idle = live.connection === "connected" && runtime.ready && !live.pendingUi && !busy;
  const inheritedFrom = scope === "project" ? "Global" : "Project";
  const inheritedTimeline =
    scope === "project"
      ? policy.global.timelineEnabled
      : (policy.project.timelineEnabled ?? policy.global.timelineEnabled);
  const inheritedGuard =
    scope === "project" ? policy.global.guardEnabled : (policy.project.guardEnabled ?? policy.global.guardEnabled);
  const draftGuardEnabled = guard === "inherit" ? inheritedGuard : guard === "enabled";
  const globalGuardRules = policy.global.guardRules ?? DEFAULT_GUARD_RULES;
  const inheritedGuardRules =
    scope === "project"
      ? mergeGuardRules(globalGuardRules)
      : mergeGuardRules(globalGuardRules, policy.project.guardRules ?? {});
  const inheritedWorkspace =
    scope === "project" ? policy.global.workspace : (policy.project.workspace ?? policy.global.workspace);
  const inheritedGuardTimeout =
    scope === "project"
      ? policy.global.guardTimeoutSeconds
      : (policy.project.guardTimeoutSeconds ?? policy.global.guardTimeoutSeconds);
  const inheritedClarifyTimeout =
    scope === "project"
      ? policy.global.clarifyTimeoutSeconds
      : (policy.project.clarifyTimeoutSeconds ?? policy.global.clarifyTimeoutSeconds);
  const displayedVerify = verify === "inherit" ? policy.project.verify : verify;
  const checks = displayedVerify.mode === "selected" ? displayedVerify.checks : [];

  const save = async (
    nextVerify: VerifyPolicyReadModel | "inherit",
    nextTimeline: TogglePolicyDraft,
    nextWorkspace: WorkspacePolicyMode | "inherit" = workspace,
    nextGuardTimeout: TimeoutPolicyDraft = guardTimeout,
    nextClarifyTimeout: TimeoutPolicyDraft = clarifyTimeout,
    nextGuard: TogglePolicyDraft = guard,
    nextGuardRules: GuardRuleOverrides = guardRules,
  ) => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    const request = ++saveRequest.current;
    setVerify(nextVerify);
    setTimeline(nextTimeline);
    setGuard(nextGuard);
    setGuardRules(nextGuardRules);
    setWorkspace(nextWorkspace);
    setGuardTimeout(nextGuardTimeout);
    setClarifyTimeout(nextClarifyTimeout);
    setBusy(true);
    setError("");
    try {
      await runtimeStore.updateRuntimePolicy(
        scope,
        nextVerify,
        nextTimeline === "inherit" ? "inherit" : nextTimeline === "enabled",
        nextGuard === "inherit" ? "inherit" : nextGuard === "enabled",
        nextWorkspace,
        nextGuardTimeout,
        nextClarifyTimeout,
        policy.revision,
        nextGuardRules,
      );
    } catch (cause) {
      if (request === saveRequest.current) {
        resetDraft();
        setError(cause instanceof Error ? cause.message : "Policy could not be saved");
      }
      throw cause;
    } finally {
      if (request === saveRequest.current) {
        saveInFlight.current = false;
        setBusy(false);
      }
    }
  };

  const changeVerifyMode = (mode: "inherit" | "auto" | "selected") => {
    const next =
      mode === "inherit"
        ? ("inherit" as const)
        : mode === "auto"
          ? ({ mode: "auto" } as const)
          : ({
              mode: "selected",
              checks:
                displayedVerify.mode === "selected"
                  ? displayedVerify.checks
                  : policy.availableVerifyChecks.slice(0, 6).map(check => check.id),
            } as const);
    void save(next, timeline, workspace).catch(() => undefined);
  };

  const toggleCheck = (id: string) => {
    const next = checks.includes(id)
      ? checks.filter(item => item !== id)
      : checks.length < 6
        ? [...checks, id]
        : checks;
    if (next === checks) return;
    void save({ mode: "selected", checks: next }, timeline, workspace).catch(() => undefined);
  };
  const verifySetHere = scope === "project" ? verify !== "inherit" && verify.mode === "selected" : verify !== "inherit";
  const setHereCount = [
    verifySetHere,
    guard !== "inherit",
    timeline !== "inherit",
    workspace !== "inherit",
    guardTimeout !== "inherit",
    clarifyTimeout !== "inherit",
  ].filter(Boolean).length;

  return (
    <div className="runtime-policy">
      <div className="policy-toolbar">
        <div className="policy-scope" role="tablist" aria-label="Policy scope">
          <button
            type="button"
            role="tab"
            disabled={busy}
            aria-selected={scope === "project"}
            className={scope === "project" ? "is-active" : ""}
            onClick={() => setScope("project")}>
            Project
          </button>
          <button
            type="button"
            role="tab"
            disabled={busy}
            aria-selected={scope === "session"}
            className={scope === "session" ? "is-active" : ""}
            onClick={() => setScope("session")}>
            This session
          </button>
        </div>
        <span className="policy-set-count">{setHereCount} of 6 set here</span>
        <button className="policy-global-link" type="button" disabled={busy} onClick={onOpenGlobalPolicy}>
          Global defaults <span aria-hidden="true">›</span>
        </button>
      </div>

      <InspectorSection
        title="Verification"
        meta={
          displayedVerify.mode === "selected"
            ? `${checks.length} of ${policy.availableVerifyChecks.length} checks`
            : "automatic detection"
        }
        className="policy-section">
        <PolicySelectField
          label="Verify checks"
          description="Choose automatic detection or up to six declared checks."
          value={verify === "inherit" ? "inherit" : verify.mode}
          isOverride={verifySetHere}
          inheritedLabel={
            scope === "session" ? `Inherit from Project (${verifyPolicyLabel(policy.project.verify)})` : ""
          }
          disabled={!idle}
          options={[
            { value: "auto", label: "Automatic detection" },
            { value: "selected", label: "Selected checks" },
          ]}
          onChange={value => changeVerifyMode(value as "inherit" | "auto" | "selected")}
        />
        {verify !== "inherit" && verify.mode === "selected" && (
          <details className="policy-disclosure">
            <summary>
              <span>
                <strong>Declared checks</strong>
                <small>Detected from this project's scripts.</small>
              </span>
              <small>
                {checks.length} of {policy.availableVerifyChecks.length}
              </small>
              <IconChevronDown size={15} />
            </summary>
            <div className="policy-disclosure-body policy-checks">
              {policy.availableVerifyChecks.map(check => (
                <label key={check.id} title={check.command}>
                  <input
                    type="checkbox"
                    checked={checks.includes(check.id)}
                    disabled={!idle || (!checks.includes(check.id) && checks.length >= 6)}
                    onChange={() => toggleCheck(check.id)}
                  />
                  <span className="mono">{check.label}</span>
                </label>
              ))}
              {checks
                .filter(id => !policy.availableVerifyChecks.some(check => check.id === id))
                .map(id => (
                  <label className="is-missing" key={id}>
                    <input type="checkbox" checked disabled={!idle} onChange={() => toggleCheck(id)} />
                    <span>Unknown: {id}</span>
                  </label>
                ))}
              {policy.availableVerifyChecks.length === 0 && (
                <small>No declared checks detected. Changed-set hygiene will still run.</small>
              )}
            </div>
          </details>
        )}
      </InspectorSection>

      <InspectorSection
        title="Safety and interaction"
        meta={`${Object.keys(guardRules).length} category override${Object.keys(guardRules).length === 1 ? "" : "s"}`}
        className="policy-section">
        <PolicySelectField
          label="Guard"
          description="Confirm guarded commands and paths."
          value={guard}
          inheritedLabel={`Inherit from ${inheritedFrom} (${togglePolicyLabel(inheritedGuard)})`}
          disabled={!idle}
          options={[
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
          ]}
          onChange={value =>
            void save(verify, timeline, workspace, guardTimeout, clarifyTimeout, value as TogglePolicyDraft).catch(
              () => undefined,
            )
          }
        />
        <details className="policy-disclosure">
          <summary>
            <span>
              <strong>Guard categories</strong>
              <small>Choose which risks inherit, allow, confirm, or block.</small>
            </span>
            <small className={Object.keys(guardRules).length ? "is-here" : ""}>
              {Object.keys(guardRules).length} set here
            </small>
            <IconChevronDown size={15} />
          </summary>
          <div className="policy-disclosure-body">
            {!draftGuardEnabled && (
              <p className="policy-guard-disabled" role="status">
                Guard is disabled by {guard === "inherit" ? `${inheritedFrom} policy` : "this scope"}. Saved category
                rules apply when Guard is enabled.
              </p>
            )}
            {GUARD_RISK_CATEGORIES.map(category => (
              <PolicySelectField
                key={category}
                label={GUARD_RULE_LABELS[category]}
                description={GUARD_RULE_DESCRIPTIONS[category]}
                value={guardRules[category] ?? "inherit"}
                inheritedLabel={`Use ${inheritedFrom} policy (${guardActionLabel(inheritedGuardRules[category])})`}
                disabled={!idle || !draftGuardEnabled}
                options={GUARD_ACTIONS.map(action => ({ value: action, label: guardActionLabel(action) }))}
                onChange={value => {
                  const next = { ...guardRules };
                  if (value === "inherit") delete next[category];
                  else next[category] = value as GuardAction;
                  void save(verify, timeline, workspace, guardTimeout, clarifyTimeout, guard, next).catch(
                    () => undefined,
                  );
                }}
              />
            ))}
          </div>
        </details>
        <RuntimePolicyTimeoutControl
          label="Guard timeout"
          description="How long a guarded prompt waits for you."
          value={guardTimeout === "inherit" ? inheritedGuardTimeout : guardTimeout}
          inherited={guardTimeout === "inherit"}
          inheritedFrom={inheritedFrom}
          disabled={!idle || !draftGuardEnabled}
          onChange={value => void save(verify, timeline, workspace, value, clarifyTimeout).catch(() => undefined)}
          onReset={
            guardTimeout !== "inherit"
              ? () => void save(verify, timeline, workspace, "inherit", clarifyTimeout).catch(() => undefined)
              : undefined
          }
        />
        <RuntimePolicyTimeoutControl
          label="Clarify timeout"
          description="How long a clarifying question waits."
          value={clarifyTimeout === "inherit" ? inheritedClarifyTimeout : clarifyTimeout}
          inherited={clarifyTimeout === "inherit"}
          inheritedFrom={inheritedFrom}
          disabled={!idle}
          onChange={value => void save(verify, timeline, workspace, guardTimeout, value).catch(() => undefined)}
          onReset={
            clarifyTimeout !== "inherit"
              ? () => void save(verify, timeline, workspace, guardTimeout, "inherit").catch(() => undefined)
              : undefined
          }
        />
        <PolicySelectField
          label="Timeline"
          description="Keep recoverable checkpoints for this run."
          value={timeline}
          inheritedLabel={`Inherit from ${inheritedFrom} (${togglePolicyLabel(inheritedTimeline)})`}
          disabled={!idle}
          options={[
            { value: "enabled", label: "Enabled" },
            { value: "disabled", label: "Disabled" },
          ]}
          onChange={value => void save(verify, value as TogglePolicyDraft, workspace).catch(() => undefined)}
        />
      </InspectorSection>

      <InspectorSection
        title="Environment"
        meta={workspace === "inherit" ? workspaceLabels[inheritedWorkspace] : workspaceLabels[workspace]}
        className="policy-section">
        <PolicySelectField
          label="Workspace"
          description="Choose where this scope works by default."
          value={workspace}
          inheritedLabel={`Inherit from ${inheritedFrom} (${workspaceLabels[inheritedWorkspace]})`}
          disabled={!idle}
          options={Object.entries(workspaceLabels).map(([value, label]) => ({ value, label }))}
          onChange={value =>
            void save(verify, timeline, value as WorkspacePolicyMode | "inherit").catch(() => undefined)
          }
        />
        <p className="policy-note">
          Session changes apply immediately when possible. Package capability and safety gates remain authoritative.
        </p>
      </InspectorSection>
      {error && (
        <p className="policy-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <small className="policy-saving" role="status">
          Saving…
        </small>
      )}
    </div>
  );
}

function PolicySelectField({
  label,
  description,
  value,
  inheritedLabel,
  stateLabel,
  isOverride = value !== "inherit",
  disabled,
  options,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  inheritedLabel: string;
  stateLabel?: string;
  isOverride?: boolean;
  disabled: boolean;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const descriptionId = useId();
  const stateId = useId();
  return (
    <div className="policy-field" data-override={isOverride}>
      <OverviewOrb state={isOverride ? "done" : "neutral"} label={isOverride ? "Set here" : "Inherited or default"} />
      <div className="policy-field-copy">
        <span>
          <strong>{label}</strong>
          <small className={isOverride ? "policy-source is-here" : "policy-source"}>
            {isOverride ? "set here" : inheritedLabel ? inheritedLabel.replace(/^.*from /, "from ") : "default"}
          </small>
        </span>
        <p id={descriptionId}>{description}</p>
      </div>
      <select
        value={value}
        disabled={disabled}
        aria-label={`${label} policy`}
        aria-describedby={descriptionId}
        onChange={event => onChange(event.target.value)}>
        {inheritedLabel && <option value="inherit">{inheritedLabel}</option>}
        {options.map(option => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {stateLabel && (
        <small id={stateId} className="sr-only">
          {stateLabel}
        </small>
      )}
    </div>
  );
}

function Memory({
  live,
  memoryEnabled,
  papercutEnabled,
  reviewerConfigured,
  onOpenReviewerSettings,
}: {
  live: RuntimeStoreSnapshot;
  memoryEnabled: boolean;
  papercutEnabled: boolean;
  reviewerConfigured?: boolean;
  onOpenReviewerSettings: () => void;
}) {
  const [view, setView] = useState<"memory" | "papercuts">(memoryEnabled ? "memory" : "papercuts");
  const continuity = live.runtime?.operational.continuity;
  const memoryCount = continuity ? continuity.memory.length + continuity.globalMemory.length : undefined;
  const papercutCount = live.runtime?.operational.papercuts.counts.total;
  useEffect(() => {
    if (view === "memory" && !memoryEnabled && papercutEnabled) setView("papercuts");
    if (view === "papercuts" && !papercutEnabled && memoryEnabled) setView("memory");
  }, [memoryEnabled, papercutEnabled, view]);
  return (
    <div className="memory-page">
      {memoryEnabled && papercutEnabled && (
        <div className="memory-view-bar">
          <nav className="memory-archive-nav" aria-label="Memory view">
            <button type="button" aria-pressed={view === "memory"} onClick={() => setView("memory")}>
              Memory <span className="mono">{memoryCount ?? "–"}</span>
            </button>
            <button type="button" aria-pressed={view === "papercuts"} onClick={() => setView("papercuts")}>
              Papercuts <span className="mono">{papercutCount ?? "–"}</span>
            </button>
          </nav>
        </div>
      )}
      {view === "memory" && memoryEnabled && (
        <ContinuityMemory
          live={live}
          reviewerConfigured={reviewerConfigured}
          onOpenReviewerSettings={onOpenReviewerSettings}
        />
      )}
      {view === "papercuts" && papercutEnabled && <Papercuts live={live} />}
    </div>
  );
}

function Papercuts({ live }: { live: RuntimeStoreSnapshot }) {
  const summary = live.runtime?.operational.papercuts;
  const [status, setStatus] = useState<PapercutStatusReadModel | "all">("open");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<PapercutListPage>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [deleting, setDeleting] = useState<PapercutRecordReadModel>();
  const [mutationError, setMutationError] = useState("");
  const generation = live.runtime?.sessionGeneration;
  const requestVersion = useRef(0);

  useEffect(() => {
    const timeout = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timeout);
  }, [search]);
  useEffect(() => {
    const request = ++requestVersion.current;
    if (live.connection !== "connected" || !live.runtime?.ready) {
      setPage(undefined);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setPage(undefined);
    setLoading(true);
    setLoadingMore(false);
    setError("");
    void runtimeStore
      .papercuts(status, query, 0, 25, controller.signal)
      .then(result => {
        if (requestVersion.current === request) setPage(result);
      })
      .catch(cause => {
        if (!controller.signal.aborted && requestVersion.current === request)
          setError(cause instanceof Error ? cause.message : "Unable to load papercuts");
      })
      .finally(() => {
        if (!controller.signal.aborted && requestVersion.current === request) setLoading(false);
      });
    return () => controller.abort();
  }, [generation, live.connection, live.runtime?.ready, query, refresh, status, summary?.revision]);

  const loadMore = async () => {
    if (page?.nextOffset === null || page?.nextOffset === undefined || loadingMore) return;
    setLoadingMore(true);
    setError("");
    const request = requestVersion.current;
    try {
      const next = await runtimeStore.papercuts(status, query, page.nextOffset, page.limit);
      if (requestVersion.current !== request) return;
      if (next.revision !== page.revision) {
        setRefresh(value => value + 1);
        return;
      }
      setPage({ ...next, offset: 0, records: [...page.records, ...next.records] });
    } catch (cause) {
      if (requestVersion.current === request)
        setError(cause instanceof Error ? cause.message : "Unable to load more papercuts");
    } finally {
      setLoadingMore(false);
    }
  };
  const count = (value: PapercutStatusReadModel | "all") =>
    value === "all" ? summary?.counts.total : summary?.counts[value];
  const outcome = (record: PapercutRecordReadModel) =>
    record.status === "resolved" ? record.resolution : record.status === "dismissed" ? record.dismissal : undefined;
  const canMutate = live.connection === "connected" && live.runtime?.ready === true && !busy;
  const beginEdit = (record: PapercutRecordReadModel) => {
    setEditing(record.id);
    setDraft(record.message);
    setMutationError("");
  };
  const save = async (record: PapercutRecordReadModel) => {
    if (!canMutate || !draft.trim()) return;
    setBusy(record.id);
    setMutationError("");
    try {
      await runtimeStore.updatePapercut(record, draft.trim());
      setEditing("");
      setRefresh(value => value + 1);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to update papercut";
      setMutationError(message);
      if (/changed or was removed/i.test(message)) setRefresh(value => value + 1);
    } finally {
      setBusy("");
    }
  };
  const remove = async (record: PapercutRecordReadModel) => {
    if (!canMutate) return;
    setBusy(record.id);
    setMutationError("");
    try {
      await runtimeStore.deletePapercut(record);
      setEditing("");
      setDeleting(undefined);
      setRefresh(value => value + 1);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to delete papercut";
      setMutationError(message);
      setDeleting(undefined);
      if (/changed or was removed/i.test(message)) setRefresh(value => value + 1);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="memory-ledger papercut-ledger">
      <div className="memory-ledger-head">
        <div className="papercut-toolbar">
          <div className="papercut-status" role="group" aria-label="Papercut status">
            {(["open", "resolved", "dismissed", "all"] as const).map(value => (
              <button
                type="button"
                aria-pressed={status === value}
                className={status === value ? "is-active" : ""}
                key={value}
                onClick={() => setStatus(value)}>
                {value}
                <span className="mono">{count(value) ?? "–"}</span>
              </button>
            ))}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh papercuts"
            disabled={loading}
            onClick={() => setRefresh(value => value + 1)}>
            <IconRefresh size={14} />
          </button>
        </div>
        <label className="memory-ledger-search">
          <IconSearch size={13} />
          <span className="sr-only">Search papercuts</span>
          <input
            type="search"
            value={search}
            maxLength={200}
            placeholder="Search papercuts"
            onChange={event => setSearch(event.target.value)}
          />
          <span className="mono">{page?.total ?? 0}</span>
        </label>
      </div>
      {loading && !page && (
        <div className="memory-ledger-no-results">
          <IconLoader2 className="spin" size={18} />
          <strong>Loading papercuts</strong>
        </div>
      )}
      {!loading && error && !page && (
        <div className="memory-ledger-no-results">
          <IconAlertTriangle size={18} />
          <strong>Papercuts unavailable</strong>
          <span>{error}</span>
        </div>
      )}
      {!loading && !error && page?.records.length === 0 && (
        <div className="memory-ledger-empty">
          <strong>{query ? "No matching papercuts" : `No ${status === "all" ? "stored" : status} papercuts`}</strong>
          <span>{query ? "Try a different search." : "Captured workflow friction will appear here."}</span>
        </div>
      )}
      {page && page.records.length > 0 && (
        <div className="memory-ledger-list">
          {page.records.map(record => {
            const isEditing = editing === record.id;
            return (
              <details className="memory-ledger-row papercut-row" key={record.id} open={isEditing || undefined}>
                <summary>
                  <OverviewOrb
                    state={record.status === "open" ? "attention" : record.status === "resolved" ? "done" : "neutral"}
                    label={record.status}
                  />
                  <div className="memory-archive-copy">
                    <span>
                      <strong>{record.message}</strong>
                      <small className="policy-source">{record.status}</small>
                    </span>
                    <p>
                      {outcome(record) ??
                        `${record.occurrences} occurrence${record.occurrences === 1 ? "" : "s"} · last seen ${displayTime(record.lastSeenAt)}`}
                    </p>
                  </div>
                  <IconChevronDown className="memory-ledger-chevron" size={13} />
                </summary>
                <div className="memory-ledger-detail">
                  {isEditing ? (
                    <div className="memory-editor">
                      <label>
                        Message
                        <textarea
                          value={draft}
                          maxLength={500}
                          rows={4}
                          disabled={Boolean(busy)}
                          onChange={event => setDraft(event.target.value)}
                        />
                      </label>
                      <div>
                        <button
                          className="primary-button"
                          type="button"
                          disabled={!canMutate || !draft.trim()}
                          onClick={() => void save(record)}>
                          {busy === record.id ? "Saving…" : "Save"}
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() => setEditing("")}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <dl>
                        <div>
                          <dt>ID</dt>
                          <dd title={record.id}>{record.id.slice(0, 8)}</dd>
                        </div>
                        <div>
                          <dt>Created</dt>
                          <dd>
                            <time dateTime={record.createdAt}>{displayTime(record.createdAt)}</time>
                          </dd>
                        </div>
                        <div>
                          <dt>Last seen</dt>
                          <dd>
                            <time dateTime={record.lastSeenAt}>{displayTime(record.lastSeenAt)}</time>
                          </dd>
                        </div>
                        <div>
                          <dt>Occurrences</dt>
                          <dd>{record.occurrences}</dd>
                        </div>
                        {outcome(record) && (
                          <div>
                            <dt>{record.status === "resolved" ? "Resolution" : "Dismissal"}</dt>
                            <dd title={outcome(record)}>{outcome(record)}</dd>
                          </div>
                        )}
                      </dl>
                      <footer>
                        <button
                          className="text-button"
                          type="button"
                          disabled={!canMutate}
                          onClick={() => beginEdit(record)}>
                          Edit
                        </button>
                        <button
                          className="text-button danger"
                          type="button"
                          disabled={!canMutate}
                          onClick={() => {
                            setMutationError("");
                            setDeleting(record);
                          }}>
                          <IconTrash size={13} />
                          Delete
                        </button>
                      </footer>
                    </>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}
      {page?.nextOffset !== null && page?.nextOffset !== undefined && (
        <button className="session-usage-expand" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? "Loading…" : `Load more · ${page.records.length}/${page.total}`}
        </button>
      )}
      {error && page && (
        <p className="ui-request-error" role="alert">
          {error}
        </p>
      )}
      {mutationError && (
        <p className="ui-request-error" role="alert">
          {mutationError}
        </p>
      )}
      {deleting && (
        <ActionDialog
          title="Delete papercut?"
          description="This papercut will be permanently removed from the project backlog."
          confirmLabel="Delete papercut"
          busyLabel="Deleting…"
          busy={busy === deleting.id}
          danger
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => void remove(deleting)}
        />
      )}
    </div>
  );
}

function ContinuityMemory({
  live,
  reviewerConfigured,
  onOpenReviewerSettings,
}: {
  live: RuntimeStoreSnapshot;
  reviewerConfigured?: boolean;
  onOpenReviewerSettings: () => void;
}) {
  const continuity = live.runtime?.operational.continuity;
  const memory = continuity?.memory ?? [];
  const globalMemory = live.runtime?.operational.continuity.globalMemory ?? [];
  const [editing, setEditing] = useState("");
  const [trigger, setTrigger] = useState("");
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState("");
  const [deleting, setDeleting] = useState<ContinuityMemoryNoteReadModel>();
  const [confirmingMigration, setConfirmingMigration] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const noteKey = (note: ContinuityMemoryNoteReadModel) => `${note.scope}:${note.id}`;
  const query = search.trim().toLowerCase();
  const matches = (note: ContinuityMemoryNoteReadModel) =>
    !query ||
    [note.trigger, note.guidance, note.authority, note.origin, ...(note.relatedPaths ?? [])].some(value =>
      value.toLowerCase().includes(query),
    );
  const visibleGlobalMemory = globalMemory.filter(matches);
  const visibleMemory = memory.filter(matches);
  const total = globalMemory.length + memory.length;
  const shown = visibleGlobalMemory.length + visibleMemory.length;
  const idle =
    live.connection === "connected" &&
    live.runtime?.ready === true &&
    live.runtime.conversation.streaming === false &&
    !live.pendingUi &&
    !busy;
  const edit = (note: ContinuityMemoryNoteReadModel) => {
    setEditing(noteKey(note));
    setTrigger(note.trigger);
    setGuidance(note.guidance);
    setError("");
  };
  const save = async (note: ContinuityMemoryNoteReadModel) => {
    if (!idle || !trigger.trim() || !guidance.trim()) return;
    setBusy(noteKey(note));
    setError("");
    try {
      await runtimeStore.updateContinuityMemory(note, trigger.trim(), guidance.trim());
      setEditing("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update memory");
      if (cause instanceof Error && /\b(?:stale|changed|revision)\b/i.test(cause.message)) setEditing("");
    } finally {
      setBusy("");
    }
  };
  const remove = async (note: ContinuityMemoryNoteReadModel) => {
    if (!idle) return;
    setBusy(noteKey(note));
    setError("");
    try {
      await runtimeStore.deleteContinuityMemory(note);
      setEditing("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete memory");
    } finally {
      setBusy("");
      setDeleting(undefined);
    }
  };
  const migrate = async () => {
    if (!idle || reviewerConfigured !== true) return;
    setBusy("migration");
    setError("");
    try {
      await runtimeStore.migrateContinuityMemory();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to migrate V4 memory");
    } finally {
      setBusy("");
      setConfirmingMigration(false);
    }
  };
  const rows = (notes: ContinuityMemoryNoteReadModel[]) =>
    notes.map(note => {
      const key = noteKey(note);
      const isEditing = editing === key;
      return (
        <details className="memory-ledger-row" key={key} open={isEditing || undefined}>
          <summary>
            <div className="memory-archive-copy">
              <span>
                <strong>{note.trigger}</strong>
                <small className={`policy-source${note.scope === "project" ? " is-here" : ""}`}>
                  {note.scope === "user" ? "global" : "project"}
                </small>
              </span>
              <p>{note.guidance}</p>
            </div>
            <IconChevronDown className="memory-ledger-chevron" size={13} />
          </summary>
          <div className="memory-ledger-detail">
            {isEditing ? (
              <div className="memory-editor">
                <label>
                  Trigger
                  <input
                    value={trigger}
                    maxLength={240}
                    disabled={Boolean(busy)}
                    onChange={event => setTrigger(event.target.value)}
                  />
                </label>
                <label>
                  Guidance
                  <textarea
                    value={guidance}
                    maxLength={800}
                    rows={5}
                    disabled={Boolean(busy)}
                    onChange={event => setGuidance(event.target.value)}
                  />
                </label>
                <div>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      !idle ||
                      !trigger.trim() ||
                      !guidance.trim() ||
                      trigger.trim().length + guidance.trim().length > 1_000
                    }
                    onClick={() => void save(note)}>
                    {busy === key ? "Saving…" : "Save"}
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => setEditing("")}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <dl>
                  <div>
                    <dt>Authority</dt>
                    <dd>{note.authority.replaceAll("_", " ")}</dd>
                  </div>
                  <div>
                    <dt>Origin</dt>
                    <dd>{note.origin}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>
                      <time dateTime={note.updatedAt}>{displayTime(note.updatedAt)}</time>
                    </dd>
                  </div>
                  <div>
                    <dt>Source summary</dt>
                    <dd title={note.sourceSummary}>{note.sourceSummary}</dd>
                  </div>
                  <div>
                    <dt>Related paths</dt>
                    <dd title={(note.relatedPaths ?? []).join("\n")}>
                      {note.relatedPaths?.length ? note.relatedPaths.join(", ") : "None"}
                    </dd>
                  </div>
                </dl>
                <footer>
                  <button className="text-button" type="button" disabled={!idle} onClick={() => edit(note)}>
                    Edit
                  </button>
                  <button
                    className="text-button danger"
                    type="button"
                    disabled={!idle}
                    onClick={() => {
                      setError("");
                      setDeleting(note);
                    }}>
                    <IconTrash size={13} />
                    Delete
                  </button>
                </footer>
              </>
            )}
          </div>
        </details>
      );
    });
  if (live.runtime?.operational.continuity.availability === "unavailable")
    return <FeatureUnavailable name="Continuity memory" />;
  return (
    <div className="memory-ledger memory-notes-ledger">
      <div className="memory-ledger-head">
        {reviewerConfigured === false && (
          <div className="memory-reviewer-warning" role="status">
            <OverviewOrb state="attention" label="Attention" />
            <div>
              <strong>Memory Reviewer is not configured</strong>
              <span>New memories proposed by the model will not be stored.</span>
              <button className="text-button" type="button" onClick={onOpenReviewerSettings}>
                Select a reviewer ›
              </button>
            </div>
          </div>
        )}
        {continuity?.v4MigrationAvailable && (
          <div className="memory-migration-banner" role="status">
            <div>
              <IconRestore size={16} />
              <span>
                <strong>Previous memory found</strong>
                <small>Review and migrate preserved V4 notes into the V5 notebook.</small>
              </span>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={!idle || reviewerConfigured === undefined}
              onClick={() => (reviewerConfigured === false ? onOpenReviewerSettings() : setConfirmingMigration(true))}>
              {reviewerConfigured === false
                ? "Select Memory Reviewer"
                : reviewerConfigured === undefined
                  ? "Loading settings…"
                  : "Migrate memory"}
            </button>
          </div>
        )}
        <label className="memory-ledger-search">
          <IconSearch size={13} />
          <span className="sr-only">Search memory</span>
          <input
            type="search"
            value={search}
            placeholder={`Search ${total} note${total === 1 ? "" : "s"}`}
            onChange={event => setSearch(event.target.value)}
          />
          <span className="mono">{query ? `${shown}/${total}` : total}</span>
        </label>
      </div>
      {shown > 0 && (
        <section className="memory-ledger-list" aria-label="Memory archive">
          {rows([...visibleMemory, ...visibleGlobalMemory])}
        </section>
      )}
      {!query && total === 0 && (
        <div className="memory-ledger-empty">
          <strong>No saved memory</strong>
          <span>Continuity has not saved durable guidance for this project or user.</span>
        </div>
      )}
      {query && shown === 0 && (
        <div className="memory-ledger-no-results">
          <IconSearch size={18} />
          <strong>No matching memory</strong>
          <span>Try a trigger, guidance, authority, origin, or related path.</span>
        </div>
      )}
      {!idle && total > 0 && (
        <p className="settings-note" role="status">
          Memory changes are available when the session is idle.
        </p>
      )}
      {error && (
        <p className="ui-request-error" role="alert">
          {error}
        </p>
      )}
      {deleting && (
        <ActionDialog
          title={`Delete ${deleting.scope === "user" ? "global" : "project"} memory?`}
          description={
            deleting.scope === "user"
              ? "This rule will be removed from every project."
              : "This rule will be removed from this project."
          }
          confirmLabel="Delete memory"
          busyLabel="Deleting…"
          busy={busy === noteKey(deleting)}
          danger
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => void remove(deleting)}
        />
      )}
      {confirmingMigration && (
        <ActionDialog
          title="Migrate previous memory?"
          description="The configured Memory Reviewer will keep, revise, or reject each V4 note. Backups remain available for rollback until the next V5 write."
          confirmLabel="Migrate memory"
          busyLabel="Migrating…"
          busy={busy === "migration"}
          onCancel={() => setConfirmingMigration(false)}
          onConfirm={() => void migrate()}
        />
      )}
    </div>
  );
}

/* The filter chips key themselves with the marker the rows already use, so the
   toolbar teaches the ledger's vocabulary instead of restating it in words. */
const STATEQL_FILTERS: Array<{ tag: StateQLActivityTag; marker: string; noun: string }> = [
  { tag: "read", marker: "Q", noun: "read" },
  { tag: "write", marker: "W", noun: "write" },
  { tag: "error", marker: "!", noun: "error" },
];

export function StateQLWorkspace({ live, onClose }: { live: RuntimeStoreSnapshot; onClose: () => void }) {
  const snapshotScope = `${live.connection}:${live.runtime?.ready ?? false}:${live.runtime?.sessionGeneration ?? "none"}:${live.runtime?.sessionId ?? "none"}`;
  const [snapshotState, setSnapshotState] = useState<{ scope: string; value: StateQLSnapshot }>();
  const snapshot = snapshotState?.scope === snapshotScope ? snapshotState.value : undefined;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [activityTags, setActivityTags] = useState<ReadonlySet<StateQLActivityTag>>(new Set());
  const [expandedActivity, setExpandedActivity] = useState<Set<string>>(new Set());
  const toolRevision = useMemo(
    () =>
      (live.runtime?.conversation.tools ?? [])
        .filter(tool => tool.name === "stateql" && tool.status !== "running")
        .map(tool => `${tool.id}:${tool.status}`)
        .join("|"),
    [live.runtime?.conversation.tools],
  );

  useEffect(() => {
    setLoading(true);
    setError("");
    if (live.connection !== "connected" || !live.runtime?.ready) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    void runtimeStore
      .stateqlSnapshot(50, controller.signal)
      .then(value => {
        if (!active) return;
        setSnapshotState({ scope: snapshotScope, value });
        const first = buildStateQLActivity(value)[0];
        setExpandedActivity(first ? new Set([first.id]) : new Set());
      })
      .catch(cause => {
        if (active && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "StateQL status failed to load");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    live.connection,
    live.runtime?.ready,
    live.runtime?.sessionId,
    live.runtime?.sessionGeneration,
    refresh,
    toolRevision,
  ]);

  const activity = useMemo(() => (snapshot ? buildStateQLActivity(snapshot) : []), [snapshot]);
  const visibleActivity = useMemo(() => selectStateQLActivity(activity, activityTags), [activity, activityTags]);
  const visibleHistory = visibleActivity.filter(item => item.source === "history");
  const visibleMetadata = visibleActivity.filter(item => item.source === "metadata");
  const historyCount = activity.filter(item => item.source === "history").length;
  const metadataCount = activity.length - historyCount;
  const allVisibleExpanded = visibleActivity.length > 0 && visibleActivity.every(item => expandedActivity.has(item.id));
  const rowsScope = `${live.runtime?.sessionGeneration ?? "none"}:${live.runtime?.sessionId ?? "none"}`;
  const header = (
    <header className="panel-head">
      <IconDatabase size={18} aria-hidden="true" />
      <span className="section-kicker" id="database-panel-title">
        Database
      </span>
      <span className="spacer" />
      <button
        className="text-button"
        type="button"
        disabled={loading || !snapshot}
        aria-live="polite"
        onClick={() => setRefresh(value => value + 1)}>
        {loading ? <IconLoader2 className="spin" size={14} /> : <IconRefresh size={14} />}
        {loading ? "Refreshing" : "Refresh"}
      </button>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close database">
        <IconX size={17} />
      </button>
    </header>
  );

  if (!snapshot)
    return (
      <div className="stateql-workspace">
        {header}
        <div className="stateql-ledger-empty">
          {loading ? <IconLoader2 className="spin" size={20} /> : <IconDatabase size={20} />}
          <strong>{loading ? "Loading StateQL" : "StateQL unavailable"}</strong>
          <span>
            {loading
              ? "Reading bounded local status and history."
              : error || "No StateQL snapshot is available for this actor."}
          </span>
        </div>
      </div>
    );

  const connection = snapshot.connection;
  const mode = connection
    ? `${connection.driver} / ${connection.read_only ? "read-only" : "read-write"}`
    : "disconnected";
  const toggleAll = () =>
    setExpandedActivity(current => {
      if (allVisibleExpanded) return new Set([...current].filter(id => !visibleActivity.some(item => item.id === id)));
      return new Set([...current, ...visibleActivity.map(item => item.id)]);
    });
  const toggleTag = (tag: StateQLActivityTag) =>
    setActivityTags(current => {
      const next = new Set(current);
      if (!next.delete(tag)) next.add(tag);
      return next;
    });
  const setExpanded = (item: StateQLActivityItem, open: boolean) =>
    setExpandedActivity(current => {
      const next = new Set(current);
      if (open) next.add(item.id);
      else next.delete(item.id);
      return next;
    });

  return (
    <div className="stateql-workspace">
      {header}
      <section className="stateql-connection-strip" aria-label="Database context">
        <div className="stateql-connection-primary">
          <strong className="mono" title={connection?.name}>
            {connection?.name ?? "No active connection"}
          </strong>
          <span className={connection ? "is-connected" : ""}>{mode}</span>
        </div>
        <dl>
          <div>
            <dt>Database</dt>
            <dd className="mono" title={connection?.database}>
              {connection?.database ?? "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>Transaction</dt>
            <dd>{snapshot.transaction?.state ?? "None"}</dd>
          </div>
          <div>
            <dt>State</dt>
            <dd className="mono">{snapshot.state_version ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{snapshot.state_confidence ?? "Unavailable"}</dd>
          </div>
        </dl>
        <span className="stateql-ledger-actor mono" title={snapshot.actor_id}>
          Actor {snapshot.actor_id}
        </span>
      </section>
      {error && (
        <p className="stateql-ledger-error" role="alert">
          Refresh failed. Showing the last available snapshot. {error}
        </p>
      )}
      <section className="stateql-ledger-body" aria-labelledby="stateql-activity-title">
        <header className="stateql-ledger-toolbar">
          <h2 id="stateql-activity-title">Session activity</h2>
          <span className="mono">
            {historyCount} history · {metadataCount} retained
          </span>
          <div className="stateql-ledger-filters" role="group" aria-label="Filter database activity">
            {STATEQL_FILTERS.map(({ tag, marker, noun }) => {
              const count = filterStateQLActivity(activity, tag).length;
              return (
                <button type="button" aria-pressed={activityTags.has(tag)} key={tag} onClick={() => toggleTag(tag)}>
                  <span className={`stateql-ledger-marker is-${tag}`} aria-hidden="true">
                    {marker}
                  </span>
                  {count} {count === 1 ? noun : `${noun}s`}
                </button>
              );
            })}
          </div>
          <button
            className="text-button stateql-expand-all"
            type="button"
            disabled={visibleActivity.length === 0}
            onClick={toggleAll}>
            {allVisibleExpanded ? "Collapse all" : "Expand all"}
          </button>
        </header>
        {visibleActivity.length > 0 ? (
          <div
            className="stateql-ledger-scroll"
            role="region"
            aria-label="Scrollable database activity ledger"
            tabIndex={0}>
            <table className="stateql-ledger-table">
              <caption className="sr-only">Bounded StateQL session history and retained metadata</caption>
              <colgroup>
                <col className="toggle" />
                <col className="command" />
                <col className="sql" />
                <col className="handle" />
                <col className="status" />
                <col className="time" />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="Expand activity" />
                  <th>Command</th>
                  <th>Statement</th>
                  <th>Handle</th>
                  <th>Status</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {visibleHistory.map(item => (
                  <StateQLLedgerItem
                    item={item}
                    expanded={expandedActivity.has(item.id)}
                    key={item.id}
                    rowsScope={rowsScope}
                    onExpandedChange={open => setExpanded(item, open)}
                  />
                ))}
                {visibleMetadata.length > 0 && (
                  <tr className="stateql-ledger-metadata">
                    <td colSpan={6}>Recent metadata without timestamp</td>
                  </tr>
                )}
                {visibleMetadata.map(item => (
                  <StateQLLedgerItem
                    item={item}
                    expanded={expandedActivity.has(item.id)}
                    key={item.id}
                    rowsScope={rowsScope}
                    onExpandedChange={open => setExpanded(item, open)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="stateql-ledger-empty">
            <IconClock size={20} />
            <strong>No matching activity</strong>
            <span>
              {activity.length === 0
                ? "Commands run in this shared workspace will appear here."
                : "No activity in the bounded snapshot matches the pressed filters."}
            </span>
          </div>
        )}
      </section>
    </div>
  );
}

const STATEQL_TONE_STATES: Record<StateQLActivityTone, OverviewState> = {
  success: "done",
  danger: "failed",
  active: "running",
  neutral: "neutral",
};

function stateqlExecution(item: StateQLActivityItem): string {
  return item.source === "metadata"
    ? "History unavailable"
    : item.cached
      ? "cache hit"
      : item.executed
        ? "database executed"
        : item.success
          ? "completed"
          : "failed";
}

function StateQLLedgerItem({
  item,
  expanded,
  rowsScope,
  onExpandedChange,
}: {
  item: StateQLActivityItem;
  expanded: boolean;
  rowsScope: string;
  onExpandedChange: (open: boolean) => void;
}) {
  const status = stateqlActivityStatus(item);
  const kind = item.tags.includes("error")
    ? "error"
    : item.tags.includes("write")
      ? "write"
      : item.tags.includes("read")
        ? "read"
        : "other";
  const marker = kind === "error" ? "!" : kind === "write" ? "W" : kind === "read" ? "Q" : "M";
  const statement = item.sql ?? "Statement not retained";
  const detailId = `stateql-detail-${encodeURIComponent(item.id)}`;
  return (
    <>
      <tr
        className={`stateql-ledger-row is-${kind} ${expanded ? "is-expanded" : ""}`}
        onClick={() => onExpandedChange(!expanded)}>
        <td>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${item.command}`}
            onClick={event => {
              event.stopPropagation();
              onExpandedChange(!expanded);
            }}>
            <IconChevronDown size={15} />
          </button>
        </td>
        <th scope="row">
          <span className="stateql-ledger-command">
            <span className={`stateql-ledger-marker is-${kind}`} aria-hidden="true">
              {marker}
            </span>
            <span>{item.command}</span>
          </span>
        </th>
        <td className="stateql-ledger-sql-peek" title={statement}>
          {statement}
        </td>
        <td className="mono" title={item.result?.alias ?? item.handle}>
          {item.result?.alias ?? item.handle ?? "N/A"}
        </td>
        <td>
          <OverviewStateLabel state={STATEQL_TONE_STATES[status.tone]}>{status.label}</OverviewStateLabel>
        </td>
        <td className="mono">
          {item.timestamp ? <time dateTime={item.timestamp}>{displayTime(item.timestamp)}</time> : "No time"}
        </td>
      </tr>
      {expanded && (
        <tr className="stateql-ledger-detail" id={detailId}>
          <td colSpan={6}>
            <StateQLLedgerDetail item={item} rowsScope={rowsScope} />
          </td>
        </tr>
      )}
    </>
  );
}

function StateQLReceiptRow({
  label,
  mono,
  title,
  children,
}: {
  label: string;
  mono?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined} title={title}>
        {children}
      </dd>
    </div>
  );
}

function StateQLLedgerDetail({ item, rowsScope }: { item: StateQLActivityItem; rowsScope: string }) {
  return (
    <div className="stateql-ledger-detail-grid">
      <section className="stateql-ledger-sql" aria-label="SQL statement">
        <header>
          <strong>SQL statement</strong>
          <span>{stateqlExecution(item)}</span>
        </header>
        <p>SQL may contain inline literals or comments. Parameters are not included in activity history.</p>
        {item.sql !== undefined ? (
          <pre dir="ltr">
            <code>{item.sql}</code>
          </pre>
        ) : (
          <span className="stateql-ledger-unavailable">SQL was not retained for this activity.</span>
        )}
      </section>
      <section className="stateql-ledger-receipts" aria-label="Database receipt">
        <header>
          <strong>{item.result ? "Result receipt" : item.operation ? "Operation receipt" : "Activity receipt"}</strong>
          <span>{item.source === "metadata" ? "retained metadata" : "session history"}</span>
        </header>
        {item.result && (
          <dl className="stateql-ledger-receipt">
            <StateQLReceiptRow label="Result handle" mono title={item.result.handle}>
              {item.result.handle}
            </StateQLReceiptRow>
            <StateQLReceiptRow label="Alias">{item.result.alias ?? "No alias"}</StateQLReceiptRow>
            <StateQLReceiptRow label="Rows" mono>
              {item.result.rows.toLocaleString()}
            </StateQLReceiptRow>
            <StateQLReceiptRow label="Actor" mono title={item.actorId}>
              {item.actorId ?? "N/A"}
            </StateQLReceiptRow>
          </dl>
        )}
        {item.operation && (
          <dl className="stateql-ledger-receipt">
            <StateQLReceiptRow label="Operation handle" mono title={item.operation.handle}>
              {item.operation.handle}
            </StateQLReceiptRow>
            <StateQLReceiptRow label="Affected">
              {item.operation.affected_rows === null ? "Unavailable" : `${item.operation.affected_rows} rows`}
            </StateQLReceiptRow>
            <StateQLReceiptRow label="State">{item.operation.status}</StateQLReceiptRow>
            <StateQLReceiptRow label="Actor" mono title={item.operation.actor_id}>
              {item.operation.actor_id}
            </StateQLReceiptRow>
          </dl>
        )}
        {!item.result && !item.operation && (
          <span className="stateql-ledger-unavailable">No retained receipt is available.</span>
        )}
        {item.result && item.operation && (
          <p className="stateql-ledger-warning">This handle matches both result and operation metadata.</p>
        )}
      </section>
      {item.result && (
        <StateQLMaterializedRows
          active
          handle={item.result.handle}
          key={`${rowsScope}:${item.result.handle}`}
          total={item.result.rows}
        />
      )}
    </div>
  );
}

const STATEQL_ROWS_PAGE_SIZE = 25;

function stateqlCellText(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function stateqlColumns(page: StateQLRowsPage | undefined): string[] {
  const columns = new Set<string>();
  for (const row of page?.rows ?? []) for (const key of Object.keys(row)) columns.add(key);
  return [...columns];
}

function StateQLMaterializedRows({ active, handle, total }: { active: boolean; handle: string; total: number }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<StateQLRowsPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const columns = useMemo(() => stateqlColumns(page), [page]);

  useEffect(() => {
    if (!active || !open) return;
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setError("");
    void runtimeStore
      .stateqlRows(handle, offset, STATEQL_ROWS_PAGE_SIZE, controller.signal)
      .then(value => {
        if (current) setPage(value);
      })
      .catch(cause => {
        if (current && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Materialized rows failed to load");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [active, handle, offset, open, retry]);

  const move = (nextOffset: number) => {
    if (loading) return;
    setPage(undefined);
    setOffset(nextOffset);
  };
  const start = page && page.returned > 0 ? page.offset + 1 : 0;
  const end = page && page.returned > 0 ? page.offset + page.returned : 0;

  return (
    <details className="stateql-rows" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span>
          <strong>Materialized rows</strong>
          <small>Loaded on demand from this result handle.</small>
        </span>
        <span className="mono">{total.toLocaleString()} rows</span>
        <IconChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="stateql-rows-content">
        <p className="stateql-rows-note">
          Rows can contain sensitive database content. Only this bounded page is loaded.
        </p>
        {loading && !page && (
          <div className="stateql-rows-state" role="status">
            <IconLoader2 className="spin" size={15} />
            Loading rows
          </div>
        )}
        {error && (
          <div className="stateql-rows-state is-error" role="alert">
            <span>{error}</span>
            <button className="text-button" type="button" onClick={() => setRetry(value => value + 1)}>
              Retry
            </button>
          </div>
        )}
        {page && page.rows.length === 0 && (
          <div className="stateql-rows-state">
            <span>No rows are available on this page.</span>
          </div>
        )}
        {page && page.rows.length > 0 && (
          <div className="stateql-rows-scroll" role="region" aria-label={`Rows for ${handle}`} tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {columns.map(column => (
                    <th scope="col" key={column}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row, rowIndex) => (
                  <tr key={`${page.offset}:${rowIndex}`}>
                    {columns.map(column => {
                      const text = Object.hasOwn(row, column) ? stateqlCellText(row[column]) : "N/A";
                      return (
                        <td className="mono" title={text} key={column}>
                          {text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page && (
          <footer className="stateql-rows-footer">
            <span className="mono">
              {start}-{end} of {page.total.toLocaleString()}
            </span>
            <div>
              <button
                className="text-button"
                type="button"
                disabled={loading || page.offset === 0}
                onClick={() => move(Math.max(0, page.offset - page.limit))}>
                Previous
              </button>
              <button
                className="text-button"
                type="button"
                disabled={loading || page.next_offset === null}
                onClick={() => page.next_offset !== null && move(page.next_offset)}>
                Next
              </button>
            </div>
          </footer>
        )}
      </div>
    </details>
  );
}

function Timeline({ live, enabled: packageEnabled }: { live: RuntimeStoreSnapshot; enabled: boolean }) {
  const timeline = live.runtime?.operational.timeline;
  const checkpoints = timeline?.checkpoints ?? [];
  const failures = timeline?.failures ?? [];
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [files, setFiles] = useState<TimelineCheckpointFiles>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [diff, setDiff] = useState<TimelineCheckpointDiff>();
  const active = checkpoints.find(checkpoint => checkpoint.id === selected);
  const enabled = live.connection === "connected" && live.runtime?.ready === true && !busy;
  const act = async (action: "restore" | "fork" | "clear", checkpointId?: string) => {
    if (!enabled) return;
    const operation = checkpointId ? `${action}:${checkpointId}` : action;
    setBusy(operation);
    setError("");
    try {
      await runtimeStore.timeline(action, checkpointId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Timeline action failed");
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    let cancelled = false;
    setFiles(undefined);
    setSelectedPath(undefined);
    setDiff(undefined);
    if (!active) return;
    void runtimeStore
      .timelineCheckpointFiles(active.id)
      .then(value => {
        if (!cancelled) setFiles(value);
      })
      .catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Timeline files failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [active?.id, live.runtime?.sessionGeneration]);
  const openDiff = async (path: string) => {
    if (!active) return;
    setSelectedPath(path);
    setDiff(undefined);
    try {
      setDiff(await runtimeStore.timelineCheckpointDiff(active.id, path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Timeline diff failed to load");
    }
  };
  if (timeline?.availability !== "available") {
    return packageEnabled ? (
      <div className="empty-state">
        <IconTimeline size={20} />
        <strong>Initializing Timeline</strong>
        <span>Waiting for the first Timeline state.</span>
      </div>
    ) : (
      <FeatureUnavailable name="Timeline" />
    );
  }
  const verifiedCount = checkpoints.filter(checkpoint => checkpoint.verified).length;
  return (
    <div className="timeline-layout">
      <div className="timeline-toolbar">
        <span>
          {checkpoints.length} checkpoint{checkpoints.length === 1 ? "" : "s"} · {verifiedCount} verified
          {failures.length > 0 && ` · ${failures.length} failed capture${failures.length === 1 ? "" : "s"}`}
        </span>
        <button
          className="text-button danger"
          type="button"
          disabled={!enabled || (checkpoints.length === 0 && failures.length === 0)}
          onClick={() => void act("clear")}>
          <IconTrash size={13} />
          {busy === "clear" ? "Clearing…" : "Clear timeline"}
        </button>
      </div>
      {checkpoints.map(checkpoint => {
        const expanded = active?.id === checkpoint.id;
        const indicatorState =
          checkpoint.verificationState === "passed"
            ? "done"
            : checkpoint.verificationState === "failed"
              ? "failed"
              : "neutral";
        const verificationLabel =
          checkpoint.verificationState === "passed"
            ? "Verified"
            : checkpoint.verificationState === "failed"
              ? "Failed"
              : "Unverified";
        return (
          <div className={`checkpoint-item ${expanded ? "is-expanded" : ""}`} key={checkpoint.id}>
            <div className="checkpoint-row">
              <OverviewOrb state={indicatorState} label={verificationLabel} />
              <button
                className="checkpoint-copy"
                type="button"
                aria-expanded={expanded}
                onClick={() => setSelected(current => (current === checkpoint.id ? undefined : checkpoint.id))}>
                <span className="checkpoint-title">
                  <strong title={checkpoint.title}>{oneLine(checkpoint.title)}</strong>
                </span>
                <span className="checkpoint-meta">
                  {checkpoint.branch && (
                    <span className="checkpoint-branch">
                      <IconGitBranch size={12} />
                      <span>{checkpoint.branch}</span>
                    </span>
                  )}
                  {checkpoint.changes ? (
                    <>
                      <span>
                        {checkpoint.changes.fileCount} file
                        {checkpoint.changes.fileCount === 1 ? "" : "s"}
                      </span>
                      <span className="checkpoint-diff-count">
                        <ins>+{checkpoint.changes.additions}</ins>
                        <del>−{checkpoint.changes.deletions}</del>
                      </span>
                    </>
                  ) : (
                    <span>No file changes</span>
                  )}
                  <time dateTime={checkpoint.createdAt}>{displayTimelineTime(checkpoint.createdAt)}</time>
                </span>
              </button>
              <OverviewStateLabel state={indicatorState}>{verificationLabel}</OverviewStateLabel>
              <span className="checkpoint-row-actions">
                <button
                  type="button"
                  title="Fork from checkpoint"
                  aria-label="Fork from checkpoint"
                  aria-busy={busy === `fork:${checkpoint.id}`}
                  disabled={!enabled}
                  onClick={() => void act("fork", checkpoint.id)}>
                  {busy === `fork:${checkpoint.id}` ? (
                    <IconLoader2 className="spin" size={15} />
                  ) : (
                    <IconGitFork size={15} />
                  )}
                </button>
                <button
                  type="button"
                  title="Restore checkpoint"
                  aria-label="Restore checkpoint"
                  aria-busy={busy === `restore:${checkpoint.id}`}
                  disabled={!enabled}
                  onClick={() => void act("restore", checkpoint.id)}>
                  {busy === `restore:${checkpoint.id}` ? (
                    <IconLoader2 className="spin" size={15} />
                  ) : (
                    <IconRestore size={15} />
                  )}
                </button>
              </span>
            </div>
            {expanded && (
              <CheckpointDetail
                files={files}
                selectedPath={selectedPath}
                diff={diff}
                error={error}
                onOpenDiff={openDiff}
              />
            )}
          </div>
        );
      })}
      {failures.map(failure => (
        <div className="checkpoint-item" key={failure.id}>
          <div className="checkpoint-row">
            <OverviewOrb state="failed" label="Capture failed" />
            <span className="checkpoint-copy">
              <span className="checkpoint-title">
                <strong title={failure.title}>{oneLine(failure.title)}</strong>
              </span>
              <span className="checkpoint-meta">
                <span title={failure.reason}>{failure.reason}</span>
                <time dateTime={failure.createdAt}>{displayTimelineTime(failure.createdAt)}</time>
              </span>
            </span>
            <OverviewStateLabel state="failed">Capture failed</OverviewStateLabel>
            <span className="checkpoint-row-actions" />
          </div>
        </div>
      ))}
      {checkpoints.length === 0 && failures.length === 0 && (
        <div className="empty-state">
          <IconTimeline size={20} />
          <strong>No checkpoints</strong>
          <span>Timeline has not captured this run.</span>
        </div>
      )}
      {error && !active && (
        <p className="ui-request-error timeline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function CheckpointDetail({
  files,
  selectedPath,
  diff,
  error,
  onOpenDiff,
}: {
  files?: TimelineCheckpointFiles;
  selectedPath?: string;
  diff?: TimelineCheckpointDiff;
  error: string;
  onOpenDiff(path: string): void;
}) {
  return (
    <div className="checkpoint-inline-detail">
      <div className="checkpoint-files" aria-label="Checkpoint changed files">
        {files?.files.map(file => (
          <button
            type="button"
            className={selectedPath === file.path ? "is-active" : ""}
            key={file.path}
            onClick={() => onOpenDiff(file.path)}>
            <IconFile size={13} />
            <span title={file.path}>{file.path}</span>
            {file.binary ? (
              <small>binary</small>
            ) : (
              <small>
                <ins>+{file.additions}</ins>
                <del>−{file.deletions}</del>
              </small>
            )}
          </button>
        ))}
        {!files && <span className="settings-note">Loading changes…</span>}
        {files && files.files.length === 0 && <span className="settings-note">No file changes</span>}
      </div>
      {selectedPath && <TimelineDiff value={diff} />}
      {error && (
        <p className="ui-request-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function TimelineDiff({ value }: { value?: TimelineCheckpointDiff }) {
  if (!value) return <div className="timeline-diff-empty">Loading diff…</div>;
  if (value.state !== "text" || !value.text)
    return (
      <div className="timeline-diff-empty">
        {value.state === "binary"
          ? "Binary file"
          : value.state === "oversized"
            ? "Diff is too large to display"
            : "Diff unavailable"}
      </div>
    );
  if (value.truncated) {
    const highlighted = DOMPurify.sanitize(highlightSource(value.text, value.path, true));
    return (
      <pre className="file-code timeline-diff">
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        <small>Output truncated</small>
      </pre>
    );
  }
  return (
    <Suspense fallback={<div className="timeline-diff-empty">Rendering diff…</div>}>
      <PierreCodeViewer mode="diff" path={value.path} text={value.text} revision={value.checkpointId} />
    </Suspense>
  );
}

function oneLine(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trimEnd()}…` : normalized;
}
function SessionUsage({ metrics }: { metrics?: SessionMetricsReadModel }) {
  const [usageOpen, setUsageOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const usageContentId = useId();
  const [usageListRef, ledCells] = useResponsiveUsageLedCells();
  const toolUsage = [...(metrics?.toolUsage ?? [])].sort(
    (left, right) => right.tokens - left.tokens || right.calls - left.calls || left.name.localeCompare(right.name),
  );
  const inputTokens = metrics?.inputTokens ?? 0;
  const outputTokens = metrics?.outputTokens ?? 0;
  const cacheReadTokens = metrics?.cacheReadTokens ?? 0;
  const cacheWriteTokens = metrics?.cacheWriteTokens ?? 0;
  const inputOutputTokens = inputTokens + outputTokens;
  const inputPercent = inputOutputTokens > 0 ? (inputTokens / inputOutputTokens) * 100 : 50;
  const outputPercent = inputOutputTokens > 0 ? (outputTokens / inputOutputTokens) * 100 : 50;
  const cacheHitRate = formatCacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens);
  const visibleUsage = showAll ? toolUsage : toolUsage.slice(0, 5);
  const maxToolTokens = toolUsage[0]?.tokens ?? 0;
  return (
    <InspectorSection title="Session usage" meta={`${metrics?.userMessages ?? 0} turns`} className="session-tool-usage">
      <div className="session-tool-summary">
        <div className="session-tool-call-total">
          <small>Tool calls</small>
          <strong className="mono">{formatCompactNumber(metrics?.toolCalls ?? 0)}</strong>
          <span>{toolUsage.length === 200 ? "200 tools shown" : `${toolUsage.length} tools used`}</span>
        </div>
        <div className="session-token-composition">
          <div>
            <small>Input + output</small>
            <strong className="mono">{formatCompactNumber(inputOutputTokens)}</strong>
          </div>
          <LedBar
            a={inputPercent}
            b={outputPercent}
            cells={ledCells}
            label={`${formatCompactNumber(inputTokens)} input tokens and ${formatCompactNumber(outputTokens)} output tokens`}
          />
          <div className="session-token-key">
            <span>
              <strong>Input</strong> {formatCompactNumber(inputTokens)}
            </span>
            <span>
              <strong>Output</strong> {formatCompactNumber(outputTokens)}
            </span>
          </div>
          <div className="session-token-key">
            <span
              title="Share of prompt tokens served from cache"
              aria-label={`Cache input: ${cacheHitRate}. Share of prompt tokens served from cache`}>
              <strong>Cache input</strong> {cacheHitRate}
            </span>
            <span>
              <strong>Context</strong> {Math.round(metrics?.contextPercent ?? 0)}%
            </span>
          </div>
        </div>
      </div>
      <button
        className="session-tool-usage-heading"
        type="button"
        aria-expanded={usageOpen}
        aria-controls={usageContentId}
        onClick={() => setUsageOpen(value => !value)}>
        <strong>Usage by tool</strong>
        <span title="Token volume is logarithmically scaled relative to the busiest tool; LED count adapts to panel width">
          Tokens / calls <IconChevronDown size={14} />
        </span>
      </button>
      <div id={usageContentId} hidden={!usageOpen}>
        {visibleUsage.length ? (
          <div className="session-tool-usage-list" ref={usageListRef}>
            {visibleUsage.map(usage => {
              const scaledTotal = maxToolTokens > 0 ? (Math.log1p(usage.tokens) / Math.log1p(maxToolTokens)) * 100 : 0;
              const inputShare = usage.tokens > 0 ? usage.inputTokens / usage.tokens : 0;
              const outputShare = usage.tokens > 0 ? usage.outputTokens / usage.tokens : 0;
              return (
                <div className="session-tool-usage-row" key={usage.name}>
                  <div>
                    <strong>{usage.name}</strong>
                    <LedBar
                      a={scaledTotal * inputShare}
                      b={scaledTotal * outputShare}
                      cells={ledCells}
                      thin
                      label={`${formatCompactNumber(usage.inputTokens)} input tokens and ${formatCompactNumber(usage.outputTokens)} output tokens; log-scaled relative volume`}
                    />
                  </div>
                  <span className="mono">
                    ~{formatCompactNumber(usage.tokens)}
                    <small>tok</small>
                  </span>
                  <span className="mono">
                    {formatCompactNumber(usage.calls)}
                    <small>calls</small>
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="session-tool-usage-empty">No completed tool calls in this session.</div>
        )}
        {toolUsage.length > 5 && (
          <button
            className="session-usage-expand"
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll(value => !value)}>
            {showAll ? "Show less" : `Show ${toolUsage.length - 5} more`} <IconChevronDown size={14} />
          </button>
        )}
      </div>
    </InspectorSection>
  );
}

function Tools({ live }: { live: RuntimeStoreSnapshot }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"project" | "session">("project");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const runtime = live.runtime;
  const policies = runtime?.operational.tools.policies ?? [];
  const normalized = query.trim().toLowerCase();
  const claimed = new Set<string>();
  const policyGroups = policies.map(policy => ({
    owner: policy.owner,
    policy,
    tools: policy.managedTools.filter(tool => {
      if (claimed.has(tool)) return false;
      claimed.add(tool);
      return true;
    }),
  }));
  const groups = [
    ...policyGroups,
    {
      owner: "Pi built-ins",
      policy: undefined,
      tools: (runtime?.availableTools ?? []).filter(tool => !claimed.has(tool)),
    },
  ]
    .map(group => ({
      ...group,
      tools: group.tools.filter(tool => !normalized || tool.toLowerCase().includes(normalized)),
    }))
    .filter(group => group.tools.length);
  const directOverrides =
    scope === "project" ? runtime?.runtimePolicy.project.toolOverrides : runtime?.runtimePolicy.session.toolOverrides;
  const effectiveOverrides = runtime?.runtimePolicy.effective.toolOverrides ?? {};
  const disabled = live.connection !== "connected" || !runtime?.ready || Boolean(live.pendingUi);
  const visibleCount = groups.reduce((total, group) => total + group.tools.length, 0);
  const setHere = Object.keys(directOverrides ?? {}).length;
  return (
    <div className="tools-page">
      <div className="tool-scope-bar">
        <div className="policy-scope" role="tablist" aria-label="Tool override scope">
          <button
            type="button"
            role="tab"
            aria-selected={scope === "project"}
            className={scope === "project" ? "is-active" : ""}
            onClick={() => setScope("project")}>
            Project
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "session"}
            className={scope === "session" ? "is-active" : ""}
            onClick={() => setScope("session")}>
            This session
          </button>
        </div>
      </div>
      <div className="tool-ledger-head">
        <label className="memory-ledger-search">
          <IconSearch size={13} />
          <span className="sr-only">Filter tools</span>
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={`Filter ${runtime?.availableTools.length ?? 0} tools`}
          />
          <span className="mono">{visibleCount}</span>
        </label>
        <p className="tool-override-note">
          Inherited tools follow global Settings. Package capability and safety gates remain authoritative.
        </p>
      </div>
      <InspectorSection title="Tool overrides" meta={`${setHere} set here`} className="tool-overrides-panel">
        <div className="tool-override-groups">
          {groups.map(group => (
            <section className="tool-override-group" key={group.owner}>
              <header>
                <strong>{group.owner}</strong>
                <span>{group.tools.length}</span>
              </header>
              {group.tools.map(tool => {
                const capable = group.policy ? group.policy.enabledTools.includes(tool) : true;
                const packageDefault: ToolExposureMode = group.policy?.deferredTools.includes(tool)
                  ? "deferred"
                  : group.policy
                    ? capable
                      ? "active"
                      : "disabled"
                    : runtime?.activeTools.includes(tool)
                      ? "active"
                      : "disabled";
                const effective = capable ? (effectiveOverrides[tool] ?? packageDefault) : "disabled";
                const locked = tool === "search_tools";
                const directOverride = directOverrides?.[tool];
                const state: OverviewState =
                  effective === "active" ? "done" : effective === "deferred" ? "attention" : "neutral";
                return (
                  <label
                    className={`tool-override-row ${directOverride ? "is-override" : ""} ${locked ? "is-locked" : ""}`}
                    data-effective={effective}
                    key={tool}>
                    <OverviewOrb state={state} label={`Current setting: ${effective}`} />
                    <span className="tool-override-name">
                      <strong>{tool}</strong>
                      <small className="policy-source">{locked ? "always on" : effective}</small>
                    </span>
                    <select
                      aria-label={`${scope === "project" ? "Project" : "Session"} override for ${tool}`}
                      value={directOverride ?? "inherit"}
                      disabled={disabled || locked || busy === tool || (!capable && !directOverride)}
                      onChange={event => {
                        if (!runtime) return;
                        const mode = event.target.value as ToolExposureMode | "inherit";
                        setBusy(tool);
                        setError("");
                        void runtimeStore
                          .updateToolPolicy(scope, tool, mode, runtime.runtimePolicy.revision)
                          .catch(cause =>
                            setError(cause instanceof Error ? cause.message : "Tool policy could not be saved"),
                          )
                          .finally(() => setBusy(""));
                      }}>
                      <option value="inherit">Inherit</option>
                      <option value="active" disabled={!capable}>
                        Active
                      </option>
                      <option value="deferred" disabled={!capable}>
                        Deferred
                      </option>
                      <option value="disabled" disabled={!capable}>
                        Disabled
                      </option>
                    </select>
                  </label>
                );
              })}
            </section>
          ))}
        </div>
        {!groups.length && (
          <div className="empty-state">
            <IconSearch size={20} />
            <strong>No matching tools</strong>
            <span>Try another tool name.</span>
          </div>
        )}
        {error && (
          <p className="policy-error" role="alert">
            {error}
          </p>
        )}
      </InspectorSection>
      <SieveStatus live={live} />
    </div>
  );
}

function SieveStatus({ live }: { live: RuntimeStoreSnapshot }) {
  const sieve = live.runtime?.operational.sieve;
  if (
    !sieve ||
    sieve.availability !== "available" ||
    !sieve.latest ||
    !sieve.cumulativeActual ||
    !sieve.cumulativeProjected
  ) {
    return (
      <InspectorSection title="Context Pruning">
        <FeatureUnavailable name="Pi Sieve" />
      </InspectorSection>
    );
  }
  const saved = sieve.cumulativeActual.netCharsSaved;
  const projected = sieve.cumulativeProjected.netCharsSaved;
  const observing = sieve.mode === "observe";
  const latestProjected = sieve.latestMode === "observe";
  const savings = Object.entries(observing ? sieve.cumulativeProjected.byTool : sieve.cumulativeActual.byTool)
    .filter(([, usage]) => usage.netCharsSaved > 0)
    .sort((left, right) => right[1].netCharsSaved - left[1].netCharsSaved)
    .slice(0, 3);
  const largestSaving = savings[0]?.[1].netCharsSaved ?? 1;
  const prefixChurn = sieve.stability?.prefixChurnViolations ?? 0;
  const softExceedances = sieve.stability?.softBudgetExceedances ?? 0;
  const healthy = prefixChurn === 0 && softExceedances === 0;
  const epochReason = sieve.epoch?.reason?.replaceAll("-", " ") ?? "not started";
  const contextPercent = sieve.contextUsagePercent;

  return (
    <InspectorSection
      title="Context Pruning"
      meta={sieve.projectionMode === "stable" ? "stable" : sieve.projectionMode}>
      <div className="sieve-gauge">
        <div>
          <strong>Context in use</strong>
          <b>{contextPercent === undefined ? "—" : `${Math.round(contextPercent)}%`}</b>
        </div>
        <LedBar
          a={contextPercent ?? 0}
          responsive
          label={
            contextPercent === undefined
              ? "Context usage unavailable"
              : `${Math.round(contextPercent)} percent of context in use`
          }
        />
        <p>
          <span>Pruning starts at {formatCompactNumber(sieve.threshold ?? 0)} characters</span>
          <span>{sieve.updatedAt ? `Updated ${displayTime(sieve.updatedAt)}` : "Update unavailable"}</span>
        </p>
      </div>

      <div className="sieve-summary" aria-label="Context pruning summary">
        <div>
          <small>{observing ? "Would remove" : "Removed"}</small>
          <strong>{formatCompactNumber(observing ? projected : saved)}</strong>
          <span>characters</span>
        </div>
        <div>
          <small>Recalled</small>
          <strong>{formatCompactNumber(sieve.recalledChars ?? 0)}</strong>
          <span>over {formatCompactNumber(sieve.recalls ?? 0)} recalls</span>
        </div>
        <div>
          <small>Last pass</small>
          <strong>{formatCompactNumber(sieve.latest.netCharsSaved)}</strong>
          <span>
            {formatCompactNumber(sieve.latest.transformed)} of {formatCompactNumber(sieve.latest.scanned)} pruned
            {latestProjected ? " · projected" : ""}
          </span>
        </div>
      </div>

      <div className="sieve-savings-heading">
        <strong>Where savings come from</strong>
        <span>Characters removed</span>
      </div>
      <div className="sieve-savings-list">
        {savings.map(([name, usage]) => (
          <div className="sieve-saving-row" key={name}>
            <div>
              <strong>{name}</strong>
              <LedBar a={(usage.netCharsSaved / largestSaving) * 100} thin />
            </div>
            <span className="mono">{formatCompactNumber(usage.netCharsSaved)}</span>
          </div>
        ))}
        {savings.length === 0 && <p className="sieve-no-savings">No savings recorded yet.</p>}
      </div>

      <div className="sieve-health-row">
        <OverviewOrb state={healthy ? "done" : "attention"} label={healthy ? "Healthy" : "Needs attention"} />
        <div>
          <strong>
            {healthy
              ? "No prefix churn or budget exceedances"
              : `${formatCompactNumber(prefixChurn)} prefix churn, ${formatCompactNumber(softExceedances)} budget exceedances`}
          </strong>
          <small>{formatCompactNumber(sieve.stability?.projectionCacheHits ?? 0)} projection reuses</small>
        </div>
      </div>

      <details className="sieve-projection">
        <summary>
          <span>
            <strong>{sieve.projectionMode === "standard-v2" ? "Standard V2" : "Projection"}</strong>
            <small>
              {sieve.projectionMode === "standard-v2"
                ? "Comparison and churn diagnostics."
                : "Frozen results carried between epochs."}
            </small>
          </span>
          <small>{sieve.projectionMode}</small>
          <IconChevronDown className="chev" size={15} aria-hidden="true" />
        </summary>
        <div className="sieve-projection-body">
          {sieve.projectionMode === "stable" ? (
            <dl>
              <div>
                <dt>Active pruning</dt>
                <dd>{sieve.activePruning ? "Enabled" : "Disabled"}</dd>
              </div>
              <div>
                <dt>Frozen results</dt>
                <dd>{formatCompactNumber(sieve.epoch?.frozenResultCount ?? 0)}</dd>
              </div>
              <div>
                <dt>Chars retained</dt>
                <dd>{formatCompactNumber(sieve.epoch?.frozenRetainedChars ?? 0)}</dd>
              </div>
              <div>
                <dt>Rollover eligible</dt>
                <dd>{formatCompactNumber(sieve.epoch?.rolloverEligibleRetainedChars ?? 0)}</dd>
              </div>
              <div>
                <dt>Epoch started</dt>
                <dd>{epochReason}</dd>
              </div>
              <div>
                <dt>Epoch ID</dt>
                <dd className="mono" title={sieve.epoch?.id}>
                  {sieve.epoch?.id ?? "Unavailable"}
                </dd>
              </div>
            </dl>
          ) : (
            <dl>
              <div>
                <dt>Comparisons</dt>
                <dd>{formatCompactNumber(sieve.stability?.standardComparisons ?? 0)}</dd>
              </div>
              <div>
                <dt>Prefix changes</dt>
                <dd>{formatCompactNumber(sieve.stability?.standardPrefixChurn ?? 0)}</dd>
              </div>
              <div>
                <dt>Chars invalidated</dt>
                <dd>{formatCompactNumber(sieve.stability?.standardEstimatedInvalidatedChars ?? 0)}</dd>
              </div>
              <div>
                <dt>Earliest change</dt>
                <dd>{sieve.stability?.standardEarliestChangedPriorMessageIndex ?? "None"}</dd>
              </div>
              {Object.entries(sieve.stability?.standardChangesByKind ?? {}).map(([kind, count]) => (
                <div key={kind}>
                  <dt>{kind.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
                  <dd>{formatCompactNumber(count)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </details>
      {sieve.error && (
        <p className="inline-alert" role="alert">
          {sieve.error}
        </p>
      )}
    </InspectorSection>
  );
}

function HeartbeatJobs({ jobs }: { jobs: JobReadModel[] }) {
  const active = jobs
    .filter(job => job.state === "running" || job.state === "cancelling")
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  const settled = jobs
    .filter(job => job.state !== "running" && job.state !== "cancelling")
    .sort(
      (left, right) => Date.parse(right.finishedAt ?? right.startedAt) - Date.parse(left.finishedAt ?? left.startedAt),
    )
    .slice(0, 6);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active.length]);
  const visible = [...active, ...settled];
  return (
    <InspectorSection title="Heartbeat jobs" meta={`${active.length} running`} className="heartbeat-panel">
      <div className="overview-list">
        {visible.map(job => {
          const startedAt = Date.parse(job.startedAt);
          const finishedAt = job.finishedAt ? Date.parse(job.finishedAt) : now;
          const duration = Math.max(0, finishedAt - startedAt);
          const state: OverviewState =
            job.state === "completed"
              ? "done"
              : job.state === "failed" || job.state === "timed_out"
                ? "failed"
                : job.state === "running" || job.state === "cancelling"
                  ? "running"
                  : "neutral";
          const timestamp = job.finishedAt ?? job.startedAt;
          const timingLabel = job.finishedAt ? "Finished" : "Started";
          const label = job.state === "completed" ? "Done" : job.state.replace("_", " ");
          return (
            <article className="overview-list-row" key={job.id}>
              <OverviewOrb state={state} label={label} />
              <div>
                <strong title={job.label}>{job.label}</strong>
                <small>
                  {timingLabel} {displayTime(timestamp)}
                  {job.exitCode !== undefined ? ` · exit ${job.exitCode ?? "signal"}` : ""}
                </small>
              </div>
              <OverviewStateLabel state={state}>{label}</OverviewStateLabel>
              <time className="mono">{formatDuration(duration)}</time>
            </article>
          );
        })}
        {visible.length === 0 && (
          <div className="empty-state">
            <IconActivityHeartbeat size={20} />
            <strong>No background jobs</strong>
            <span>Heartbeat has not started work in this session.</span>
          </div>
        )}
      </div>
    </InspectorSection>
  );
}

function InspectorSection({
  title,
  meta,
  indicator,
  className = "",
  defaultOpen = true,
  children,
}: {
  title: string;
  meta?: string;
  indicator?: { state: OverviewState; label: string };
  className?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className={`inspector-section ${className}`}
      open={open}
      onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span>
          <strong>{title}</strong>
          {indicator && <OverviewOrb state={indicator.state} label={indicator.label} />}
          {meta && <small>{meta}</small>}
        </span>
        <IconChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="inspector-section-content">{children}</div>
    </details>
  );
}

function TodoList({
  work,
}: {
  work: NonNullable<NonNullable<RuntimeStoreSnapshot["runtime"]>["operational"]["continuity"]["work"]>;
}) {
  return (
    <ol className="todo-list">
      {work.todos.map(todo => {
        const state: OverviewState =
          todo.status === "done"
            ? "done"
            : todo.status === "in_progress"
              ? "running"
              : todo.status === "blocked"
                ? "failed"
                : "neutral";
        const label = todo.status === "in_progress" ? "Running" : todo.status;
        return (
          <li className={`todo-item is-${todo.status}`} key={todo.id}>
            <OverviewOrb state={state} label={label} />
            <span className="todo-label">{todo.text}</span>
            <OverviewStateLabel state={state}>{label}</OverviewStateLabel>
          </li>
        );
      })}
    </ol>
  );
}

function FeatureUnavailable({ name }: { name: string }) {
  return (
    <div className="empty-state" role="status">
      <IconX size={20} />
      <strong>{name} unavailable</strong>
      <span>Installed package version does not expose compatible state.</span>
    </div>
  );
}

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`status status-${tone}`}>
      <span aria-hidden="true" />
      {children}
    </span>
  );
}
