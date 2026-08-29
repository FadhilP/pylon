import type {
  ExtensionUIDialogOptions,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Option, Question } from "./questions.ts";

export type ClarificationAnswer = { question: string; answer: string };

type RemoteQuestionnaire = ExtensionUIContext & {
  questionnaire?: (
    questions: Array<{ question: string; options: string[] }>,
    options?: ExtensionUIDialogOptions,
  ) => Promise<string[] | undefined>;
};

const label = (option: Option) =>
  option.description ? `${option.label} — ${option.description}` : option.label;

export async function askQuestionnaire(
  ui: ExtensionUIContext,
  mode: string,
  questions: Question[],
  options?: ExtensionUIDialogOptions,
): Promise<ClarificationAnswer[] | undefined> {
  const remote = ui as RemoteQuestionnaire;
  if (mode === "rpc" && remote.questionnaire) {
    const answers = await remote.questionnaire(
      questions.map((item) => ({
        question: item.question,
        options: item.options.map(label),
      })),
      options,
    );
    return answers?.map((answer, index) => ({
      question: questions[index].question,
      answer,
    }));
  }

  if (mode !== "rpc" && mode !== "tui") return undefined;
  const answers: ClarificationAnswer[] = [];
  for (const item of questions) {
    const offered = [...item.options.map(label), "Write a different answer…"];
    const choice = await ui.select(item.question, offered, options);
    if (!choice) return undefined;
    const answer =
      choice === "Write a different answer…"
        ? (await ui.input("Custom answer", undefined, options))?.trim()
        : choice;
    if (!answer) return undefined;
    answers.push({ question: item.question, answer });
  }
  return answers;
}
