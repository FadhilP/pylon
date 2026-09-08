import { EditorState, StateEffect, StateField, type Text } from "@codemirror/state";
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

export const paintCode = StateEffect.define<{
  text: string;
  notes: readonly Annotation[];
  blocks: { line: number; widget: WidgetType }[];
  gitChanges?: ReadonlyMap<number, GitLineChange>;
}>();
export const paintedCode = StateField.define<{
  blocks: DecorationSet;
  notes: readonly Annotation[];
  gitChanges?: ReadonlyMap<number, GitLineChange>;
}>({
  create: () => ({ blocks: Decoration.none, notes: [] }),
  update(value, transaction) {
    // Unlike colors, hash-anchored notes and Git markers must disappear immediately after edits.
    if (transaction.docChanged) value = { blocks: Decoration.none, notes: [] };
    for (const effect of transaction.effects) {
      if (!effect.is(paintCode) || effect.value.text !== transaction.state.doc.toString()) continue;
      const blocks = effect.value.blocks
        .filter(block => block.line > 0 && block.line <= transaction.state.doc.lines)
        .map(block => Decoration.widget({ widget: block.widget, block: true, side: 1 }).range(transaction.state.doc.line(block.line).to));
      value = { blocks: Decoration.set(blocks, true), notes: effect.value.notes, gitChanges: effect.value.gitChanges };
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value.blocks),
});
