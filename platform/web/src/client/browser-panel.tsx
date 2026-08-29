import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconLoader2,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import type { HeliosBrowserCommand, HeliosBrowserResult } from "../shared/protocol/helios";
import {
  ACTIVE_FRAME_INTERVAL_MS,
  ACTIVE_FRAME_WINDOW_MS,
  IDLE_FRAME_INTERVAL_MS,
  METADATA_INTERVAL_MS,
  framePollingDelay,
} from "../shared/browser-polling";
import { runtimeStore } from "./runtime/event-store";

type Action = Omit<HeliosBrowserCommand, "expectedGeneration">;

function viewportSize(element: HTMLElement | null) {
  const width = Math.round(element?.clientWidth ?? 900);
  const height = Math.round(element?.clientHeight ?? 650);
  return { width: Math.max(320, Math.min(1920, width)), height: Math.max(240, Math.min(1080, height)) };
}

function navigableUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "about:blank" || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed || "about:blank";
  return `https://${trimmed}`;
}

export function BrowserPanel({
  connected,
  generation,
  mirrorRequest,
  onActiveChange,
  onClose,
  onError,
}: {
  connected: boolean;
  generation?: number;
  mirrorRequest: string;
  onActiveChange: (active: boolean) => void;
  onClose: () => void;
  onError: (cause: unknown, fallback: string) => void;
}) {
  const [browser, setBrowser] = useState<HeliosBrowserResult>();
  const [frame, setFrame] = useState("");
  const [address, setAddress] = useState("about:blank");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const active = useRef(true);
  const moveQueued = useRef<{ x: number; y: number } | undefined>(undefined);
  const moveSending = useRef(false);
  const wheelQueued = useRef<{ x: number; y: number; deltaX: number; deltaY: number } | undefined>(undefined);
  const wheelSending = useRef(false);
  const activeUntil = useRef(0);
  const wakePolling = useRef<() => void>(() => undefined);
  const requestSequence = useRef(0);
  const appliedStateSequence = useRef(0);
  const appliedFrameSequence = useRef(0);
  const handledMirrorRequest = useRef("");

  const markActive = () => {
    activeUntil.current = Date.now() + ACTIVE_FRAME_WINDOW_MS;
    wakePolling.current();
  };

  const request = async (action: Action, silent = false) => {
    const snapshot = runtimeStore.getSnapshot();
    if (snapshot.connection !== "connected" || !snapshot.runtime?.ready) return;
    const sessionId = snapshot.runtime.sessionId;
    const sessionGeneration = snapshot.runtime.sessionGeneration;
    const stillCurrent = () => {
      const current = runtimeStore.getSnapshot();
      return (
        current.connection === "connected" &&
        current.runtime?.ready === true &&
        current.runtime.sessionId === sessionId &&
        current.runtime.sessionGeneration === sessionGeneration
      );
    };
    const sequence = ++requestSequence.current;
    try {
      const result = await runtimeStore.heliosBrowser(action);
      if (!active.current || !stillCurrent()) return;
      if (sequence >= appliedStateSequence.current) {
        appliedStateSequence.current = sequence;
        setBrowser(result);
        onActiveChange(result.active);
        if (result.page?.url && document.activeElement !== addressRef.current) setAddress(result.page.url);
        setError("");
      }
      if (result.frame && sequence >= appliedFrameSequence.current) {
        appliedFrameSequence.current = sequence;
        setFrame(`data:${result.frame.mimeType};base64,${result.frame.data}`);
      }
      return result;
    } catch (cause) {
      if (!active.current || !stillCurrent()) return;
      if (!silent) setError(cause instanceof Error ? cause.message : "Browser request failed");
      throw cause;
    }
  };

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const snapshot = runtimeStore.getSnapshot();
      if (snapshot.connection === "connected" && snapshot.runtime?.ready) {
        void runtimeStore.heliosBrowser({ action: "release" }).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    void request({ action: "status" }).catch(() => undefined);
  }, [connected, generation]);

  useEffect(() => {
    if (!connected || !mirrorRequest || handledMirrorRequest.current === mirrorRequest) return;
    if (browser?.active && browser.state === "ready") {
      handledMirrorRequest.current = mirrorRequest;
      return;
    }
    let stopped = false;
    let timer: number | undefined;
    const deadline = Date.now() + 80_000;
    const poll = async () => {
      const result = await request({ action: "status" }, true).catch(() => undefined);
      if (stopped) return;
      if ((result?.active && result.state === "ready") || Date.now() >= deadline) {
        handledMirrorRequest.current = mirrorRequest;
        return;
      }
      timer = window.setTimeout(poll, 500);
    };
    timer = window.setTimeout(poll, 250);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [browser?.active, browser?.state, connected, generation, mirrorRequest]);

  useEffect(() => {
    if (!browser?.active || browser.ownership !== "owned" || browser.state !== "ready") return;
    const controlled = browser.controlled;
    let stopped = false;
    let polling = false;
    let timer: number | undefined;
    let nextPollAt = 0;
    let metadataDueAt = Date.now() + METADATA_INTERVAL_MS;
    let release = Promise.resolve<unknown>(undefined);

    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      nextPollAt = 0;
    };
    const schedule = (delay: number) => {
      clearTimer();
      if (stopped || document.hidden) return;
      nextPollAt = Date.now() + delay;
      timer = window.setTimeout(poll, delay);
    };
    const poll = async () => {
      timer = undefined;
      nextPollAt = 0;
      if (stopped || polling || document.hidden) return;
      polling = true;
      const startedAt = Date.now();
      const frameResult = await request({ action: "frame" }, true).catch(() => undefined);
      if (!frameResult) await request({ action: "status" }, true).catch(() => undefined);
      if (controlled && !stopped && !document.hidden && Date.now() >= metadataDueAt) {
        metadataDueAt = Date.now() + METADATA_INTERVAL_MS;
        await request({ action: "tab-list" }, true).catch(() => undefined);
      }
      polling = false;
      if (!stopped && !document.hidden) {
        const delay =
          (controlled ? framePollingDelay(Date.now(), activeUntil.current) : IDLE_FRAME_INTERVAL_MS) -
          (Date.now() - startedAt);
        schedule(Math.max(0, delay));
      }
    };
    const wake = () => {
      if (stopped || polling || document.hidden) return;
      const now = Date.now();
      if (timer !== undefined && nextPollAt <= now + ACTIVE_FRAME_INTERVAL_MS) return;
      schedule(0);
    };
    const suspend = () => {
      clearTimer();
      moveQueued.current = undefined;
      wheelQueued.current = undefined;
      if (controlled) release = runtimeStore.heliosBrowser({ action: "release" }).catch(() => undefined);
    };
    const resume = async () => {
      await release;
      if (stopped || document.hidden) return;
      const result = controlled
        ? await request({ action: "acquire" }, true).catch(async () =>
            request({ action: "status" }, true).catch(() => undefined),
          )
        : await request({ action: "status" }, true).catch(() => undefined);
      if (!stopped && !document.hidden && result?.active && result.ownership === "owned") {
        if (result.controlled) activeUntil.current = Date.now() + ACTIVE_FRAME_WINDOW_MS;
        schedule(0);
      }
    };
    const visibility = () => {
      if (document.hidden) suspend();
      else void resume();
    };

    activeUntil.current = Date.now() + ACTIVE_FRAME_WINDOW_MS;
    wakePolling.current = wake;
    document.addEventListener("visibilitychange", visibility);
    if (document.hidden) suspend();
    else schedule(0);
    return () => {
      stopped = true;
      clearTimer();
      wakePolling.current = () => undefined;
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [browser?.active, browser?.controlled, browser?.ownership, browser?.state]);

  useEffect(() => {
    if (!browser?.active || browser.ownership !== "owned" || browser.state !== "ready" || !viewportRef.current) return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(
        () => void request({ action: "resize", ...viewportSize(viewportRef.current) }, true).catch(() => undefined),
        180,
      );
    });
    observer.observe(viewportRef.current);
    return () => {
      observer.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [browser?.active, browser?.ownership, browser?.state]);

  const run = async (label: string, action: Action) => {
    if (busy) return;
    markActive();
    setBusy(label);
    try {
      await request(action);
    } catch (cause) {
      onError(cause, `Unable to ${label.toLowerCase()}`);
    } finally {
      if (active.current) setBusy("");
    }
  };

  const point = (clientX: number, clientY: number) => {
    const image = imageRef.current;
    if (!image?.naturalWidth || !image.naturalHeight) return;
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    const left = rect.left + (rect.width - width) / 2;
    const top = rect.top + (rect.height - height) / 2;
    if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return;
    return { x: Math.round((clientX - left) / scale), y: Math.round((clientY - top) / scale) };
  };

  const sendMove = (next: { x: number; y: number }) => {
    moveQueued.current = next;
    if (moveSending.current) return;
    const flush = async () => {
      const current = moveQueued.current;
      if (!current) {
        moveSending.current = false;
        return;
      }
      moveQueued.current = undefined;
      moveSending.current = true;
      await request({ action: "pointer", phase: "move", ...current }, true).catch(() => undefined);
      void flush();
    };
    void flush();
  };

  const pointer = (event: ReactPointerEvent<HTMLDivElement>, phase: "move" | "down" | "up") => {
    if (!browser?.controlled) return;
    const position = point(event.clientX, event.clientY);
    if (!position) return;
    markActive();
    if (phase === "move") return sendMove(position);
    event.preventDefault();
    if (phase === "down") event.currentTarget.setPointerCapture(event.pointerId);
    const button = event.button === 1 ? "middle" : event.button === 2 ? "right" : "left";
    void request({ action: "pointer", phase, button, ...position }, true).catch(() => undefined);
  };

  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!browser?.controlled) return;
    const position = point(event.clientX, event.clientY);
    if (!position) return;
    markActive();
    event.preventDefault();
    const previous = wheelQueued.current;
    wheelQueued.current = {
      ...position,
      deltaX: Math.max(-5000, Math.min(5000, Math.round(event.deltaX) + (previous?.deltaX ?? 0))),
      deltaY: Math.max(-5000, Math.min(5000, Math.round(event.deltaY) + (previous?.deltaY ?? 0))),
    };
    if (wheelSending.current) return;
    const flush = async () => {
      const current = wheelQueued.current;
      if (!current) {
        wheelSending.current = false;
        return;
      }
      wheelQueued.current = undefined;
      wheelSending.current = true;
      await request({ action: "wheel", ...current }, true).catch(() => undefined);
      void flush();
    };
    void flush();
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    void run("Navigate", { action: "navigate", url: navigableUrl(address) });
  };

  const owned = browser?.ownership === "owned";
  return (
    <aside id="browser-panel" className="inspector browser-panel is-open" aria-labelledby="browser-title">
      <header>
        <div>
          <IconWorld size={18} />
          <strong id="browser-title">Helios Browser</strong>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close browser panel">
          <IconX size={17} />
        </button>
      </header>
      <div className="browser-toolbar">
        <button
          type="button"
          disabled={!browser?.controlled || Boolean(busy)}
          onClick={() => void run("Go back", { action: "back" })}
          aria-label="Back">
          <IconArrowLeft size={15} />
        </button>
        <button
          type="button"
          disabled={!browser?.controlled || Boolean(busy)}
          onClick={() => void run("Go forward", { action: "forward" })}
          aria-label="Forward">
          <IconArrowRight size={15} />
        </button>
        <button
          type="button"
          disabled={!browser?.controlled || Boolean(busy)}
          onClick={() => void run("Reload", { action: "reload" })}
          aria-label="Reload">
          <IconRefresh className={busy === "Reload" ? "spin" : ""} size={15} />
        </button>
        <form onSubmit={navigate}>
          <input
            ref={addressRef}
            aria-label="Address"
            value={address}
            onChange={event => setAddress(event.target.value)}
            disabled={!browser?.controlled}
            spellCheck={false}
          />
        </form>
        {browser?.controlled && (
          <button
            className="browser-stop"
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void run("Close browser", { action: "close" })}
            aria-label="Close Helios browser">
            <IconPlayerStop size={15} />
          </button>
        )}
      </div>
      {browser?.active && owned && (
        <div className="browser-tabs">
          {browser.controlled ? (
            <>
              <select
                aria-label="Browser tab"
                value={browser.page?.index ?? ""}
                onChange={event =>
                  void run("Switch tab", { action: "tab-select", tabIndex: Number(event.target.value) })
                }>
                {(browser.tabs ?? []).map(tab => (
                  <option key={tab.index} value={tab.index}>
                    {tab.title || tab.url}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void run("Create tab", { action: "tab-new" })} aria-label="New tab">
                <IconPlus size={14} />
              </button>
              <button
                type="button"
                disabled={browser.page === undefined}
                onClick={() =>
                  browser.page && void run("Close tab", { action: "tab-close", tabIndex: browser.page.index })
                }
                aria-label="Close tab">
                <IconX size={14} />
              </button>
            </>
          ) : (
            <>
              <span>Live mirror · Agent control</span>
              <button
                className="browser-take-control"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void run("Take control", { action: "acquire" })}>
                {busy || "Take control"}
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="browser-error" role="alert">
          {error}
        </p>
      )}
      {!browser && (
        <div className="browser-empty">
          <IconLoader2 className="spin" size={22} />
          <span>Checking Helios…</span>
        </div>
      )}
      {browser && !browser.active && (
        <div className="browser-empty">
          <IconWorld size={28} />
          <strong>Launch embedded browser</strong>
          <span>An isolated headless browser will run locally and stay out of session history.</span>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() =>
              void run("Launch browser", {
                action: "start",
                url: navigableUrl(address),
                ...viewportSize(viewportRef.current),
              })
            }>
            {busy || "Launch"}
          </button>
        </div>
      )}
      {browser?.active && !owned && (
        <div className="browser-empty">
          <IconExternalLink size={28} />
          <strong>Attached browser</strong>
          <span>
            Direct embedded control is disabled for user-owned browsers. Detach it or let Helios control it through
            consent-gated tools.
          </span>
        </div>
      )}
      {browser?.active && owned && (
        <div
          ref={viewportRef}
          className="browser-viewport"
          tabIndex={browser.controlled ? 0 : -1}
          aria-label={browser.controlled ? "Interactive Helios browser viewport" : "Live Helios browser mirror"}
          onPointerMove={event => pointer(event, "move")}
          onPointerDown={event => pointer(event, "down")}
          onPointerUp={event => pointer(event, "up")}
          onWheel={wheel}
          onContextMenu={event => event.preventDefault()}
          onKeyDown={event => {
            if (!browser.controlled) return;
            if (event.key === "Tab") event.preventDefault();
            markActive();
            if (!event.repeat)
              void request({ action: "key", phase: "down", key: event.key }, true).catch(() => undefined);
          }}
          onKeyUp={event => {
            if (!browser.controlled) return;
            markActive();
            void request({ action: "key", phase: "up", key: event.key }, true).catch(() => undefined);
          }}>
          {frame ? (
            <img ref={imageRef} src={frame} alt="Helios browser viewport" draggable={false} />
          ) : (
            <span>
              <IconLoader2 className="spin" size={22} />
              Loading viewport…
            </span>
          )}
          <small>
            {browser.controlled ? "Direct control · agent browser actions paused" : "Live mirror · agent control"}
          </small>
        </div>
      )}
    </aside>
  );
}
