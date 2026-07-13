# pi-helios

Consent-gated Windows-window and browser-viewport screenshots for [Pi](https://pi.dev). Helios lets a vision-capable model inspect current UI state while debugging. It cannot capture whole desktop, click, type, watch continuously, or run in background.

## Install

```sh
pi install /absolute/path/to/pi-helios
```

Ask Pi to inspect a named Windows window or browser tab. Pi calls `helios_capture`; Helios shows confirmation before every capture. Captures attach to model request and remain in Pi session; temporary files are deleted immediately.

## Targets

### Windows window

`target: "window"` requires `title`, matched case-insensitively against visible top-level window titles. Exact match wins. Ambiguous partial matches fail; use a more specific title.

Helios resolves window first, names it in confirmation, then revalidates its handle, process, and visibility before capture. Window titles may change normally between those steps. Win32 `PrintWindow` captures only selected window. No whole-desktop fallback exists. Obscured or minimized content may be captured when Windows permits.

`PrintWindow` can return blank or incomplete images for protected, elevated, GPU-accelerated, hung, or unsupported windows. Helios reports native failure instead of falling back to monitor capture.

### Browser viewport

`target: "browser"` captures visible viewport through loopback Chrome DevTools Protocol endpoint. Default: `http://127.0.0.1:9222`. Optional `title` selects tab by title or URL substring.

Launch Chromium/Chrome with separate debugging profile:

```sh
chromium --remote-debugging-port=9222 --user-data-dir=/tmp/pi-helios-profile
```

Only `localhost`, `127.0.0.1`, and `::1` endpoints accepted. Never expose debugging port to network.

## Privacy

Every capture requires interactive confirmation. Screenshots can contain passwords, private messages, tokens, or customer data. Review named window/tab before approving. Selected model provider receives image and window/tab metadata; Pi session history retains them. Non-interactive modes and text-only models refuse capture.
