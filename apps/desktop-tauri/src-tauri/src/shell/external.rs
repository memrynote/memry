//! Handing a URL or a file to the OS: links, `memry-file:` files, and the three commands the
//! renderer calls. Every entry applies the same allowlist, so a note's link cannot launch a
//! protocol handler and a path cannot name a file outside the app's own directories.

use std::path::{Path, PathBuf};

use memry_desktop::shell::external::{
    OsAction, is_allowed_external_url, os_action, resolve_for_os,
};
use memry_desktop::shell::file_open::Resolution;
use memry_desktop::shell::local_scheme::{
    LocalScheme, locate, normalize_absolute, resolve_local_scheme_path,
};
use tauri::{AppHandle, Wry};
use tauri_plugin_opener::OpenerExt;

use crate::commands::error::{CommandError, ErrorKind};
use crate::protocols;

const WINDOWS: bool = cfg!(windows);

fn refused(message: &str) -> CommandError {
    CommandError::new(ErrorKind::Invalid, "not_allowed", message)
}

/// Opens an `https:`, `http:` or `mailto:` URL in the OS.
pub fn open_url(app: &AppHandle<Wry>, url: &str) -> Result<(), CommandError> {
    if !is_allowed_external_url(url) {
        tracing::warn!(
            scope = "External",
            "refused a link with a scheme the app does not open"
        );
        return Err(refused("only web and mail links open outside the app"));
    }
    #[cfg(feature = "e2e")]
    if crate::e2e::record_os_open(app, &format!("url {url}")) {
        return Ok(());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| CommandError::new(ErrorKind::Internal, "open_failed", error.to_string()))
}

/// A path the OS may be handed: canonical, inside one of the app's directories.
struct Allowed {
    real: PathBuf,
    /// The vault or the app data directory itself, which a person may always open.
    is_root: bool,
}

/// The real path of `path` when it lies inside the open vault or the app data directory and
/// resolves there (a link out of the root is refused).
fn allowed_path(app: &AppHandle<Wry>, path: &str) -> Result<Allowed, CommandError> {
    let roots = protocols::roots(app);
    let mut candidates: Vec<&Path> = roots.vault.iter().map(PathBuf::as_path).collect();
    candidates.push(&roots.app_data);
    let texts: Vec<String> = candidates
        .iter()
        .filter_map(|root| normalize_absolute(&root.to_string_lossy(), WINDOWS))
        .collect();
    let normalized =
        normalize_absolute(path, WINDOWS).ok_or_else(|| refused("not an absolute path"))?;
    let found = locate(&normalized, &texts, WINDOWS).ok_or_else(|| {
        tracing::warn!(
            scope = "External",
            "refused a path outside the app's directories"
        );
        refused("the path is outside the vault and the app data directory")
    })?;
    match resolve_for_os(candidates[found.root], &found.rel) {
        Ok(Resolution::Inside(real)) => Ok(Allowed {
            real,
            is_root: found.rel.is_empty(),
        }),
        Ok(_) => Err(refused("the path does not resolve inside its directory")),
        Err(error) => Err(CommandError::new(
            ErrorKind::Storage,
            "path_failed",
            error.to_string(),
        )),
    }
}

/// `openMemryFileInOs`: the file a `memry-file:` URL names, in the OS.
pub fn open_memry_file(app: &AppHandle<Wry>, url: &str) -> Result<(), CommandError> {
    let path = resolve_local_scheme_path(url, LocalScheme::File, WINDOWS)
        .ok_or_else(|| refused("not a memry-file URL"))?;
    open_path(app, &path)
}

/// Opens the file in its app when it is a type [`os_action`] opens, shows it in the file manager
/// when it is any other type, and refuses a program.
pub fn open_path(app: &AppHandle<Wry>, path: &str) -> Result<(), CommandError> {
    let Allowed { real, is_root } = allowed_path(app, path)?;
    let action = if is_root {
        OsAction::Open
    } else {
        os_action(&real).map_err(|error| {
            CommandError::new(ErrorKind::Storage, "path_failed", error.to_string())
        })?
    };
    match action {
        OsAction::Refuse => {
            tracing::warn!(
                scope = "External",
                "refused to open a file the OS would run"
            );
            Err(refused("a program is not opened from here"))
        }
        OsAction::Reveal => {
            tracing::info!(
                scope = "External",
                "showed a file of a type the app does not open in the file manager"
            );
            reveal(app, real)
        }
        OsAction::Open => {
            #[cfg(feature = "e2e")]
            if crate::e2e::record_os_open(app, &format!("path {}", real.to_string_lossy())) {
                return Ok(());
            }
            // `canonicalize` gives a verbatim `\\?\` path on Windows, which `ShellExecuteExW`
            // does not take for a file; `simplified` drops the prefix when the path means the same
            // without it. No-op elsewhere.
            app.opener()
                .open_path(dunce::simplified(&real).to_string_lossy(), None::<&str>)
                .map_err(|error| {
                    CommandError::new(ErrorKind::Internal, "open_failed", error.to_string())
                })
        }
    }
}

pub fn reveal_path(app: &AppHandle<Wry>, path: &str) -> Result<(), CommandError> {
    reveal(app, allowed_path(app, path)?.real)
}

fn reveal(app: &AppHandle<Wry>, real: PathBuf) -> Result<(), CommandError> {
    #[cfg(feature = "e2e")]
    if crate::e2e::record_os_open(app, &format!("reveal {}", real.to_string_lossy())) {
        return Ok(());
    }
    app.opener()
        .reveal_item_in_dir(real)
        .map_err(|error| CommandError::new(ErrorKind::Internal, "reveal_failed", error.to_string()))
}
