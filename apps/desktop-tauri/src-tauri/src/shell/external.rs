//! Handing a URL or a file to the OS: links, `memry-file:` files, and the three commands the
//! renderer calls. Every entry applies the same allowlist, so a note's link cannot launch a
//! protocol handler and a path cannot name a file outside the app's own directories.

use std::path::{Path, PathBuf};

use memry_desktop::shell::external::is_allowed_external_url;
use memry_desktop::shell::file_open::{Resolution, resolve_under_root};
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
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| CommandError::new(ErrorKind::Internal, "open_failed", error.to_string()))
}

/// The real path of `path` when it lies inside the open vault or the app data directory and
/// resolves there (a link out of the root is refused).
fn allowed_path(app: &AppHandle<Wry>, path: &str) -> Result<PathBuf, CommandError> {
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
    match resolve_under_root(candidates[found.root], &found.rel) {
        Ok(Resolution::Inside(real)) => Ok(real),
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

pub fn open_path(app: &AppHandle<Wry>, path: &str) -> Result<(), CommandError> {
    let real = allowed_path(app, path)?;
    app.opener()
        .open_path(real.to_string_lossy(), None::<&str>)
        .map_err(|error| CommandError::new(ErrorKind::Internal, "open_failed", error.to_string()))
}

pub fn reveal_path(app: &AppHandle<Wry>, path: &str) -> Result<(), CommandError> {
    let real = allowed_path(app, path)?;
    app.opener()
        .reveal_item_in_dir(real)
        .map_err(|error| CommandError::new(ErrorKind::Internal, "reveal_failed", error.to_string()))
}
