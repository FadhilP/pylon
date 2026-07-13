# pi-focus

Low-noise extension-first TUI package for [Pi](https://pi.dev), built from an audit of real tool-heavy sessions.

## Install

```sh
pi install /absolute/path/to/pi-focus
```

Apply palette once:

```text
/ui theme
```

Or select `focus-dark` through `/settings`.

## Commands

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

`compact` uses one-line header/footer. `comfortable` adds secondary key hints on terminals at least 80 columns wide. Unicode and ANSI-styled labels are measured by terminal cell width. `bell on` enables an opt-in terminal bell after each settled agent run for current runtime; `bell off` disables it. `disable` restores built-in header, footer, editor, and working indicator for current runtime. Package can be disabled persistently through `pi config`.

## Changes

- restrained neutral tool/message surfaces instead of full neon status blocks;
- readable diff, syntax, markdown, thinking, warning, and error colors;
- compact workspace/session header;
- responsive footer grouping workspace, active state or extension status, usage, context pressure, and cost;
- built-in `CustomEditor` wrapper preserving Pi keybindings while showing model/thinking;
- quieter working indicator;
- transient Scout/Advisor child-model widget.

## Limits

Extension API cannot restructure built-in user/assistant transcript rows, remove internal thinking separators, or change built-in tool-row composition without overriding tool execution. Those remain Pi-core work. Theme improves their contrast and visual weight safely.
