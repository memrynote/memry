//! `downloadImage` (`metadata.ts:310-360`): a link's hero image, saved as `thumbnail.<ext>` in the
//! item's attachment folder.

use std::path::Path;

use wreq::header::{ACCEPT, CONTENT_TYPE};

use super::{WebFetch, WebFetchError, header_text, read_capped, send, within};
use crate::vault::fs_atomic::atomic_write;

const IMAGE_EXTENSIONS: [&str; 6] = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];

/// `getImageExtension` (`metadata.ts:274-301`): by content type, then by the URL path, then
/// `.jpg`.
pub fn image_extension(image_url: &str, content_type: Option<&str>) -> &'static str {
    let by_type =
        content_type.and_then(
            |value| match value.split(';').next().unwrap_or_default().trim() {
                "image/jpeg" | "image/jpg" => Some(".jpg"),
                "image/png" => Some(".png"),
                "image/gif" => Some(".gif"),
                "image/webp" => Some(".webp"),
                "image/svg+xml" => Some(".svg"),
                _ => None,
            },
        );
    by_type
        .or_else(|| {
            let url = url::Url::parse(image_url).ok()?;
            let ext = path_extname(url.path()).to_lowercase();
            let known = IMAGE_EXTENSIONS.into_iter().find(|known| *known == ext)?;
            Some(if known == ".jpeg" { ".jpg" } else { known })
        })
        .unwrap_or(".jpg")
}

/// Node's `path.posix.extname` for the paths a URL has: trailing slashes are ignored, and a
/// name whose only dot leads it has no extension.
fn path_extname(path: &str) -> &str {
    let name = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or_default();
    match name.rfind('.') {
        Some(dot) if dot > 0 => &name[dot..],
        _ => "",
    }
}

impl WebFetch {
    /// Downloads `image_url` into `dest_dir` (created when missing) as `thumbnail.<ext>` and
    /// returns that file name, or `None` on any failure, which the caller treats as "no
    /// thumbnail". The file appears whole or not at all.
    pub async fn download_image(&self, image_url: &str, dest_dir: &Path) -> Option<String> {
        let request = self.client.get(image_url).header(ACCEPT, "image/*");
        let cap = self.limits.max_image_bytes;
        let fetched = within(self.limits.image_timeout, async move {
            let response = send(request).await?;
            if !response.status().is_success() {
                return Err(WebFetchError::Status(response.status().as_u16()));
            }
            let content_type = header_text(&response, CONTENT_TYPE);
            let body = read_capped(response, cap).await?;
            Ok((content_type, body))
        })
        .await;
        let (content_type, body) = match fetched {
            Ok(fetched) => fetched,
            Err(error) => {
                tracing::warn!(%error, "Image download failed");
                return None;
            }
        };
        let file_name = format!(
            "thumbnail{}",
            image_extension(image_url, content_type.as_deref())
        );
        let dest_dir = dest_dir.to_path_buf();
        let target = dest_dir.join(&file_name);
        let written = tokio::task::spawn_blocking(move || {
            std::fs::create_dir_all(&dest_dir).map_err(|error| error.to_string())?;
            atomic_write(&target, &body).map_err(|error| error.to_string())
        });
        match written.await {
            Ok(Ok(())) => Some(file_name),
            Ok(Err(error)) => {
                tracing::warn!(%error, "Image download error: the file could not be written");
                None
            }
            Err(error) => {
                tracing::warn!(%error, "Image download error: the writer stopped");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_by_type_then_url_then_jpg() {
        assert_eq!(
            image_extension("https://x.test/a.png", Some("image/webp; q=1")),
            ".webp"
        );
        assert_eq!(
            image_extension("https://x.test/a.png", Some("Image/WEBP")),
            ".png"
        );
        assert_eq!(image_extension("https://x.test/a.JPEG?x=1#y", None), ".jpg");
        assert_eq!(
            image_extension("https://x.test/a.svg/", Some("text/html")),
            ".svg"
        );
        assert_eq!(image_extension("https://x.test/.png", None), ".jpg");
        assert_eq!(image_extension("https://x.test/a.bmp", None), ".jpg");
        assert_eq!(image_extension("not a url", None), ".jpg");
    }
}
