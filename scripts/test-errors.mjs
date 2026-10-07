import { inspect } from "node:util";

export default async function* testErrors(source) {
  for await (const { type, data } of source) {
    if (type === "test:fail" && !data.todo) {
      const location = data.file ? ` (${data.file}:${data.line}:${data.column})` : "";
      yield `FAIL ${data.name}${location}\n${inspect(data.details.error, { depth: null, colors: Boolean(process.stdout.isTTY) })}\n`;
    } else if (type === "test:stderr") {
      yield data.message;
    } else if (type === "test:diagnostic" && (data.level === "error" || /^(Error|Warning):/.test(data.message))) {
      yield `${data.message}\n`;
    }
  }
}
