export type Option = { label: string; description?: string };
export type Question = { question: string; options: Option[] };

export function validateQuestion(question: string, options: Option[]) {
  if (!question.trim() || question.length > 500 || options.length < 2 || options.length > 4)
    throw Error("Clarification requires one concise question and 2-4 options.");
  const labels = options.map(o => o.label.trim().toLowerCase());
  if (
    labels.some(x => !x) ||
    new Set(labels).size !== labels.length ||
    options.some(o => o.label.length > 120 || (o.description?.length || 0) > 240)
  )
    throw Error("Clarification options must be concise, non-empty, and unique.");
}

export function validateQuestions(questions: Question[]) {
  if (questions.length < 1 || questions.length > 6) throw Error("Clarification requires 1-6 questions.");
  for (const item of questions) validateQuestion(item.question, item.options);
}
