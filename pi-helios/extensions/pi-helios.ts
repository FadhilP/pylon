import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { captureBrowser, captureWindow, findWindow, validatePng } from "../src/capture.ts";

const captureSchema = Type.Object({
  target: StringEnum(["window", "browser"] as const, { description: "Capture one Windows window or one browser viewport" }),
  endpoint: Type.Optional(Type.String({ description: "Loopback Chrome DevTools endpoint; browser only" })),
  title: Type.Optional(Type.String({ description: "Required Windows window title substring, or optional browser tab title/URL substring" })),
});

export default function helios(pi: ExtensionAPI) {
  pi.registerTool({
    name: "helios_capture",
    label: "Helios Capture",
    description: "Capture one Windows window or browser viewport after visible user confirmation, then attach it for visual debugging. Never captures whole desktop, runs in background, or controls input.",
    promptSnippet: "Capture consented Windows-window or browser-viewport screenshots for visual debugging",
    promptGuidelines: [
      "Use helios_capture only when user asks to inspect current computer or browser state.",
      "Never use helios_capture for monitoring; every capture requires fresh user confirmation.",
    ],
    parameters: captureSchema,
    executionMode: "sequential",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("Helios capture requires interactive confirmation");
      if (ctx.model && !ctx.model.input.includes("image")) throw new Error("Selected model does not support image input");
      const endpoint = params.endpoint ?? "http://127.0.0.1:9222";
      const windowTarget = params.target === "window"
        ? await findWindow((command, args, options) => pi.exec(command, args, options), params.title ?? "", signal)
        : undefined;
      const source = windowTarget
        ? `Windows window “${windowTarget.title}” (including obscured content when Windows permits)`
        : `browser viewport${params.title ? ` matching “${params.title}”` : ""} via ${endpoint}`;
      const approved = await ctx.ui.confirm(
        "Allow screenshot?",
        `Helios will capture ${source}. Screenshots may contain secrets. Image and selected window/tab metadata will be sent to selected model provider and retained in Pi session history.`,
      );
      if (!approved) {
        return { content: [{ type: "text" as const, text: "User declined screenshot capture." }], details: { declined: true } };
      }

      onUpdate?.({ content: [{ type: "text" as const, text: `Capturing ${source}...` }], details: {} });
      const directory = await mkdtemp(join(tmpdir(), "pi-helios-"));
      const screenshot = join(directory, "capture.png");
      try {
        await chmod(directory, 0o700).catch(() => {});
        let browser: { title: string; url: string } | undefined;
        if (windowTarget) {
          await captureWindow((command, args, options) => pi.exec(command, args, options), windowTarget, screenshot, signal);
        } else {
          const captured = await captureBrowser(endpoint, params.title, signal);
          await writeFile(screenshot, captured.data, { mode: 0o600 });
          browser = { title: captured.title, url: captured.url };
        }
        const bytes = await readFile(screenshot);
        validatePng(bytes);

        const readTool = createReadToolDefinition(ctx.cwd);
        const result = await readTool.execute(toolCallId, { path: screenshot }, signal, onUpdate, ctx);
        const description = browser
          ? `Captured browser viewport: ${browser.title}${browser.url ? ` (${browser.url})` : ""}`
          : `Captured Windows window: ${windowTarget!.title}`;
        return {
          content: [{ type: "text" as const, text: description }, ...result.content],
          details: { target: params.target, browser, windowTitle: windowTarget?.title },
        };
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {
          ctx.ui.notify(`Helios could not delete temporary capture directory: ${directory}`, "warning");
        });
      }
    },
  });
}
