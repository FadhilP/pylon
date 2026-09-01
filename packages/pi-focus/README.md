# pi-focus

A quieter, extension-first Pi TUI with the included `focus-dark` theme.

## Install

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi, then apply the palette once with `/ui theme` or select `focus-dark` in `/settings`.

## TUI controls

| Command | Effect |
| --- | --- |
| `/ui` | Show current UI state |
| `/ui enable` / `/ui disable` | Enable Focus or restore built-in UI for this runtime |
| `/ui density compact|comfortable` | Choose layout density |
| `/ui bell on|off` | Toggle a settled-run terminal bell for this runtime |
| `/ui theme` | Apply the included theme |

`compact` uses one-line header/footer. `comfortable` adds secondary key hints on terminals at least 80 columns wide. `/ui` is TUI-only. Disable the package persistently through `pi config`.

## What changes

Focus provides restrained message/tool surfaces, readable diff/syntax/Markdown/thinking/warning/error colors, a compact workspace/session header, responsive usage/context/cost footer, a keybinding-preserving editor with model and thinking level, a quieter working indicator, and transient Scout/Advisor/Grunt child-model status.

The Pi extension API cannot restructure built-in transcript rows, remove internal thinking separators, or change built-in tool rows without taking over tool execution. Focus improves their contrast and visual weight but does not change those core behaviors.