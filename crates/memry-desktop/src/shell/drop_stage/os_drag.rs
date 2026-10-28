//! Files of an OS drag. WebKitGTK hands an OS file drag to the page with no `File` objects and an
//! empty URI list (WebKit hides file URLs from a page), so the page cannot name the files; the
//! shell reads them off the native drag.
//!
//! Invariant: a record exists only for a drag from outside the app that the user dropped on the
//! window, and only for [`OS_DROP_TTL`] after the drop. The page cannot cause one (a drag it
//! started is never recorded and clears the record), cannot read one before the drop or after the
//! TTL, and cannot use one twice: staging uses it up. Every URI the page asks to stage must be a
//! file of that record.

use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::{DropStaging, StageError, lock};

/// Bytes read from the source per chunk written.
const COPY_CHUNK: usize = 1024 * 1024;
/// How long after the drop the page may read and stage the dropped files. The page asks within
/// milliseconds; the window only bounds a record nobody used.
pub const OS_DROP_TTL: Duration = Duration::from_secs(5);

/// The drag the OS is offering a window. `drag` identifies one native drag across its events.
pub(super) struct OsDrag {
    drag: u64,
    paths: Vec<PathBuf>,
    dropped_at: Option<Instant>,
}

/// The local path a `file://` URI names, or `None` for any other URI.
pub fn file_uri_path(uri: &str) -> Option<PathBuf> {
    let url = url::Url::parse(uri.trim()).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()
}

impl DropStaging {
    /// A drag from outside the app over a window offers `uris`. A new `drag` replaces the record;
    /// the same drag updates it until it is dropped. URIs that name no local file are left out.
    pub fn os_drag_offered<S: AsRef<str>>(&self, drag: u64, uris: &[S]) {
        let paths = uris
            .iter()
            .filter_map(|uri| file_uri_path(uri.as_ref()))
            .collect();
        let mut record = lock(&self.os_drag);
        match record.as_mut() {
            Some(current) if current.drag == drag => {
                if current.dropped_at.is_none() {
                    current.paths = paths;
                }
            }
            _ => {
                *record = Some(OsDrag {
                    drag,
                    paths,
                    dropped_at: None,
                });
            }
        }
    }

    /// The user dropped `drag` on the window. A drop of any other drag changes nothing.
    pub fn os_drag_dropped(&self, drag: u64, now: Instant) {
        if let Some(current) = lock(&self.os_drag).as_mut()
            && current.drag == drag
        {
            current.dropped_at = Some(now);
        }
    }

    /// A drag the app itself started entered a window: whatever was recorded is not its drop.
    pub fn os_drag_cleared(&self) {
        *lock(&self.os_drag) = None;
    }

    /// The `file://` URIs of the files dropped within [`OS_DROP_TTL`] before `now`.
    pub fn os_drop_uris(&self, now: Instant) -> Result<Vec<String>, StageError> {
        let record = lock(&self.os_drag);
        let paths = dropped_paths(record.as_ref(), now)?;
        Ok(paths
            .iter()
            .filter_map(|path| url::Url::from_file_path(path).ok())
            .map(String::from)
            .collect())
    }

    /// Stages copies of the dropped files the page names by `file://` URI, and returns each
    /// copy's id and path. Every URI must name a file of a drop within [`OS_DROP_TTL`] before
    /// `now`; the drop is used up either way. All or nothing: on a failure the copies already
    /// made are released.
    pub fn stage_os_drop(
        &self,
        uris: &[String],
        now: Instant,
    ) -> Result<Vec<(String, PathBuf)>, StageError> {
        let record = lock(&self.os_drag).take();
        let dropped = dropped_paths(record.as_ref(), now)?;
        let sources = uris
            .iter()
            .map(|uri| {
                file_uri_path(uri)
                    .filter(|path| dropped.contains(path))
                    .ok_or(StageError::NotDropped)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut staged: Vec<(String, PathBuf)> = Vec::with_capacity(sources.len());
        for source in &sources {
            match self.stage_copy(source) {
                Ok(entry) => staged.push(entry),
                Err(error) => {
                    self.release_after_failure(staged.into_iter().map(|(id, _)| id).collect());
                    return Err(error);
                }
            }
        }
        Ok(staged)
    }

    fn stage_copy(&self, source: &Path) -> Result<(String, PathBuf), StageError> {
        // Checked before opening: opening a FIFO for reading waits for a writer.
        let before = fs::metadata(source)?;
        if !before.is_file() {
            return Err(StageError::NotAFile);
        }
        let mut from = open_no_wait(source)?;
        let meta = from.metadata()?;
        if !meta.is_file() || !same_file(&before, &meta) {
            return Err(StageError::NotAFile);
        }
        let name = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let id = self.begin(&name, meta.len())?;
        match self
            .copy_into(&id, &mut from)
            .and_then(|()| self.finish(&id))
        {
            Ok(path) => Ok((id, path)),
            Err(error) => {
                self.release_after_failure(vec![id]);
                Err(error)
            }
        }
    }

    /// Writes `from` into the open transfer `id` through [`write_chunk`](Self::write_chunk),
    /// so a source that grows past its size at `begin` is refused like a page that overruns.
    fn copy_into(&self, id: &str, from: &mut File) -> Result<(), StageError> {
        let mut buffer = vec![0; COPY_CHUNK];
        let mut offset = 0;
        loop {
            let read = from.read(&mut buffer)?;
            if read == 0 {
                return Ok(());
            }
            self.write_chunk(id, offset, &buffer[..read])?;
            offset += read as u64;
        }
    }

    fn release_after_failure(&self, ids: Vec<String>) {
        if let Err(error) = self.release(&ids) {
            // The next launch sweeps what stays; the drop already failed with its own error.
            tracing::warn!(scope = "DropStage", %error, "could not release a failed drop");
        }
    }
}

fn dropped_paths(record: Option<&OsDrag>, now: Instant) -> Result<&[PathBuf], StageError> {
    match record {
        Some(OsDrag {
            paths,
            dropped_at: Some(at),
            ..
        }) if now.saturating_duration_since(*at) <= OS_DROP_TTL => Ok(paths),
        _ => Err(StageError::NotDropped),
    }
}

/// Opens `path` for reading without waiting: if it became a FIFO after the check, the open
/// returns at once and the identity check refuses it.
#[cfg(unix)]
fn open_no_wait(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_no_wait(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}

/// Whether the file opened is the one checked: nothing swapped it in between.
#[cfg(unix)]
fn same_file(checked: &fs::Metadata, opened: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    checked.dev() == opened.dev() && checked.ino() == opened.ino()
}

#[cfg(not(unix))]
fn same_file(checked: &fs::Metadata, opened: &fs::Metadata) -> bool {
    checked.len() == opened.len() && checked.modified().ok() == opened.modified().ok()
}

#[cfg(test)]
mod tests;
