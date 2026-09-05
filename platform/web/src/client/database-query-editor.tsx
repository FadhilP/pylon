import { Fragment, useEffect, useMemo, useRef } from "react";
import { loadSyntaxLanguage, syntaxTokens } from "../shared/syntax-highlighting";
import { useSyntaxHighlightingRevision } from "./use-chrome";

export function DatabaseSyntax({ text, language = "sql" }: { text: string; language?: "sql" | "json" }) {
  const revision = useSyntaxHighlightingRevision();
  useEffect(() => { void loadSyntaxLanguage(language); }, [language]);
  const lines = useMemo(() => syntaxTokens(text, language), [text, language, revision]);
  return <code className="database-syntax">{lines.map((line, index) => <Fragment key={index}>
    {index > 0 && "\n"}{line.map((token, position) => <span key={position} className={token.className}>{token.content}</span>)}
  </Fragment>)}</code>;
}

export function DatabaseQueryEditor({ text, language, onChange, onRun }: {
  text: string; language: "sql" | "json"; onChange: (text: string) => void; onRun: () => void;
}) {
  const backdrop = useRef<HTMLPreElement>(null);
  return <div className="database-query-input">
    <pre ref={backdrop} aria-hidden="true"><DatabaseSyntax text={text + "\n"} language={language} /></pre>
    <textarea aria-label={language === "json" ? "MongoDB command JSON" : "SQL query"} spellCheck={false} autoCapitalize="off" autoCorrect="off"
      wrap="off" value={text} maxLength={65536} placeholder={language === "json" ? '{ "operation": "find", "collection": "users", "filter": {} }' : "SELECT …"}
      onChange={event => onChange(event.target.value)} onScroll={event => {
        if (!backdrop.current) return;
        backdrop.current.scrollTop = event.currentTarget.scrollTop;
        backdrop.current.scrollLeft = event.currentTarget.scrollLeft;
      }} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); onRun(); }
      }} />
  </div>;
}
