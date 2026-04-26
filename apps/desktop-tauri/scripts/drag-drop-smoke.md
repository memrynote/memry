# M3 drag-drop path-resolution spike

Run `pnpm --filter @memry/desktop-tauri dev`, drag files into the
window, watch dev console for `[drag-drop spike] paths:` log line.

| Outcome | What it means | Action |
|---|---|---|
| Real `/Users/...` paths | macOS WebKit + Tauri 2 deliver real paths. | M8 file import can rely on drop events. |
| `webkit-fake-url://` | Native drop didn't work. | Fall back to `dialog_choose_files` for file imports. |
| No drop payload | Drop event was not delivered or could not be manually verified. | Treat `dialog_choose_files` as the canonical fallback until a human Finder smoke passes. |

## Phase F result

Last verified: 2026-04-26, macOS 26.4, Tauri 2.10, Memry desktop-tauri.

Manual Finder drop into the Tauri window emitted real absolute paths:

```text
[drag-drop spike] paths:
[
  "/Users/h4yfans/Desktop/Untitled.mov",
  "/Users/h4yfans/Desktop/Screenshot 2026-04-22 at 22.58.37.png",
  "/Users/h4yfans/Desktop/Screenshot 2026-04-22 at 22.58.37 copy.png",
  "/Users/h4yfans/Desktop/Screenshot 2026-04-22 at 22.58.37 copy 2.png"
]
```

Result: green. M8 file import can consume native drop events, with
`dialog_choose_files` retained as the fallback path.
