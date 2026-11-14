//! The model download. Electron's embedding worker fetches the files through transformers.js
//! `from_pretrained` (`apps/desktop/src/main/lib/embedding-worker.ts:113-150`), which streams each
//! file to `<file>.tmp.<pid>.<random>` and renames it into the cache when complete
//! (`@huggingface/transformers` 4.3.1 `src/utils/cache/FileCache.js:48-103`). This port keeps the
//! cache layout and the rename, and adds what the pinned revision allows: every file is checked
//! against its pinned size and SHA-256 before it is used, and a cut download resumes from its
//! `<file>.part` with a `Range` request instead of starting over.
//!
//! Like Electron's main-process fetch, the client never goes through a system or `HTTP_PROXY`
//! proxy (#4450).

#[cfg(test)]
mod tests;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use reqwest::StatusCode;
use reqwest::header::{CONTENT_RANGE, RANGE};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::service::{ModelProgress, Phase};

/// Where the model files are served: `<host>/<repo>/resolve/<revision>/<path>`.
pub const HUB_HOST: &str = "https://huggingface.co";

/// One file of a pinned model revision, `path` relative to the model directory with `/`
/// separators (`memry_ml::ModelFile`). The paths come from the compiled pin table, never from
/// the network or the disk, and never contain a `..` component.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// What ends a download early: the owner cancelled it (AI off, vault close, quit), or the
/// request it serves ran out of time.
#[derive(Debug, Clone)]
pub struct Abort {
    pub cancel: CancellationToken,
    pub deadline: Instant,
}

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("downloading {file} failed with HTTP {status}")]
    Http { file: String, status: u16 },
    #[error("downloading {file} failed: {source}")]
    Transport {
        file: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("the download of {file} ended before the whole file arrived")]
    Incomplete { file: String },
    #[error("the server sent more of {file} than its pinned size")]
    TooLarge { file: String },
    #[error("{file} does not match its pinned SHA-256")]
    HashMismatch { file: String },
    #[error("writing {file} failed: {source}")]
    Io {
        file: String,
        #[source]
        source: io::Error,
    },
    #[error("the model download was cancelled")]
    Cancelled,
    #[error("the model download ran past its deadline")]
    DeadlineExceeded,
}

/// The files of one model group and where they go.
pub struct ModelSource {
    client: reqwest::Client,
    /// `<host>/<repo>/resolve/<revision>`, no trailing slash.
    url: String,
    dir: PathBuf,
    files: Vec<PinnedFile>,
    /// Every file on disk was hashed once this app session. A later load checks sizes only:
    /// the files are written by this source alone, and only after their hash matched.
    verified: AtomicBool,
}

impl ModelSource {
    pub fn new(
        host: &str,
        repo: &str,
        revision: &str,
        dir: PathBuf,
        files: Vec<PinnedFile>,
    ) -> Self {
        // The hub answers with a redirect to its CDN: an `https` host never follows one to plain
        // `http`. Tests serve the files from a local `http` fake.
        let client = crate::http::builder()
            .no_proxy()
            .https_only(host.starts_with("https://"))
            .build()
            .expect("the model download client needs a process default rustls crypto provider");
        Self {
            client,
            url: format!("{}/{repo}/resolve/{revision}", host.trim_end_matches('/')),
            dir,
            files,
            verified: AtomicBool::new(false),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Makes every file present and verified, downloading what is missing, reporting progress
    /// weighted by file size. A file of the wrong size or hash is deleted and fetched again,
    /// including one an Electron profile left at the same path.
    pub async fn ensure(
        &self,
        abort: &Abort,
        progress: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<(), DownloadError> {
        let deadline = tokio::time::Instant::from_std(abort.deadline);
        tokio::select! {
            result = self.ensure_all(progress) => result,
            () = abort.cancel.cancelled() => Err(DownloadError::Cancelled),
            () = tokio::time::sleep_until(deadline) => Err(DownloadError::DeadlineExceeded),
        }
    }

    async fn ensure_all(
        &self,
        progress: &(dyn Fn(ModelProgress) + Sync),
    ) -> Result<(), DownloadError> {
        let total: u64 = self.files.iter().map(|f| f.size).sum();
        let mut meter = Meter::new(total, progress);
        let hash_present = !self.verified.load(Ordering::SeqCst);
        for file in &self.files {
            let target = file_path(&self.dir, &file.path);
            if self.present(&target, file, hash_present)? {
                meter.add(file.size);
                continue;
            }
            self.fetch(file, &target, &mut meter).await?;
            // `progress.status === 'done'` (embedding-worker.ts:147-149).
            progress(ModelProgress::new(
                Phase::Loading,
                95,
                "Finalizing model...",
            ));
        }
        self.verified.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Whether `target` is the pinned file. A file that is not is removed, so it is never used.
    fn present(&self, target: &Path, file: &PinnedFile, hash: bool) -> Result<bool, DownloadError> {
        let io = |source| DownloadError::Io {
            file: file.path.clone(),
            source,
        };
        let size = match fs::metadata(target) {
            Ok(meta) => meta.len(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io(error)),
        };
        if size == file.size && (!hash || sha256_file(target).map_err(io)? == file.sha256) {
            return Ok(true);
        }
        tracing::warn!(
            scope = "Embeddings",
            file = file.path,
            "a model file does not match its pin; downloading it again"
        );
        fs::remove_file(target).map_err(io)?;
        Ok(false)
    }

    async fn fetch(
        &self,
        file: &PinnedFile,
        target: &Path,
        meter: &mut Meter<'_>,
    ) -> Result<(), DownloadError> {
        let io = |source| DownloadError::Io {
            file: file.path.clone(),
            source,
        };
        let part = part_path(target);
        if let Some(parent) = part.parent() {
            fs::create_dir_all(parent).map_err(io)?;
        }
        let mut offset = fs::metadata(&part).map_or(0, |meta| meta.len());
        if offset > file.size {
            fs::remove_file(&part).map_err(io)?;
            offset = 0;
        }
        if offset < file.size {
            offset = self.stream(file, &part, offset, meter).await?;
        } else {
            meter.add(offset);
        }
        if offset != file.size {
            return Err(DownloadError::Incomplete {
                file: file.path.clone(),
            });
        }
        if sha256_file(&part).map_err(io)? != file.sha256 {
            fs::remove_file(&part).map_err(io)?;
            return Err(DownloadError::HashMismatch {
                file: file.path.clone(),
            });
        }
        fs::rename(&part, target).map_err(io)
    }

    /// Appends the rest of the file to `part` from `offset` and returns the new length. A server
    /// that ignores the range restarts the file from its first byte.
    async fn stream(
        &self,
        file: &PinnedFile,
        part: &Path,
        offset: u64,
        meter: &mut Meter<'_>,
    ) -> Result<u64, DownloadError> {
        let transport = |source| DownloadError::Transport {
            file: file.path.clone(),
            source,
        };
        let io = |source| DownloadError::Io {
            file: file.path.clone(),
            source,
        };
        let mut request = self.client.get(format!("{}/{}", self.url, file.path));
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"));
        }
        let mut response = request.send().await.map_err(transport)?;
        let resumed = response.status() == StatusCode::PARTIAL_CONTENT
            && range_start(&response) == Some(offset);
        if !resumed && response.status() != StatusCode::OK {
            // A range the server cannot or did not serve as asked: the next attempt starts over.
            if matches!(
                response.status(),
                StatusCode::RANGE_NOT_SATISFIABLE | StatusCode::PARTIAL_CONTENT
            ) {
                fs::remove_file(part).map_err(io)?;
            }
            return Err(DownloadError::Http {
                file: file.path.clone(),
                status: response.status().as_u16(),
            });
        }
        let mut written = if resumed { offset } else { 0 };
        let mut out = OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(part)
            .map_err(io)?;
        meter.add(written);
        while let Some(chunk) = response.chunk().await.map_err(transport)? {
            if written + chunk.len() as u64 > file.size {
                drop(out);
                fs::remove_file(part).map_err(io)?;
                return Err(DownloadError::TooLarge {
                    file: file.path.clone(),
                });
            }
            out.write_all(&chunk).map_err(io)?;
            written += chunk.len() as u64;
            meter.add(chunk.len() as u64);
        }
        out.sync_all().map_err(io)?;
        Ok(written)
    }
}

/// The first byte of a `Content-Range: bytes <start>-<end>/<size>` answer.
fn range_start(response: &reqwest::Response) -> Option<u64> {
    let value = response.headers().get(CONTENT_RANGE)?.to_str().ok()?;
    let range = value.strip_prefix("bytes ")?;
    range.split('-').next()?.parse().ok()
}

fn file_path(dir: &Path, path: &str) -> PathBuf {
    debug_assert!(
        !path.split('/').any(|part| part == ".."),
        "a pinned model path leaves the model directory: {path}"
    );
    let mut out = dir.to_path_buf();
    out.extend(path.split('/'));
    out
}

fn part_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut reader = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
    }
}

/// Download progress across the whole group, weighted by size. Electron reports per chunk
/// (`embedding-worker.ts:133-145`); this reports each whole percent once.
struct Meter<'a> {
    loaded: u64,
    total: u64,
    last: Option<u8>,
    progress: &'a (dyn Fn(ModelProgress) + Sync),
}

impl<'a> Meter<'a> {
    fn new(total: u64, progress: &'a (dyn Fn(ModelProgress) + Sync)) -> Self {
        Self {
            loaded: 0,
            total,
            last: None,
            progress,
        }
    }

    fn add(&mut self, bytes: u64) {
        self.loaded += bytes;
        let pct = if self.total == 0 {
            0
        } else {
            ((self.loaded as f64 / self.total as f64) * 100.0)
                .round()
                .min(100.0) as u8
        };
        if self.last == Some(pct) {
            return;
        }
        self.last = Some(pct);
        (self.progress)(ModelProgress::new(
            Phase::Downloading,
            pct,
            format!("Downloading model: {pct}%"),
        ));
    }
}
