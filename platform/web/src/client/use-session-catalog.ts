import { useEffect, useRef, useState } from "react";
import type { HeliosAndroidToolingResult } from "../shared/protocol/helios-android-tooling";
import type { ExtensionListSnapshot, HookSettingsReadModel, PackageSummary } from "../shared/protocol/snapshots";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

export type ReportError = (cause: unknown, fallback: string) => void;

/** True while the snapshot still describes the session that started a request. */
export function runtimeRequestStillCurrent(
  snapshot: RuntimeStoreSnapshot,
  sessionId: string,
  sessionGeneration: number,
): boolean {
  return (
    snapshot.connection === "connected" &&
    snapshot.runtime?.ready === true &&
    snapshot.runtime.sessionId === sessionId &&
    snapshot.runtime.sessionGeneration === sessionGeneration
  );
}

interface SessionResource<T> {
  load: () => Promise<T>;
  apply: (value: T) => void;
  /** Races against a session switch report themselves; they are not real failures. */
  stale: RegExp;
  fallback: string;
  reportError: ReportError;
}

/**
 * Loads one per-session resource whenever the session changes, discarding both
 * results and errors that arrive after the session has moved on. Returns whether
 * a load is in flight.
 */
function useSessionResource<T>(live: RuntimeStoreSnapshot, resource: SessionResource<T>): boolean {
  const [loading, setLoading] = useState(true);
  // Read through a ref so a new inline `resource` object never re-runs the load.
  const latest = useRef(resource);
  latest.current = resource;

  useEffect(() => {
    if (live.connection !== "connected" || !live.runtime?.ready) return;
    let active = true;
    const { load, apply, stale, fallback, reportError } = latest.current;
    const sessionId = live.runtime.sessionId;
    const generation = live.runtime.sessionGeneration;
    const current = () => runtimeRequestStillCurrent(runtimeStore.getSnapshot(), sessionId, generation);

    setLoading(true);
    void load()
      .then(result => {
        if (active && current()) apply(result);
      })
      .catch(cause => {
        const message = cause instanceof Error ? cause.message : fallback;
        if (stale.test(message)) return;
        if (active && current()) reportError(cause, fallback);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [live.connection, live.runtime?.ready, live.runtime?.sessionId, live.runtime?.sessionGeneration]);

  return loading;
}

/**
 * The installed packages, extensions, and hook settings for the selected session,
 * plus the per-area busy flags the settings dialog drives.
 */
export function useSessionCatalog(live: RuntimeStoreSnapshot, settingsOpen: boolean, reportError: ReportError) {
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [packageBusy, setPackageBusy] = useState("");
  const [extensions, setExtensions] = useState<ExtensionListSnapshot>();
  const [extensionBusy, setExtensionBusy] = useState("");
  const [hookSettings, setHookSettings] = useState<HookSettingsReadModel>();
  const [hooksBusy, setHooksBusy] = useState(false);
  const [androidTooling, setAndroidTooling] = useState<HeliosAndroidToolingResult>();
  const [androidToolingBusy, setAndroidToolingBusy] = useState<"" | "install" | "remove">("");

  const packagesLoading = useSessionResource(live, {
    load: () => runtimeStore.listPackages(),
    apply: result => setPackages(result.packages),
    stale: /session changed while listing packages|package list is stale/i,
    fallback: "Unable to list packages",
    reportError,
  });

  const extensionsLoading = useSessionResource(live, {
    load: () => runtimeStore.listExtensions(),
    apply: setExtensions,
    stale: /session changed while listing extensions|extension list is stale/i,
    fallback: "Unable to list extensions",
    reportError,
  });

  const hooksLoading = useSessionResource(live, {
    load: () => runtimeStore.listHookSettings(),
    apply: result => setHookSettings(result.settings),
    stale: /session changed while listing hook settings|hook settings are stale/i,
    fallback: "Unable to load hook settings",
    reportError,
  });

  // Android tooling is only inspected while the dialog that shows it is open.
  const heliosActive = packages.some(item => item.id === "pi-helios" && item.active);
  useEffect(() => {
    if (!settingsOpen || live.connection !== "connected" || !live.runtime?.ready || !heliosActive) return;
    let active = true;
    void runtimeStore
      .heliosAndroidTooling({ action: "status" })
      .then(result => {
        if (active) setAndroidTooling(result);
      })
      .catch(cause => {
        if (active) reportError(cause, "Unable to inspect Android tooling");
      });
    return () => {
      active = false;
    };
  }, [
    settingsOpen,
    live.connection,
    live.runtime?.ready,
    live.runtime?.sessionId,
    live.runtime?.sessionGeneration,
    heliosActive,
  ]);

  return {
    packages,
    setPackages,
    packagesLoading,
    packageBusy,
    setPackageBusy,
    extensions,
    setExtensions,
    extensionsLoading,
    extensionBusy,
    setExtensionBusy,
    hookSettings,
    setHookSettings,
    hooksLoading,
    hooksBusy,
    setHooksBusy,
    androidTooling,
    setAndroidTooling,
    androidToolingBusy,
    setAndroidToolingBusy,
  };
}
