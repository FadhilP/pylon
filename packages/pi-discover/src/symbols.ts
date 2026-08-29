import { extname } from "node:path";

export type SymbolRow = {
  name: string;
  kind: string;
  line: number;
  column: number;
  signature: string;
};

const languages: Record<string, string> = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".dart": "dart",
  ".go": "go",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".php": "php",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".sh": "shell",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "vue",
  ".svelte": "svelte",
};

export function languageFor(path: string): string | undefined {
  return languages[extname(path).toLowerCase()];
}

function signature(value: string): string {
  return value.trim().slice(0, 300);
}

/**
 * One heuristic declaration pattern. `name` names the capture group holding the symbol
 * (or the groups to try in order), and `kind` is either a literal or derived from the match.
 */
type SymbolRule = {
  pattern: RegExp;
  name: number | readonly number[];
  kind: string | ((match: RegExpExecArray) => string);
  /** Names this pattern matches but that are control flow rather than declarations. */
  reject?: readonly string[];
};

/** Languages whose declarations are matched only by their own rules. */
const exclusiveRules: Record<string, readonly SymbolRule[]> = {
  python: [
    {
      pattern: /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/,
      name: 2,
      kind: (match) => (match[1] === "def" ? "function" : "class"),
    },
  ],
  go: [
    {
      pattern:
        /^\s*(?:func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)|type\s+([A-Za-z_]\w*)\s+(struct|interface))/,
      name: [1, 2],
      kind: (match) => (match[1] ? "function" : match[3]),
    },
  ],
  rust: [
    {
      pattern:
        /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|type|mod|const|static)\s+([A-Za-z_]\w*)/,
      name: 2,
      kind: (match) => (match[1] === "fn" ? "function" : match[1]),
    },
  ],
  ruby: [
    {
      pattern: /^\s*(def|class|module)\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/,
      name: 2,
      kind: (match) => (match[1] === "def" ? "function" : match[1]),
    },
  ],
  shell: [
    {
      pattern: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*(?:\(\s*\))?\s*\{/,
      name: 1,
      kind: "function",
    },
  ],
  dart: [
    {
      pattern:
        /^\s*(?:(?:abstract|base|final|interface|sealed|mixin)\s+)*(class|enum|mixin|extension(?:\s+type)?|typedef)\s+([A-Za-z_$][\w$]*)/,
      name: 2,
      kind: (match) => match[1].replace(/\s+/g, " "),
    },
    {
      pattern:
        /^\s*(?:(?:external|static|abstract|covariant)\s+)*(?:[A-Za-z_$][\w$]*(?:<[^;{}()=]+>)?\??\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^;{}()=]+>)?\s*\([^;{}]*\)\s*(?:async\*?|sync\*?)?\s*(?:=>|\{|;)/,
      name: 1,
      kind: "function",
    },
  ],
};

/** Keyword declarations shared by every language without exclusive rules. */
const declarationRule: SymbolRule = {
  pattern:
    /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+)*(?:async\s+)?(class|interface|enum|function|type|namespace|module|struct|trait)\s+([A-Za-z_$][\w$]*)/,
  name: 2,
  kind: (match) => match[1],
};

const scriptRules: readonly SymbolRule[] = [
  {
    pattern:
      /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=;]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
    name: 1,
    kind: "function",
  },
  {
    pattern:
      /^\s*(?:(?:public|private|protected|static|abstract|readonly|override)\s+)*(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^;{}()=]+>)?\s*\([^;{}]*\)\s*(?::[^;{=]+)?\s*(?:\{|=>)/,
    name: 1,
    kind: "function",
    reject: ["if", "for", "while", "switch", "catch", "function"],
  },
];

const managedRules: readonly SymbolRule[] = [
  {
    pattern:
      /^\s*(?:(?:public|private|protected|internal|static|abstract|final|virtual|override|synchronized|native|async|open)\s+)*(?:[A-Za-z_$][\w$<>,.?\[\]]*\s+)+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^;{]+)?\s*(?:\{|;|=>)/,
    name: 1,
    kind: "function",
  },
];

const nativeRules: readonly SymbolRule[] = [
  {
    pattern:
      /^\s*(?:(?:static|inline|extern|virtual|constexpr|consteval|constinit|unsigned|signed)\s+)*(?:[A-Za-z_]\w*(?:\s*<[^;{}()]+>)?\s*[*&]*\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:\{|;)/,
    name: 1,
    kind: "function",
  },
];

/** Extra rules tried after `declarationRule`, keyed by language. */
const sharedRules: Record<string, readonly SymbolRule[]> = {
  javascript: scriptRules,
  typescript: scriptRules,
  vue: scriptRules,
  svelte: scriptRules,
  java: managedRules,
  csharp: managedRules,
  kotlin: managedRules,
  swift: managedRules,
  c: nativeRules,
  cpp: nativeRules,
};

function rulesFor(language: string): readonly SymbolRule[] {
  return (
    exclusiveRules[language] ?? [
      declarationRule,
      ...(sharedRules[language] ?? []),
    ]
  );
}

function matchedName(
  match: RegExpExecArray,
  name: SymbolRule["name"],
): string | undefined {
  if (typeof name === "number") return match[name];
  for (const group of name) if (match[group]) return match[group];
  return undefined;
}

/** Lightweight language-aware symbol extraction. Results are intentionally marked heuristic by the tool. */
export function extractSymbols(content: string, language: string): SymbolRow[] {
  const rules = rulesFor(language);
  const rows: SymbolRow[] = [];
  for (const [index, source] of content.split(/\r?\n/).entries()) {
    for (const rule of rules) {
      const match = rule.pattern.exec(source);
      if (!match) continue;
      const name = matchedName(match, rule.name);
      // A rejected match means the line is control flow, so no later rule should claim it either.
      if (!name || rule.reject?.includes(name)) break;
      rows.push({
        name,
        kind: typeof rule.kind === "string" ? rule.kind : rule.kind(match),
        line: index + 1,
        column: source.indexOf(name) + 1,
        signature: signature(source),
      });
      break;
    }
  }
  return rows;
}
