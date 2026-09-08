import { EditorState, StateEffect, StateField, type Text, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, type WidgetType } from "@codemirror/view";
import type { SyntaxSpan } from "./incremental-syntax.ts";
import type { Annotation } from "../../shared/workspace/annotations.ts";
import type { GitLineChange } from "../../shared/workspace/code-viewer-model.ts";

/** Selection ending at the next line's start belongs to the preceding line. */
export function selectedCodeLines(doc: Text, from: number, to: number) {
  return { from: doc.lineAt(from).number, to: doc.lineAt(to > from ? to - 1 : to).number };
}

export function codeEditLimit(maxLength: number) {
  return EditorState.changeFilter.of(
    transaction =>
      !transaction.docChanged || (!transaction.startState.readOnly && transaction.newDoc.length <= maxLength),
  );
}

export const paintSyntax = StateEffect.define<{ doc: Text; spans: readonly SyntaxSpan[] }>();
export const paintedSyntax = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    // Existing colors can follow edits while the worker catches up; source notes cannot.
    if (transaction.docChanged) value = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(paintSyntax) || effect.value.doc !== transaction.state.doc) continue;
      value = Decoration.set(effect.value.spans
        .filter(span => span.from >= 0 && span.to <= transaction.state.doc.length && span.from < span.to)
        .map(span => Decoration.mark({ class: span.className }).range(span.from, span.to)), true);
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});

/** Provisional display markers follow edits until the index comparison catches up. */
function mapGitChanges(markers: ReadonlyMap<number, GitLineChange> | undefined, transaction: Transaction) {
  if (!markers) return undefined;
  let linesChanged = false;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (transaction.startState.doc.lineAt(fromA).number !== transaction.startState.doc.lineAt(toA).number ||
      transaction.newDoc.lineAt(fromB).number !== transaction.newDoc.lineAt(toB).number) linesChanged = true;
  });
  if (!linesChanged) return markers;
  const mapped = new Map<number, GitLineChange>();
  const add = (position: number, marker: GitLineChange) => {
    const line = transaction.newDoc.lineAt(position).number;
    const previous = mapped.get(line);
    if (marker.kind === "deleted" && previous) {
      if (previous.kind !== "deleted") return;
      if (previous.edge !== marker.edge) marker = { kind: "deleted", edge: "both" };
    }
    mapped.set(line, marker);
  };
  for (const [number, marker] of markers) {
    if (number < 1 || number > transaction.startState.doc.lines) continue;
    const line = transaction.startState.doc.line(number);
    if (marker.kind === "deleted") {
      if (marker.edge !== "after") add(transaction.changes.mapPos(line.from, 1), { kind: "deleted", edge: "before" });
      if (marker.edge !== "before") add(transaction.changes.mapPos(line.to, -1), { kind: "deleted", edge: "after" });
    } else {
      const from = transaction.changes.mapPos(line.from, 1);
      const to = transaction.changes.mapPos(line.to, -1);
      if (!line.length || from < to) add(from, marker);
    }
  }
  return mapped;
}

export const paintCode = StateEffect.define<{
  text: string;
  notes: readonly Annotation[];
  blocks: { line: number; widget: WidgetType }[];
  gitChanges?: ReadonlyMap<number, GitLineChange>;
  gitIndexText?: string;
}>();
export const paintedCode = StateField.define<{
  blocks: DecorationSet;
  notes: readonly Annotation[];
  gitChanges?: ReadonlyMap<number, GitLineChange>;
  gitIndexText?: string;
}>({
  create: () => ({ blocks: Decoration.none, notes: [] }),
  update(value, transaction) {
    // Captured notes must vanish immediately; display-only Git markers can follow edits.
    if (transaction.docChanged) value = { blocks: Decoration.none, notes: [],
      gitIndexText: value.gitIndexText, gitChanges: mapGitChanges(value.gitChanges, transaction) };
    for (const effect of transaction.effects) {
      if (!effect.is(paintCode) || effect.value.text !== transaction.state.doc.toString()) continue;
      const blocks = effect.value.blocks
        .filter(block => block.line > 0 && block.line <= transaction.state.doc.lines)
        .map(block => Decoration.widget({ widget: block.widget, block: true, side: 1 }).range(transaction.state.doc.line(block.line).to));
      value = { blocks: Decoration.set(blocks, true), notes: effect.value.notes,
        gitIndexText: effect.value.gitIndexText,
        // Omitted means pending; explicit undefined means a settled unavailable result.
        gitChanges: "gitChanges" in effect.value ? effect.value.gitChanges
          : effect.value.gitIndexText === value.gitIndexText ? value.gitChanges : undefined };
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value.blocks),
});
