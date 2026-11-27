//! Shims the Electron app installed run `<app> [tokens] --cli "$@"` (`renderShim` of
//! `apps/desktop/src/main/cli/terminal-command.ts:156-179`). They keep working without a
//! reinstall: everything before `--cli` is ignored and the user's words arrive unchanged.

use std::ffi::OsString;

use memrynote_cli::headless_args;

const USER_ARGS: [&str; 5] = ["--json", "notes", "create", "a \"quoted\" title", "--tag"];

/// The argv the OS hands the binary for a shim command line: the executable, the shim's own
/// tokens, then the user's words in place of `"$@"` or `%*`.
fn argv(shim_tokens: &[&str]) -> Vec<OsString> {
    shim_tokens
        .iter()
        .copied()
        .chain(USER_ARGS)
        .map(OsString::from)
        .collect()
}

/// The words of a shim's launch line before its `"$@"` / `%*`, split as the shell does for
/// these lines (double-quoted paths, no escapes inside them).
fn launch_tokens(line: &str, user_args: &str) -> Vec<String> {
    let line = line
        .strip_prefix("exec ")
        .unwrap_or(line)
        .strip_suffix(user_args)
        .expect("the launch line ends with the user's arguments");
    let mut tokens = Vec::new();
    let mut quoted = false;
    let mut current = String::new();
    for ch in line.chars() {
        match ch {
            '"' => quoted = !quoted,
            ' ' if !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            ch => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn expected() -> Option<Vec<String>> {
    Some(USER_ARGS.iter().map(|arg| (*arg).to_owned()).collect())
}

#[test]
fn a_linux_shim_with_the_headless_switches_and_an_app_path() {
    let shim = "#!/bin/sh\n# Memry terminal command shim\nexec \"/opt/MemryNote/memrynote\" \"/opt/MemryNote/resources/app.asar\" --ozone-platform=headless --disable-gpu --cli \"$@\"\n";
    let line = shim.lines().nth(2).expect("launch line");
    let tokens = launch_tokens(line, " \"$@\"");
    assert_eq!(
        tokens,
        [
            "/opt/MemryNote/memrynote",
            "/opt/MemryNote/resources/app.asar",
            "--ozone-platform=headless",
            "--disable-gpu",
            "--cli"
        ]
    );
    let tokens: Vec<&str> = tokens.iter().map(String::as_str).collect();
    assert_eq!(headless_args(&argv(&tokens)), expected());
}

#[test]
fn a_macos_shim() {
    let shim = "#!/bin/sh\n# Memry terminal command shim\nexec \"/Applications/MemryNote.app/Contents/MacOS/MemryNote\" --cli \"$@\"\n";
    let line = shim.lines().nth(2).expect("launch line");
    let tokens = launch_tokens(line, " \"$@\"");
    let tokens: Vec<&str> = tokens.iter().map(String::as_str).collect();
    assert_eq!(headless_args(&argv(&tokens)), expected());
}

#[test]
fn a_windows_cmd_shim() {
    let shim = "@echo off\r\n@rem Memry terminal command shim\r\n\"C:\\Users\\Kaan Ö\\AppData\\Local\\Programs\\MemryNote\\MemryNote.exe\" --cli %*\r\n";
    let line = shim.split("\r\n").nth(2).expect("launch line");
    let tokens = launch_tokens(line, " %*");
    assert_eq!(
        tokens,
        [
            "C:\\Users\\Kaan Ö\\AppData\\Local\\Programs\\MemryNote\\MemryNote.exe",
            "--cli"
        ]
    );
    let tokens: Vec<&str> = tokens.iter().map(String::as_str).collect();
    assert_eq!(headless_args(&argv(&tokens)), expected());
}

#[test]
fn only_the_first_cli_token_starts_the_arguments() {
    let args = headless_args(&argv(&["app", "--cli", "--cli"]));
    let mut want = vec!["--cli".to_owned()];
    want.extend(expected().expect("args"));
    assert_eq!(args, Some(want));
    assert_eq!(headless_args(&argv(&["app"])), None);
}

/// The real shell passes the user's words through `"$@"` unchanged.
#[cfg(unix)]
#[test]
fn a_posix_shim_run_by_sh_hands_the_words_through() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("tempdir");
    let app = dir.path().join("Memry Note app");
    std::fs::write(
        &app,
        "#!/bin/sh\nfor arg in \"$0\" \"$@\"; do printf '%s\\0' \"$arg\"; done\n",
    )
    .expect("write app");
    std::fs::set_permissions(&app, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    let shim = dir.path().join("memrynote");
    std::fs::write(
        &shim,
        format!(
            "#!/bin/sh\n# Memry terminal command shim\nexec \"{}\" --ozone-platform=headless --disable-gpu --cli \"$@\"\n",
            app.display()
        ),
    )
    .expect("write shim");
    let output = std::process::Command::new("sh")
        .arg(&shim)
        .args(USER_ARGS)
        .output()
        .expect("run shim");
    assert!(output.status.success());
    let argv: Vec<OsString> = String::from_utf8(output.stdout)
        .expect("utf-8")
        .split_terminator('\0')
        .map(OsString::from)
        .collect();
    assert_eq!(headless_args(&argv), expected());
}
