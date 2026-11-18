//! What the first-launch run checks before it writes anything: no running Electron, every
//! importable vault's `data.db` at the schema the table map reads, and room for the copies.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::RunError;
use crate::electron_import::vault_db::tables::ELECTRON_DATA_LAST_MIGRATION;
use crate::electron_import::vault_prep::{Disposition, PlannedVault};
use crate::electron_import::{ElectronConfig, ElectronProfile, YStoreReader};

/// Free bytes for this user on the volume holding `path`.
pub type FreeSpace = fn(&Path) -> io::Result<u64>;

pub(super) fn run(
    profile: &ElectronProfile,
    config: Option<&ElectronConfig>,
    vaults: &[&PlannedVault],
    data_dir: &Path,
    free_space: FreeSpace,
) -> Result<(), RunError> {
    for vault in vaults {
        if matches!(vault.disposition, Disposition::Import(_))
            && vault.source_ledger != Some(ELECTRON_DATA_LAST_MIGRATION)
        {
            return Err(RunError::ElectronSchema {
                vault: vault.path.clone(),
                found: vault.source_ledger,
                expected: ELECTRON_DATA_LAST_MIGRATION,
            });
        }
    }
    let mut total = 0_u64;
    for vault in vaults {
        let Disposition::Import(id) = &vault.disposition else {
            continue;
        };
        let memry = Path::new(&vault.path).join(".memry");
        let size = ["data.db", "data.db-wal", "index.db", "index.db-wal"]
            .iter()
            .map(|name| file_len(&memry.join(name)))
            .sum::<u64>()
            + dir_len(&YStoreReader::store_dir(profile, &id.vault_id, config));
        total = total.saturating_add(size);
        enough(Path::new(&vault.path), size.saturating_mul(2), free_space)?;
    }
    enough(data_dir, total.saturating_mul(2), free_space)
}

/// Twice a vault's databases and store on its own volume (staging), twice them all on the
/// app data volume (the scratch copies).
fn enough(volume: &Path, needed: u64, free_space: FreeSpace) -> Result<(), RunError> {
    if needed == 0 {
        return Ok(());
    }
    let available = free_space(volume)
        .map_err(|e| RunError::Import(crate::electron_import::ImportError::io(volume, e)))?;
    if available < needed {
        return Err(RunError::DiskSpace {
            volume: PathBuf::from(volume),
            needed,
            available,
        });
    }
    Ok(())
}

fn file_len(path: &Path) -> u64 {
    fs::metadata(path).map_or(0, |m| m.len())
}

/// The files directly in `dir`: a LevelDB directory has no subfolders.
fn dir_len(dir: &Path) -> u64 {
    fs::read_dir(dir).map_or(0, |entries| {
        entries
            .filter_map(Result::ok)
            .filter_map(|e| e.metadata().ok())
            .filter(fs::Metadata::is_file)
            .map(|m| m.len())
            .sum()
    })
}

#[cfg(unix)]
pub fn free_space(path: &Path) -> io::Result<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `c_path` is a NUL-terminated string and `stat` is written by `statvfs` before it
    // is read; a failure returns -1 and leaves it unread.
    let code = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };
    if code != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `statvfs` returned 0, so it filled `stat`.
    let stat = unsafe { stat.assume_init() };
    #[allow(clippy::useless_conversion)] // the field widths differ per OS
    Ok(u64::from(stat.f_bavail).saturating_mul(u64::from(stat.f_frsize)))
}

#[cfg(windows)]
pub fn free_space(path: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::core::PCWSTR;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut available = 0_u64;
    // SAFETY: `wide` is NUL-terminated and outlives the call; `available` is a valid out pointer.
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut available), None, None) }
        .map_err(|e| io::Error::other(e.to_string()))?;
    Ok(available)
}
