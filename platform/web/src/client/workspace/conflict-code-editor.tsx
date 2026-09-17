import { Component, useState, type ReactNode } from "react";
import { MAX_EDIT_BYTES } from "../../shared/workspace/workspace-mutations";
import { EditableCode, type CodeBlock } from "../rendering/editable-code";
import type { ConflictChoice } from "./git-review-model";
import { editableConflictStructureMatches, parseEditableConflictText, type EditableConflictBlock, type EditableConflictText } from "./git-review-model";

const noNotes: never[] = [];
const noOpenNotes = new Set<string>();

type Props = {
  path: string;
  text: string;
  parsed: EditableConflictText;
  original: readonly EditableConflictBlock[];
  choices: Readonly<Record<number, ConflictChoice | undefined>>;
  readOnly: boolean;
  oursLabel: string;
  theirsLabel: string;
  oursDetail(block: EditableConflictBlock): string;
  theirsDetail(block: EditableConflictBlock): string;
  onChange(text: string): void;
  onChoice(index: number, choice: ConflictChoice): void;
};

class ConflictEditorBoundary extends Component<{ children: ReactNode; text: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error("Conflict editor failed; preserving raw text", error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <>
      <div className="code-viewer-error" role="alert">Conflict editing failed. The draft is preserved below; copy it before reloading.</div>
      <textarea className="workspace-text-input" aria-label="Conflict draft" value={this.props.text} readOnly spellCheck={false} wrap="off" />
    </>;
  }
}

export default function ConflictCodeEditor(props: Props) {
  const [target, setTarget] = useState<{ line: number; token: number }>();
  const focus = (line: number) => setTarget(previous => ({ line, token: (previous?.token ?? 0) + 1 }));
  const blocks: CodeBlock[] = props.parsed.blocks.flatMap((block, index) => {
    const original = props.original[index];
    const choice = props.choices[index];
    const oursEdited = original !== undefined && block.ours !== original.ours;
    const theirsEdited = original !== undefined && block.theirs !== original.theirs;
    return [
      {
        key: `conflict:${index}:ours`,
        line: block.startLine,
        children: <section className="git-conflict-editor-card">
          <header>
            <strong>
              Conflict {index + 1}
              {choice ? ` · keeping ${choice === "ours" ? props.oursLabel.toLowerCase() : choice === "theirs" ? props.theirsLabel.toLowerCase() : "both, in order"}` : ""}
            </strong>
            <span>
              {(["ours", "theirs", "both"] as const).map(value => <button key={value} aria-pressed={choice === value}
                disabled={props.readOnly} onClick={() => props.onChoice(index, value)}>
                {value === "ours" ? props.oursLabel : value === "theirs" ? props.theirsLabel : "Both"}
              </button>)}
            </span>
          </header>
          <button className="git-conflict-editor-side ours" disabled={props.readOnly} onClick={() => focus(block.oursTargetLine)}>
            {props.oursDetail(block)}{oursEdited ? " · edited" : ""}
          </button>
        </section>,
      },
      {
        key: `conflict:${index}:theirs`,
        line: block.theirsStartLine,
        children: <button className="git-conflict-editor-side theirs" disabled={props.readOnly} onClick={() => focus(block.theirsTargetLine)}>
          {props.theirsDetail(block)}{theirsEdited ? " · edited" : ""}
        </button>,
      },
      {
        key: `conflict:${index}:end`,
        line: block.endLine,
        children: <div className="git-conflict-editor-end" />,
      },
    ];
  });
  const lineStyles = props.parsed.lines.map(item => ({
    line: item.line,
    className: `git-conflict-editor-line is-${item.kind}`,
  }));
  return <ConflictEditorBoundary text={props.text}>
    <EditableCode
      path={props.path}
      text={props.text}
      editing={{ readOnly: props.readOnly, maxLength: MAX_EDIT_BYTES, onChange: props.onChange, onSave: () => undefined }}
      targetLine={target?.line}
      navigationToken={target?.token}
      notes={noNotes}
      openNotes={noOpenNotes}
      onToggleNote={() => undefined}
      onSelection={() => undefined}
      onAddNote={() => undefined}
      blocks={blocks}
      lineStyles={lineStyles}
      protectedRanges={text => parseEditableConflictText(text).protectedRanges}
      validText={text => editableConflictStructureMatches(text, props.original)}
    />
  </ConflictEditorBoundary>;
}
