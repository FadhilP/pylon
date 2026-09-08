export type Modifier = "Mod" | "Ctrl" | "Alt" | "Shift" | "Meta";
export type Binding = { kind: "chord"; key: string; modifiers: Modifier[] } | { kind: "double-shift" };
export type KeyScope = "global" | "composer" | "explorer";
export type KeymapPreset = "pylon" | "vscode" | "jetbrains";
const chord = (key: string, ...modifiers: Modifier[]): Binding => ({ kind: "chord", key, modifiers });

/** Only implemented actions belong here. Menus, search and keyboard settings share these IDs. */
export const KEY_COMMANDS = [
  {
    id: "find-file",
    label: "Go to file",
    group: "Navigation",
    scope: "global",
    inInputs: true,
    binding: chord("P", "Mod"),
  },
  {
    id: "find-text",
    label: "Search in workspace",
    group: "Navigation",
    scope: "global",
    inInputs: true,
    binding: chord("F", "Mod", "Shift"),
  },
  { id: "find-symbol", label: "Go to symbol", group: "Navigation", scope: "global", inInputs: true, binding: null },
  {
    id: "last-tab",
    label: "Reopen last search tab",
    group: "Navigation",
    scope: "global",
    binding: { kind: "double-shift" },
  },
  {
    id: "sessions",
    label: "Focus session search",
    group: "Navigation",
    scope: "global",
    inInputs: true,
    binding: chord("K", "Mod"),
  },
  {
    id: "new-session",
    label: "New session",
    group: "Session",
    scope: "global",
    binding: chord("Enter", "Mod", "Shift"),
  },
  { id: "stop-turn", label: "Stop the running turn", group: "Session", scope: "global", binding: chord(".", "Mod") },
  { id: "send", label: "Send message", group: "Session", scope: "composer", binding: chord("Enter") },
  { id: "newline", label: "Insert a newline", group: "Session", scope: "composer", binding: chord("Enter", "Shift") },
  { id: "worktree", label: "Move session to worktree", group: "Session", scope: "global", binding: null },
  {
    id: "archive",
    label: "Archive session",
    group: "Session",
    scope: "global",
    binding: chord("Backspace", "Mod", "Shift"),
  },
  {
    id: "reveal",
    label: "Show open file in tree",
    group: "Explorer",
    scope: "explorer",
    binding: chord("E", "Mod", "Shift"),
  },
  { id: "collapse", label: "Collapse all folders", group: "Explorer", scope: "explorer", binding: null },
  { id: "terminal", label: "Toggle terminal drawer", group: "View", scope: "global", binding: chord("`", "Mod") },
  {
    id: "changes",
    label: "Show changes and Git controls",
    group: "View",
    scope: "global",
    binding: chord("G", "Mod", "Shift"),
  },
  { id: "inspector", label: "Toggle inspector", group: "View", scope: "global", binding: null },
  { id: "theme", label: "Switch light/dark theme", group: "View", scope: "global", binding: null },
  { id: "settings", label: "Open settings", group: "View", scope: "global", binding: null },
  {
    id: "apply",
    label: "Review session changes for apply",
    group: "Workspace",
    scope: "global",
    binding: chord("S", "Mod", "Shift"),
  },
  { id: "reindex", label: "Rebuild Discover index", group: "Workspace", scope: "global", binding: null },
] as const satisfies readonly {
  id: string;
  label: string;
  group: string;
  scope: KeyScope;
  inInputs?: boolean;
  binding: Binding | null;
}[];
export type CommandId = (typeof KEY_COMMANDS)[number]["id"];
export type KeyCommand = (typeof KEY_COMMANDS)[number];
export interface Keymap {
  preset: KeymapPreset;
  overrides: Partial<Record<CommandId, Binding | null>>;
}
export interface KeyboardSettings {
  revision: number;
  keymap: Keymap;
}
export const DEFAULT_KEYMAP: Keymap = { preset: "pylon", overrides: {} };
export const PRESETS: KeymapPreset[] = ["pylon", "vscode", "jetbrains"];
const presetOverrides: Record<KeymapPreset, Partial<Record<CommandId, Binding | null>>> = {
  pylon: {},
  vscode: { "last-tab": null },
  // Browser-adapted: retain a usable file shortcut and do not bind double Shift twice.
  jetbrains: {
    "find-symbol": chord("N", "Mod", "Alt", "Shift"),
    sessions: chord("E", "Mod"),
    terminal: chord("F12", "Alt"),
  },
};
const modifiers: Modifier[] = ["Mod", "Ctrl", "Alt", "Shift", "Meta"];
const namedKeys = new Set([
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);
export function validKey(key: unknown): key is string {
  return typeof key === "string" && (namedKeys.has(key) || (/^[ -~]$/.test(key) && key === key.toUpperCase()));
}
export function isBinding(value: unknown): value is Binding {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "double-shift") return Object.keys(v).length === 1;
  return (
    v.kind === "chord" &&
    Object.keys(v).every(key => ["kind", "key", "modifiers"].includes(key)) &&
    validKey(v.key) &&
    Array.isArray(v.modifiers) &&
    v.modifiers.length <= 4 &&
    v.modifiers.every(m => modifiers.includes(m)) &&
    new Set(v.modifiers).size === v.modifiers.length &&
    !(v.modifiers.includes("Mod") && (v.modifiers.includes("Ctrl") || v.modifiers.includes("Meta")))
  );
}
export function defaultBinding(id: CommandId, preset: KeymapPreset): Binding | null {
  return Object.hasOwn(presetOverrides[preset], id)
    ? presetOverrides[preset][id]!
    : (KEY_COMMANDS.find(command => command.id === id)!.binding as Binding | null);
}
export function effectiveBinding(map: Keymap, id: CommandId): Binding | null {
  return Object.hasOwn(map.overrides, id) ? map.overrides[id]! : defaultBinding(id, map.preset);
}
function physicalModifiers(binding: Extract<Binding, { kind: "chord" }>, mac: boolean): string[] {
  return binding.modifiers.map(m => (m === "Mod" ? (mac ? "Meta" : "Ctrl") : m)).sort();
}
export function bindingLabel(binding: Binding | null, mac = false): string {
  if (!binding) return "Unbound";
  if (binding.kind === "double-shift") return "Shift Shift";
  return [...physicalModifiers(binding, mac), binding.key === " " ? "Space" : binding.key].join("+");
}
export function overlaps(a: KeyCommand, b: KeyCommand): boolean {
  if (a.scope === b.scope) return true;
  const global = a.scope === "global" ? a : b.scope === "global" ? b : undefined;
  if (!global) return false;
  const local = global === a ? b : a;
  return local.scope !== "composer" || ("inInputs" in global && global.inInputs === true);
}
export function sameBinding(a: Binding | null, b: Binding | null): boolean {
  return !!a && !!b && [false, true].some(mac => bindingLabel(a, mac) === bindingLabel(b, mac));
}

/** Conservative policy, not feature detection: browsers/OSs can reserve additional keys. */
export function browserVerdict(
  binding: Binding | null,
  environment?: { mac: boolean; browser: string },
): { kind: "unbound" | "blocked" | "costs" | "unknown"; message: string } {
  if (!binding) return { kind: "unbound", message: "" };
  if (binding.kind === "double-shift") return { kind: "unknown", message: "Double tap; outside text inputs" };
  const mods = binding.modifiers;
  const primary = mods.includes("Mod") || mods.includes("Ctrl") || mods.includes("Meta");
  if (
    (binding.key === "F12" && !mods.length) ||
    (primary &&
      ((!mods.includes("Alt") &&
        (["N", "T", "W", "Q", "L", "Tab"].includes(binding.key) ||
          (mods.includes("Shift") && ["P", "O", "A", "I", "J", "C"].includes(binding.key)))) ||
        (mods.includes("Alt") && ["I", "J", "C"].includes(binding.key)))) ||
    (mods.includes("Alt") && binding.key === "F4")
  )
    return { kind: "blocked", message: "Reserved by common browsers or the OS" };
  const localPrimary =
    !environment || physicalModifiers(binding, environment.mac).includes(environment.mac ? "Meta" : "Ctrl");
  if (
    environment?.browser === "Firefox" &&
    localPrimary &&
    mods.includes("Shift") &&
    !mods.includes("Alt") &&
    ["K", "E"].includes(binding.key)
  ) {
    return { kind: "costs", message: "Firefox developer tools may intercept this combination" };
  }
  if (
    environment &&
    ["Chrome", "Edge"].includes(environment.browser) &&
    localPrimary &&
    binding.key === "B" &&
    mods.includes("Shift") &&
    !mods.includes("Alt")
  ) {
    return { kind: "costs", message: "Overrides the browser bookmarks bar shortcut" };
  }
  const costs: Record<string, string> = {
    P: "print",
    F: "find in page",
    S: "save page",
    O: "open file",
    D: "bookmark",
    H: "history",
    J: "downloads",
    R: "reload",
    E: "browser search",
  };
  if (
    primary &&
    localPrimary &&
    !mods.includes("Alt") &&
    costs[binding.key] &&
    (!mods.includes("Shift") || ["S", "R"].includes(binding.key))
  ) {
    return { kind: "costs", message: `Overrides browser ${costs[binding.key]}` };
  }
  return { kind: "unknown", message: "Browser/OS availability may vary" };
}
export function bindingProblem(command: KeyCommand, binding: Binding | null): string | undefined {
  if (!binding) return;
  if (!isBinding(binding)) return "Invalid key combination";
  if (browserVerdict(binding).kind === "blocked") return browserVerdict(binding).message;
  if (binding.kind === "double-shift")
    return command.scope === "global" ? undefined : "Double Shift is a global shortcut";
  const modified = binding.modifiers.some(mod => mod !== "Shift");
  if (!modified && binding.key.length === 1) return "Typing keys need Ctrl, Cmd or Alt";
  if (!modified && ["Escape", "Tab"].includes(binding.key))
    return "Escape and Tab are reserved for focus and cancellation";
  if (!modified && command.scope === "global" && !/^F\d+$/.test(binding.key))
    return "Global shortcuts require a modifier";
}
export function validateKeymap(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return "Invalid keymap";
  const map = value as Keymap;
  if (
    Object.keys(map).some(key => !["preset", "overrides"].includes(key)) ||
    !PRESETS.includes(map.preset) ||
    !map.overrides ||
    typeof map.overrides !== "object" ||
    Array.isArray(map.overrides)
  )
    return "Invalid keymap";
  if (Object.keys(map.overrides).some(id => !KEY_COMMANDS.some(command => command.id === id)))
    return "Unknown keyboard command";
  for (const command of KEY_COMMANDS) {
    const value = effectiveBinding(map, command.id);
    if (value !== null && !isBinding(value)) return "Invalid key combination";
    const problem = bindingProblem(command, value);
    if (problem) return `${command.label}: ${problem}`;
    for (const other of KEY_COMMANDS)
      if (other.id !== command.id && overlaps(command, other) && sameBinding(value, effectiveBinding(map, other.id)))
        return `${command.label} conflicts with ${other.label}`;
  }
}
export function isKeyboardSettings(value: unknown): value is KeyboardSettings {
  const v = value as KeyboardSettings | null;
  return !!v && Number.isSafeInteger(v.revision) && v.revision >= 0 && !validateKeymap(v.keymap);
}
/** Assignment evicts only bindings that can execute in the same context, across either platform. */
export function assignBinding(
  map: Keymap,
  id: CommandId,
  binding: Binding | null,
): { keymap: Keymap; lost: CommandId[] } {
  const command = KEY_COMMANDS.find(command => command.id === id)!;
  const problem = bindingProblem(command, binding);
  if (problem) throw new Error(problem);
  const keymap = structuredClone(map);
  const lost: CommandId[] = [];
  for (const other of KEY_COMMANDS)
    if (other.id !== id && overlaps(command, other) && sameBinding(binding, effectiveBinding(map, other.id))) {
      keymap.overrides[other.id] = null;
      lost.push(other.id);
    }
  keymap.overrides[id] = binding;
  return { keymap, lost };
}
export interface KeyStroke {
  key: string;
  keyCode?: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  getModifierState?: (key: string) => boolean;
}
export function eventBinding(event: KeyStroke, mac: boolean): Binding | undefined {
  if (event.repeat || event.isComposing || event.keyCode === 229 || event.getModifierState?.("AltGraph")) return;
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (!validKey(key)) return;
  const mods: Modifier[] = [];
  if (event.ctrlKey && event.metaKey) mods.push("Ctrl", "Meta");
  else if (event.ctrlKey) mods.push(mac ? "Ctrl" : "Mod");
  else if (event.metaKey) mods.push(mac ? "Mod" : "Meta");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  return { kind: "chord", key, modifiers: mods };
}
export function matchesBinding(event: KeyStroke, binding: Binding | null, mac: boolean): boolean {
  if (event.defaultPrevented || !binding || binding.kind !== "chord") return false;
  const pressed = eventBinding(event, mac);
  return !!pressed && bindingLabel(pressed, mac) === bindingLabel(binding, mac);
}
/** A tap requires release; intervening input, repetition and blur reset the sequence. */
export class DoubleShift {
  private downAt: number | undefined;
  private first = 0;
  reset() {
    this.downAt = undefined;
    this.first = 0;
  }
  handle(event: KeyStroke, type: "keydown" | "keyup", now: number): boolean {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.key !== "Shift" ||
      event.repeat
    ) {
      this.reset();
      return false;
    }
    if (type === "keydown") {
      this.downAt = now;
      return false;
    }
    if (this.downAt === undefined) return false;
    if (now - this.downAt > 250) {
      this.reset();
      return false;
    }
    this.downAt = undefined;
    if (this.first && now - this.first <= 420) {
      this.reset();
      return true;
    }
    this.first = now;
    return false;
  }
}
