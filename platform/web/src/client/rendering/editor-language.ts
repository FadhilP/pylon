import { treeDiagnostics } from "./syntax-diagnostics.ts";
import { LanguageDescription, LanguageSupport, LRLanguage, syntaxTree } from "@codemirror/language";
import { forEachDiagnostic, setDiagnostics, setDiagnosticsEffect, type Diagnostic } from "@codemirror/lint";
import { Compartment, EditorState, RangeSet, StateField } from "@codemirror/state";
import { GutterMarker, gutterLineClass, ViewPlugin } from "@codemirror/view";
import { autocompletion, completeAnyWord, completeFromList, CompletionContext, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { sourceLanguage } from "./source-language.ts";

export type SqlDialect = "sqlite" | "postgres" | "mysql";
const dialectNames = { sqlite: "SQLite", postgres: "PostgreSQL", mysql: "MySQL" };
const enhanced = new WeakMap<LanguageSupport, LanguageSupport>();

class DiagnosticLineMarker extends GutterMarker {
  constructor(readonly elementClass: string) { super(); }
}
const errorLine = new DiagnosticLineMarker("cm-syntax-line-error");
const warningLine = new DiagnosticLineMarker("cm-syntax-line-warning");
const diagnosticLineClasses = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, tr) {
    if (!tr.docChanged && !tr.effects.some(effect => effect.is(setDiagnosticsEffect))) return markers;
    const lines = new Map<number, GutterMarker>();
    // Use current positions and one marker per diagnostic's starting line, as the native lint gutter does.
    forEachDiagnostic(tr.state, (diagnostic, from) => {
      const marker = diagnostic.severity === "error" ? errorLine : diagnostic.severity === "warning" ? warningLine : undefined;
      if (!marker) return;
      const start = tr.state.doc.lineAt(from).from;
      if (lines.get(start) !== errorLine) lines.set(start, marker);
    });
    return RangeSet.of([...lines].sort(([a], [b]) => a - b).map(([from, marker]) => marker.range(from)));
  },
  provide: field => gutterLineClass.from(field),
});

type WordExclusions = { labels: ReadonlySet<string>; ignoreCase: boolean };
const wordExclusionKey = "editorCompletionWordExclusions";

const completeDocumentWords: CompletionSource = context => {
  const result = completeAnyWord(context);
  if (!result || !("options" in result)) return result;
  const exclusions = context.state.languageDataAt<WordExclusions>(wordExclusionKey, context.pos);
  const node = syntaxTree(context.state).resolveInner(context.pos, -1);
  // Keep words when keyword completion is suppressed, including quoted SQL identifiers.
  const keywordsActive = !/comment|string|QuotedIdentifier/i.test(node.name) && node.name !== ".";
  const validFor = result.validFor instanceof RegExp
    ? new RegExp(`^(?:${result.validFor.source})$`, result.validFor.flags) : result.validFor;
  return {
    ...result,
    options: result.options.filter(option => !keywordsActive || !exclusions.some(({ labels, ignoreCase }) =>
      labels.has(ignoreCase ? option.label.toLowerCase() : option.label)))
      // An untyped fallback lets CodeMirror prefer equivalent native symbols over document words.
      .map(option => ({ ...option, type: undefined })),
    validFor: (text, from, to, state) => {
      const current = state.languageDataAt<WordExclusions>(wordExclusionKey, to);
      return current.length === exclusions.length && current.every((entry, index) => entry === exclusions[index])
        && (validFor instanceof RegExp ? validFor.test(text) : validFor?.(text, from, to, state) ?? false);
    },
  };
};

/** Only the catalogue and the requested grammar load; LanguageDescription deduplicates concurrent loads. */
export async function loadEditorLanguage(path: string, dialect?: SqlDialect): Promise<LanguageSupport | undefined> {
  const { languages } = await import("@codemirror/language-data");
  const filename = path.split(/[\\/]/).at(-1) ?? path;
  const description = dialect ? LanguageDescription.matchLanguageName(languages, dialectNames[dialect], false)
    : LanguageDescription.matchFilename(languages, filename)
      ?? LanguageDescription.matchFilename(languages, filename.toLowerCase())
      ?? LanguageDescription.matchLanguageName(languages, sourceLanguage(path), false);
  if (!description) return undefined;
  const support = await description.load();
  let result = enhanced.get(support);
  if (!result) {
    // Some maintained grammars (e.g. Rust and C++) have no completion provider.
    // Reuse their literal word tokens rather than maintaining another keyword catalogue.
    const words = support.language instanceof LRLanguage
      ? [...new Set(support.language.parser.nodeSet.types.map(type => type.name).filter(name => /^[a-z][a-z_0-9]+$/.test(name)))] : [];
    const keywords = completeFromList(words.map(label => ({ label, type: "keyword" })));
    const ignoreCase = support.language.name === "sql";
    const labels = new Set(words);
    if (ignoreCase) {
      // SQL's parser node names don't contain its keyword inventory. Read the installed
      // dialect's synchronous provider once on load, not on each keystroke.
      const state = EditorState.create({ extensions: support });
      const context = new CompletionContext(state, 0, true);
      for (const source of state.languageDataAt<CompletionSource | Completion[]>("autocomplete", 0)) {
        const completion = (Array.isArray(source) ? completeFromList(source) : source)(context);
        if (completion && "options" in completion) for (const option of completion.options) labels.add(option.label.toLowerCase());
      }
    }
    result = new LanguageSupport(support.language, [support.support,
      support.language.data.of({ [wordExclusionKey]: { labels, ignoreCase } satisfies WordExclusions }),
      ...(words.length ? [support.language.data.of({
        autocomplete: (context: Parameters<typeof keywords>[0]) => {
          const node = syntaxTree(context.state).resolveInner(context.pos, -1);
          return /comment|string/i.test(node.name) ? null : keywords(context);
        },
      })] : [])]);
    enhanced.set(support, result);
  }
  return result;
}

export function editorAssistance(path: string, options: { dialect?: SqlDialect; onLoadError?: () => void } = {}) {
  const language = new Compartment();
  return [
    language.of([]),
    ViewPlugin.define(view => {
      let active = true;
      void loadEditorLanguage(path, options.dialect).then(support => {
        if (active) view.dispatch({ effects: language.reconfigure(support ?? []) });
      }).catch(() => { if (active) options.onLoadError?.(); });
      return { destroy() { active = false; } };
    }),
    autocompletion(),
    EditorState.languageData.of(() => [{ autocomplete: completeDocumentWords },
      ...(path.toLowerCase().endsWith(".json") ? [{ autocomplete: completeFromList(["true", "false", "null"]) }] : [])]),
    diagnosticLineClasses,
    // Old markers must not survive edits while the worker catches up.
    EditorState.transactionExtender.of(tr => tr.docChanged ? setDiagnostics(tr.startState, []) : null),
  ];
}

/** Recovery-node diagnostics are syntax hints, not type checking. Legacy stream modes cannot validate syntax. */
export async function syntaxDiagnostics(text: string, path: string): Promise<Diagnostic[]> {
  const support = await loadEditorLanguage(path);
  if (!(support?.language instanceof LRLanguage)) return [];
  return treeDiagnostics(text, support.language.parser.parse(text));
}
