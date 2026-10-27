//! Login item rules (`app.setLoginItemSettings`, `ipc/settings-handlers.ts`). Enabling start on
//! boot also removes the entry an Electron install left, or the user would start two copies.

/// The name every Tauri login item is registered under (the Windows Run value, the Linux
/// `.desktop` file stem).
pub const APP_NAME: &str = "MemryNote";

/// Whether a Windows `Run` value belongs to an older install of the app: its command names
/// `Memrynote.exe` and it is not the value this build writes. Value names are case-insensitive,
/// so `Memrynote` and `MemryNote` are the same value and never a duplicate.
pub fn is_foreign_run_value(name: &str, data: &str) -> bool {
    !name.eq_ignore_ascii_case(APP_NAME) && data.to_ascii_lowercase().contains("memrynote.exe")
}

/// Whether a Linux autostart `.desktop` file is another entry for the app: its `Exec` line names
/// `memrynote` and it is not the file this build writes.
pub fn is_foreign_autostart_entry(file_name: &str, contents: &str) -> bool {
    // File names are case-sensitive on Linux: `memrynote.desktop` is not ours.
    if file_name == format!("{APP_NAME}.desktop") {
        return false;
    }
    contents
        .lines()
        .filter_map(|line| line.trim().strip_prefix("Exec="))
        .any(|command| command.to_ascii_lowercase().contains("memrynote"))
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
    fn another_apps_run_value_is_left_alone() {
        assert!(!is_foreign_run_value(
            "OneDrive",
            r#""C:\OneDrive\OneDrive.exe" /background"#
        ));
        assert!(!is_foreign_run_value("Other", ""));
    }

    #[test]
    fn a_desktop_file_for_the_app_under_another_name_is_foreign() {
        let entry = "[Desktop Entry]\nType=Application\nExec=/opt/Memrynote/memrynote --hidden\n";
        assert!(is_foreign_autostart_entry("memrynote.desktop", entry));
        assert!(!is_foreign_autostart_entry("MemryNote.desktop", entry));
    }

    #[test]
    fn a_desktop_file_for_something_else_is_left_alone() {
        let entry = "[Desktop Entry]\nExec=/usr/bin/firefox\nName=memrynote notes helper\n";
        // Only the Exec line counts, not the name.
        assert!(!is_foreign_autostart_entry("firefox.desktop", entry));
    }
}
