import { useEffect, useRef } from "react";
import {
  DEFAULT_KEYMAP,
  DoubleShift,
  KEY_COMMANDS,
  bindingLabel,
  effectiveBinding,
  matchesBinding,
  type CommandId,
  type KeyScope,
} from "../shared/keyboard";
import { runtimeStore } from "./runtime/event-store";

export type ShortcutHandlers = Partial<Record<CommandId, () => void | boolean | Promise<unknown>>>;
export const isMacKeyboard = () => /Mac|iPhone|iPad/.test(navigator.platform);
export function shortcutLabel(id: CommandId): string {
  return bindingLabel(
    effectiveBinding(runtimeStore.getSnapshot().keyboardSettings?.keymap ?? DEFAULT_KEYMAP, id),
    isMacKeyboard(),
  );
}
export function shortcutsBlocked(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  return (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.repeat ||
    !!event.getModifierState?.("AltGraph") ||
    !!document.querySelector("[data-keyboard-recording], dialog[open], [role=dialog][aria-modal=true]") ||
    !!target?.closest(".xterm, .workspace-editor, .database-query-input, .cm-editor, .monaco-editor")
  );
}
function inputTarget(event: KeyboardEvent): boolean {
  return (
    event.target instanceof Element &&
    !!event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")
  );
}
function invoke(event: KeyboardEvent, handler: () => void | boolean | Promise<unknown>): boolean {
  try {
    const result = handler();
    if (result === false) return false;
    event.preventDefault();
    if (result instanceof Promise)
      void result.catch(error => runtimeStore.reportError(error instanceof Error ? error.message : "Shortcut failed"));
    return true;
  } catch (error) {
    event.preventDefault();
    runtimeStore.reportError(error instanceof Error ? error.message : "Shortcut failed");
    return true;
  }
}
/** Called by the owning widget before its fallback keys; the global listener runs last. */
export function dispatchShortcut(event: KeyboardEvent, scope: KeyScope, handlers: ShortcutHandlers): boolean {
  if (shortcutsBlocked(event)) return false;
  const keymap = runtimeStore.getSnapshot().keyboardSettings?.keymap ?? DEFAULT_KEYMAP;
  for (const command of KEY_COMMANDS) {
    const handler = handlers[command.id];
    if (!handler || command.scope !== scope) continue;
    if (scope === "global" && inputTarget(event) && !("inInputs" in command && command.inInputs)) continue;
    if (matchesBinding(event, effectiveBinding(keymap, command.id), isMacKeyboard()) && invoke(event, handler))
      return true;
  }
  return false;
}
export function useGlobalShortcuts(handlers: ShortcutHandlers, disabled: boolean): void {
  const latest = useRef({ handlers, disabled });
  latest.current = { handlers, disabled };
  useEffect(() => {
    const taps = new DoubleShift();
    const reset = () => taps.reset();
    let previousMap = runtimeStore.getSnapshot().keyboardSettings?.keymap;
    const keys = (event: KeyboardEvent) => {
      const currentMap = runtimeStore.getSnapshot().keyboardSettings?.keymap;
      if (currentMap !== previousMap) {
        reset();
        previousMap = currentMap;
      }
      if (latest.current.disabled || shortcutsBlocked(event)) {
        reset();
        return;
      }
      if (event.type === "keydown" && dispatchShortcut(event, "global", latest.current.handlers)) {
        reset();
        return;
      }
      if (inputTarget(event)) {
        reset();
        return;
      }
      if (!taps.handle(event, event.type as "keydown" | "keyup", Date.now())) return;
      const map = runtimeStore.getSnapshot().keyboardSettings?.keymap ?? DEFAULT_KEYMAP;
      const command = KEY_COMMANDS.find(
        command => command.scope === "global" && effectiveBinding(map, command.id)?.kind === "double-shift",
      );
      const handler = command && latest.current.handlers[command.id];
      if (handler) invoke(event, handler);
    };
    window.addEventListener("keydown", keys);
    window.addEventListener("keyup", keys);
    window.addEventListener("blur", reset);
    window.addEventListener("compositionstart", reset);
    return () => {
      window.removeEventListener("keydown", keys);
      window.removeEventListener("keyup", keys);
      window.removeEventListener("blur", reset);
      window.removeEventListener("compositionstart", reset);
    };
  }, []);
}
