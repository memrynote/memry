use tauri::{AppHandle, Wry};
use tauri_plugin_autostart::ManagerExt;

/// Registers or removes this build's `.desktop` entry through the plugin. Enabling first removes
/// what an Electron install left.
pub fn apply(app: &AppHandle<Wry>, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    let present = manager.is_enabled().map_err(|error| error.to_string())?;
    if enabled {
        remove_foreign_entries();
        if !present {
            manager.enable().map_err(|error| error.to_string())?;
        }
    } else if present {
        manager.disable().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn remove_foreign_entries() {
    use memry_desktop::shell::autostart::is_foreign_autostart_entry;

    let Some(dir) = dirs_autostart() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.ends_with(".desktop") {
            continue;
        }
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        if is_foreign_autostart_entry(name, &contents) {
            match std::fs::remove_file(&path) {
                Ok(()) => tracing::info!(scope = "Autostart", "removed the older entry {name}"),
                Err(error) => {
                    tracing::warn!(scope = "Autostart", "could not remove {name}: {error}");
                }
            }
        }
    }
}

fn dirs_autostart() -> Option<std::path::PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::Path::new(&home).join(".config"))
        })?;
    Some(config.join("autostart"))
}
