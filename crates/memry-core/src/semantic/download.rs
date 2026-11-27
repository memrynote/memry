//! The model download: 8 MiB range requests straight on the `Transport` seam,
//! appended to a `.part` file whose length is the resume point.
//!
//! Requests are built here rather than through `HttpClient`, so no JSON or
//! `x-memry-client` header reaches a third-party host and no retry ladder
//! runs. The Swift transport hands back redirects instead of following them,
//! and Hugging Face's `resolve/` URLs answer with a 302 to its CDN.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::PathBuf;

use sha2::{Digest, Sha256};

use super::model::{self, ModelDir, ModelFile};
use crate::api::runtime::runtime;
use crate::api::semantic::DownloadFailure;
use crate::seams::reachability::{Reachability, Reachable};
use crate::seams::transport::{HttpRequest, HttpResponse, Transport};

/// Bounds the three copies of a body between URLSession and the file.
pub(crate) const RANGE_BYTES: u64 = 8 * 1024 * 1024;
/// The seam's default is a hard 60 s; 8 MiB on a slow Wi-Fi needs longer.
const TIMEOUT_MS: u64 = 120_000;
const MAX_REDIRECTS: usize = 3;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum DownloadEnd {
    Complete,
    NotOnWifi,
    OptedOut,
}

#[derive(Debug)]
pub(crate) enum DownloadError {
    Failed(DownloadFailure),
    Io(io::Error),
}

impl From<io::Error> for DownloadError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// Idempotent: a finished file is skipped, a part resumes from its length,
/// and a complete part that was never renamed is verified again.
pub(crate) async fn download(
    dir: &ModelDir,
    transport: &dyn Transport,
    reachability: &dyn Reachability,
) -> Result<DownloadEnd, DownloadError> {
    let manifest = dir.manifest();
    for file in manifest.files {
        if dir.is_final(file) {
            continue;
        }
        let part = dir.part_path(file);
        if let Some(parent) = part.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut received = model::len(&part);
        if received > file.size {
            fs::remove_file(&part)?;
            received = 0;
        }
        while received < file.size {
            if !dir.opted_in() {
                return Ok(DownloadEnd::OptedOut);
            }
            if reachability.current() != Reachable::Wifi {
                return Ok(DownloadEnd::NotOnWifi);
            }
            let last = (received + RANGE_BYTES).min(file.size) - 1;
            let url = format!("{}{}", manifest.base_url, file.path);
            let body = match fetch_range(transport, url, received, last, file.size).await {
                Ok(body) => body,
                Err(DownloadFailure::Network) if reachability.current() != Reachable::Wifi => {
                    return Ok(DownloadEnd::NotOnWifi);
                }
                Err(failure) => return Err(DownloadError::Failed(failure)),
            };
            // An opt-out during the request has already removed the part.
            if !dir.opted_in() {
                return Ok(DownloadEnd::OptedOut);
            }
            let mut out = OpenOptions::new().create(true).append(true).open(&part)?;
            out.write_all(&body)?;
            out.sync_all()?;
            received += body.len() as u64;
        }
        verify_and_rename(dir, file, part).await?;
    }
    Ok(DownloadEnd::Complete)
}

/// Hashes on the blocking pool: the weights file is 174 MB.
async fn verify_and_rename(
    dir: &ModelDir,
    file: &'static ModelFile,
    part: PathBuf,
) -> Result<(), DownloadError> {
    let target = dir.final_path(file);
    runtime()
        .spawn_blocking(move || {
            if hex::encode(sha256(&part)?) != file.sha256 {
                fs::remove_file(&part)?;
                return Err(DownloadError::Failed(DownloadFailure::Mismatch));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&part, &target)?;
            Ok(())
        })
        .await
        .map_err(|error| DownloadError::Io(io::Error::other(error)))?
}

fn sha256(path: &PathBuf) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut input = File::open(path)?;
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            return Ok(hasher.finalize().into());
        }
        hasher.update(&buffer[..read]);
    }
}

/// One range, following up to three https redirects with the same range.
async fn fetch_range(
    transport: &dyn Transport,
    mut url: String,
    first: u64,
    last: u64,
    size: u64,
) -> Result<Vec<u8>, DownloadFailure> {
    let mut status = 0;
    for _ in 0..=MAX_REDIRECTS {
        let request = HttpRequest {
            method: "GET".into(),
            url: url.clone(),
            headers: HashMap::from([("range".into(), format!("bytes={first}-{last}"))]),
            body: None,
            timeout_ms: TIMEOUT_MS,
        };
        let response = transport
            .send(request)
            .await
            .map_err(|_| DownloadFailure::Network)?;
        status = response.status;
        match status {
            301 | 302 | 303 | 307 | 308 => url = redirect(&url, &response)?,
            206 => return ranged_body(response, first, last, size),
            _ => return Err(DownloadFailure::Http { status }),
        }
    }
    Err(DownloadFailure::Http { status })
}

fn redirect(from: &str, response: &HttpResponse) -> Result<String, DownloadFailure> {
    let refused = DownloadFailure::Http {
        status: response.status,
    };
    let location = response.headers.get("location").ok_or(refused.clone())?;
    if location.starts_with("https://") {
        return Ok(location.clone());
    }
    if location.starts_with('/') && !location.starts_with("//") {
        let authority_end = from["https://".len()..]
            .find('/')
            .map_or(from.len(), |at| at + "https://".len());
        return Ok(format!("{}{location}", &from[..authority_end]));
    }
    Err(refused)
}

/// Requires `content-range: bytes <first>-<end>/<size>` with `end <= last`
/// and a body of exactly that span. A different total is a different file.
fn ranged_body(
    response: HttpResponse,
    first: u64,
    last: u64,
    size: u64,
) -> Result<Vec<u8>, DownloadFailure> {
    let malformed = DownloadFailure::Http { status: 206 };
    let header = response
        .headers
        .get("content-range")
        .ok_or(malformed.clone())?;
    let (span, total) = header
        .strip_prefix("bytes ")
        .and_then(|rest| rest.split_once('/'))
        .ok_or(malformed.clone())?;
    if total.parse::<u64>().ok() != Some(size) {
        return Err(DownloadFailure::Mismatch);
    }
    let (start, end) = span
        .split_once('-')
        .and_then(|(start, end)| Some((start.parse::<u64>().ok()?, end.parse::<u64>().ok()?)))
        .ok_or(malformed.clone())?;
    if start != first || end < start || end > last || response.body.len() as u64 != end - start + 1
    {
        return Err(malformed);
    }
    Ok(response.body)
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
