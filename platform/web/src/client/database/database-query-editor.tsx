import { Component, Fragment, Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadSyntaxLanguage, syntaxTokens } from "../rendering/syntax-highlighting";
import { useSyntaxHighlightingRevision } from "../app/use-chrome";
import type { DatabaseDriver } from "./database-workspace";

const CodeEditor = lazy(() => import("./database-code-editor"));
export interface DatabaseQueryEditorProps {
  text: string;
  driver: DatabaseDriver;
  active: boolean;
  onChange: (text: string) => void;
  onRun: () => void;
}

class QueryEditorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error("Database editor unavailable; using plain text", error); }
  render() { return this.state.failed ? <><small role="status">Advanced query editing unavailable; your draft is preserved in plain text.</small>{this.props.fallback}</> : this.props.children; }
}

export function DatabaseSyntax({ text, language = "sql" }: { text: string; language?: "sql" | "json" }) {
  const revision = useSyntaxHighlightingRevision();
  useEffect(() => {
    void loadSyntaxLanguage(language);
  }, [language]);
  const lines = useMemo(() => syntaxTokens(text, language), [text, language, revision]);
  return (
    <code className="database-syntax">
      {lines.map((line, index) => (
        <Fragment key={index}>
          {index > 0 && "\n"}
          {line.map((token, position) => (
            <span key={position} className={token.className}>
              {token.content}
            </span>
          ))}
        </Fragment>
      ))}
    </code>
  );
}

export function DatabaseQueryEditor(props: DatabaseQueryEditorProps) {
  const [visited, setVisited] = useState(props.active);
  useEffect(() => { if (props.active) setVisited(true); }, [props.active]);
  const label = props.driver === "mongodb" ? "MongoDB command JSON" : props.driver === "redis" ? "Redis command JSON" : "SQL query";
  const fallback = <textarea className="database-query-fallback" aria-label={label} value={props.text}
    maxLength={65536} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
    onChange={event => props.onChange(event.target.value)} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
        event.preventDefault(); props.onRun();
      }
    }} />;
  return <div className="database-query-input">
    <QueryEditorBoundary fallback={fallback}>
      {(props.active || visited) && <Suspense fallback={fallback}><CodeEditor {...props} /></Suspense>}
    </QueryEditorBoundary>
  </div>;
}
