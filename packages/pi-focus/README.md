# pi-focus

Low-noise extension-first TUI package for [Pi](https://pi.dev), built from an audit of real tool-heavy sessions.

## Installation

```sh
pi install git:github.com/FadhilP/pi-conductor
```

This installs the complete Pi Conductor bundle, including pi-focus and the `focus-dark` theme. Run `/reload` after installation.

Apply the palette once with `/ui theme`, or select `focus-dark` through `/settings`.

## Usage

```text
/ui status
/ui compact
/ui comfortable
/ui disable
/ui enable
/ui bell on
/ui bell off
/ui theme
```

`compact` uses a one-line header and footer. `comfortable` adds secondary key hints on terminals at least 80 columns wide. Unicode and ANSI-styled labels are measured by terminal cell width.

`bell on` enables an opt-in terminal bell after each settled agent run for the current runtime; `bell off` disables it. `disable` restores the built-in header, footer, editor, and working indicator for the current runtime. Disable the package persistently through `pi config`.

## Features

- Restrained neutral tool and message surfaces instead of full neon status blocks.
- Readable diff, syntax, Markdown, thinking, warning, and error colors.
- Compact workspace and session header.
- Responsive footer grouping workspace, active state or extension status, usage, context pressure, and cost.
- Built-in `CustomEditor` wrapper preserving Pi keybindings while showing model and thinking level.
- Quieter working indicator.
- Transient Scout, Advisor, and Grunt child-model widget.

## Limitations

The extension API cannot restructure built-in user or assistant transcript rows, remove internal thinking separators, or change built-in tool-row composition without overriding tool execution. Those remain Pi-core work. The theme safely improves their contrast and visual weight.
