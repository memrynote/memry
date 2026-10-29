//! On-disk storage of custom icons (`vault/custom-icons.ts`): `<vault>/.memry/icons/<id>.<ext>`.
//!
//! `.memry` is outside the note tree, so the watcher and the index never see these files. The
//! synced `custom_icon` record carries the same bytes, which is what rebuilds a missing file on
//! a device that only pulled the record (Step 13 owns the records).
//!
//! [`write_icon`] is the only writer of the folder. Every source (an upload, a link, the rebuild
//! from a record, the sync mirror) goes through it, so an SVG is sanitized here and nowhere
//! else; that also cleans one written by an older build or by a peer. The id and the extension
//! come from a synced record, which is remote input, so neither reaches the filesystem unless
//! it is a plain name.

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::fs_atomic::{RETRY_DELAYS_MS, WriteError, atomic_replace_checked};
use super::layout::{ICONS_DIR, MEMRY_DIR};
use super::svg::sanitize_svg_bytes;

#[derive(Debug, thiserror::Error)]
pub enum IconError {
    /// The id is not `[a-zA-Z0-9_-]+` or the extension not `[a-zA-Z0-9]+`
    /// (`VaultErrorCode.INVALID_PATH`).
    #[error("invalid custom icon file name: {id}.{ext}")]
    InvalidName { id: String, ext: String },
    /// An SVG with nothing usable left after sanitizing (`VaultErrorCode.CORRUPTED`).
    #[error("custom icon {0} is not a usable SVG")]
    UnusableSvg(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Write(#[from] WriteError),
}

fn is_plain(value: &str, extra: &[char]) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}

/// The icons folder of the vault at `vault`.
pub fn icons_dir(vault: &Path) -> PathBuf {
    vault.join(MEMRY_DIR).join(ICONS_DIR)
}

/// The file of one icon, refused unless the id and the extension are plain names.
pub fn icon_path(vault: &Path, id: &str, ext: &str) -> Result<PathBuf, IconError> {
    if !is_plain(id, &['_', '-']) || !is_plain(ext, &[]) {
        return Err(IconError::InvalidName {
            id: id.to_owned(),
            ext: ext.to_owned(),
        });
    }
    Ok(icons_dir(vault).join(format!("{id}.{ext}")))
}

/// Writes (or replaces) one icon's bytes and returns its path. An `svg` is sanitized first;
/// bytes with no usable SVG left write nothing.
///
/// The icons folder is created inside `.memry`, never `.memry` itself: a vault whose folder is
/// away (a drive unplugged) fails the write instead of growing a stray copy of its root. The
/// write is atomic, where Electron wrote the file in place.
pub fn write_icon(vault: &Path, id: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, IconError> {
    let path = icon_path(vault, id, ext)?;
    let sanitized;
    let bytes = if ext.eq_ignore_ascii_case("svg") {
        sanitized =
            sanitize_svg_bytes(bytes).ok_or_else(|| IconError::UnusableSvg(id.to_owned()))?;
        &sanitized[..]
    } else {
        bytes
    };
    match std::fs::create_dir(icons_dir(vault)) {
        Err(err) if err.kind() != io::ErrorKind::AlreadyExists => return Err(err.into()),
        _ => {}
    }
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    atomic_replace_checked(&path, bytes, &delays, &mut || Ok(()))?;
    Ok(path)
}

/// Removes one icon's file. A file that is not there is no error.
pub fn remove_icon(vault: &Path, id: &str, ext: &str) -> Result<(), IconError> {
    match std::fs::remove_file(icon_path(vault, id, ext)?) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err.into()),
        _ => Ok(()),
    }
}

/// Whether this device holds the icon's file.
pub fn icon_exists(vault: &Path, id: &str, ext: &str) -> bool {
    icon_path(vault, id, ext).is_ok_and(|path| path.is_file())
}
