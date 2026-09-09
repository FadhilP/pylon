import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDots,
  IconGitBranch,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type {
  GitActionInput,
  GitCommit,
  GitDetail,
  GitDetailQuery,
  GitFile,
  GitOperation,
  GitState,
} from "../../shared/workspace/git";
import type { DiffContentsLoader } from "../../shared/workspace/code-viewer-model";
import type { WorkspaceReadModel } from "../../shared/protocol/snapshots";
import { FileTypeIcon } from "../rendering/file-icons";
import type { RuntimeStoreSnapshot } from "../runtime/event-store";
import { ActionDialog } from "../ui/action-dialog";
import { copyText } from "../ui/clipboard";
import { reconstructConflictText, conflictChoiceText, type ConflictChoice } from "./git-review-model";
import { WorkspaceEditor } from "./workspace-editor";
import { FileContent } from "./files-panel";
import type { GitWorkspaceController } from "./git-controller";
import "./git-workspace.css";
export { useGitWorkspace } from "./git-controller";
const CodeViewer = lazy(() => import("../rendering/code-viewer"));
type OpenFile = (path: string, view?: "current" | "base" | "diff") => void;
type Takeover = "cherry" | "merge" | "rebase" | "branch";
export const isConflict = (file: GitFile) =>
  file.indexStatus === "U" ||
  file.worktreeStatus === "U" ||
  ["AA", "DD"].includes(file.indexStatus + file.worktreeStatus);
const staged = (file: GitFile) => !isConflict(file) && ![" ", "?", ""].includes(file.indexStatus);
const unstaged = (file: GitFile) => !isConflict(file) && ![" ", ""].includes(file.worktreeStatus);
const statusLetter = (file: GitFile) =>
  isConflict(file) ? "U" : file.indexStatus === "?" ? "A" : staged(file) ? file.indexStatus : file.worktreeStatus;
const pathsOf = (files: GitFile[]) => [
  ...new Set(files.flatMap(file => (file.oldPath ? [file.oldPath, file.path] : [file.path]))),
];
const short = (oid?: string) => oid?.slice(0, 9) ?? "";
const refLabel = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
const canMutate = (git: GitWorkspaceController) => git.ready && !git.busy && !git.dirty && !git.state?.truncated;

export function GitDialogs({ git }: { git: GitWorkspaceController }) {
  const request = git.confirmation;
  return request ? (
    <ActionDialog
      title={request.title}
      description={request.description}
      error={git.error}
      confirmLabel={request.label}
      busyLabel={`${request.label}…`}
      busy={git.busy}
      danger={request.danger}
      inputLabel={request.inputLabel}
      initialValue={request.initialValue}
      allowEmpty={request.allowEmpty}
      maxLength={2000}
      onCancel={() => git.ask(undefined)}
      onConfirm={value => void git.confirm(value)}
    />
  ) : null;
}
function Group({ name, count, children }: { name: string; count: number; children?: ReactNode }) {
  return (
    <header className="git-panel-group">
      <strong title={name}>{name}</strong>
      <small>{count}</small>
      <span />
      {children}
    </header>
  );
}
type WorkspaceApply = NonNullable<WorkspaceReadModel["lastApply"]>;
function SkeletonFiles({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div className="sk-row" key={index}>
          <span className="sk" />
          <span className="sk" style={{ "--sk-w": `${62 + ((index * 43) % 96)}px` } as CSSProperties} />
        </div>
      ))}
    </div>
  );
}
/** One banner at a time, worst news first. The warnings describe a live condition, so only a result or an error is dismissible. */
function Feedback({ git, apply }: { git: GitWorkspaceController; apply?: WorkspaceApply }) {
  const banner = git.error
    ? { tone: "danger", title: "Git action failed", body: git.error, role: "alert" as const, dismiss: true }
    : git.dirty
      ? { tone: "", title: "Unsaved drafts", body: "Save or discard editor drafts before Git actions. Only saved files can be staged." }
      : git.state?.truncated
        ? { tone: "", title: "Inspection truncated", body: "Git inspection exceeded its safe limit. Mutations are disabled." }
        : apply?.message
          ? { tone: apply.state === "conflict" || apply.state === "error" ? "danger" : "good", title: apply.state === "conflict" ? "Applied with conflicts" : apply.state === "error" ? "Apply failed" : "Applied", body: apply.message }
          : git.result
            ? { tone: "good", title: "Done", body: git.result, dismiss: true }
            : undefined;
  if (!banner) return null;
  return (
    <section className={`git-panel-op ${banner.tone}`} role={banner.role ?? "status"} aria-live="polite">
      <div className="git-op-title">
        <strong>{banner.title}</strong>
        {banner.dismiss && (
          <button className="git-op-dismiss" type="button" aria-label="Dismiss" onClick={git.dismiss}>
            <IconX size={14} />
          </button>
        )}
      </div>
      <p>{banner.body}</p>
    </section>
  );
}
function Composer({ git }: { git: GitWorkspaceController }) {
  const count = git.state?.files.filter(staged).length ?? 0;
  const disabled =
    !canMutate(git) || !!git.state?.operation || !git.message.trim() || (!count && !(git.amend && git.state?.head));
  return (
    <footer className="git-panel-composer">
      <textarea
        aria-label="Commit message"
        value={git.message}
        onChange={event => git.setMessage(event.target.value)}
        placeholder="Describe what changed"
        maxLength={100000}
      />
      <div className="git-composer-actions">
        <label>
          <input type="checkbox" checked={git.amend} onChange={event => git.setAmend(event.target.checked)} />
          Amend last commit
        </label>
        <button className="primary-button" disabled={disabled} onClick={() => void git.commit()}>
          Commit {count || ""}
        </button>
        <button
          className="secondary-button"
          disabled={disabled || git.amend || !git.state?.upstream}
          onClick={() => void git.commit(true)}>
          Commit & push
        </button>
      </div>
      {git.amend && <p>Amend rewrites the last commit, even with no staged files.</p>}
    </footer>
  );
}
function Operation({ git, review }: { git: GitWorkspaceController; review?: (query?: GitDetailQuery) => void }) {
  const state = git.state!;
  const op = state.operation;
  if (!op) return null;
  const conflicts = state.files.filter(isConflict);
  const revision = state.revision!;
  const sequence = op.kind !== "conflict";
  const confirm = (action: "abort" | "skip") => {
    if (op.kind === "conflict") return;
    const operation = op.kind;
    git.ask({
      title: `${action === "abort" ? "Abort" : "Skip commit in"} ${op.kind}?`,
      label: action === "abort" ? "Abort operation" : "Skip commit",
      danger: true,
      description:
        action === "abort"
          ? `Return to before the ${op.kind}. Resolutions made during this operation will be lost.`
          : `Drop ${op.currentCommit ?? "the current commit"} from this operation. Its changes will not be replayed.`,
      action: () => ({ action, operation, expectedRevision: revision, confirmed: true }),
    });
  };
  return (
    <section className={`git-panel-op ${conflicts.length ? "danger" : ""}`} aria-live="polite">
      <div className="git-op-title">
        <strong>
          {op.kind === "conflict"
            ? "Unmerged files"
            : `${op.kind[0].toUpperCase()}${op.kind.slice(1)} ${conflicts.length ? "stopped" : "in progress"}`}
        </strong>
        {op.step && (
          <code>
            {op.step}/{op.total ?? "?"}
          </code>
        )}
      </div>
      <p>
        {op.kind === "rebase" && (
          <>
            Replaying <code>{short(op.currentCommit)}</code> onto <code>{short(op.onto)}</code>.{" "}
          </>
        )}
        {conflicts.length ? `${conflicts.length} files need a decision.` : "All conflicted files have been staged."}
      </p>
      {op.total && (
        <div className="git-op-progress" role="img" aria-label={`${op.step ?? 0} of ${op.total} commits`}>
          {Array.from({ length: Math.min(40, op.total) }, (_, index) => (
            <i key={index} className={index < (op.step ?? 1) - 1 ? "done" : ""} />
          ))}
        </div>
      )}
      <div className="git-op-actions">
        {review && (
          <button onClick={() => review(conflicts[0] ? { kind: "conflict", path: conflicts[0].path } : undefined)}>
            Resolve here
          </button>
        )}
        {sequence && (
          <>
            <button
              disabled={!canMutate(git) || conflicts.length > 0}
              onClick={() => {
                if (op.kind !== "conflict")
                  void git.action({
                    action: "continue",
                    operation: op.kind,
                    expectedRevision: revision,
                    confirmed: true,
                  });
              }}>
              Continue
            </button>
            {op.kind !== "merge" && (
              <button disabled={!canMutate(git)} onClick={() => confirm("skip")}>
                Skip commit
              </button>
            )}
            <button disabled={!canMutate(git)} onClick={() => confirm("abort")}>
              Abort
            </button>
          </>
        )}
      </div>
    </section>
  );
}
function toggleFile(git: GitWorkspaceController, files: GitFile[], include: boolean) {
  const revision = git.state?.revision;
  if (!revision) return;
  void git.action(
    include
      ? { action: "stage", expectedRevision: revision, paths: pathsOf(files) }
      : { action: "unstage", expectedRevision: revision, paths: pathsOf(files), confirmed: true },
  );
}
function Count({ file }: { file: GitFile }) {
  return (
    <span className="git-file-count">
      {file.binary ? (
        "binary"
      ) : (
        <>
          <ins>{file.additions === undefined ? "" : `+${file.additions}`}</ins>
          <del>{file.deletions === undefined ? "" : `−${file.deletions}`}</del>
        </>
      )}
    </span>
  );
}

export function GitPanel({
  live,
  git,
  onClose,
  onReview,
  onOpenFile,
  onApply,
  onHandoff,
  onCheckout,
}: {
  live: RuntimeStoreSnapshot;
  git: GitWorkspaceController;
  onClose(): void;
  onReview(query?: GitDetailQuery): void;
  onOpenFile: OpenFile;
  onApply?: () => void;
  onHandoff?: () => void;
  onCheckout?: (branch: string) => void;
}) {
  const [tab, setTab] = useState<"changes" | "history" | "stashes">("changes");
  const [takeover, setTakeover] = useState<Takeover>();
  const [inspect, setInspect] = useState<GitDetailQuery>();
  const state = git.state;
  const workspace = live.runtime?.workspace;
  const revision = state?.revision ?? "";
  const menu = (kind: Takeover) => {
    setTakeover(kind);
    setInspect(undefined);
  };
  const openDetail = (query: GitDetailQuery) => {
    setInspect(query);
    git.select(query);
  };
  const askStash = () =>
    git.ask({
      title: "Stash changes?",
      description:
        "Shelve tracked and untracked changes in this workspace. Ignored files are not included. The stash remains shared by this repository’s worktrees.",
      label: "Stash changes",
      inputLabel: "Message (optional)",
      allowEmpty: true,
      action: message => ({
        action: "stash",
        expectedRevision: revision,
        message,
        includeUntracked: true,
        confirmed: true,
      }),
    });
  const discardAll = () =>
    git.ask({
      title: "Discard all changes?",
      description: `Permanently discard staged and unstaged edits, including untracked files: ${state?.files.map(file => file.path).join(", ")}. Stash instead if you might need them.`,
      label: "Discard everything",
      danger: true,
      action: () => ({
        action: "discard",
        expectedRevision: revision,
        paths: pathsOf(state!.files),
        scope: "all",
        confirmed: true,
      }),
    });
  return (
    <aside className="inspector git-panel is-open" id="git-panel" aria-label="Git">
      <header className="git-panel-head">
        <IconGitBranch size={16} />
        <strong>Git</strong>
        <span />
        <button title="Refresh Git status" aria-label="Refresh Git status" onClick={git.refresh}>
          <IconRefresh size={16} />
        </button>
        {state?.available && (
          <details className="git-menu">
            <summary aria-label="More Git actions">
              <IconDots size={16} />
            </summary>
            <div className="git-menu-sheet">
              <button
                disabled={!canMutate(git) || !state.remotes.length}
                onClick={() =>
                  git.ask({
                    title: "Fetch remote refs?",
                    description: `Fetch from ${state.remotes[0]?.name}. This does not merge changes into your working tree.`,
                    label: "Fetch",
                    action: () => ({ action: "fetch", expectedRevision: revision, confirmed: true }),
                  })
                }>
                Fetch from remote
              </button>
              <button disabled={!canMutate(git) || !state.files.length} onClick={askStash}>
                Stash changes
              </button>
              <button onClick={() => menu("cherry")}>Cherry-pick from a branch…</button>
              <button onClick={() => menu("merge")}>Merge a branch…</button>
              <button onClick={() => menu("rebase")}>Rebase onto…</button>
              <hr />
              <button onClick={() => menu("branch")}>New branch from here…</button>
              <button
                className="danger"
                disabled={!canMutate(git) || !state.files.length || !!state.operation}
                onClick={discardAll}>
                Discard all changes
              </button>
            </div>
          </details>
        )}
        <button title="Close Git panel" aria-label="Close Git panel" onClick={onClose}>
          <IconX size={16} />
        </button>
      </header>
      <Feedback git={git} apply={workspace?.lastApply} />
      {!state ? (
        git.ready ? (
          <div className="git-panel-loading" role="status" aria-busy="true">
            <SkeletonFiles />
          </div>
        ) : (
          <div className="git-panel-empty">Connect to a ready session to inspect Git.</div>
        )
      ) : !state.available ? (
        <div className="git-panel-empty">
          <strong>Git unavailable</strong>
          <p>{state.reason}</p>
          {state.revision && (
            <button
              className="primary-button"
              disabled={!canMutate(git)}
              onClick={() =>
                git.ask({
                  title: "Initialize repository?",
                  description: "Create Git metadata in this exact workspace folder. Existing files are not committed.",
                  label: "Initialize repository",
                  action: () => ({ action: "init", expectedRevision: revision, confirmed: true }),
                })
              }>
              Initialize repository
            </button>
          )}
        </div>
      ) : takeover ? (
        <Takeover key={takeover} kind={takeover} git={git} close={() => setTakeover(undefined)} />
      ) : inspect ? (
        <RevisionDetail
          git={git}
          query={inspect}
          close={() => {
            setInspect(undefined);
            git.select(undefined);
          }}
          review={onReview}
        />
      ) : (
        <>
          <p className="git-panel-desc">
            {workspace?.mode === "worktree"
              ? "Commit and sync the isolated worktree this session is working in."
              : workspace?.mode === "checkout"
                ? "This session uses a managed branch in the project checkout."
                : "This folder is used without Pylon worktree isolation."}
          </p>
          <div className="git-panel-ref">
            {onCheckout && !state.operation ? (
              <select
                aria-label="Switch branch"
                value={state.branch ?? ""}
                disabled={!canMutate(git)}
                onChange={event => onCheckout(event.target.value)}>
                {!state.branch && <option value="">Detached HEAD</option>}
                {state.branches
                  .filter(branch => !branch.remote)
                  .map(branch => (
                    <option key={branch.name} value={refLabel(branch.name)}>
                      {refLabel(branch.name)}
                    </option>
                  ))}
              </select>
            ) : (
              <code title={state.branch}>{state.branch ?? `Detached ${short(state.head)}`}</code>
            )}
            <span className={`git-panel-mode ${workspace?.mode === "local" ? "warn" : ""}`}>
              {workspace?.mode === "worktree"
                ? "Worktree"
                : workspace?.mode === "checkout"
                  ? "Project checkout"
                  : "Local folder"}
            </span>
          </div>
          <Operation git={git} review={onReview} />
          <Divergence git={git} />
          <nav className="git-panel-tabs" aria-label="Git sections">
            {(["changes", "history", "stashes"] as const).map(value => (
              <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
                {value[0].toUpperCase() + value.slice(1)}{" "}
                {value === "changes" ? (
                  <small>{state.files.length}</small>
                ) : value === "stashes" ? (
                  <small>{state.stashes.length}</small>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="git-panel-scroll">
            {tab === "changes" ? (
              <Changes git={git} review={onReview} />
            ) : tab === "history" ? (
              <History git={git} inspect={openDetail} />
            ) : (
              <Stashes git={git} inspect={openDetail} create={askStash} />
            )}
          </div>
          {tab === "changes" && !state.operation && <Composer git={git} />}
          <footer className="git-panel-apply">
            <p>
              {workspace?.mode === "worktree"
                ? "Apply the session delta without staging or committing. The session stays isolated."
                : "Review saved changes before committing."}
            </p>
            {onApply && (
              <button className="secondary-button" onClick={onApply}>
                Apply to project
              </button>
            )}
            {onHandoff && (
              <button className="secondary-button" onClick={onHandoff}>
                Move to worktree
              </button>
            )}
            <button className="primary-button" onClick={() => onReview()}>
              Review changes
            </button>
          </footer>
        </>
      )}
    </aside>
  );
}
function Divergence({ git }: { git: GitWorkspaceController }) {
  const state = git.state!;
  const revision = state.revision!;
  return (
    <>
      <div className="git-panel-track">
        <span>
          <code title={state.upstream}>{state.upstream ?? "No upstream"}</code>
          <small>{state.behind ?? 0} behind</small>
        </span>
        <i aria-hidden="true">
          {Array.from({ length: Math.min(state.behind ?? 0, 6) }, (_, i) => (
            <b className="behind" key={`b${i}`} />
          ))}
          <em />
          {Array.from({ length: Math.min(state.ahead ?? 0, 6) }, (_, i) => (
            <b className="ahead" key={`a${i}`} />
          ))}
        </i>
        <span>
          <code title={state.branch}>{state.branch ?? "HEAD"}</code>
          <small>{state.ahead ?? 0} ahead</small>
        </span>
      </div>
      {state.upstream && (
        <div className="git-panel-sync">
          <button
            className="secondary-button"
            disabled={!canMutate(git) || !!state.operation}
            onClick={() =>
              git.ask({
                title: "Pull upstream changes?",
                description: `Fast-forward ${state.branch} from ${state.upstream}. Diverged branches are refused; use Merge or Rebase explicitly.`,
                label: "Pull",
                action: () => ({ action: "pull", expectedRevision: revision, confirmed: true }),
              })
            }>
            <IconArrowDown size={14} />
            Pull
          </button>
          <button
            className="secondary-button"
            disabled={!canMutate(git) || !!state.operation}
            onClick={() =>
              git.ask({
                title: "Push commits?",
                description: `Push ${state.branch} to ${state.upstream}, without force. Unsaved or uncommitted changes are not pushed.`,
                label: "Push",
                action: () => ({ action: "push", expectedRevision: revision, confirmed: true }),
              })
            }>
            <IconArrowUp size={14} />
            Push
          </button>
        </div>
      )}
    </>
  );
}
function Changes({ git, review }: { git: GitWorkspaceController; review(query?: GitDetailQuery): void }) {
  const files = git.state!.files;
  const sections = [
    { name: "Conflicted", files: files.filter(isConflict), side: "unstaged" as const },
    { name: "Staged", files: files.filter(staged), side: "staged" as const },
    { name: "Changed", files: files.filter(unstaged), side: "unstaged" as const },
  ];
  if (!files.length)
    return (
      <div className="git-panel-empty">
        <IconCheck size={20} />
        <strong>Working tree clean</strong>
        <p>Committed session changes can still be inspected in Files.</p>
      </div>
    );
  return (
    <>
      {sections
        .filter(section => section.name !== "Conflicted" || section.files.length)
        .map(section => (
          <section key={section.name}>
            <Group name={section.name} count={section.files.length}>
              {section.name === "Conflicted" ? (
                <button onClick={() => review({ kind: "conflict", path: section.files[0].path })}>Resolve here</button>
              ) : (
                section.files.length > 0 && (
                  <>
                    <button
                      disabled={!canMutate(git) || !!git.state?.operation}
                      onClick={() => toggleFile(git, section.files, section.side !== "staged")}>
                      {section.side === "staged" ? "Unstage all" : "Stage all"}
                    </button>
                    {section.side === "unstaged" && (
                      <button
                        className="danger"
                        disabled={!canMutate(git) || !!git.state?.operation}
                        onClick={() =>
                          git.ask({
                            title: "Discard working changes?",
                            description: `Discard saved unstaged edits to ${section.files.map(file => file.path).join(", ")}. Tracked files return to the index; untracked files are permanently deleted.`,
                            label: "Discard changes",
                            danger: true,
                            action: () => ({
                              action: "discard",
                              expectedRevision: git.state!.revision!,
                              paths: pathsOf(section.files),
                              scope: "working",
                              confirmed: true,
                            }),
                          })
                        }>
                        Discard
                      </button>
                    )}
                  </>
                )
              )}
            </Group>
            {section.files.map(file => (
              <div className="git-panel-file" key={file.path}>
                <input
                  type="checkbox"
                  aria-label={`${section.side === "staged" ? "Unstage" : "Stage"} ${file.path}`}
                  checked={section.side === "staged"}
                  disabled={!canMutate(git) || !!git.state?.operation}
                  onChange={() => toggleFile(git, [file], section.side !== "staged")}
                />
                <b className={`letter ${statusLetter(file)}`}>{statusLetter(file)}</b>
                <button
                  title={file.path}
                  onClick={() =>
                    review(
                      isConflict(file)
                        ? { kind: "conflict", path: file.path }
                        : { kind: "file", path: file.path, stage: section.side },
                    )
                  }>
                  {file.path}
                </button>
                <Count file={file} />
                <IconChevronRight size={14} />
              </div>
            ))}
            {!section.files.length && (
              <p className="git-panel-desc">
                {section.side === "staged" ? "Choose files for this commit." : "Everything is staged."}
              </p>
            )}
          </section>
        ))}
    </>
  );
}
function History({ git, inspect }: { git: GitWorkspaceController; inspect(query: GitDetailQuery): void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<string>(undefined);
  const commits = git.state!.history;
  const selected = commits.filter(commit => picked.includes(commit.oid));
  return (
    <>
      {commits.map(commit => (
        <button
          key={commit.oid}
          className={`git-panel-commit ${picked.includes(commit.oid) ? "selected" : ""}`}
          aria-pressed={picked.includes(commit.oid)}
          onClick={event => {
            if (event.shiftKey && anchor.current) {
              const start = commits.findIndex(item => item.oid === anchor.current),
                end = commits.indexOf(commit);
              setPicked(commits.slice(Math.min(start, end), Math.max(start, end) + 1).map(item => item.oid));
            } else {
              anchor.current = commit.oid;
              setPicked([commit.oid]);
            }
          }}
          onDoubleClick={() => inspect({ kind: "commit", oid: commit.oid })}>
          <i />
          <span>
            <strong>{commit.subject}</strong>
            <small>
              <code>{short(commit.oid)}</code> · {commit.author} · {new Date(commit.authoredAt).toLocaleDateString()}
            </small>
          </span>
          <IconChevronRight size={14} />
        </button>
      ))}
      {!commits.length && <div className="git-panel-empty">No commits yet.</div>}
      {selected.length > 0 && (
        <footer className="git-panel-selection">
          <span>
            {selected.length === 1
              ? short(selected[0].oid)
              : `${short(selected.at(-1)!.oid)}…${short(selected[0].oid)}`}{" "}
            · {selected.length} selected
          </span>
          <button
            className="primary-button"
            onClick={() =>
              inspect(
                selected.length === 1
                  ? { kind: "commit", oid: selected[0].oid }
                  : { kind: "range", oldest: selected.at(-1)!.oid, newest: selected[0].oid },
              )
            }>
            Show changes
          </button>
          <button onClick={() => setPicked([])}>Clear</button>
        </footer>
      )}
      <p className="git-panel-desc">
        Latest 100 commits. Shift-click selects a contiguous run. Merge-commit diffs use the first parent.
      </p>
    </>
  );
}
function stashAction(
  git: GitWorkspaceController,
  stash: GitState["stashes"][number],
  action: "stashApply" | "stashPop" | "stashDrop",
) {
  const revision = git.state!.revision!;
  const verb = action === "stashApply" ? "Apply" : action === "stashPop" ? "Pop" : "Drop";
  git.ask({
    title: `${verb} this stash?`,
    label: `${verb} stash`,
    danger: action !== "stashApply",
    description: `${stash.selector} · ${stash.oid}\n${stash.subject}\n${action === "stashApply" ? "Apply its changes, keeping the stash." : action === "stashPop" ? "Apply its changes and remove the stash only if Git succeeds. Conflicts keep the stash." : "Remove the shelved changes from the stash list. This cannot be undone here."}`,
    action: () => ({ action, expectedRevision: revision, selector: stash.selector, oid: stash.oid, confirmed: true }),
  });
}
function Stashes({
  git,
  inspect,
  create,
}: {
  git: GitWorkspaceController;
  inspect(query: GitDetailQuery): void;
  create(): void;
}) {
  return (
    <>
      {git.state!.stashes.map(stash => (
        <div className="git-panel-stash" key={stash.selector}>
          <button onClick={() => inspect({ kind: "stash", oid: stash.oid })}>
            <strong>{stash.subject}</strong>
            <small>
              {stash.selector} · {short(stash.oid)}
            </small>
          </button>
          <span>
            {(["stashApply", "stashPop", "stashDrop"] as const).map(action => (
              <button
                key={action}
                disabled={!canMutate(git)}
                className={action === "stashDrop" ? "danger" : ""}
                onClick={() => stashAction(git, stash, action)}>
                {action.replace("stash", "")}
              </button>
            ))}
          </span>
        </div>
      ))}
      {!git.state!.stashes.length && (
        <div className="git-panel-empty">
          <strong>No stashes</strong>
          <p>Shelve work without making a commit.</p>
        </div>
      )}
      <button
        className="git-panel-stash-create secondary-button"
        disabled={!canMutate(git) || !git.state!.files.length}
        onClick={create}>
        Stash changes
      </button>
    </>
  );
}
function RevisionDetail({
  git,
  query,
  close,
  review,
}: {
  git: GitWorkspaceController;
  query: GitDetailQuery;
  close(): void;
  review(query: GitDetailQuery): void;
}) {
  const detail = git.detail;
  const state = git.state!;
  const stash = query.kind === "stash" ? state.stashes.find(item => item.oid === query.oid) : undefined;
  const commits =
    query.kind === "commit"
      ? state.history.filter(item => item.oid === query.oid)
      : query.kind === "range"
        ? state.history.slice(
            state.history.findIndex(item => item.oid === query.newest),
            state.history.findIndex(item => item.oid === query.oldest) + 1,
          )
        : [];
  const title = stash?.subject ?? (commits.length === 1 ? commits[0].subject : `${commits.length} commits`);
  return (
    <div className="git-panel-takeover">
      <header>
        <button aria-label="Back to Git list" onClick={close}>
          <IconChevronLeft size={16} />
        </button>
        <strong>{title}</strong>
      </header>
      <div className="git-panel-scroll">
        <p className="git-panel-desc">
          {stash
            ? `${stash.selector} · ${stash.oid}`
            : "Combined changes against the first parent of the oldest selected commit."}
        </p>
        <Group name="Files" count={detail?.files.length ?? 0}>
          <button onClick={() => review(query)}>Open diff</button>
        </Group>
        {!detail ? (
          <div className="git-panel-empty">Loading changes…</div>
        ) : (
          detail.files.map(file => (
            <button key={file.path} className="git-detail-file" title={file.path} onClick={() => review(query)}>
              <FileTypeIcon path={file.path} size={15} />
              <span>{file.path}</span>
              <Count file={file} />
            </button>
          ))
        )}
      </div>
      <footer>
        {stash ? (
          <>
            {(["stashApply", "stashPop", "stashDrop"] as const).map(action => (
              <button key={action} disabled={!canMutate(git)} onClick={() => stashAction(git, stash, action)}>
                {action.replace("stash", "")}
              </button>
            ))}
          </>
        ) : (
          <>
            <button
              className="danger"
              disabled={!canMutate(git) || !commits.length || !!state.operation}
              onClick={() => {
                const revision = state.revision!;
                git.ask({
                  title: `Revert ${commits.length} commits?`,
                  description: `Create one inverse commit per selected commit, newest first: ${commits.map(commit => commit.oid).join(", ")}. Merge commits require a manual mainline choice and are refused here.`,
                  label: "Revert commits",
                  danger: true,
                  action: () => ({
                    action: "revert",
                    expectedRevision: revision,
                    oids: commits.map(commit => commit.oid),
                    confirmed: true,
                  }),
                });
              }}>
              Revert
            </button>
            <button
              onClick={() =>
                void copyText(
                  query.kind === "range"
                    ? `${query.oldest}^..${query.newest}`
                    : query.kind === "commit"
                      ? query.oid
                      : "",
                )
              }>
              <IconCopy size={13} />
              Copy
            </button>
          </>
        )}
        <button className="primary-button" onClick={() => review(query)}>
          Open diff
        </button>
      </footer>
    </div>
  );
}
function Takeover({ kind, git, close }: { kind: Takeover; git: GitWorkspaceController; close(): void }) {
  const state = git.state!;
  const [target, setTarget] = useState(
    kind === "branch" ? "" : (state.branches.find(branch => !branch.current)?.name ?? ""),
  );
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    setPicked([]);
    if (kind === "cherry" && target) git.select({ kind: "history", ref: target });
  }, [kind, target]);
  const commits = git.detail?.commits ?? [];
  const ordered = commits.filter(commit => picked.includes(commit.oid)).reverse();
  const title =
    kind === "cherry" ? "Cherry-pick" : kind === "branch" ? "New branch" : kind === "merge" ? "Merge" : "Rebase";
  return (
    <div className="git-panel-takeover">
      <header>
        <button aria-label="Back to Git" onClick={close}>
          <IconChevronLeft size={16} />
        </button>
        <strong>{title}</strong>
      </header>
      <label>
        {kind === "branch" ? "Branch name" : "Source branch"}
        {kind === "branch" ? (
          <input value={target} onChange={event => setTarget(event.target.value)} />
        ) : (
          <select value={target} onChange={event => setTarget(event.target.value)}>
            {state.branches.map(branch => (
              <option key={branch.name} value={branch.name}>
                {refLabel(branch.name)}
              </option>
            ))}
          </select>
        )}
      </label>
      <div className="git-panel-scroll">
        {kind === "cherry" ? (
          commits.map(commit => (
            <label className="git-panel-pick" key={commit.oid}>
              <input
                type="checkbox"
                checked={picked.includes(commit.oid)}
                onChange={() =>
                  setPicked(previous =>
                    previous.includes(commit.oid)
                      ? previous.filter(oid => oid !== commit.oid)
                      : [...previous, commit.oid],
                  )
                }
              />
              <span>
                <strong>{commit.subject}</strong>
                <code>{short(commit.oid)}</code>
              </span>
            </label>
          ))
        ) : (
          <p className="git-panel-desc">
            {kind === "rebase"
              ? "Replay this branch’s commits onto the selected branch. Commit hashes change. A clean working tree is required."
              : kind === "merge"
                ? "Merge the selected branch into this workspace. Conflicts can be resolved in Review."
                : "Create a branch at HEAD without switching this session’s managed branch."}
          </p>
        )}
      </div>
      <footer>
        <button
          className="primary-button"
          disabled={!canMutate(git) || !target || (kind === "cherry" && !ordered.length)}
          onClick={() => {
            const revision = state.revision!;
            git.ask({
              title: `${title}?`,
              description:
                kind === "cherry"
                  ? `Replay oldest first onto ${state.branch}: ${ordered.map(commit => commit.oid).join(", ")}.`
                  : `${title} ${target} ${kind === "branch" ? `at ${state.head}` : `on ${state.branch}`}. ${kind === "rebase" ? "This rewrites commits." : ""}`,
              label: title,
              danger: kind === "rebase",
              action: () =>
                kind === "branch"
                  ? { action: "createBranch", expectedRevision: revision, name: target, confirmed: true }
                  : kind === "cherry"
                    ? {
                        action: "cherryPick",
                        expectedRevision: revision,
                        oids: ordered.map(commit => commit.oid),
                        confirmed: true,
                      }
                    : { action: kind, expectedRevision: revision, target, confirmed: true },
            });
          }}>
          {title}
          {kind === "cherry" ? ` ${ordered.length} commits` : ""}
        </button>
      </footer>
    </div>
  );
}

export function ReviewSurface({
  live,
  git,
  onClose,
  onOpenFile,
}: {
  live: RuntimeStoreSnapshot;
  git: GitWorkspaceController;
  onClose(): void;
  onOpenFile: OpenFile;
}) {
  const [path, setPath] = useState<string>();
  const [side, setSide] = useState<"staged" | "unstaged">("unstaged");
  const [edit, setEdit] = useState(false);
  const state = git.state;
  const query = git.selection;
  const historical = query?.kind === "commit" || query?.kind === "range" || query?.kind === "stash";
  const files = historical ? (git.detail?.files ?? []) : (state?.files ?? []);
  const requestedPath = historical ? (query.path ?? git.detail?.selectedPath) : path;
  const selected = files.find(file => file.path === requestedPath) ?? files.find(isConflict) ?? files[0];
  const selectedPath = selected?.path;
  const selectFile = (file: GitFile, nextSide = side) => {
    setPath(file.path);
    setEdit(false);
    if (historical) git.selectPath(file.path);
    if (!historical) {
      const actualSide =
        nextSide === "staged" && !staged(file)
          ? "unstaged"
          : nextSide === "unstaged" && !unstaged(file) && !isConflict(file)
            ? "staged"
            : nextSide;
      setSide(actualSide);
      git.select(
        isConflict(file) ? { kind: "conflict", path: file.path } : { kind: "file", path: file.path, stage: actualSide },
      );
    }
  };
  useEffect(() => {
    if (historical || !state || !selected) return;
    if (query && "path" in query && files.some(file => file.path === query.path)) {
      setPath(query.path);
      if (query.kind === "file") setSide(query.stage);
    } else selectFile(selected);
  }, [historical, query, state?.revision]);
  const groups = new Map<string, GitFile[]>();
  for (const file of files) {
    const name =
      state?.operation && !historical
        ? isConflict(file)
          ? "Conflicted"
          : "Ready"
        : file.path.includes("/")
          ? file.path.slice(0, file.path.lastIndexOf("/"))
          : "Workspace";
    groups.set(name, [...(groups.get(name) ?? []), file]);
  }
  const counts = files.reduce(
    (total, file) => ({ add: total.add + (file.additions ?? 0), del: total.del + (file.deletions ?? 0) }),
    { add: 0, del: 0 },
  );
  return (
    <section className="git-review" aria-label="Review changes">
      <aside className="git-review-set">
        <header>
          <div>
            <code>{state?.branch ?? "Review"}</code>
            <small>
              {historical
                ? "Historical changes · read only"
                : `${files.length} files · +${counts.add} / −${counts.del}`}
            </small>
          </div>
          <button aria-label="Close Review" onClick={onClose}>
            <IconX size={16} />
          </button>
        </header>
        {state?.operation && !historical && <Operation git={git} />}
        <div className="git-review-rows">
          {[...groups].map(([name, entries]) => (
            <section key={name}>
              <Group name={name} count={entries.length}>
                {!historical && !state?.operation && (
                  <button disabled={!canMutate(git)} onClick={() => toggleFile(git, entries, !entries.every(staged))}>
                    {entries.every(staged) ? "Leave all out" : "Include all"}
                  </button>
                )}
              </Group>
              {entries.map(file => (
                <div className={`git-review-row ${selectedPath === file.path ? "on" : ""}`} key={file.path}>
                  {historical || state?.operation ? (
                    <i className={`git-status-orb ${isConflict(file) ? "attention" : "done"}`} />
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={`Include ${file.path}`}
                      checked={staged(file)}
                      disabled={!canMutate(git)}
                      onChange={() => toggleFile(git, [file], !staged(file))}
                    />
                  )}
                  <FileTypeIcon path={file.path} size={15} />
                  <button title={file.path} onClick={() => selectFile(file)}>
                    {file.path.split("/").at(-1)}
                  </button>
                  {state?.operation && !historical ? (
                    <small>{isConflict(file) ? "unresolved" : "ready"}</small>
                  ) : (
                    <Count file={file} />
                  )}
                  <i className={`stripe ${statusLetter(file)}`} />
                </div>
              ))}
            </section>
          ))}
        </div>
        {!historical && !state?.operation && <Composer git={git} />}
      </aside>
      <main className="git-review-view">
        {!selectedPath ? (
          <div className="git-review-empty">
            <strong>{state ? "Nothing to review" : "Loading Git status…"}</strong>
            <p>Choose changes, a commit or a stash from Git.</p>
          </div>
        ) : (
          <>
            <header className="git-review-vbar">
              <code title={selectedPath}>{selectedPath}</code>
              <span className="git-review-toolbar">
                {!historical && !isConflict(selected!) && (
                  <>
                    <button
                      aria-pressed={side === "unstaged" && !edit}
                      disabled={!unstaged(selected!)}
                      onClick={() => selectFile(selected!, "unstaged")}>
                      Unstaged diff
                    </button>
                    <button
                      aria-pressed={side === "staged" && !edit}
                      disabled={!staged(selected!)}
                      onClick={() => selectFile(selected!, "staged")}>
                      Staged diff
                    </button>
                    <button aria-pressed={edit} onClick={() => setEdit(value => !value)}>
                      Working copy
                    </button>
                  </>
                )}
                <button onClick={() => onOpenFile(selectedPath, "current")}>Open file history</button>
              </span>
            </header>
            {edit && !historical ? (
              <WorkspaceEditor
                sessionId={live.runtime!.sessionId}
                generation={live.runtime!.sessionGeneration}
                path={selectedPath}
                revision={state?.revision ?? ""}
                ready={git.ready}
                disabled={git.busy}>
                {value => <FileContent view="current" value={value} onError={() => git.refresh()} />}
              </WorkspaceEditor>
            ) : query?.kind === "conflict" && git.detail?.conflict?.path === selectedPath ? (
              <ConflictResolver
                key={`${selectedPath}:${git.detail.conflict.version}`}
                git={git}
                detail={git.detail}
                operation={git.detail.conflict.operation}
                open={() => onOpenFile(selectedPath, "current")}
              />
            ) : (
              <ReviewDiff
                path={selectedPath}
                detail={historical && git.detail?.selectedPath !== selectedPath ? undefined : git.detail}
                historical={historical || side === "staged"}
              />
            )}
          </>
        )}
      </main>
    </section>
  );
}
function ReviewDiff({ path, detail, historical }: { path: string; detail?: GitDetail; historical: boolean }) {
  const loader = useMemo<DiffContentsLoader | undefined>(
    () =>
      detail
        ? async requested => {
            const file = detail.files.find(item => item.path === requested);
            if (!file || file.textTruncated) throw new Error("Full source is unavailable for this file.");
            return { oldFile: { contents: file.beforeText ?? "" }, newFile: { contents: file.afterText ?? "" } };
          }
        : undefined,
    [detail],
  );
  if (!detail) return <div className="git-review-empty">Loading diff…</div>;
  if (!detail.unifiedDiff) return <div className="git-review-empty">No changes in this comparison.</div>;
  return (
    <Suspense fallback={<div className="git-review-empty">Rendering…</div>}>
      <CodeViewer
        mode="diff"
        path={path}
        text={detail.unifiedDiff}
        revision={detail.revision ?? "git"}
        showFileHeaders
        scrollToFile={{ path, token: 1 }}
        loadDiffFiles={loader}
        annotationSource={
          detail.truncated
            ? undefined
            : { kind: historical ? "historical" : "current", revision: `Git review: ${detail.revision}` }
        }
      />
    </Suspense>
  );
}
function ConflictResolver({
  git,
  detail,
  operation,
  open,
}: {
  git: GitWorkspaceController;
  detail: GitDetail;
  operation?: GitOperation;
  open(): void;
}) {
  const conflict = detail.conflict!;
  const choiceKey = `${conflict.path}:${conflict.version}:${operation?.kind}:${operation?.currentCommit ?? ""}`;
  const choices = git.conflictChoices[choiceKey] ?? {};
  const setChoices = (
    next:
      Record<number, ConflictChoice> | ((previous: Record<number, ConflictChoice>) => Record<number, ConflictChoice>),
  ) => {
    git.setConflictChoices(previous => ({
      ...previous,
      [choiceKey]: typeof next === "function" ? next(previous[choiceKey] ?? {}) : next,
    }));
  };
  const all = conflict.blocks.every((_, index) => choices[index]);
  const text = all ? reconstructConflictText(conflict.text, conflict.blocks, choices) : undefined;
  const stale = detail.revision !== git.state?.revision;
  const ours = operation?.kind === "rebase" ? "New base" : "This branch";
  const theirs = operation?.kind === "rebase" ? "Your commit" : "Incoming";
  const chooseAll = (choice: ConflictChoice) =>
    setChoices(Object.fromEntries(conflict.blocks.map((_, index) => [index, choice])));
  let cursor = 0;
  const views: ReactNode[] = [];
  conflict.blocks.forEach((block, index) => {
    if (block.start > cursor)
      views.push(
        <pre className="git-conflict-context" key={`ctx${index}`}>
          {conflict.text.slice(cursor, block.start)}
        </pre>,
      );
    const choice = choices[index];
    const kept = choice ? conflictChoiceText(block, choice) : undefined;
    views.push(
      <section className="git-review-conflict" key={index}>
        <header>
          <strong>
            Conflict {index + 1}
            {choice
              ? ` · kept ${choice === "ours" ? ours.toLowerCase() : choice === "theirs" ? theirs.toLowerCase() : "both, in order"}`
              : ""}
          </strong>
          <span>
            {(["ours", "theirs", "both"] as const).map(value => (
              <button
                key={value}
                aria-pressed={choice === value}
                onClick={() => setChoices(previous => ({ ...previous, [index]: value }))}>
                {value === "ours" ? ours : value === "theirs" ? theirs : "Both"}
              </button>
            ))}
          </span>
        </header>
        {kept !== undefined ? (
          <pre>{kept}</pre>
        ) : (
          <>
            <div className="ours">
              <small>
                {operation?.kind === "rebase" ? `Already on ${short(operation.onto)}` : (block.oursLabel ?? ours)}
              </small>
              <pre>{block.ours}</pre>
            </div>
            <div className="theirs">
              <small>
                {operation?.kind === "rebase"
                  ? `From your commit ${short(operation.currentCommit)}`
                  : (block.theirsLabel ?? theirs)}
              </small>
              <pre>{block.theirs}</pre>
            </div>
          </>
        )}
      </section>,
    );
    cursor = block.end;
  });
  if (cursor < conflict.text.length)
    views.push(
      <pre className="git-conflict-context" key="tail">
        {conflict.text.slice(cursor)}
      </pre>,
    );
  return (
    <>
      <div className="git-review-conflict-bar">
        <span>
          {stale
            ? "Repository state changed. Choices are retained; reload before resolving."
            : "Choices stay local until you mark this file resolved."}
        </span>
        <small>
          {Object.keys(choices).length}/{conflict.blocks.length} chosen
        </small>
        <button
          className="primary-button"
          disabled={!all || stale || !canMutate(git)}
          onClick={async () => {
            if (text === undefined || !detail.revision) return;
            if (
              await git.action({
                action: "resolve",
                expectedRevision: detail.revision,
                path: conflict.path,
                expectedVersion: conflict.version,
                text,
                confirmed: true,
              })
            )
              git.select(undefined);
          }}>
          Mark resolved
        </button>
      </div>
      <div className="git-review-conflict-tools">
        <button onClick={() => chooseAll("ours")}>Keep all from {ours.toLowerCase()}</button>
        <button onClick={() => chooseAll("theirs")}>Keep all from {theirs.toLowerCase()}</button>
        <button onClick={open}>Edit manually</button>
        <button
          onClick={() => {
            if (
              !Object.keys(choices).length ||
              window.confirm("Reload this file and discard the conflict choices made here?")
            ) {
              setChoices({});
              git.select({ kind: "conflict", path: conflict.path });
            }
          }}>
          Reload conflict
        </button>
      </div>
      <div className="git-review-conflicts">
        {views}
        {!conflict.blocks.length && (
          <p className="git-panel-desc">No markers remain. Mark resolved to stage the manually edited file.</p>
        )}
      </div>
    </>
  );
}
