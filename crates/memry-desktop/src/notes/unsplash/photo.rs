//! The photo shape and the host allowlist of `packages/contracts/src/unsplash-api.ts`.
//!
//! The service attaches the access key to requests built from a photo's URLs, and the renderer
//! hands a whole photo back on download. So the check lives here, in the owner of the request,
//! and not at the command that happens to receive the photo: a photo is usable only when every
//! URL in it sits on the host its field allows.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

pub(super) const API_HOST: &str = "api.unsplash.com";
const IMAGE_HOSTS: [&str; 2] = ["images.unsplash.com", "plus.unsplash.com"];
const WEB_HOSTS: [&str; 2] = ["unsplash.com", "www.unsplash.com"];

const MAX_ID_BYTES: usize = 64;
const MAX_AUTHOR_BYTES: usize = 200;
const MAX_BLUR_HASH_BYTES: usize = 200;

/// A search result, in the contract's `UnsplashPhoto` shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UnsplashPhoto {
    pub id: String,
    /// `urls.thumb`, hotlinked by the picker.
    pub thumb_url: String,
    /// `urls.small`, hotlinked by the picker.
    pub preview_url: String,
    /// `urls.regular`, the bytes that land in the vault.
    pub full_url: String,
    /// `links.download_location`, the tracking endpoint pinged once per pick.
    pub download_location: String,
    pub author_name: String,
    /// `links.html`, the attribution link.
    pub html_url: String,
    pub blur_hash: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// Why a photo is not usable. Never shown to the user: an unusable search result is dropped.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("photo field `{field}` is not acceptable")]
pub struct InvalidPhoto {
    pub field: &'static str,
}

impl UnsplashPhoto {
    /// Shapes one raw API result and checks it. `None` for a result that fails any check, so one
    /// odd record cannot poison a page of results or smuggle a foreign URL back in on download.
    pub(super) fn from_api(raw: &Value) -> Option<Self> {
        let text = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
        let number = |value: Option<&Value>| {
            value
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
        };
        let urls = raw.get("urls");
        let links = raw.get("links");
        let photo = Self {
            id: text(raw.get("id"))?,
            thumb_url: text(urls.and_then(|u| u.get("thumb")))?,
            preview_url: text(urls.and_then(|u| u.get("small")))?,
            full_url: text(urls.and_then(|u| u.get("regular")))?,
            download_location: text(links.and_then(|l| l.get("download_location")))?,
            author_name: text(raw.get("user").and_then(|u| u.get("name")))?,
            html_url: text(links.and_then(|l| l.get("html")))?,
            blur_hash: text(raw.get("blur_hash")),
            width: number(raw.get("width"))?,
            height: number(raw.get("height"))?,
        };
        photo.validate().ok()?;
        Some(photo)
    }

    /// The contract's checks, plus an id that is safe to put in a file name: Unsplash ids are
    /// letters, digits, `-` and `_`, and the id becomes `unsplash-<id>.<ext>`.
    pub fn validate(&self) -> Result<(), InvalidPhoto> {
        let check = |ok: bool, field: &'static str| ok.then_some(()).ok_or(InvalidPhoto { field });
        check(
            !self.id.is_empty()
                && self.id.len() <= MAX_ID_BYTES
                && self
                    .id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "id",
        )?;
        check(on_host(&self.thumb_url, &IMAGE_HOSTS), "thumbUrl")?;
        check(on_host(&self.preview_url, &IMAGE_HOSTS), "previewUrl")?;
        check(on_host(&self.full_url, &IMAGE_HOSTS), "fullUrl")?;
        check(
            on_host(&self.download_location, &[API_HOST]),
            "downloadLocation",
        )?;
        check(
            !self.author_name.is_empty() && self.author_name.len() <= MAX_AUTHOR_BYTES,
            "authorName",
        )?;
        check(on_host(&self.html_url, &WEB_HOSTS), "htmlUrl")?;
        check(
            self.blur_hash
                .as_ref()
                .is_none_or(|hash| hash.len() <= MAX_BLUR_HASH_BYTES),
            "blurHash",
        )?;
        check(self.width > 0 && self.height > 0, "size")
    }
}

/// An `https` URL on exactly one of `hosts`, with no credentials and no explicit port.
fn on_host(value: &str, hosts: &[&str]) -> bool {
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.host_str().is_some_and(|host| hosts.contains(&host))
}

/// Where the bytes of a photo may come from: an `https` URL on an image host.
pub(super) fn is_image_url(url: &Url) -> bool {
    on_host(url.as_str(), &IMAGE_HOSTS)
}

/// The host the access key may be sent to, for the check on where a response came from.
pub(super) fn is_api_url(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(API_HOST) && url.port().is_none()
}
