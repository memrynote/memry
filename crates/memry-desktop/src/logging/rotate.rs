//! The size-rotating file `logger.ts` keeps: 5 MiB, the live `main.log` plus
//! `main.1.log` to `main.4.log` (`main.1.log` is the newest), the oldest removed first.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const FILES_KEPT: usize = 5;

pub struct RotatingFile {
    dir: PathBuf,
    stem: String,
    ext: String,
    max_bytes: u64,
    /// `None` only between a failed rotation and the next write's reopen.
    file: Option<File>,
    size: u64,
}

impl RotatingFile {
    pub fn open(dir: &Path, file_name: &str, max_bytes: u64) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let (stem, ext) = match file_name.rsplit_once('.') {
            Some((stem, ext)) => (stem.to_owned(), format!(".{ext}")),
            None => (file_name.to_owned(), String::new()),
        };
        let mut this = Self {
            dir: dir.to_owned(),
            stem,
            ext,
            max_bytes,
            file: None,
            size: 0,
        };
        this.reopen()?;
        Ok(this)
    }

    fn live(&self) -> PathBuf {
        self.dir.join(format!("{}{}", self.stem, self.ext))
    }

    fn archive(&self, n: usize) -> PathBuf {
        self.dir.join(format!("{}.{n}{}", self.stem, self.ext))
    }

    fn reopen(&mut self) -> io::Result<()> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.live())?;
        self.size = file.metadata()?.len();
        self.file = Some(file);
        Ok(())
    }

    /// Closes the live file first (Windows cannot rename an open one), shifts the
    /// archives up and starts a new live file.
    fn rotate(&mut self) -> io::Result<()> {
        self.file = None;
        let shifted = (|| {
            let _ = fs::remove_file(self.archive(FILES_KEPT - 1));
            for n in (1..FILES_KEPT - 1).rev() {
                if self.archive(n).exists() {
                    fs::rename(self.archive(n), self.archive(n + 1))?;
                }
            }
            fs::rename(self.live(), self.archive(1))
        })();
        // Reopen either way: a failed shift keeps appending to the live file
        // rather than dropping lines.
        self.reopen()?;
        shifted
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.file.is_none() {
            self.reopen()?;
        }
        if self.size > 0
            && self.size + buf.len() as u64 > self.max_bytes
            && let Err(error) = self.rotate()
        {
            eprintln!("MemryNote could not rotate its log: {error}");
        }
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("log file closed"))?;
        file.write_all(buf)?;
        self.size += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.file.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_mebibytes_rotate_once_and_keep_at_most_five_files() {
        let dir = tempfile::tempdir().expect("tmp");
        let mut log = RotatingFile::open(dir.path(), "main.log", MAX_BYTES).expect("open");
        let line = vec![b'x'; 1023];
        let mut line = line;
        line.push(b'\n');
        for _ in 0..6 * 1024 {
            log.write_all(&line).expect("write");
        }
        let names = names(dir.path());
        assert_eq!(names, ["main.1.log", "main.log"]);
        assert!(
            fs::metadata(dir.path().join("main.1.log"))
                .expect("archive")
                .len()
                <= MAX_BYTES
        );
    }

    #[test]
    fn the_newest_archive_is_dot_one_and_the_oldest_falls_off() {
        let dir = tempfile::tempdir().expect("tmp");
        let mut log = RotatingFile::open(dir.path(), "main.log", 10).expect("open");
        for generation in 0..8 {
            log.write_all(format!("gen-{generation}-pad").as_bytes())
                .expect("write");
        }
        let read = |name: &str| fs::read_to_string(dir.path().join(name)).expect(name);
        assert_eq!(read("main.log"), "gen-7-pad");
        assert_eq!(read("main.1.log"), "gen-6-pad");
        assert_eq!(read("main.4.log"), "gen-3-pad");
        assert_eq!(names(dir.path()).len(), FILES_KEPT);
        assert!(!dir.path().join("main.5.log").exists());
    }

    #[test]
    fn an_existing_log_is_appended_to_not_truncated() {
        let dir = tempfile::tempdir().expect("tmp");
        fs::write(dir.path().join("main.log"), "old\n").expect("seed");
        let mut log = RotatingFile::open(dir.path(), "main.log", MAX_BYTES).expect("open");
        log.write_all(b"new\n").expect("write");
        assert_eq!(
            fs::read_to_string(dir.path().join("main.log")).expect("read"),
            "old\nnew\n"
        );
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .expect("dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        names.sort();
        names
    }
}
