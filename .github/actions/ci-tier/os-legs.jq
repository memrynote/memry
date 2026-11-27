# The Windows and Apple Silicon legs a fast-tier PR adds, run by tier.sh over the PR's files (JSON
# lines from the pull request files API, slurped) with $gated, the cfg-gated modules os-modules.sh
# found, and $tauri_exclude. Prints `rust_windows rust_macos tauri_windows tauri_macos`, each
# `none`, `checks` (Rust fmt, clippy, doctests and the live OS seams; the Tauri debug build and its
# launch smoke) or `tests` (also the Rust test partitions; the Tauri e2e specs).
#
# A file adds an OS when:
#   - it is build.rs, under .cargo/, the toolchain file, or a CI definition the workflow uses (tests)
#   - it is a Cargo manifest or the lock (checks)
#   - its path names the OS (windows, win, win32, msvc; macos, mac, darwin, apple, .plist)
#   - it is in a module only that OS compiles (`#[cfg(windows)] mod win;`), or is a file that holds
#     an inline one (`#[cfg(windows)] mod win { ... }`)
#   - it is a .rs file whose hunks, context included, carry an OS cfg (`cfg`, `cfg_attr`, `cfg!`
#     naming windows, unix, target_os, target_family or target_env, or a `target_os = ` line of a
#     multi-line cfg), or whose changed lines use an OS API (std::os::windows, windows_sys, objc2).
#     Adding or removing any OS cfg changes what the other OSes compile, so it adds both OSes,
#     `target_os = "linux"` included; `cfg(not(test))` alone is not an OS cfg.
#   - it is a .rs file with changes whose patch GitHub did not send (too large): tests
# A match is `tests` instead of `checks` when the file is a test (tests/, tests.rs, *_test(s).rs) or
# a hunk carries a test attribute. A rename is judged by its old name too.
def names: [.filename, (.previous_filename // empty)];
def hunk: (.patch // "") | split("\n")[] | select(test("^[-+ ]")) | select(test("^(\\+\\+\\+|---) ") | not) | .[1:];
def changed: (.patch // "") | split("\n")[] | select(test("^[-+]")) | select(test("^(\\+\\+\\+|---) ") | not) | .[1:];
def os_cfg:
  (test("cfg(_attr)?!?\\s*\\(") and test("\\b(windows|unix|target_os|target_family|target_env)\\b"))
  or test("\\b(target_os|target_family|target_env)\\s*=")
  or test("^\\s*(windows|unix)\\s*[,)]");
def os_api: test("std::os::(windows|unix)|\\bwindows_sys::|\\bwindows::Win32|\\bobjc2|\\bcore_foundation::|\\bcocoa::");
def os_signal: any(hunk; os_cfg) or any(changed; os_api);
def is_test:
  any(names[]; test("(^|/)tests?/|(^|/)tests?\\.rs$|_tests?\\.rs$"))
  or any(hunk; test("#\\[(tokio::)?test\\b|cfg\\((all\\()?test\\b"));
def found: if is_test then 2 else 1 end;
def gated_os: [names[] as $n | $gated[] as $g | select($n == $g.prefix or $n == $g.prefix + ".rs" or ($n | startswith($g.prefix + "/"))) | $g.os];
def level($os; $os_path):
  if any(names[]; test("(^|/)build\\.rs$|(^|/)\\.cargo/|(^|/)rust-toolchain(\\.toml)?$|^\\.github/")) then 2
  elif any(names[]; test("(^|/)Cargo\\.(toml|lock)$")) then 1
  elif any(names[]; test($os_path; "i")) then found
  elif any(gated_os[]; . == $os or . == "both") then found
  elif (any(names[]; endswith(".rs")) | not) then 0
  elif .patch == null then (if (.changes // 1) > 0 then 2 else 0 end)
  elif os_signal then found
  else 0 end;
def win: level("win"; "(^|[/._-])(windows|win|win32|win64|msvc)([/._-]|$)");
def mac: level("mac"; "(^|[/._-])(macos|mac|darwin|apple|osx)([/._-]|$)|\\.plist$");
def name: ["none", "checks", "tests"][.];
def most(f): (map(f) | max // 0) | name;
# Each workflow's own definitions: its file and the composite actions it uses on every OS.
(map(select(any(names[]; test("^(crates/|apps/desktop-tauri/src-tauri/|\\.github/(actions/(ci-tier|libsodium-dist|ort-static|paths-changed|setup-pnpm)/|workflows/rust-ci\\.yml$))"))))) as $rust
| (map(select(any(names[]; test("^(apps/desktop-tauri/|crates/memry-tauri/|crates/memry-desktop/|crates/(Cargo\\.(toml|lock)|rust-toolchain\\.toml)$|crates/\\.cargo/|\\.github/(actions/(ci-tier|libsodium-dist|paths-changed|setup-pnpm)/|workflows/desktop-tauri-ci\\.yml$))") and (test($tauri_exclude) | not))))) as $tauri
| [($rust | most(win)), ($rust | most(mac)), ($tauri | most(win)), ($tauri | most(mac))] | join(" ")
