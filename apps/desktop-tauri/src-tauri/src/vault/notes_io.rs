//! High-level note IO. Composes path resolution, atomic write, and
//! frontmatter parse/serialize into the operations Tauri commands
//! call directly.
//!
//! - `read_note_from_disk` returns `None` on missing path. If the
//!   on-disk file is missing required frontmatter fields, this writes
//!   the repaired version back via atomic_write so subsequent reads
//!   do not have to repeat the auto-fill — matches Electron's behavior
//!   in `vault/notes.ts::ensureFrontmatter`.
//! - `write_note_to_disk` always serializes via `frontmatter::serialize_note`
//!   (which bumps `modified`), then atomic-writes. The returned
//!   `NoteOnDisk` includes a SHA-256 content hash so the watcher /
//!   sync queue can detect no-op rewrites cheaply.
//! - All paths are vault-relative and forward-slashed.

use crate::error::AppResult;
use crate::vault::frontmatter::{self, NoteFrontmatter, ParsedNote};
use crate::vault::fs as vfs;
use crate::vault::paths;
use std::path::Path;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteOnDisk {
    pub relative_path: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadNoteResult {
    pub relative_path: String,
    pub raw: String,
    pub content_hash: String,
    pub parsed: ParsedNote,
}

pub async fn read_note_from_disk(
    vault_root: &Path,
    relative_path: &str,
) -> AppResult<Option<ReadNoteResult>> {
    let abs = paths::resolve_supported(vault_root, relative_path)?;
    let raw = match vfs::safe_read(&abs).await? {
        Some(s) => s,
        None => return Ok(None),
    };

    let parsed = frontmatter::parse_note(&raw, Some(relative_path))?;

    if parsed.was_modified {
        let serialized = frontmatter::serialize_note(&parsed.frontmatter, &parsed.content)?;
        vfs::atomic_write(&abs, &serialized).await?;
        let hash = vfs::content_hash(&serialized);
        return Ok(Some(ReadNoteResult {
            relative_path: relative_path.to_string(),
            raw: serialized,
            content_hash: hash,
            parsed,
        }));
    }

    let hash = vfs::content_hash(&raw);
    Ok(Some(ReadNoteResult {
        relative_path: relative_path.to_string(),
        raw,
        content_hash: hash,
        parsed,
    }))
}

pub async fn write_note_to_disk(
    vault_root: &Path,
    relative_path: &str,
    frontmatter_in: &NoteFrontmatter,
    content: &str,
) -> AppResult<NoteOnDisk> {
    let abs = paths::resolve_supported(vault_root, relative_path)?;
    let serialized = frontmatter::serialize_note(frontmatter_in, content)?;
    let new_hash = vfs::content_hash(&serialized);

    if let Some(existing) = vfs::safe_read(&abs).await? {
        if vfs::content_hash(&existing) == new_hash {
            return Ok(NoteOnDisk {
                relative_path: relative_path.to_string(),
                content_hash: new_hash,
            });
        }
    }

    vfs::atomic_write(&abs, &serialized).await?;
    Ok(NoteOnDisk {
        relative_path: relative_path.to_string(),
        content_hash: new_hash,
    })
}

pub async fn delete_note_from_disk(vault_root: &Path, relative_path: &str) -> AppResult<()> {
    let abs = paths::resolve_supported(vault_root, relative_path)?;
    vfs::delete_file(&abs).await
}
