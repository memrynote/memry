//! One pack download (`fetchVerified`, `ocr-languages.ts:241-288`): check the size and sha256
//! against the pin, write a `.part` file, then move it under its final name.
//!
//! The request goes through the pinned sync transport, as everything sent to the sync server does
//! (`tests/sync_host_clients.rs`), so it inherits the transport's host policy and its direct
//! (proxy-free) route to a loopback server (#4450). The transport reads a body whole, so the
//! settings row sees a download start and end, not Electron's progress in between.

use std::collections::HashMap;
use std::path::PathBuf;

use memry_core::seams::transport::HttpRequest;
use sha2::{Digest, Sha256};

use super::{OcrLanguage, OcrLanguageStatus, OcrLanguages, Pin};

/// Why a download failed, as the `errors:` key the settings row shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Failure {
    Unreachable,
    Unavailable,
    Corrupt,
    SaveFailed,
}

impl Failure {
    pub(super) fn key(self) -> &'static str {
        match self {
            Self::Unreachable => "errors:ocrLanguages.unreachable",
            Self::Unavailable => "errors:ocrLanguages.unavailable",
            Self::Corrupt => "errors:ocrLanguages.corrupt",
            Self::SaveFailed => "errors:ocrLanguages.saveFailed",
        }
    }
}

/// The `.part` file of a download in progress, deleted unless [`Self::keep`] ran: on an error and
/// when a cancelled download is dropped mid-write.
struct PartFile(Option<PathBuf>);

impl PartFile {
    fn keep(mut self) {
        self.0 = None;
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        let Some(path) = self.0.take() else {
            return;
        };
        if let Err(error) = std::fs::remove_file(&path)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(
                scope = "OcrLanguages",
                "could not delete {}: {error}",
                path.display()
            );
        }
    }
}

fn failed(lang: OcrLanguage, failure: Failure, error: impl std::fmt::Display) -> Failure {
    tracing::warn!(
        scope = "OcrLanguages",
        lang = lang.code(),
        "OCR language download failed: {error}"
    );
    failure
}

impl OcrLanguages {
    pub(super) async fn fetch_verified(&self, lang: OcrLanguage, pin: Pin) -> Result<(), Failure> {
        self.set_status(
            lang,
            Some(OcrLanguageStatus::Downloading {
                received_bytes: 0,
                total_bytes: pin.bytes,
            }),
        );
        let request = HttpRequest {
            method: "GET".to_owned(),
            url: format!("{}/ocr/v1/{}.traineddata.gz", self.server_url, lang.code()),
            headers: HashMap::new(),
            body: None,
            timeout_ms: u64::try_from(self.download_timeout.as_millis()).unwrap_or(u64::MAX),
        };
        let response = self
            .transport
            .send(request)
            .await
            .map_err(|error| failed(lang, Failure::Unreachable, error))?;
        match response.status {
            200..=299 => {}
            404 => return Err(failed(lang, Failure::Unavailable, response.status)),
            status => return Err(failed(lang, Failure::Unreachable, status)),
        }
        let body = response.body;
        if body.len() as u64 != pin.bytes || hex::encode(Sha256::digest(&body)) != pin.sha256 {
            return Err(failed(
                lang,
                Failure::Corrupt,
                "the data does not match its pin",
            ));
        }

        let save = |error: std::io::Error| failed(lang, Failure::SaveFailed, error);
        tokio::fs::create_dir_all(&self.dir).await.map_err(save)?;
        let temp = self
            .dir
            .join(format!("{}.{}.part", lang.code(), uuid::Uuid::new_v4()));
        let part = PartFile(Some(temp.clone()));
        tokio::fs::write(&temp, &body).await.map_err(save)?;
        tokio::fs::rename(&temp, self.dir.join(lang.file_name()))
            .await
            .map_err(save)?;
        part.keep();
        Ok(())
    }
}
