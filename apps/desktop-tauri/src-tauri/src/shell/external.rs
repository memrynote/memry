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

/// Opens the file in its app when [`os_action`] says so, and otherwise shows it in the file
/// manager. The decision and the open read the same path, byte for byte.
pub fn open_path(app: &AppHandle<Wry>, path: &str) -> Result<(), CommandError> {
    let Allowed { real, is_root } = allowed_path(app, path)?;
    // `canonicalize` gives a verbatim `\\?\` path on Windows, which `ShellExecuteExW` does not
    // take for a file; `simplified` drops the prefix only when the path means the same without
    // it. No-op elsewhere.
    let target = dunce::simplified(&real);
    let action = os_action(target, is_root)
        .map_err(|error| CommandError::new(ErrorKind::Storage, "path_failed", error.to_string()))?;
    match action {
        OsAction::Refuse => {
            tracing::warn!(
                scope = "External",
                rule = "link_swapped_in",
                "refused to open a file"
            );
            Err(refused("the file changed into a link"))
        }
        OsAction::Reveal(rule) => {
            tracing::info!(
                scope = "External",
                rule = rule.as_str(),
                "showed a file in the file manager instead of opening it"
            );
            reveal(app, target)
        }
        OsAction::Open => {
            #[cfg(feature = "e2e")]
            if crate::e2e::record_os_open(app, &format!("path {}", target.display())) {
                return Ok(());
            }
            // A `Path`, not a string: a name that is not UTF-8 reaches the OS unchanged.
            tauri_plugin_opener::open_path(target, None::<&str>).map_err(|error| {
                CommandError::new(ErrorKind::Internal, "open_failed", error.to_string())
            })
        }
    }
}

pub fn reveal_path(app: &AppHandle<Wry>, path: &str) -> Result<(), CommandError> {
    reveal(app, &allowed_path(app, path)?.real)
}

fn reveal(app: &AppHandle<Wry>, target: &Path) -> Result<(), CommandError> {
    #[cfg(feature = "e2e")]
    if crate::e2e::record_os_open(app, &format!("reveal {}", target.display())) {
        return Ok(());
    }
    app.opener()
        .reveal_item_in_dir(target)
        .map_err(|error| CommandError::new(ErrorKind::Internal, "reveal_failed", error.to_string()))
}
