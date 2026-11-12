//! What an outside writer puts in a note file after the app replaced it (#4289). A writer that
//! truncated the file and stalled before its write, or wrote a first chunk and stalled before
//! the rest, still holds the file the app's rename took off its path, and on Unix its writes
//! land there, in a file no path names. A write over a file the run did not write holds that
//! file open ([`Replaced`]) and keeps what the writer puts in it, for [`WATCH`], as a version of
//! the note: the app's text wins, and the outside text is kept (#4257 L1).
//!
//! The watch holds the vault weakly, so a close or a reopen never waits for it: a writer's
//! text that lands after its vault closed is not kept, and the close logs it.
//!
//! The replaced file is held only where holding it cannot fail the rename
//! ([`holds_across_rename`]): a local volume of a type known to keep an open file across a
//! rename. On Windows it is not: a rename over a file another handle holds open fails on a volume
//! without POSIX rename semantics, so the save would never land. On a network volume it is not
//! either: an SMB server may refuse the rename while a handle is open, and NFS renames the open
//! file to a `.nfs*` file left in the vault's folder until it closes. A volume of any other type
//! is not held, so one this module does not know never risks the rename.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use memry_core::api::vault::Vault;
use memry_core::markdown::frontmatter::split_frontmatter_block;

use super::consumer::Applied;
use super::consumer::rows::RowOwner;
use super::hash::content_hash;
use super::note_file::MAX_NOTE_BYTES;

const SCOPE: &str = "vault_late_writes";

/// How long a replaced file is watched for its writer's bytes; only a file written within it
/// before the replace is. A writer that truncated and stalled writes within moments; ten
/// seconds covers one held up by a busy disk or a sync client throttled to its next chunk,
/// while a thread and a handle per watch stay short-lived.
pub const WATCH: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(100);
/// At most this many files are watched at once: each holds a thread and a file handle.
const MAX_WATCHED: usize = 32;
static WATCHED: AtomicUsize = AtomicUsize::new(0);

/// The file a write replaced, with the hash of the bytes it held then; open where
/// [`holds_across_rename`].
#[derive(Debug, Default)]
pub struct Replaced {
    file: Option<File>,
    hash: String,
}

impl Replaced {
    pub(super) fn new(file: Option<File>, hash: &str) -> Self {
        Self {
            file,
            hash: hash.to_owned(),
        }
    }

    /// Keeps each text an outside writer puts in the replaced file within [`WATCH`] as a
    /// version of the note, on a thread of its own, and publishes `told` for each one kept. For
    /// a file whose bytes are the run's own there is no writer to watch for, nor for one nobody
    /// wrote within [`WATCH`] (a file of an earlier run the open's reconcile writes).
    pub(crate) fn keep_late_writes(
        self,
        vault: &Arc<Vault>,
        rows: &Arc<RowOwner>,
        note_id: &str,
        told: Applied,
    ) {
        let Some(file) = self.file.filter(written_lately) else {
            return;
        };
        let Some(slot) = Slot::take() else {
            return tracing::warn!(scope = SCOPE, note_id, "too many replaced files watched");
        };
        let watcher = Watcher {
            note_id: note_id.to_owned(),
            vault: Arc::downgrade(vault),
            rows: rows.clone(),
            told,
        };
        let hash = self.hash;
        let spawned = thread::Builder::new()
            .name("vault-late-writes".into())
            .spawn(move || {
                let _slot = slot;
                watcher.watch(&file, hash);
            });
        if let Err(error) = spawned {
            tracing::error!(
                scope = SCOPE,
                note_id,
                "a replaced file is not watched for its writer: {error}"
            );
        }
    }
}

/// Whether the file the app replaces can stay open across the rename: a known local volume on a
/// Unix that names its type. See the module comment for Windows and other volumes.
pub(super) fn holds_across_rename(file: &File) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::fd::AsRawFd;
        let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
        // SAFETY: `fstatfs` fills `stat` for the open descriptor, and it is read only on success.
        if unsafe { libc::fstatfs(file.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            return false;
        }
        // SAFETY: `fstatfs` returned 0, so `stat` is initialized.
        let stat = unsafe { stat.assume_init() };
        is_local(&stat)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = file;
        false
    }
}

#[cfg(target_os = "macos")]
fn is_local(stat: &libc::statfs) -> bool {
    let name: Vec<u8> = stat
        .f_fstypename
        .iter()
        .take_while(|&&c| c != 0)
        .map(|&c| c as u8)
        .collect();
    is_local_type(&String::from_utf8_lossy(&name))
}

/// Local volumes by `f_fstypename`: APFS, HFS+, exFAT, FAT. Network, FUSE and FSKit volumes are
/// not among them.
#[cfg(any(target_os = "macos", test))]
fn is_local_type(name: &str) -> bool {
    matches!(name, "apfs" | "hfs" | "exfat" | "msdos")
}

#[cfg(target_os = "linux")]
fn is_local(stat: &libc::statfs) -> bool {
    // `f_type` is signed and 64 bits wide on some targets; the magic numbers are its low 32 bits.
    is_local_magic(stat.f_type as u32)
}

/// Local volumes by `f_type` (`linux/magic.h`): ext2/3/4, btrfs, XFS, tmpfs, F2FS, ZFS,
/// bcachefs, overlayfs.
#[cfg(any(target_os = "linux", test))]
fn is_local_magic(magic: u32) -> bool {
    matches!(
        magic,
        0xEF53
            | 0x9123_683E
            | 0x5846_5342
            | 0x0102_1994
            | 0xF2F5_2010
            | 0x2FC1_2FC1
            | 0xCA45_1A4E
            | 0x794C_7630
    )
}

/// One of the [`MAX_WATCHED`] watches, given back when dropped, a panic of its thread included.
struct Slot;

impl Slot {
    fn take() -> Option<Self> {
        if WATCHED.fetch_add(1, Ordering::Relaxed) >= MAX_WATCHED {
            WATCHED.fetch_sub(1, Ordering::Relaxed);
            return None;
        }
        Some(Self)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        WATCHED.fetch_sub(1, Ordering::Relaxed);
    }
}

struct Watcher {
    note_id: String,
    vault: Weak<Vault>,
    rows: Arc<RowOwner>,
    told: Applied,
}

impl Watcher {
    /// Reads the file once its size and time stop moving, and once more at the end of [`WATCH`]
    /// (a write that kept both), and keeps each text it has not kept yet, while the vault is
    /// open.
    fn watch(&self, file: &File, mut kept: String) {
        let deadline = Instant::now() + WATCH;
        let mut last = stat(file);
        let mut moved = false;
        loop {
            thread::sleep(POLL);
            if self.vault.strong_count() == 0 {
                return self.closed(file, &kept);
            }
            let now = stat(file);
            let end = Instant::now() >= deadline;
            if now != last {
                (last, moved) = (now, true);
                if !end {
                    continue;
                }
            }
            if moved || end {
                moved = false;
                if let Some(text) = read(file).filter(|text| !text.is_empty()) {
                    let hash = content_hash(&text);
                    if hash != kept {
                        self.keep(&text);
                        kept = hash;
                    }
                }
            }
            if end {
                return;
            }
        }
    }

    /// The vault closed while the file was watched: a text it holds that was not kept is lost
    /// with the handle, so it is logged.
    fn closed(&self, file: &File, kept: &str) {
        let pending =
            read(file).is_some_and(|text| !text.is_empty() && content_hash(&text) != kept);
        if pending {
            tracing::warn!(
                scope = SCOPE,
                note_id = self.note_id,
                "the vault closed before an outside writer's text in a replaced file was kept"
            );
        }
    }

    fn keep(&self, text: &str) {
        let note_id = self.note_id.as_str();
        let Some(vault) = self.vault.upgrade() else {
            return tracing::warn!(
                scope = SCOPE,
                note_id,
                "an outside writer's text in a replaced file came after its vault closed"
            );
        };
        let body = split_frontmatter_block(text).body;
        match vault.write_back().keep_outside_write(note_id, text, body) {
            Ok(true) => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "an outside writer wrote to a file the app had replaced; its text is kept as \
                     a version"
                );
                self.rows.publish(self.told.clone());
            }
            // A version holds that text already.
            Ok(false) => {}
            Err(error) => tracing::error!(
                scope = SCOPE,
                note_id,
                "an outside writer's text in a replaced file was not kept: {error}"
            ),
        }
    }
}

fn written_lately(file: &File) -> bool {
    let modified = file.metadata().and_then(|meta| meta.modified());
    // `elapsed` fails for a time ahead of the clock.
    modified.is_ok_and(|at| !at.elapsed().is_ok_and(|age| age >= WATCH))
}

fn stat(file: &File) -> Option<(u64, Option<SystemTime>)> {
    let meta = file.metadata().ok()?;
    Some((meta.len(), meta.modified().ok()))
}

fn read(mut file: &File) -> Option<String> {
    let mut bytes = Vec::new();
    let read = file
        .seek(SeekFrom::Start(0))
        .and_then(|_| file.take(MAX_NOTE_BYTES + 1).read_to_end(&mut bytes));
    match read {
        Ok(_) if bytes.len() as u64 <= MAX_NOTE_BYTES => {
            // A version holds what Electron would read of it.
            Some(String::from_utf8_lossy(&bytes).into_owned())
        }
        Ok(_) => {
            tracing::warn!(scope = SCOPE, "a replaced file grew past the read cap");
            None
        }
        Err(error) => {
            tracing::warn!(scope = SCOPE, "a replaced file could not be read: {error}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn a_file_on_a_local_volume_is_held_across_the_rename() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("n.md");
        std::fs::write(&path, "x").unwrap();
        assert!(holds_across_rename(&File::open(&path).unwrap()));
    }

    #[test]
    fn network_and_fuse_volumes_are_not_held() {
        for name in ["smbfs", "nfs", "afpfs", "webdav", "macfuse", "osxfuse"] {
            assert!(!is_local_type(name), "{name}");
        }
        for name in ["apfs", "hfs", "exfat", "msdos"] {
            assert!(is_local_type(name), "{name}");
        }
        for magic in [0x6969, 0xFF53_4D42, 0xFE53_4D42, 0x6573_5546] {
            assert!(!is_local_magic(magic), "{magic:#x}");
        }
        // ext4, xfs, btrfs, tmpfs.
        for magic in [0xEF53, 0x5846_5342, 0x9123_683E, 0x0102_1994] {
            assert!(is_local_magic(magic), "{magic:#x}");
        }
    }

    #[test]
    fn a_volume_of_an_unknown_type_is_not_held() {
        // An FSKit name and Linux vboxsf: a type this module does not know fails closed.
        assert!(!is_local_type("fskit-unknown"));
        assert!(!is_local_magic(0x786F_4256));
    }
}
