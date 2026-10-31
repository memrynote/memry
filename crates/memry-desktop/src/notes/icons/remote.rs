//! An icon given as a link (`icons/remote-icon.ts`): downloaded once, here, and from then on an
//! ordinary local icon. Nothing keeps the URL, so rendering an icon never makes a request and a
//! dead or hijacked link cannot change what the user sees.
//!
//! The response is hostile input: only `http` and `https` are fetched, the whole request has a
//! timeout, the body is read through [`read_capped`] (the declared length is a claim, the running
//! count is the bound), and a body that is not an image is refused. Electron fell back to the
//! URL's extension for any content type; here the extension is consulted only when the server
//! names no type or `application/octet-stream`, so a captive portal's `text/html` page behind a
//! `.png` link is refused before its body is read.

use std::time::Duration;

use percent_encoding::percent_decode_str;
use reqwest::Client;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use url::Url;

use crate::http::{ReadError, read_capped};

use super::CustomIconError;
use super::normalize::{INPUT_EXTENSIONS, MAX_INPUT_BYTES};

/// Give up on a slow host rather than leave the picker spinning (`DOWNLOAD_TIMEOUT_MS`).
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10);

/// `CustomIconAddFromUrlSchema`: a link of at most 2048 characters.
const MAX_URL_CHARS: usize = 2048;

/// `CUSTOM_ICON_NAME_MAX_LENGTH`, in UTF-16 units as JavaScript counts them.
const NAME_MAX_UNITS: usize = 60;

const EXTENSION_BY_MIME: [(&str, &str); 6] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/jpg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
    ("image/svg+xml", "svg"),
];

/// The bytes behind a link, with the input extension they were served as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteIcon {
    pub bytes: Vec<u8>,
    pub ext: &'static str,
    /// The name the link suggests, for a caller that has none.
    pub name: String,
}

/// Downloads the image behind `raw` through `client` (the app passes `crate::http::client()`).
pub async fn download(client: &Client, raw: &str) -> Result<RemoteIcon, CustomIconError> {
    download_within(client, raw, DOWNLOAD_TIMEOUT).await
}

/// [`download`] with another timeout, for tests.
#[doc(hidden)]
pub async fn download_within(
    client: &Client,
    raw: &str,
    timeout: Duration,
) -> Result<RemoteIcon, CustomIconError> {
    let url = parse_url(raw)?;
    let host = url.host_str().unwrap_or_default().to_owned();
    let failed = |timed_out: bool| {
        tracing::warn!(scope = "CustomIcons", host = %host, timed_out, "an icon download failed");
        CustomIconError::Download { timed_out }
    };
    let response = client
        .get(url.clone())
        .header(ACCEPT, "image/*")
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| failed(error.is_timeout()))?;
    if !response.status().is_success() {
        tracing::warn!(scope = "CustomIcons", host = %host, status = %response.status(), "an icon download was refused");
        return Err(CustomIconError::Download { timed_out: false });
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .map(|value| value.to_str().unwrap_or("?"));
    let ext = pick_extension(&url, content_type).ok_or(CustomIconError::UnsupportedUrl)?;
    let bytes = read_capped(response, MAX_INPUT_BYTES)
        .await
        .map_err(|error| match error {
            ReadError::TooLarge { .. } => CustomIconError::TooLarge,
            ReadError::Transport(error) => failed(error.is_timeout()),
        })?;
    if bytes.is_empty() {
        return Err(failed(false));
    }
    Ok(RemoteIcon {
        bytes,
        ext,
        name: name_from_url(&url),
    })
}

fn parse_url(raw: &str) -> Result<Url, CustomIconError> {
    let raw = raw.trim();
    if raw.chars().count() > MAX_URL_CHARS {
        return Err(CustomIconError::InvalidUrl);
    }
    let url = Url::parse(raw).map_err(|_| CustomIconError::InvalidUrl)?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err(CustomIconError::InvalidUrl),
    }
}

/// The input extension of a response: its content type, else the URL's extension when the server
/// named no type or a generic binary one.
fn pick_extension(url: &Url, content_type: Option<&str>) -> Option<&'static str> {
    let mime = content_type
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase());
    if let Some(mime) = mime.as_deref().filter(|m| !m.is_empty()) {
        if let Some((_, ext)) = EXTENSION_BY_MIME.iter().find(|(known, _)| *known == mime) {
            return Some(ext);
        }
        if mime != "application/octet-stream" {
            return None;
        }
    }
    let last = url.path_segments()?.next_back()?;
    let ext = last.rsplit_once('.')?.1.to_ascii_lowercase();
    let ext = if ext == "jpeg" { "jpg" } else { ext.as_str() };
    INPUT_EXTENSIONS
        .iter()
        .find(|known| **known == ext)
        .copied()
}

/// `iconNameFromUrl`: the link's file name without its extension, else its host, cut to 60 units.
pub fn name_from_url(url: &Url) -> String {
    let last = url
        .path_segments()
        .and_then(|mut segments| segments.rfind(|s| !s.is_empty()))
        .unwrap_or_default();
    let decoded = percent_decode_str(last)
        .decode_utf8()
        .map_or_else(|_| last.to_owned(), |text| text.into_owned());
    let base = match decoded.rsplit_once('.') {
        Some((stem, ext)) if !ext.is_empty() => stem,
        _ => decoded.as_str(),
    }
    .trim();
    let name = if base.is_empty() {
        url.host_str().unwrap_or_default()
    } else {
        base
    };
    let mut units = 0;
    name.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= NAME_MAX_UNITS
        })
        .collect()
}
