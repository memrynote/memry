//! Pruning the `data.db.corrupt-*` quarantines a finished recovery left behind.
//!
//! Core never prunes them on its own: a quarantine may be the only copy of work that has
//! not synced. A shell that wants to bound the disk use calls [`prune_settled`], which
//! owns the one rule that makes deleting one safe: **the salvage of that quarantine is
//! recorded in `recovery_log` as complete**. Everything else stays:
//!
//! - the quarantine a `data.db.recovering` marker names, recorded or not (a leftover
//!   marker is how a later launch learns what happened);
//! - a quarantine with no `recovery_log` row (salvage never finished, or ran in a build
//!   without the log);
//! - a quarantine whose row says rows were refused, tables unreadable, or tables and columns
//!   this build has no place for (`detail` is not empty, `rows_rejected` is not 0): it holds
//!   what the live database lacks.
//!
//! Anything that cannot be decided (an unreadable marker, directory or log) prunes nothing
//! and returns the error: the files cost disk, a wrong delete costs the user's data.
//! Order comes from the timestamp in the name, never from the modification time, which a
//! file-sync tool rewrites.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use crate::api::errors::StorageError;
use crate::storage::recovery::{io_failure, marker_path, pending_recovery};

const SIDECARS: [&str; 3] = ["-wal", "-shm", "-journal"];

/// Deletes every settled `<path>.corrupt-*` quarantine beside `path` except the `keep`
/// newest settled ones. Returns how many it deleted. See the module docs for what is
/// never deleted.
pub fn prune_settled(path: &Path, keep: usize) -> Result<usize, StorageError> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Ok(0);
    };
    if pending_recovery(path)?.is_some() {
        return Ok(0);
    }
    let named_by_marker = marker_target(path)?;
    let quarantines = list(dir, &name.to_string_lossy())?;
    if quarantines.is_empty() {
        return Ok(0);
    }
    let clean = clean_recoveries(path)?;
    let settled: Vec<PathBuf> = quarantines
        .into_iter()
        .filter(|(file, _)| named_by_marker.as_deref() != Some(file.as_str()))
        .filter(|(file, _)| clean.get(file).copied().unwrap_or(false))
        .map(|(_, full)| full)
        .collect();
    let excess = settled.len().saturating_sub(keep);
    let mut removed = 0;
    for old in settled.into_iter().take(excess) {
        // Sidecars first: a main file left without its log is a quarantine, a log left
        // without its file would be replayed onto whatever SQLite creates there.
        let mut targets: Vec<PathBuf> = SIDECARS
            .iter()
            .map(|suffix| PathBuf::from(format!("{}{suffix}", old.display())))
            .collect();
        targets.push(old.clone());
        for target in targets {
            match std::fs::remove_file(&target) {
                Ok(()) => {}
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                Err(err) => return Err(io_failure("a quarantine to delete", &target, &err)),
            }
        }
        removed += 1;
    }
    Ok(removed)
}

/// The file name the marker names, whether or not that file or its log row exist.
fn marker_target(path: &Path) -> Result<Option<String>, StorageError> {
    let marker = marker_path(path);
    if marker.is_dir() {
        return Ok(None);
    }
    match std::fs::read_to_string(&marker) {
        Ok(text) => Ok(Path::new(text.trim())
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(io_failure("the marker", &marker, &err)),
    }
}

/// `(file name, full path)` of each `<name>.corrupt-<stamp>[-<n>]`, oldest first. The
/// sidecars (`-wal`, `-shm`, `-journal`) do not parse as `<n>` and are skipped.
fn list(dir: &Path, name: &str) -> Result<Vec<(String, PathBuf)>, StorageError> {
    let prefix = format!("{name}.corrupt-");
    let entries = std::fs::read_dir(dir).map_err(|err| io_failure("the directory", dir, &err))?;
    let mut found = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| io_failure("the directory", dir, &err))?;
        let file = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = file.strip_prefix(&prefix) else {
            continue;
        };
        let parsed = match rest.split_once('-') {
            Some((stamp, n)) => stamp.parse::<u128>().ok().zip(n.parse::<u64>().ok()),
            None => rest.parse::<u128>().ok().map(|stamp| (stamp, 0)),
        };
        if let Some(order) = parsed {
            found.push((order, file, entry.path()));
        }
    }
    found.sort();
    Ok(found
        .into_iter()
        .map(|(_, file, full)| (file, full))
        .collect())
}

/// Quarantine name -> whether its `recovery_log` row records a complete salvage.
fn clean_recoveries(path: &Path) -> Result<HashMap<String, bool>, StorageError> {
    if !path
        .try_exists()
        .map_err(|err| io_failure("the database", path, &err))?
    {
        return Ok(HashMap::new());
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| io_failure("the database", path, &err))?;
    let mut stmt = conn
        .prepare("SELECT quarantine_name, rows_rejected, detail FROM recovery_log")
        .map_err(|err| io_failure("the recovery log in", path, &err))?;
    let rows = stmt
        .query_map([], |row| {
            let rejected: i64 = row.get(1)?;
            let detail: String = row.get(2)?;
            Ok((row.get::<_, String>(0)?, rejected == 0 && detail.is_empty()))
        })
        .map_err(|err| io_failure("the recovery log in", path, &err))?;
    rows.collect::<Result<_, _>>()
        .map_err(|err| io_failure("the recovery log in", path, &err))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::open_data;
    use crate::storage::recovery::quarantine_and_rebuild;
    use crate::storage::test_support::temp_dir;

    /// A database that went through `rounds` finished recoveries; returns the quarantines
    /// oldest first.
    fn recovered(path: &Path, rounds: usize) -> Vec<PathBuf> {
        drop(open_data(path).expect("open"));
        (0..rounds)
            .map(|_| {
                let report = quarantine_and_rebuild(path).expect("recover");
                report.quarantined
            })
            .collect()
    }

    #[test]
    fn only_settled_quarantines_beyond_the_newest_are_deleted() {
        let dir = temp_dir("prune-settled");
        let path = dir.path().join("data.db");
        let made = recovered(&path, 4);
        let removed = prune_settled(&path, 2).expect("prune");
        assert_eq!(removed, 2);
        assert!(!made[0].exists() && !made[1].exists());
        assert!(made[2].exists() && made[3].exists());
    }

    #[test]
    fn a_quarantine_a_marker_still_names_is_kept() {
        let dir = temp_dir("prune-marker");
        let path = dir.path().join("data.db");
        let made = recovered(&path, 3);
        // A leftover marker for the oldest one (its salvage is recorded, the marker stuck).
        std::fs::write(marker_path(&path), made[0].display().to_string()).expect("marker");
        assert_eq!(prune_settled(&path, 1).expect("prune"), 1);
        assert!(made[0].exists(), "named by the marker");
        assert!(!made[1].exists());
        assert!(made[2].exists());
    }

    #[test]
    fn a_quarantine_without_a_log_row_or_with_a_partial_salvage_is_kept() {
        let dir = temp_dir("prune-unlogged");
        let path = dir.path().join("data.db");
        let made = recovered(&path, 3);
        let conn = Connection::open(&path).expect("open");
        conn.execute(
            "DELETE FROM recovery_log WHERE quarantine_name = ?1",
            [made[0].file_name().expect("name").to_string_lossy()],
        )
        .expect("delete row");
        conn.execute(
            "UPDATE recovery_log SET detail = 'notes: 3 rows refused', rows_rejected = 3 \
             WHERE quarantine_name = ?1",
            [made[1].file_name().expect("name").to_string_lossy()],
        )
        .expect("mark partial");
        drop(conn);
        assert_eq!(prune_settled(&path, 0).expect("prune"), 1);
        assert!(made[0].exists() && made[1].exists());
        assert!(!made[2].exists());
    }

    #[test]
    fn nothing_is_deleted_while_a_recovery_is_unfinished_or_the_log_is_unreadable() {
        let dir = temp_dir("prune-failclosed");
        let path = dir.path().join("data.db");
        let made = recovered(&path, 2);
        std::fs::write(&path, b"not a database at all, just bytes").expect("damage");
        assert!(prune_settled(&path, 0).is_err());
        assert!(made.iter().all(|file| file.exists()));
    }
}
