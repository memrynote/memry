//! Which Windows installer laid the app down, and the AppUserModelID that follows
//! (`apps/desktop/src/main/windows-install-layout.ts`). Windows paths by definition, so the
//! probes are built as strings and the rule tests on any host.

pub const NSIS_UNINSTALLER_FILENAME: &str = "Uninstall MemryNote.exe";
pub const APP_USER_MODEL_ID: &str = "com.memrynote.memry";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsInstallLayout {
    Nsis,
    Velopack,
    Unknown,
}

fn parent(path: &str) -> &str {
    path.rfind('\\').map_or("", |at| &path[..at])
}

/// Velopack: `<dir>\..\Update.exe` exists; NSIS: `<dir>\Uninstall MemryNote.exe` exists;
/// otherwise unknown.
pub fn detect(exec_path: &str, exists: impl Fn(&str) -> bool) -> WindowsInstallLayout {
    let dir = parent(exec_path);
    if exists(&format!("{}\\Update.exe", parent(dir))) {
        WindowsInstallLayout::Velopack
    } else if exists(&format!("{dir}\\{NSIS_UNINSTALLER_FILENAME}")) {
        WindowsInstallLayout::Nsis
    } else {
        WindowsInstallLayout::Unknown
    }
}

/// Velopack's bootstrap already sets the AppUserModelID its Start menu shortcut carries, and
/// overriding it would add a second taskbar icon. Every other layout sets
/// [`APP_USER_MODEL_ID`]. `None` keeps the current ID.
pub fn app_user_model_id_override(
    exec_path: &str,
    exists: impl Fn(&str) -> bool,
) -> Option<&'static str> {
    (detect(exec_path, exists) != WindowsInstallLayout::Velopack).then_some(APP_USER_MODEL_ID)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VELOPACK: &str = "C:\\Users\\k\\AppData\\Local\\MemryNote\\current\\Memrynote.exe";
    const NSIS: &str = "C:\\Program Files\\MemryNote\\Memrynote.exe";

    #[test]
    fn velopack_keeps_its_own_id_so_the_shortcut_and_window_share_one_icon() {
        let exists = |p: &str| p == "C:\\Users\\k\\AppData\\Local\\MemryNote\\Update.exe";
        assert_eq!(detect(VELOPACK, exists), WindowsInstallLayout::Velopack);
        assert_eq!(app_user_model_id_override(VELOPACK, exists), None);
    }

    #[test]
    fn nsis_sets_the_app_id() {
        let exists = |p: &str| p == "C:\\Program Files\\MemryNote\\Uninstall MemryNote.exe";
        assert_eq!(detect(NSIS, exists), WindowsInstallLayout::Nsis);
        assert_eq!(
            app_user_model_id_override(NSIS, exists),
            Some(APP_USER_MODEL_ID)
        );
    }

    #[test]
    fn dev_and_unknown_layouts_set_it() {
        assert_eq!(detect("/dev/app", |_| false), WindowsInstallLayout::Unknown);
        assert_eq!(
            app_user_model_id_override("/dev/app", |_| false),
            Some(APP_USER_MODEL_ID)
        );
    }
}
