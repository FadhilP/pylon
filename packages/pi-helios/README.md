# pi-helios

Consent-gated browser automation, Android-emulator automation, and Windows-window screenshots for Pi. Helios never captures the desktop, exposes raw Playwright/Appium/ADB commands, controls physical Android devices, or monitors in the background.

## Install and availability

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi. `@playwright/cli@0.1.18` is bundled. In Pylon, `helios_browser`, `helios_android`, and `helios_capture` are deferred until `search_tools` activates them; standalone Helios keeps them active. Its package settings are available through Pylon Web.
Configuration is stored at `<agent-dir>/pi-helios/config.json`; Pylon Web uses `~/.pylon/agent` by default, while standalone Pi uses its host agent directory (normally `~/.pi/agent`) unless overridden.

## Browser setup and use

Owned browsers are isolated, temporary, and headless by default. Helios never downloads a browser automatically. From the installed package, explicitly install compatible Chrome when needed:

```sh
node node_modules/@playwright/cli/playwright-cli.js install-browser chrome
```

Downloads normally use `%LOCALAPPDATA%\ms-playwright` on Windows or Playwright's platform cache and can require several hundred MB. Attached sessions use either a loopback CDP endpoint launched with a separate profile, or a supported Playwright MCP Bridge extension in Chrome/Edge. Never expose CDP to the network.

| Tool | Main actions |
| --- | --- |
| `helios_browser` | `start`, `attach`, `close`, `detach`; navigation/resize; snapshot/find/screenshot; click/fill/press/hover/select/check; tab list/select/create/close |
| `helios_android` | AVD/package/status; start/attach/close/detach; snapshot/find/screenshot; tap/fill/back/swipe |
| `helios_capture` | Windows visible top-level window screenshot by required title substring |

Browser calls can batch up to 20 already-known ordered steps. A semantic browser plan resolves unique visible text/accessibility names for up to five non-consequential steps and fails closed on ambiguity/page change. Use latest snapshot/find refs (`e12`), not selectors. `find` takes one text or regex query up to 500 characters. `continue` reads a one-use cached snapshot chunk; new output/page changes invalidate cursors and old refs. Explicit snapshots are limited to 200 lines/20 KB, find to 80 lines/8 KB, and action snapshots to 60 lines/6 KB. URLs allow HTTP(S), `about:blank`, and explicit local `.html`/`.htm` files only. Screenshots are PNG up to 25 MB; snapshots and output are bounded/redacted.

`/helios visibility [show|hide|toggle]` controls future owned browser launches, and `/helios doctor browser` checks CLI readiness. Visibility persists but does not affect active or attached sessions. Text-only models can use bounded browser text; screenshots require an image-capable model. CDP/extension sessions are user-owned: Helios only detaches, never closes their browser/profile.

In Pylon Web, an agent-started owned browser opens a Browser panel with a local bounded JPEG mirror. The panel may launch or directly control an owned browser; control has an idle lease and pauses agent actions. Attached browsers are never mirrored/controlled. The stream stays local to Pylon and outside Pi history/provider context.

## Android emulator setup and safety

Helios starts one existing AVD or attaches to one running emulator. Install user-managed Android SDK `platform-tools`, `emulator`, and an AVD; set `ANDROID_SDK_ROOT`/`ANDROID_HOME` or use detected platform paths. In Pylon Web, **Android tooling → Install** installs pinned Appium/UiAutomator2 into Pylon data only after confirmation; it never changes global npm and preserves a valid install on failed repair. A global Appium or absolute non-symlink `APPIUM_PATH` is accepted if managed tooling is absent. `/helios doctor android` checks prerequisites.

Start/attach needs visible confirmation and is unavailable without interactive UI. Attach accepts an even-port emulator serial and validates emulator/AVD identity. Owned start is visible by default; `headless: true` is opt-in. `close` stops only the emulator Helios launched; `detach` never stops an attached emulator. Fresh confirmation is required to list installed package IDs because they may be sensitive; inventory is all-or-nothing and capped at 128 KB/4,096 packages.

Actions use only refs from the latest snapshot/find. Stale, disabled, off-screen, malformed, or package-escaped targets are refused. Android source is capped at 1 MB/5,000 nodes; editable/password-like values and common credential patterns are redacted, but screenshots cannot be. System UI, permission controllers, launchers, settings, keyboards, installers, mixed-package trees, APK install/transfer, arbitrary capabilities/scripts/selectors, raw device commands, AVD creation/deletion, and physical devices are unsupported. Private Appium binds a random loopback port and never enables relaxed security. Optional live tests require `PI_HELIOS_ANDROID_LIVE=1`, AVD/package variables, and optionally attach serial.

## Consent, privacy, and limitations

Owned browser start needs no confirmation. Attach requires session-scoped confirmation identifying the endpoint/browser; closing an attached user tab needs fresh confirmation. Without UI, owned browser sessions work, but attachment and window capture are refused. Declining consent invokes no browser command. Cleanup uncertainty leaves a retryable `cleanup-required` session.

Returned snapshots/screenshots may contain private messages, passwords, tokens, customer data, and form values. Text snapshots redact form values/common credentials best-effort and report redaction/truncation counts; screenshots cannot be redacted. Returned content and images enter Pi history and go to the selected provider. Temporary Helios artifacts are private and removed on cleanup.

Supervise purchases, messages, publishing, destructive actions, permissions, and secret entry. Upload/download, clipboard, dialogs, storage/cookies, network interception, tracing/video/PDF, arbitrary scripts, and browser chrome are unsupported.

`helios_capture` is Windows-only and captures a visible top-level window using `target: "window"` and a required title substring. Exact title wins; ambiguous matches fail. It revalidates window handle/process/visibility/bounds before `PrintWindow` and has no desktop fallback. Protected, elevated, GPU, minimized, hung, or unsupported windows may be blank or fail.

## Web Scout integration

With pi-scout, Helios provides a separate one-use 60-second headless browser grant for approved `web_scout` calls; it does not share normal Helios sessions. The child can only navigate public pages, take bounded continued snapshots, resolve trusted links, and go back. Its authenticated loopback proxy pins public destinations and blocks private, loopback, metadata, reserved, documentation, multicast, and transition ranges for requests, redirects, and subresources.