import { useEffect, useRef, useState } from "react";
import {
  validGitHubClientId,
  validGitHubRepository,
  type GitHubAuthInput,
  type GitHubAuthSnapshot,
} from "../../shared/settings/github";
import { runtimeStore, useRuntimeStore } from "../runtime/event-store";

export function GitHubSettingsPanel() {
  const connection = useRuntimeStore().connection;
  const [snapshot, setSnapshot] = useState<GitHubAuthSnapshot>();
  const [clientId, setClientId] = useState("");
  const [repository, setRepository] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const accept = (value: GitHubAuthSnapshot) =>
    setSnapshot(previous => (!previous || value.revision >= previous.revision ? value : previous));

  useEffect(() => {
    const current = ++epoch.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(undefined);
    setBusy(false);
    if (connection !== "connected") return;
    const load = async () => {
      try {
        const value = await runtimeStore.githubAuth(controller.signal);
        if (epoch.current !== current) return;
        accept(value);
        setClientId(previous => previous || value.clientId);
        timer = setTimeout(
          () => void load(),
          ["starting", "authorizing", "checking"].includes(value.phase) ? 1000 : 5000,
        );
      } catch (cause) {
        if (epoch.current !== current) return;
        setError(cause instanceof Error ? cause.message : "Cannot load GitHub connection");
        timer = setTimeout(() => void load(), 5000);
      }
    };
    void load();
    return () => {
      ++epoch.current;
      controller.abort();
      clearTimeout(timer);
    };
  }, [connection]);

  const act = async (input: GitHubAuthInput) => {
    if (!snapshot || busy) return;
    const current = epoch.current;
    setBusy(true);
    setError("");
    try {
      const value = await runtimeStore.githubAuthAction({ ...input, expectedRevision: snapshot.revision });
      if (epoch.current === current) accept(value);
    } catch (cause) {
      if (epoch.current === current) {
        setError(cause instanceof Error ? cause.message : "GitHub action failed. Refresh before retrying.");
        await runtimeStore
          .githubAuth()
          .then(value => {
            if (epoch.current === current) accept(value);
          })
          .catch(() => undefined);
      }
    } finally {
      if (epoch.current === current) setBusy(false);
    }
  };
  const running = snapshot && ["starting", "authorizing", "checking"].includes(snapshot.phase);
  const disabled = busy || connection !== "connected" || !snapshot;

  return (
    <div className="extension-settings" data-settings-search-target="github-account">
      <div className="settings-pane-header">
        <div>
          <h2>Integrations</h2>
          <p>Connect GitHub separately from AI providers and Git transport credentials.</p>
        </div>
      </div>
      <section className="workbench-section">
        <header>
          <div>
            <h4>GitHub.com</h4>
            <p>One account per Pylon agent-data directory. Tokens stay in the server’s OS credential vault.</p>
          </div>
        </header>
        <details>
          <summary>Set up a GitHub App</summary>
          <p>
            Register a{" "}
            <a href="https://github.com/settings/apps/new" target="_blank" rel="noreferrer">
              GitHub App
            </a>
            , enable Device flow, and keep user-token expiration enabled. Use its public <strong>client ID</strong>, not
            its app ID or a client secret. Webhooks are not needed.
          </p>
          <p>
            For a future read-only PR viewer, configure Pull requests and Contents as read-only. Install the app on
            selected repositories; organization approval may be required. No PR features are enabled here yet.
          </p>
          <p>Alternatively, the server can supply the public client ID through PYLON_GITHUB_CLIENT_ID.</p>
        </details>
        {(error || snapshot?.error) && <p role="alert">{error || snapshot?.error}</p>}
        <div role="status" aria-live="polite">
          {!snapshot ? (
            <p>{connection === "connected" ? "Loading GitHub connection…" : "Reconnect to Pylon to manage GitHub."}</p>
          ) : snapshot.account ? (
            <p>
              <strong>{snapshot.account.login}</strong> —{" "}
              {snapshot.verifiedAt ? "Verified" : "Saved connection; verify access with Reconnect"}
            </p>
          ) : (
            <p>{snapshot.phase === "disconnected" ? "Not connected" : "GitHub login in progress…"}</p>
          )}
          {snapshot?.expiresAt && (
            <p>
              Access token expires {new Date(snapshot.expiresAt).toLocaleString()}. Reconnect renews it when needed.
            </p>
          )}
        </div>
        {!snapshot?.account && !running && (
          <form
            className="extension-install"
            onSubmit={event => {
              event.preventDefault();
              void act({ action: "start", clientId: clientId.trim() });
            }}>
            <input
              aria-label="GitHub App client ID"
              aria-describedby="github-client-help"
              value={clientId}
              onChange={event => setClientId(event.target.value)}
              placeholder="GitHub App public client ID"
              disabled={disabled}
              autoComplete="off"
            />
            <button type="submit" disabled={disabled || !validGitHubClientId(clientId.trim())}>
              Connect GitHub
            </button>
          </form>
        )}
        <p id="github-client-help">
          No client secret or password is needed. Credentials never enter chat or model-provider requests through this
          integration.
        </p>
        {snapshot?.device && (
          <div role="status">
            <p>
              Open{" "}
              <a href={snapshot.device.verificationUri} target="_blank" rel="noreferrer">
                GitHub device authorization
              </a>{" "}
              and enter <strong>{snapshot.device.userCode}</strong>.
            </p>
            <p>
              Verify that GitHub shows the app you intended to authorize. This code expires{" "}
              {new Date(snapshot.device.expiresAt).toLocaleTimeString()}.
            </p>
          </div>
        )}
        {running && !snapshot?.device && (
          <p>Waiting for GitHub. If another tab started login, its authorization instructions stay in that tab.</p>
        )}
        {running && !snapshot?.account && (
          <button type="button" disabled={disabled} onClick={() => void act({ action: "cancel" })}>
            Cancel login (initiating tab only)
          </button>
        )}
        {snapshot?.account && !running && (
          <button type="button" disabled={disabled} onClick={() => void act({ action: "reconnect" })}>
            Reconnect / verify account
          </button>
        )}
        {(snapshot?.account || snapshot?.error || running) && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (
                window.confirm(
                  "Remove Pylon’s locally saved GitHub credentials and cancel pending login? This does not revoke authorization on GitHub.",
                )
              )
                void act({ action: "disconnect" });
            }}>
            Disconnect locally
          </button>
        )}
        <p>
          <a
            href="https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps"
            target="_blank"
            rel="noreferrer">
            Review or revoke GitHub App authorization
          </a>{" "}
          in GitHub Settings → Applications → Authorized GitHub Apps. Local disconnect only deletes Pylon’s saved
          credentials.
        </p>
      </section>
      {snapshot?.account && (
        <section className="workbench-section">
          <header>
            <div>
              <h4>Check repository access</h4>
              <p>
                Login does not grant access beyond your account and the app’s installation. This check reads repository
                metadata, not source files.
              </p>
            </div>
          </header>
          <form
            className="extension-install"
            onSubmit={event => {
              event.preventDefault();
              void act({ action: "repository", repository: repository.trim() });
            }}>
            <input
              aria-label="GitHub repository owner/name"
              value={repository}
              onChange={event => setRepository(event.target.value)}
              placeholder="owner/repository"
              disabled={disabled || running}
              autoComplete="off"
            />
            <button type="submit" disabled={disabled || running || !validGitHubRepository(repository.trim())}>
              Check access
            </button>
          </form>
          {snapshot.repository && (
            <p role="status">
              Repository metadata accessible: {snapshot.repository.fullName} (
              {snapshot.repository.private ? "private" : "public"}). This does not prove app installation on public
              repositories or permission for future PR actions.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
