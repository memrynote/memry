//! The download resume sidecar, Electron's `DownloadResumeState`
//! (`apps/desktop/src/main/sync/attachments.ts:109-118`, `:341-345`,
//! `:1409-1460`). A shipped on-disk format: a partial Electron left behind
//! resumes here, and the reverse.
//!
//! Chunks are appended in index order to `.<id>.<dest name>.mrypart` next to
//! the destination; after each landed chunk is fsynced, `<partial>.json`
//! records how many chunks and bytes the partial holds, written to a temp file
//! and renamed so a crash never half-writes it. The sidecar holds progress
//! only: no key, no file name, no content.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::protocol::attachment_manifest::{AttachmentChunkRef, AttachmentManifest};

use super::transfer::SanitizeName;

/// The sidecar, field for field and in Electron's key order, so the bytes
/// equal `JSON.stringify(state)`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeState {
    pub version: u32,
    pub attachment_id: String,
    /// The manifest's whole-file checksum: a changed manifest voids the resume.
    pub checksum: String,
    pub chunk_count: u64,
    /// Chunks `0..chunks_done` are decrypted, verified and on disk.
    pub chunks_done: u64,
    pub bytes_written: u64,
}

/// Where a download resumes: chunk 0 and nothing written, or the sidecar's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ResumePoint {
    pub chunks_done: u64,
    pub bytes_written: u64,
}

/// The partial file and its sidecar for `dest`. Keyed by the destination and
/// not only the id, because one attachment can land at two paths at once and
/// one transfer's cleanup must never delete the other's bytes.
pub fn partial_paths(
    dest: &Path,
    attachment_id: &str,
    sanitize: SanitizeName,
) -> (PathBuf, PathBuf) {
    let name = dest
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let partial = dest.with_file_name(format!(
        ".{}.{}.mrypart",
        sanitize(attachment_id),
        sanitize(&name)
    ));
    let mut state = partial.clone().into_os_string();
    state.push(".json");
    (partial, PathBuf::from(state))
}

/// The manifest's chunks in index order.
pub fn ordered_chunks(manifest: &AttachmentManifest) -> Vec<AttachmentChunkRef> {
    let mut chunks = manifest.chunks.clone();
    chunks.sort_by_key(|chunk| chunk.index);
    chunks
}

/// `loadResumableState`: resumes only when the sidecar and the partial agree
/// with THIS manifest (id, checksum, chunk count) and the partial holds
/// exactly the bytes the sidecar claims. Anything else removes both and starts
/// at chunk 0, so a stale partial can never reach the final checksum.
pub fn load(partial: &Path, state_path: &Path, manifest: &AttachmentManifest) -> ResumePoint {
    let state = fs::read(state_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<ResumeState>(&bytes).ok());
    let Some(state) = state else {
        discard(partial, state_path);
        return ResumePoint::default();
    };
    let chunk_count = manifest.chunks.len() as u64;
    let expected: u64 = ordered_chunks(manifest)
        .iter()
        .take(usize::try_from(state.chunks_done).unwrap_or(usize::MAX))
        .map(|chunk| chunk.size)
        .sum();
    let on_disk = fs::metadata(partial).map(|meta| meta.len()).ok();
    let valid = state.version == 1
        && state.attachment_id == manifest.id
        && state.checksum == manifest.checksum
        && state.chunk_count == chunk_count
        && state.chunks_done > 0
        && state.chunks_done <= chunk_count
        && on_disk == Some(expected)
        && state.bytes_written == expected;
    if !valid {
        discard(partial, state_path);
        return ResumePoint::default();
    }
    ResumePoint {
        chunks_done: state.chunks_done,
        bytes_written: state.bytes_written,
    }
}

/// `persistResumeState`: temp file, fsync, rename.
pub fn persist(state_path: &Path, state: &ResumeState) -> io::Result<()> {
    let mut tmp = state_path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut file = private_file(&tmp, false)?;
    file.write_all(&serde_json::to_vec(state).map_err(io::Error::other)?)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, state_path)
}

/// Removes the partial and its sidecar. A file that will not go stays
/// harmless: the next [`load`] finds it inconsistent and removes it again.
pub fn discard(partial: &Path, state_path: &Path) {
    let _ = fs::remove_file(partial);
    let _ = fs::remove_file(state_path);
}

/// Opens `path` for writing, readable by this user only (Electron's `0o600`),
/// appending when `append` and truncating otherwise.
pub fn private_file(path: &Path, append: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
