//! Files dropped as `file://` URIs. WebKitGTK hands an OS file drag to the page with no `File`
//! objects and an empty URI list (WebKit hides file URLs from a page), so the page cannot name
//! the files. The shell records the files of the drag the OS is offering the window (from the
//! native drag, before the page sees it); the page reads their URIs back, keeps the ones it can
//! import, and has them staged. A URI from the page is not a grant: only files of the recorded
//! drag are staged, so the page cannot reach any other file.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::{DropStaging, StageError, lock};

/// Bytes read from the source per chunk written.
const COPY_CHUNK: usize = 1024 * 1024;

/// The local path a `file://` URI names, or `None` for any other URI.
pub fn file_uri_path(uri: &str) -> Option<PathBuf> {
    let url = url::Url::parse(uri.trim()).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.to_file_path().ok()
}

impl DropStaging {
    /// Records the files of the drag the OS is offering a window, replacing the previous drag's.
    /// URIs that name no local file are left out.
    pub fn offer_os_drag<S: AsRef<str>>(&self, uris: &[S]) {
        *lock(&self.os_drag) = uris
            .iter()
            .filter_map(|uri| file_uri_path(uri.as_ref()))
            .collect();
    }

    /// The `file://` URIs of the drag recorded by [`offer_os_drag`](Self::offer_os_drag).
    pub fn os_drag_uris(&self) -> Vec<String> {
        lock(&self.os_drag)
            .iter()
            .filter_map(|path| url::Url::from_file_path(path).ok())
            .map(String::from)
            .collect()
    }

    /// Stages copies of the dropped files the page names by `file://` URI, and returns each
    /// copy's id and path. Every URI must name a file of the drag recorded by [`offer_os_drag`];
    /// the drag is used up either way. All or nothing: on a failure the copies already made are
    /// released.
    ///
    /// [`offer_os_drag`]: Self::offer_os_drag
    pub fn stage_os_drop(&self, uris: &[String]) -> Result<Vec<(String, PathBuf)>, StageError> {
        let offered = std::mem::take(&mut *lock(&self.os_drag));
        let sources = uris
            .iter()
            .map(|uri| {
                file_uri_path(uri)
                    .filter(|path| offered.contains(path))
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
        let mut from = File::open(source)?;
        let meta = from.metadata()?;
        if !meta.is_file() {
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
