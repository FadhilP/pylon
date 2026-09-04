# pi-focus

A quieter, extension-first Pi TUI with the included `focus-dark` theme.

## Install

Requires Pi and Node 22.19.0 or later:

```sh
pi install git:github.com/FadhilP/pylon
```

Reload Pi, then apply the palette once with `/ui theme` or select `focus-dark` in `/settings`.

## TUI controls

| Command                      | Effect                                               |
| ---------------------------- | ---------------------------------------------------- |
| `/ui`                        | Show current UI state                                |
| `/ui enable` / `/ui disable` | Enable Focus or restore built-in UI for this runtime |
| `/ui density compact         | comfortable`                                         | Choose layout density                               |
| `/ui bell on                 | off`                                                 | Toggle a settled-run terminal bell for this runtime |
| `/ui theme`                  | Reapply the included focus-dark theme                |

`compact` uses a one-line header. `comfortable` adds a secondary key-hint header; the footer always remains one line. Focus applies the Pylon-aligned `focus-dark` palette when its TUI starts. `/ui` is TUI-only. Disable the package persistently through `pi config`.

## What changes

Focus provides restrained message/tool surfaces, readable diff/syntax/Markdown/thinking/warning/error colors, a compact workspace header, a one-row lifecycle/session/branch footer with model usage, session cost, and context pressure, a keybinding-preserving editor with an inline placeholder and model/thinking label, a quieter thinking-level indicator, and elapsed Scout/Web Scout/Advisor/Grunt activity.

The Pi extension API cannot restructure built-in transcript rows, remove internal thinking separators, or change built-in tool rows without taking over tool execution. Focus improves their contrast and visual weight but does not change those core behaviors.
