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
/// No dump takes this long to write, so a partial one this old is one its monitor never finished.
const PARTIAL_MAX_AGE: Duration = Duration::from_secs(60 * 60);

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

/// Renames a written dump from its `new_partial_path` name to its `.dmp` name. On Windows a
/// scanner that opened the new file without delete sharing blocks the rename for a moment, so a
/// sharing violation or an access denial is tried again for up to a second.
pub fn complete(partial: &Path) -> io::Result<PathBuf> {
    let path = partial.with_extension("");
    #[cfg(windows)]
    for _ in 0..20 {
        // ERROR_ACCESS_DENIED and ERROR_SHARING_VIOLATION.
        match fs::rename(partial, &path) {
            Err(error) if matches!(error.raw_os_error(), Some(5 | 32)) => {
                std::thread::sleep(Duration::from_millis(50));
            }
            result => return result.map(|()| path),
        }
    }
    fs::rename(partial, &path)?;
    Ok(path)
}

/// Deletes the dumps beyond the newest `keep` and the ones older than `max_age`, and the partial
/// dumps (`.dmp.part`) older than an hour. Returns how many it deleted. Other files are left alone.
pub fn prune(dir: &Path, keep: usize, max_age: Duration, now: SystemTime) -> io::Result<usize> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let partial_suffix = format!(".{EXTENSION}.{PARTIAL_EXTENSION}");
    let mut dumps: Vec<(SystemTime, PathBuf)> = Vec::new();
    let mut deleted = 0;
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(modified) = entry.metadata().ok().and_then(|meta| meta.modified().ok()) else {
            continue;
        };
        if path.extension().is_some_and(|e| e == EXTENSION) {
            dumps.push((modified, path));
        } else if entry
            .file_name()
            .to_string_lossy()
            .ends_with(&partial_suffix)
            && now
                .duration_since(modified)
                .is_ok_and(|age| age > PARTIAL_MAX_AGE)
            && fs::remove_file(&path).is_ok()
        {
            deleted += 1;
        }
    }
    // Newest first.
    dumps.sort_by_key(|dump| std::cmp::Reverse(dump.0));
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
    fn a_partial_dump_left_for_over_an_hour_is_dropped_and_a_fresh_one_kept() {
        let tmp = tempfile::tempdir().expect("tmp");
        let now = SystemTime::now();
        dump(
            tmp.path(),
            "stale.dmp.part",
            Duration::from_secs(2 * 60 * 60),
            now,
        );
        dump(tmp.path(), "writing.dmp.part", Duration::from_secs(60), now);
        assert_eq!(
            prune(tmp.path(), KEEP_NEWEST, MAX_AGE, now).expect("prune"),
            1
        );
        assert!(!tmp.path().join("stale.dmp.part").exists());
        assert!(tmp.path().join("writing.dmp.part").exists());
    }

    // A scanner that opened the new dump without delete sharing blocks a plain rename; `complete`
    // waits until the scanner lets go.
    #[cfg(windows)]
    #[test]
    fn complete_waits_out_a_handle_that_blocks_the_rename() {
        use std::os::windows::fs::OpenOptionsExt;

        let tmp = tempfile::tempdir().expect("tmp");
        let partial = new_partial_path(tmp.path());
        fs::write(&partial, "written").expect("write");
        // FILE_SHARE_READ only.
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&partial)
            .expect("hold the file");
        let blocked = fs::rename(&partial, partial.with_extension("")).expect_err("blocked");
        assert!(
            matches!(blocked.raw_os_error(), Some(5 | 32)),
            "{blocked:?}"
        );

        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            drop(held);
        });
        let done = complete(&partial).expect("complete");
        release.join().expect("release");
        assert_eq!(fs::read_to_string(done).expect("read"), "written");
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
