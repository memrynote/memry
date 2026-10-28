use memry_desktop::shell::autostart::{APP_NAME, is_foreign_run_value, run_command};
use tauri::{AppHandle, Wry};
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// Writes or removes this build's `Run` value itself: the autostart plugin writes the path
/// unquoted, which fails for a profile name with spaces. Enabling first removes what an Electron
/// install left.
pub fn apply(_app: &AppHandle<Wry>, enabled: bool) -> Result<(), String> {
    let (run, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey_with_flags(RUN_KEY, KEY_READ | KEY_SET_VALUE)
        .map_err(|error| format!("cannot open the Run key: {error}"))?;
    if !enabled {
        return match run.delete_value(APP_NAME) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("cannot remove the Run value: {error}")),
        };
    }
    remove_foreign_values(&run);
    let exe = std::env::current_exe().map_err(|error| format!("no executable path: {error}"))?;
    run.set_value(APP_NAME, &run_command(&exe.to_string_lossy()))
        .map_err(|error| format!("cannot write the Run value: {error}"))
}

fn remove_foreign_values(run: &RegKey) {
    let foreign: Vec<String> = run
        .enum_values()
        .filter_map(Result::ok)
        .filter(|(name, value)| is_foreign_run_value(name, &value.to_string()))
        .map(|(name, _)| name)
        .collect();
    for name in foreign {
        match run.delete_value(&name) {
            Ok(()) => tracing::info!(scope = "Autostart", "removed the older Run value {name}"),
            Err(error) => {
                tracing::warn!(
                    scope = "Autostart",
                    "could not remove Run value {name}: {error}"
                );
            }
        }
    }
}
