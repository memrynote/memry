# Runtime E2E Lane

`pnpm --filter @memry/desktop-tauri test:e2e:runtime` runs the M5 real Tauri
runtime scenarios through `tauri-driver` and WebDriverIO.

Desktop WebDriver is supported by Tauri on Linux and Windows. macOS is skipped
because WKWebView does not provide a desktop WebDriver backend; on this machine
`tauri-driver v2.0.5` exits with `tauri-driver is not supported on this platform`.

Supported runners need:

- `cargo install tauri-driver --locked`
- Linux: `webkit2gtk-driver` plus the normal Tauri build libraries
- Windows: the native Edge WebDriver backend available on PATH

Use `pnpm --filter @memry/desktop-tauri test:e2e:runtime -- --list` to list the
registered scenarios without launching a runtime.
