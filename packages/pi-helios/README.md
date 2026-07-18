# pi-helios

Consent-gated browser use and named Windows-window screenshots for [Pi](https://pi.dev). Helios never captures a desktop, controls native input, exposes raw Playwright commands, or monitors in background.

## Installation

```sh
pi install git:github.com/FadhilP/pylon
```

Run `/reload` after installation. `@playwright/cli@0.1.17` is pinned as runtime dependency.

## Browser setup

Owned sessions use a visible isolated browser. Helios never downloads browsers during extension load or tool execution. If no compatible browser exists, run explicit setup from installed `pi-helios` package:

```sh
node node_modules/@playwright/cli/playwright-cli.js install-browser chrome
```

Playwright browser downloads normally live under `%LOCALAPPDATA%\ms-playwright` on Windows or platform Playwright cache. Download and installed size vary by browser/version; allow several hundred MB and review CLI prompt before installation.

Attached sessions need no separate browser download when existing browser is compatible:

- **CDP:** launch Chrome/Chromium/Edge with remote debugging and separate profile, then attach to loopback HTTP origin such as `http://127.0.0.1:9222`. Never expose debugging port to network.
- **Extension:** install and enable supported Playwright MCP Bridge extension in Chrome or Edge. Browser permissions and incognito policy still apply.

Example CDP launch:

```sh
chrome --remote-debugging-port=9222 --user-data-dir=C:\temp\pi-helios-cdp
```

## Browser use

`helios_browser` exposes constrained actions:

- `start`, `attach`, `close`, `detach`
- `navigate`, `back`, `forward`, `reload`
- `snapshot`, `find`, `screenshot`
- `click`, `fill`, `press`, `hover`, `select`, `check`, `uncheck`
- `tabs` with `list`, `select`, `create`, or `close`

Ordered actions can be sent in one batch (up to 20 steps):

```text
{ actions: [{ action: "start", url: "https://example.com" }, { action: "snapshot" }, { action: "close" }] }
```

Batch only steps whose targets and element references are already known. If a later action depends on inspecting an earlier snapshot or result, make a separate call instead.

Prefer targeted search over a full snapshot when the element text is known:

```text
{ action: "find", text: "Add to cart" }
{ action: "find", regex: "/sign (in|up)/i" }
```

`find` accepts exactly one plain-text or regular-expression query, searches the current accessibility snapshot, and returns matching nodes with nearby context and usable refs. Queries are limited to 500 characters.

Use element references from latest snapshot, such as `e12`; arbitrary selectors are rejected. URLs permit HTTP(S) and `about:blank`, not credentials or local files. Snapshot depth, text, output, errors, tabs, and screenshots are bounded. Screenshots remain limited to valid PNG files up to 25 MB.

Owned sessions are shown by default, isolated, temporary, and closed on explicit `close` or Pi session shutdown. Toggle future owned launches between shown and headless mode:

```text
/helios-visibility
/helios-visibility show
/helios-visibility hide
/helios-visibility status
```

No argument toggles setting. Change is in-memory and affects only future owned launches in current loaded session; active owned and attached browsers remain unchanged. Headless mode cannot provide visual supervision and must not be used for purchases, messages, publishing, permissions, or destructive actions.

Check pinned CLI readiness without launching a browser:

```text
/helios-doctor
```

Compatible browser launch remains verified during consented `start`; Helios never installs a browser automatically.

CDP/extension sessions are user-owned: Helios only `detach`s, never closes browser, kills process, or deletes profile. Shutdown cleanup is best effort after abrupt process termination.

Text-only models may use approved bounded snapshots and interactions. Screenshots require image-capable model.

## Consent and privacy

Starting owned browser requires interactive session grant. Attaching to existing browser always requires separate confirmation naming endpoint/browser and warns that existing tabs, logins, and page data may be exposed. Grant lasts for current Pi browser session. Closing attached user tab requires fresh confirmation.

Snapshots and screenshots can contain passwords, private messages, tokens, customer data, and form content. Snapshot form values and common textual credential patterns are redacted, with redaction/truncation counts returned in tool details, but users must still supervise. Screenshots cannot be text-redacted. Selected model provider receives returned page text/images and page metadata; Pi session history retains tool results and attachments. Temporary Helios artifacts are private and removed after use/session cleanup.

Consequential generic clicks cannot always be classified reliably. Supervise purchases, sending messages, publishing, destructive actions, permission prompts, and secret entry. Uploads, downloads, clipboard, dialogs, storage, cookies, user-controlled network interception, tracing, video, PDF, arbitrary scripts, and browser chrome are not supported.

No UI means session creation, attachment, screenshots, and browser control are refused. Declined consent invokes no browser command. Cancellation stops current CLI command while preserving healthy session when possible. Uncertain lifecycle cleanup leaves a retryable `cleanup-required` session; use `close` for owned sessions or `detach` for attached sessions.

## Web Scout broker

When bundled with pi-scout, Helios advertises a versioned child-browser capability without sharing normal Helios sessions. Each approved `web_scout` call receives a one-use, 60-second grant for a dedicated headless owned browser. Generic `helios_browser` owned sessions retain their separate visibility setting. Child controls are limited to public navigation, bounded snapshots, trusted link-URL resolution, and back navigation.

Web Scout traffic uses an authenticated loopback proxy that validates and pins public DNS destinations for HTTP requests and HTTPS tunnels, including redirects and subresources. Private, loopback, link-local, metadata, reserved, multicast, documentation, and transition ranges are blocked. Generic `helios_browser` behavior remains unchanged.

## Windows window capture

`helios_capture` is Windows-window-only:

```text
target: window
title: required window-title substring
```

Title matches visible top-level windows case-insensitively. Exact match wins; ambiguous partial matches fail. Helios resolves target before consent, then revalidates handle, process, visibility, and bounds before Win32 `PrintWindow`. No desktop fallback exists. Protected, elevated, GPU-accelerated, minimized, hung, or unsupported windows can produce blank/incomplete images or native failure.

### Breaking change from 0.1

`target: "browser"`, browser `endpoint`, and browser-tab `title` were removed from `helios_capture`. Use `helios_browser` `start`/`attach`, then `screenshot`. Direct CDP WebSocket screenshot implementation no longer exists.
