//! The body packs' spill directory (#5232): one file per downloaded pack,
//! held between its download and the body checks.
//!
//! Every call runs on the blocking pool. The spill is a cache like the packs
//! it holds (§8.0), so an I/O failure here is returned for the caller to fall
//! back on; only a lost blocking task is a [`StorageError`].

use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

use sha2::{Digest as _, Sha256};

use crate::api::errors::StorageError;
use crate::protocol::pack::{PACK_HEADER_SIZE, PackEntry, parse_pack};

/// Where an entry's payload sits in a spilled pack.
#[derive(Debug, Clone, Copy)]
pub(super) struct Loc {
    pub pack: usize,
    pub offset: u64,
    pub length: u64,
    pub sha256: [u8; 32],
}

async fn blocking<T: Send + 'static>(
    what: &str,
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, StorageError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| StorageError::Failed {
            what: format!("{what} did not finish: {error}"),
        })
}

pub(super) async fn create(dir: &Path) -> Result<std::io::Result<()>, StorageError> {
    let dir = dir.to_owned();
    blocking("creating the pack spill", move || {
        std::fs::create_dir_all(dir)
    })
    .await
}

/// The entries of a pack already spilled whole at `path`. A missing, torn or
/// foreign file is `None`, and the pack is downloaded again.
pub(super) async fn read_held(path: &Path) -> Result<Option<Vec<PackEntry>>, StorageError> {
    let path = path.to_owned();
    blocking("reading a spilled pack", move || {
        let bytes = std::fs::read(path).ok()?;
        parse_pack(&bytes).ok().map(|parsed| parsed.entries)
    })
    .await
}

/// Written beside its final name and renamed into place, so a file under the
/// final name is always a whole pack. A failed write leaves no `.part`.
pub(super) async fn write(
    path: &Path,
    bytes: Vec<u8>,
) -> Result<std::io::Result<()>, StorageError> {
    let path = path.to_owned();
    blocking("spilling a pack", move || {
        let partial = path.with_extension("part");
        let written =
            std::fs::write(&partial, bytes).and_then(|()| std::fs::rename(&partial, &path));
        if written.is_err() {
            let _ = std::fs::remove_file(&partial);
        }
        written
    })
    .await
}

/// Removes the spill directory; an absent one is already removed. Answers
/// why it could not, for the report.
pub(super) async fn remove(dir: &Path) -> Option<String> {
    let dir = dir.to_owned();
    let removed = blocking(
        "removing the pack spill",
        move || match std::fs::remove_dir_all(dir) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Some(error.to_string()),
            _ => None,
        },
    )
    .await;
    match removed {
        Ok(reason) => reason,
        Err(error) => Some(error.to_string()),
    }
    .map(|reason| format!("the pack spill was not removed: {reason}"))
}

/// Reads each payload off its spilled pack, in the order given, and checks it
/// against its index digest. `None` for a payload that cannot be read or no
/// longer matches.
pub(super) async fn read_payloads(
    files: &[PathBuf],
    locs: Vec<Loc>,
) -> Result<Vec<Option<Vec<u8>>>, StorageError> {
    let files = files.to_vec();
    blocking("the pack payload reads", move || {
        let mut open: Option<(usize, std::fs::File)> = None;
        locs.into_iter()
            .map(|loc| {
                if open.as_ref().is_none_or(|(pack, _)| *pack != loc.pack) {
                    open = std::fs::File::open(&files[loc.pack])
                        .ok()
                        .map(|file| (loc.pack, file));
                }
                let (_, file) = open.as_mut()?;
                let mut payload = vec![0; usize::try_from(loc.length).ok()?];
                file.seek(SeekFrom::Start(PACK_HEADER_SIZE as u64 + loc.offset))
                    .ok()?;
                file.read_exact(&mut payload).ok()?;
                (Sha256::digest(&payload).as_slice() == loc.sha256).then_some(payload)
            })
            .collect()
    })
    .await
}

/// A file name from the pack id, which is server input and never a path.
pub(super) fn name(pack_id: &str) -> String {
    let digest = Sha256::digest(pack_id.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{hex}.mpak")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spill_name_is_a_safe_file_name() {
        let name = name("../../etc/passwd");
        assert!(name.ends_with(".mpak") && !name.contains('/'));
        assert_eq!(name.len(), 64 + 5);
    }
}
