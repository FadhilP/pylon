import { Editor, type EditorTheme, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Option } from "./questions.ts";

export type ClarificationQuestion = { question: string; options: Option[] };
export type ClarificationAnswer = { question: string; answer: string };

type RemoteQuestionnaire = ExtensionUIContext & {
  questionnaire?: (questions: ClarificationQuestion[]) => Promise<string[] | undefined>;
};

const label = (option: Option) => option.description
  ? `${option.label} — ${option.description}`
  : option.label;

export async function askQuestionnaire(
  ui: ExtensionUIContext,
  mode: string,
  questions: ClarificationQuestion[],
): Promise<ClarificationAnswer[] | undefined> {
  const remote = ui as RemoteQuestionnaire;
  if (mode === "rpc") {
    if (remote.questionnaire) {
      const answers = await remote.questionnaire(questions);
      return answers?.map((answer, index) => ({ question: questions[index].question, answer }));
    }
    const answers: ClarificationAnswer[] = [];
    for (const item of questions) {
      const options = [...item.options.map(label), "Write a different answer…"];
      const choice = await ui.select(item.question, options);
      if (!choice) return undefined;
      const answer = choice === "Write a different answer…"
        ? (await ui.editor("Custom answer", ""))?.trim()
        : choice;
      if (!answer) return undefined;
      answers.push({ question: item.question, answer });
    }
    return answers;
  }

  if (mode !== "tui") return undefined;
  return ui.custom<ClarificationAnswer[] | undefined>((tui, theme, _keybindings, done) => {
    let current = 0;
    let selected = 0;
    let writing = false;
    let cached: string[] | undefined;
    const answers = new Map<number, string>();
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    const editor = new Editor(tui, editorTheme);
    const refresh = () => { cached = undefined; tui.requestRender(); };
    const finish = () => done(questions.map((item, index) => ({
      question: item.question,
      answer: answers.get(index)!,
    })));
    const advance = () => {
      if (current < questions.length - 1) current++;
      else if (answers.size === questions.length) return finish();
      selected = 0;
      refresh();
    };
    editor.onSubmit = (value) => {
      const answer = value.trim();
      if (!answer) return;
      answers.set(current, answer);
      writing = false;
      editor.setText("");
      advance();
    };

    const handleInput = (data: string) => {
      if (writing) {
        if (matchesKey(data, Key.escape)) {
          writing = false;
          editor.setText("");
          refresh();
        } else {
          editor.handleInput(data);
          refresh();
        }
        return;
      }
      if (matchesKey(data, Key.escape)) return done(undefined);
      if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
        current = (current - 1 + questions.length) % questions.length;
        selected = 0;
        return refresh();
      }
      if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
        current = (current + 1) % questions.length;
        selected = 0;
        return refresh();
      }
      const optionCount = questions[current].options.length + 1;
      if (matchesKey(data, Key.up)) {
        selected = Math.max(0, selected - 1);
        return refresh();
      }
      if (matchesKey(data, Key.down)) {
        selected = Math.min(optionCount - 1, selected + 1);
        return refresh();
      }
      if (!matchesKey(data, Key.enter)) return;
      if (selected === optionCount - 1) {
        writing = true;
        editor.setText("");
        return refresh();
      }
      answers.set(current, label(questions[current].options[selected]));
      advance();
    };

    const render = (width: number) => {
      if (cached) return cached;
      const lines: string[] = [];
      const available = Math.max(1, width);
      const add = (text: string, prefix = "") => {
        const prefixWidth = visibleWidth(prefix);
        const wrapped = wrapTextWithAnsi(text, Math.max(1, available - prefixWidth));
        wrapped.forEach((line, index) => lines.push(`${index ? " ".repeat(prefixWidth) : prefix}${line}`));
      };
      lines.push(theme.fg("accent", "─".repeat(available)));
      add(questions.map((_item, index) => {
        const mark = answers.has(index) ? "■" : "□";
        const text = ` ${mark} ${index + 1} `;
        return index === current ? theme.bg("selectedBg", text) : theme.fg(answers.has(index) ? "success" : "muted", text);
      }).join(" "), " ");
      lines.push("");
      add(questions[current].question, " ");
      lines.push("");
      questions[current].options.forEach((option, index) => {
        const prefix = selected === index ? theme.fg("accent", "> ") : "  ";
        add(`${index + 1}. ${option.label}`, prefix);
        if (option.description) add(option.description, "     ");
      });
      const customIndex = questions[current].options.length;
      add(`${customIndex + 1}. Write a different answer…`, selected === customIndex ? theme.fg("accent", "> ") : "  ");
      if (writing) {
        lines.push("");
        add(theme.fg("muted", "Your answer:"), " ");
        for (const line of editor.render(Math.max(1, available - 2))) lines.push(` ${line}`);
      }
      lines.push("");
      add(theme.fg("dim", writing
        ? "Enter save • Esc options"
        : "Tab/←→ questions • ↑↓ select • Enter answer • Esc cancel"), " ");
      lines.push(theme.fg("accent", "─".repeat(available)));
      cached = lines;
      return lines;
    };

    return {
      render,
      handleInput,
      invalidate: () => { cached = undefined; editor.invalidate(); },
      get focused() { return editor.focused; },
      set focused(value: boolean) { editor.focused = value; },
    };
  });
}
