//! Login item rules (`app.setLoginItemSettings`, `ipc/settings-handlers.ts`). Enabling start on
//! boot also removes the entry an Electron install left, or the user would start two copies.

/// The name every Tauri login item is registered under (the Windows Run value, the Linux
/// `.desktop` file stem).
pub const APP_NAME: &str = "MemryNote";

/// The command line of this build's Windows `Run` value. Quoted, because the install path holds
/// spaces when the profile name does (`C:\Users\Ada Lovelace\...`) and an unquoted command
/// there runs a program that does not exist. Electron wrote it quoted too.
pub fn run_command(exe: &str) -> String {
    format!("\"{exe}\"")
}

/// Whether a Windows `Run` value belongs to an older install of the app: its command names
/// `Memrynote.exe` and it is not the value this build writes. Value names are case-insensitive,
/// so `Memrynote` and `MemryNote` are the same value and never a duplicate.
pub fn is_foreign_run_value(name: &str, data: &str) -> bool {
    !name.eq_ignore_ascii_case(APP_NAME) && data.to_ascii_lowercase().contains("memrynote.exe")
}

/// Whether a Linux autostart `.desktop` file is the entry an Electron install wrote: the file is
/// named `memrynote.desktop` (whatever its case, but not the `MemryNote.desktop` this build
/// writes) and its `Exec` command runs a program called exactly `memrynote`. Anything else in
/// the folder is the user's own, whatever its command line mentions.
pub fn is_foreign_autostart_entry(file_name: &str, contents: &str) -> bool {
    // File names are case-sensitive on Linux: `MemryNote.desktop` is ours.
    if file_name == format!("{APP_NAME}.desktop") {
        return false;
    }
    if !file_name.eq_ignore_ascii_case("memrynote.desktop") {
        return false;
    }
    contents
        .lines()
        .filter_map(|line| line.trim().strip_prefix("Exec="))
        .any(|command| program_name(command) == "memrynote")
}

/// The file name of the program an `Exec` value starts: its first word, which a quoted path may
/// spread over spaces.
fn program_name(command: &str) -> &str {
    let command = command.trim_start();
    let program = match command.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next().unwrap_or_default(),
        None => command.split_whitespace().next().unwrap_or_default(),
    };
    program.rsplit('/').next().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_electron_run_value_is_foreign_and_ours_is_not() {
        let exe = r#""C:\Users\k\AppData\Local\MemryNote\current\Memrynote.exe""#;
        assert!(is_foreign_run_value("electron.app.Memrynote", exe));
        assert!(is_foreign_run_value(
            "com.squirrel.MemryNote.Memrynote",
            exe
        ));
        assert!(!is_foreign_run_value("MemryNote", exe));
        // Value names compare without case, so the old name is the same value.
        assert!(!is_foreign_run_value("Memrynote", exe));
    }

    #[test]
    fn the_run_command_is_quoted_so_a_path_with_spaces_still_starts() {
        assert_eq!(
            run_command(r"C:\Users\Ada Lovelace\AppData\Local\MemryNote\current\Memrynote.exe"),
            r#""C:\Users\Ada Lovelace\AppData\Local\MemryNote\current\Memrynote.exe""#
        );
    }

    #[test]
    fn another_apps_run_value_is_left_alone() {
        assert!(!is_foreign_run_value(
            "OneDrive",
            r#""C:\OneDrive\OneDrive.exe" /background"#
        ));
        assert!(!is_foreign_run_value("Other", ""));
    }

    #[test]
    fn the_desktop_file_an_electron_install_wrote_is_foreign_and_ours_is_not() {
        let entry = "[Desktop Entry]\nType=Application\nExec=/opt/MemryNote/memrynote --hidden\n";
        assert!(is_foreign_autostart_entry("memrynote.desktop", entry));
        assert!(!is_foreign_autostart_entry("MemryNote.desktop", entry));
    }

    #[test]
    fn a_quoted_command_with_spaces_in_its_path_is_matched_by_its_program() {
        let entry = "[Desktop Entry]\nExec=\"/opt/My Apps/memrynote\" --hidden\n";
        assert!(is_foreign_autostart_entry("memrynote.desktop", entry));
    }

    #[test]
    fn a_users_own_autostart_file_is_left_alone_whatever_its_command_mentions() {
        let helper = "[Desktop Entry]\nExec=/usr/bin/memrynote-clip --daemon\n";
        assert!(!is_foreign_autostart_entry("clip.desktop", helper));
        // Same program, but not a file an Electron install wrote.
        let own = "[Desktop Entry]\nExec=/opt/MemryNote/memrynote --hidden\n";
        assert!(!is_foreign_autostart_entry("my-notes.desktop", own));
        // The right file name with a different program.
        let other = "[Desktop Entry]\nExec=/usr/bin/firefox\nName=memrynote notes helper\n";
        assert!(!is_foreign_autostart_entry("memrynote.desktop", other));
        let lookalike = "[Desktop Entry]\nExec=/usr/bin/memrynote-clip\n";
        assert!(!is_foreign_autostart_entry("memrynote.desktop", lookalike));
    }
}
