# pi-helios

Consent-gated Windows-window and browser-viewport screenshots for [Pi](https://pi.dev). Helios supports vision-based UI debugging without whole-desktop capture, input control, continuous watching, or background operation.

## Installation

```sh
pi install git:github.com/FadhilP/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-helios. Run `/reload` after installation.

## Usage

Ask Pi to inspect a named Windows window or browser tab. Pi calls `helios_capture`; Helios shows confirmation before every capture. Captures attach to the model request and remain in the Pi session. Temporary files are deleted immediately.

## Windows Window

`target: "window"` requires `title`, matched case-insensitively against visible top-level window titles. Exact match wins. Ambiguous partial matches fail; use a more specific title.

Helios resolves the window first, names it in confirmation, then revalidates its handle, process, and visibility before capture. Window titles may change normally between those steps. Win32 `PrintWindow` captures only the selected window. No whole-desktop fallback exists. Obscured or minimized content may be captured when Windows permits.

`PrintWindow` can return blank or incomplete images for protected, elevated, GPU-accelerated, hung, or unsupported windows. Helios reports native failure instead of falling back to monitor capture.

## Browser Viewports

`target: "browser"` captures the visible viewport through a loopback Chrome DevTools Protocol endpoint. Default: `http://127.0.0.1:9222`. Optional `title` selects a tab by title or URL substring.

Launch Chromium or Chrome with a separate debugging profile:

```sh
chromium --remote-debugging-port=9222 --user-data-dir=/tmp/pi-helios-profile
```

Only `localhost`, `127.0.0.1`, and `::1` endpoints are accepted. Never expose the debugging port to a network.

## Privacy and Limitations

Every capture requires interactive confirmation. Screenshots can contain passwords, private messages, tokens, or customer data. Review the named window or tab before approval. The selected model provider receives the image and window or tab metadata; Pi session history retains them. Non-interactive modes and text-only models refuse capture.
