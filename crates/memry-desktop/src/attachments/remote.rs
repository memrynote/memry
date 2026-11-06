//! An image at a public URL copied into a note's attachments folder: port of
//! `vault/remote-attachment.ts`. A cover picked from a link keeps working offline, on the next
//! device, and after the page behind the link goes away; no remote URL is left in the note.
//!
//! The URL is what the user pasted. The response is untrusted: only an image type the
//! `Content-Type` declares is taken (a link to the page that shows a photo answers HTML), and the
//! body is read through `http::read_capped` at [`MAX_REMOTE_BYTES`], on the declared length and
//! again on the bytes received. The fetched bytes then go through the checks of every upload,
//! the lock refusal included ([`save_fetched`]).

use std::time::Duration;

use percent_encoding::percent_decode_str;
use reqwest::{Client, ClientBuilder};
use serde::Serialize;
use url::Url;

use super::{AttachmentError, SavedAttachment, save, writable_note};
use crate::http::{ReadError, read_capped};
use crate::session::OpenVault;

/// Big enough for a full-resolution photo, small enough that a mistake is cheap.
pub const MAX_REMOTE_BYTES: usize = 25 * 1024 * 1024;
/// `DownloadAttachmentFromUrlSchema`'s `max(2048)`.
const MAX_URL_LEN: usize = 2048;
/// A host that sends nothing for this long fails the download; a slow, steady body does not.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest name taken from the URL, before the extension.
const MAX_STEM_CHARS: usize = 64;

const SCOPE: &str = "RemoteAttachment";

/// Why a link produced no attachment: `DownloadAttachmentFromUrlFailure`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum RemoteFailure {
    // Not an image by its declared type, as a link to the page showing a photo is.
    NotAnImage,
    TooLarge,
    // The request never got an answer.
    Offline,
    // An error status, a body that broke off, or a URL that is not `http(s)`.
    Failed,
    // The bytes came, the vault refused them.
    WriteFailed,
}

/// The image a URL answered with, named for the vault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedImage {
    pub bytes: Vec<u8>,
    /// From the URL's last segment, the extension from the content type.
    pub filename: String,
}

/// The client that fetches linked images.
pub struct RemoteImages {
    http: Client,
}

impl RemoteImages {
    /// Fails only when `http` cannot build a client (no process default crypto provider).
    pub fn new(http: ClientBuilder) -> Result<Self, reqwest::Error> {
        Ok(Self {
            http: http.read_timeout(READ_TIMEOUT).build()?,
        })
    }

    /// `fetchRemoteImage`: the image at `url`, or why there is none.
    pub async fn fetch(&self, url: &str) -> Result<FetchedImage, RemoteFailure> {
        let parsed = Url::parse(url)
            .ok()
            .filter(|parsed| {
                url.len() <= MAX_URL_LEN && matches!(parsed.scheme(), "http" | "https")
            })
            .ok_or(RemoteFailure::Failed)?;
        let response = self
            .http
            .get(parsed.clone())
            .send()
            .await
            .map_err(|error| {
                tracing::warn!(
                    scope = SCOPE,
                    "a linked image could not be fetched: {error}"
                );
                RemoteFailure::Offline
            })?;
        if !response.status().is_success() {
            tracing::warn!(
                scope = SCOPE,
                "a linked image answered with an error status: {}",
                response.status()
            );
            return Err(RemoteFailure::Failed);
        }
        let extension = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(extension_for_type)
            .ok_or(RemoteFailure::NotAnImage)?;
        let bytes = read_capped(response, MAX_REMOTE_BYTES)
            .await
            .map_err(|error| match error {
                ReadError::TooLarge { .. } => RemoteFailure::TooLarge,
                ReadError::Transport(error) => {
                    tracing::error!(
                        scope = SCOPE,
                        "a linked image body could not be read: {error}"
                    );
                    RemoteFailure::Failed
                }
            })?;
        Ok(FetchedImage {
            bytes,
            filename: image_file_name(&parsed, extension),
        })
    }
}

/// `EXTENSION_BY_MIME` of the declared type, its parameters dropped. `avif` maps too, as in
/// Electron, and the upload then refuses the type.
fn extension_for_type(content_type: &str) -> Option<&'static str> {
    let mime = content_type.split(';').next()?.trim().to_ascii_lowercase();
    Some(match mime.as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        _ => return None,
    })
}

/// `filenameFor`: the URL's last path segment, decoded, without its extension, every run of
/// characters outside `[A-Za-z0-9_-]` as one `-` (a `-` itself is kept), `-` trimmed from both
/// ends, at most 64 characters, `linked-image` when nothing is left; then `.<extension>`.
pub fn image_file_name(url: &Url, extension: &str) -> String {
    let last = url.path().rsplit('/').next().unwrap_or("");
    let decoded = percent_decode_str(last)
        .decode_utf8()
        .map(|text| text.into_owned())
        .unwrap_or_default();
    let stem = match decoded.rfind('.') {
        Some(dot) => &decoded[..dot],
        None => decoded.as_str(),
    };
    let mut dashed = String::new();
    let mut in_run = false;
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            dashed.push(c);
            in_run = false;
        } else if !in_run {
            dashed.push('-');
            in_run = true;
        }
    }
    let trimmed: String = dashed
        .trim_matches('-')
        .chars()
        .take(MAX_STEM_CHARS)
        .collect();
    let stem = if trimmed.is_empty() {
        "linked-image"
    } else {
        trimmed.as_str()
    };
    format!("{stem}.{extension}")
}

/// Saves fetched bytes as an attachment of `note_id`, referenced relative to the note's file.
/// A note the vault has no row for is refused before anything is written: its ref would be
/// this device's absolute path, and a cover lives in frontmatter that syncs.
pub fn save_fetched(
    open: &OpenVault,
    note_id: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<SavedAttachment, AttachmentError> {
    let note_path = writable_note(open, note_id)?
        .ok_or_else(|| AttachmentError::NoteNotFound(note_id.to_owned()))?;
    save(&open.path, note_id, Some(&note_path), file_name, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `remote-attachment.ts`'s `filenameFor`, case by case.
    #[test]
    fn names_the_file_from_the_urls_last_segment() {
        for (url, expected) in [
            (
                "https://x.test/photos/Sunset%20Beach.JPG?w=1",
                "Sunset-Beach.jpg",
            ),
            ("https://x.test/a/b.c/photo.final.png", "photo-final.jpg"),
            ("https://x.test/", "linked-image.jpg"),
            ("https://x.test/%E2%9C%93%E2%9C%93", "linked-image.jpg"),
            ("https://x.test/--a__b--", "a__b.jpg"),
            ("https://x.test/caf%C3%A9-%25zz", "caf---zz.jpg"),
            ("https://x.test/%ff%fe.png", "linked-image.jpg"),
        ] {
            let url = Url::parse(url).unwrap();
            assert_eq!(image_file_name(&url, "jpg"), expected, "{url}");
        }
        let long = Url::parse(&format!("https://x.test/{}.png", "a".repeat(100))).unwrap();
        assert_eq!(
            image_file_name(&long, "png"),
            format!("{}.png", "a".repeat(64))
        );
    }

    #[test]
    fn takes_only_the_image_types_it_names() {
        assert_eq!(extension_for_type("image/JPEG; charset=x"), Some("jpg"));
        assert_eq!(extension_for_type("image/avif"), Some("avif"));
        for refused in ["text/html", "image/svg+xml", "", "image/png-ish"] {
            assert_eq!(extension_for_type(refused), None, "{refused}");
        }
    }
}
