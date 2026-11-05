//! The minidump directory. A dump is raw process memory, so it never leaves the machine on its
//! own: only the diagnostic bundle the user submits (Step 40 (#3557)) reads it. Startup keeps the
//! newest few and drops the old ones.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const DIR_NAME: &str = "crash-dumps";
pub const KEEP_NEWEST: usize = 20;
pub const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const EXTENSION: &str = "dmp";
const PARTIAL_EXTENSION: &str = "part";

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR_NAME)
}

/// A new, unique path in `dir` for a dump being written (`<uuid>.dmp.part`). `complete` gives it
/// its `.dmp` name once it is written, so a `.dmp` file is always a whole dump.
pub fn new_partial_path(dir: &Path) -> PathBuf {
    dir.join(format!(
        "{}.{EXTENSION}.{PARTIAL_EXTENSION}",
        uuid::Uuid::new_v4()
    ))
}

/// Renames a written dump from its `new_partial_path` name to its `.dmp` name.
pub fn complete(partial: &Path) -> io::Result<PathBuf> {
    let path = partial.with_extension("");
    fs::rename(partial, &path)?;
    Ok(path)
}

/// Deletes the dumps beyond the newest `keep` and the ones older than `max_age`. Returns how many
/// it deleted. Files that are not `.dmp` are left alone.
pub fn prune(dir: &Path, keep: usize, max_age: Duration, now: SystemTime) -> io::Result<usize> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut dumps: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|e| e == EXTENSION))
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    // Newest first.
    dumps.sort_by_key(|dump| std::cmp::Reverse(dump.0));
    let mut deleted = 0;
    for (index, (modified, path)) in dumps.iter().enumerate() {
        let too_old = now.duration_since(*modified).is_ok_and(|age| age > max_age);
        if (index >= keep || too_old) && fs::remove_file(path).is_ok() {
            deleted += 1;
        }
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dump(dir: &Path, name: &str, age: Duration, now: SystemTime) {
        let path = dir.join(name);
        let file = fs::File::create(&path).expect("create");
        file.set_modified(now - age).expect("mtime");
    }

    #[test]
    fn keeps_the_newest_and_drops_the_old_ones() {
        let tmp = tempfile::tempdir().expect("tmp");
        let now = SystemTime::now();
        let day = Duration::from_secs(86_400);
        for i in 0..5 {
            dump(tmp.path(), &format!("recent-{i}.dmp"), day * i, now);
        }
        dump(tmp.path(), "ancient.dmp", day * 40, now);
        fs::write(tmp.path().join("notes.txt"), "keep").expect("write");
        assert_eq!(prune(tmp.path(), 3, MAX_AGE, now).expect("prune"), 3);
        let mut left: Vec<_> = fs::read_dir(tmp.path())
            .expect("dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            ["notes.txt", "recent-0.dmp", "recent-1.dmp", "recent-2.dmp"]
        );
    }

    #[test]
    fn a_missing_directory_is_nothing_to_prune() {
        let tmp = tempfile::tempdir().expect("tmp");
        assert_eq!(
            prune(&tmp.path().join("none"), 20, MAX_AGE, SystemTime::now()).expect("prune"),
            0
        );
    }

    #[test]
    fn a_dump_is_a_dmp_file_only_once_it_is_complete() {
        let tmp = tempfile::tempdir().expect("tmp");
        let (a, b) = (new_partial_path(tmp.path()), new_partial_path(tmp.path()));
        assert_ne!(a, b);
        fs::write(&a, "written").expect("write");
        assert_ne!(a.extension().and_then(|e| e.to_str()), Some("dmp"));

        let done = complete(&a).expect("complete");
        assert_eq!(done.extension().and_then(|e| e.to_str()), Some("dmp"));
        assert_eq!(fs::read_to_string(&done).expect("read"), "written");
        assert!(!a.exists());
    }
}
