//! `resolveAttachment` (`vault/attachment-actions.ts`): the file of this vault an attachment
//! block's `url` names, for the actions of its block menu.
//!
//! A `url` comes in three shapes: note-relative (`../attachments/<noteId>/<file>`, written by
//! desktop), root-relative (`attachments/<noteId>/<file>`, written by mobile), and the legacy
//! absolute `memry-file://local/<path>`, possibly written on another device whose vault sits
//! elsewhere. The url is renderer input and the note body it came from is peer input, so the
//! result is a vault-relative path that [`resolve_under_root`] keeps inside the vault, links
//! included: no url hands the caller a path outside it. Electron joined strings and followed
//! links out of the vault; this refuses them.

use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;

use super::AttachmentError;
use crate::shell::file_open::{Resolution, resolve_under_root};
use crate::shell::file_service::heal;
use crate::shell::local_scheme::{
    LocalScheme, escapes_are_well_formed, locate, normalize_absolute, remap_cross_device,
    resolve_local_scheme_path,
};
use crate::vault::layout::ATTACHMENTS_DIR;

const MEMRY_FILE_PREFIX: &str = "memry-file://local/";

/// Where a block's url points in this vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAttachment {
    /// Vault-relative with `/`: the url's path, or the file self-heal found in its place.
    pub rel: String,
    /// What is there, its real location inside the vault; `None` when nothing is.
    pub path: Option<PathBuf>,
}

/// Resolves `url` from the block of the note at `note_path`. A missing file is looked for again
/// in its note's folder by its prefix or its name (`healAttachmentPath`, #1713); the url keeps
/// naming the old file.
pub fn resolve(
    vault: &Path,
    note_id: &str,
    note_path: &str,
    url: &str,
) -> Result<ResolvedAttachment, AttachmentError> {
    let rel = if url.starts_with(MEMRY_FILE_PREFIX) {
        legacy_rel(vault, url)?
    } else if has_scheme(url) || url.starts_with(['/', '\\']) {
        // `http:`, `data:`, an absolute path: a note may well show a remote image, but it is
        // not a file of the vault.
        return Err(AttachmentError::NotVaultRelative);
    } else {
        // Refs are often percent-encoded (`my%20file.pdf`).
        let decoded = decode(url);
        let normalized = decoded.replace('\\', "/");
        let own = format!("{ATTACHMENTS_DIR}/{note_id}");
        let root_relative = normalized == own || normalized.starts_with(&format!("{own}/"));
        let note_dir = match note_path.rsplit_once('/') {
            Some((dir, _)) if !root_relative => dir,
            _ => "",
        };
        join_within_vault(note_dir, &decoded).ok_or(AttachmentError::OutsideVault)?
    };
    match resolve_under_root(vault, &rel)? {
        Resolution::Inside(path) => Ok(ResolvedAttachment {
            rel,
            path: Some(path),
        }),
        Resolution::Outside => Err(AttachmentError::OutsideVault),
        Resolution::Missing => {
            if let Some(healed) = heal(vault, &rel)
                && let Resolution::Inside(path) = resolve_under_root(vault, &healed)?
            {
                return Ok(ResolvedAttachment {
                    rel: healed,
                    path: Some(path),
                });
            }
            Ok(ResolvedAttachment { rel, path: None })
        }
    }
}

/// The vault-relative path of a `memry-file:` url: its path when it is in this vault, else the
/// `attachments/...` tail of a path written on another device (`remapCrossDeviceAttachmentPath`).
fn legacy_rel(vault: &Path, url: &str) -> Result<String, AttachmentError> {
    let windows = cfg!(windows);
    let requested = resolve_local_scheme_path(url, LocalScheme::File, windows)
        .ok_or(AttachmentError::OutsideVault)?;
    let root = normalize_absolute(&vault.to_string_lossy(), windows)
        .ok_or(AttachmentError::OutsideVault)?;
    match locate(&requested, std::slice::from_ref(&root), windows) {
        Some(found) if !found.rel.is_empty() => Ok(found.rel),
        _ => remap_cross_device(&requested).ok_or(AttachmentError::OutsideVault),
    }
}

/// `/^[a-zA-Z][a-zA-Z\d+\-.]*:/`, which a Windows drive (`C:`) matches too.
fn has_scheme(url: &str) -> bool {
    let mut chars = url.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars
            .find(|c| !(c.is_ascii_alphanumeric() || "+-.".contains(*c)))
            .is_some_and(|c| c == ':')
}

/// `decodeURIComponent`, or the url as written when it is not well-formed.
fn decode(url: &str) -> String {
    if !escapes_are_well_formed(url) {
        return url.to_owned();
    }
    percent_decode_str(url)
        .decode_utf8()
        .map_or_else(|_| url.to_owned(), |decoded| decoded.into_owned())
}

/// `joinWithinVault`: `dir` and `rel` joined at either separator, `.` and `..` collapsed.
/// `None` when `..` climbs above the vault root or nothing is left.
fn join_within_vault(dir: &str, rel: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    for segment in dir.split(['/', '\\']).chain(rel.split(['/', '\\'])) {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            other => out.push(other),
        }
    }
    (!out.is_empty()).then(|| out.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_within_the_vault_or_not_at_all() {
        assert_eq!(
            join_within_vault("notes", "../attachments/n1/a.pdf").as_deref(),
            Some("attachments/n1/a.pdf")
        );
        assert_eq!(
            join_within_vault("notes", "..\\attachments\\n1\\a.pdf").as_deref(),
            Some("attachments/n1/a.pdf")
        );
        assert_eq!(
            join_within_vault("", "./attachments/n1/./a.pdf").as_deref(),
            Some("attachments/n1/a.pdf")
        );
        assert_eq!(join_within_vault("notes", "../../x.pdf"), None);
        assert_eq!(join_within_vault("", "../x.pdf"), None);
        assert_eq!(join_within_vault("notes", ".."), None);
    }

    #[test]
    fn a_scheme_or_a_drive_is_not_vault_relative() {
        for url in [
            "https://x.test/a.png",
            "data:image/png;base64,AA",
            "C:x",
            "a+b.c:d",
        ] {
            assert!(has_scheme(url), "{url}");
        }
        for url in ["a.png", "../a:b.png", "1abc:x", "", "attachments/n1/a.png"] {
            assert!(!has_scheme(url), "{url}");
        }
    }

    #[test]
    fn decodes_like_decode_uri_component() {
        assert_eq!(decode("my%20file.pdf"), "my file.pdf");
        assert_eq!(decode("100%.pdf"), "100%.pdf");
        assert_eq!(decode("bad%ff.pdf"), "bad%ff.pdf");
        assert_eq!(decode("%2e%2e/x"), "../x");
    }
}
