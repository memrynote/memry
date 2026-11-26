//! A `/capture` written into the Inbox: `ingestArticleCapture` (`inbox/ingest.ts:41-163`) with
//! `storeInboxAttachment` (`inbox/attachments.ts:244-299`) and `parseDataUrl`
//! (`inbox/parse-data-url.ts`). The row itself is the inbox owner's: `Inbox::duplicate_by_url`,
//! `Inbox::enrich_article` and `Inbox::capture_article`. This module only stores the files that
//! row points at.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use memry_core::api::inbox::Inbox;
use memry_core::crypto::sodium;
use memry_core::domain::inbox::ingest::{InboxArticle, InboxArticleFiles, InboxArticlePdf};
use memry_core::seams::secure_store::SecureStore;

use super::HeroDownload;
use super::schema::ArticleCapture;
use crate::session::OpenVault;

/// `CaptureSource` of an extension capture.
pub const CAPTURE_SOURCE: &str = "browser-extension";

/// Captures `capture` into the open vault's Inbox and returns the item id: an existing live
/// capture of the same URL is enriched unless `force`, else a new one is created.
pub async fn ingest(
    open: OpenVault,
    store: Arc<dyn SecureStore>,
    hero: Option<Arc<dyn HeroDownload>>,
    capture: ArticleCapture,
) -> Result<String, String> {
    let (inbox, existing) = blocking({
        let open = open.clone();
        let url = capture.article.url.clone();
        let force = capture.force;
        move || {
            let inbox = open.vault.inbox(store).map_err(|e| e.to_string())?;
            let existing = if force {
                None
            } else {
                inbox.duplicate_by_url(url).map_err(|e| e.to_string())?
            };
            Ok((inbox, existing.map(|item| item.id)))
        }
    })
    .await?;

    let article = capture.article.clone();
    if let Some(id) = existing {
        let hero_path = download_hero(hero.as_deref(), &open, &id, &article).await;
        return blocking(move || {
            inbox
                .enrich_article(id.clone(), article, hero_path)
                .map(|_| id)
                .map_err(|e| e.to_string())
        })
        .await;
    }

    let id = inbox.new_id();
    let tags = capture.tags.clone();
    let mut files = blocking({
        let (open, inbox, id) = (open.clone(), inbox.clone(), id.clone());
        move || Ok(store_files(&open.path, &inbox, &id, &capture))
    })
    .await?;
    if files.screenshot_path.is_none() {
        files.hero_path = download_hero(hero.as_deref(), &open, &id, &article).await;
    }
    blocking(move || {
        inbox
            .capture_article(id, article, files, tags, CAPTURE_SOURCE.to_owned())
            .map(|outcome| outcome.item.id)
            .map_err(|e| e.to_string())
    })
    .await
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// The screenshot and the PDF of a new capture, each stored under its folder. A file that
/// fails to decode or store is logged and left out, so the capture degrades (no screenshot
/// body, a link instead of a pdf) rather than being lost (`ingest.ts:90-131`).
fn store_files(
    vault: &Path,
    inbox: &Inbox,
    id: &str,
    capture: &ArticleCapture,
) -> InboxArticleFiles {
    let mut files = InboxArticleFiles::default();
    if let Some((mime, bytes)) = capture
        .screenshot_data_url
        .as_deref()
        .and_then(parse_data_url)
    {
        match store_attachment(vault, inbox, id, &bytes, "screenshot", &mime) {
            Ok(path) => files.screenshot_path = Some(path),
            Err(error) => {
                tracing::warn!(
                    scope = "Capture",
                    item_id = id,
                    "screenshot attachment failed: {error}"
                )
            }
        }
    }
    if let Some(data_url) = capture.pdf_data_url.as_deref() {
        match parse_data_url(data_url) {
            Some((mime, bytes)) if mime == "application/pdf" => {
                let filename = capture.pdf_filename.as_deref().unwrap_or("document.pdf");
                match store_attachment(vault, inbox, id, &bytes, filename, "application/pdf") {
                    Ok(path) => {
                        files.pdf = Some(InboxArticlePdf {
                            path,
                            filename: filename.to_owned(),
                            size: bytes.len() as u64,
                        })
                    }
                    Err(error) => {
                        tracing::warn!(
                            scope = "Capture",
                            item_id = id,
                            "pdf attachment failed: {error}"
                        )
                    }
                }
            }
            parsed => tracing::warn!(
                scope = "Capture",
                item_id = id,
                mime = parsed.map(|(mime, _)| mime),
                "pdf capture had a non-pdf data url"
            ),
        }
    }
    files
}

async fn download_hero(
    hero: Option<&dyn HeroDownload>,
    open: &OpenVault,
    id: &str,
    article: &InboxArticle,
) -> Option<String> {
    let (hero, url) = (hero?, article.hero_image.as_deref()?);
    let dir = item_dir(&open.path, id);
    let name = hero.download(url, &dir).await?;
    Some(format!("attachments/inbox/{id}/{name}"))
}

fn item_dir(vault: &Path, id: &str) -> PathBuf {
    vault.join("attachments").join("inbox").join(id)
}

/// `storeInboxAttachment`: the type and size checks of the inbox owner (`Inbox::check_file`),
/// then `<6 random [0-9a-z]>-<sanitized name>.<ext of the MIME type>` in the item's folder.
/// Returns the vault-relative path.
pub fn store_attachment(
    vault: &Path,
    inbox: &Inbox,
    id: &str,
    bytes: &[u8],
    filename: &str,
    mime: &str,
) -> Result<String, String> {
    inbox
        .check_file(mime.to_owned(), bytes.len() as u64)
        .map_err(|e| e.to_string())?;
    let name = format!(
        "{}-{}.{}",
        prefix(),
        sanitize(stem(filename)),
        extension(mime)
    );
    let dir = item_dir(vault, id);
    std::fs::create_dir_all(&dir).map_err(|e| e.kind().to_string())?;
    std::fs::write(dir.join(&name), bytes).map_err(|e| e.kind().to_string())?;
    Ok(format!("attachments/inbox/{id}/{name}"))
}

/// `filename.replace(/\.[^.]+$/, '')`.
fn stem(filename: &str) -> &str {
    match filename.rsplit_once('.') {
        Some((stem, ext)) if !ext.is_empty() => stem,
        _ => filename,
    }
}

/// `sanitizeFilename`: anything outside `[a-zA-Z0-9.-]` becomes `_`, runs of `_` collapse, and
/// the result is cut to 100 characters (all ASCII by then).
fn sanitize(name: &str) -> String {
    let mut out = String::with_capacity(name.len().min(100));
    for c in name.chars() {
        let c = if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
            c
        } else {
            '_'
        };
        if !(c == '_' && out.ends_with('_')) {
            out.push(c);
        }
    }
    out.truncate(100);
    out
}

/// `generatePrefix`: 6 characters of `[0-9a-z]`, uniform (bytes past 251 are redrawn).
fn prefix() -> String {
    const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = String::with_capacity(6);
    while out.len() < 6 {
        for byte in sodium::random_bytes(8) {
            if byte < 252 && out.len() < 6 {
                out.push(ALPHABET[usize::from(byte % 36)] as char);
            }
        }
    }
    out
}

/// `getExtensionFromMimeType`.
fn extension(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/flac" => "flac",
        "audio/aac" => "aac",
        "audio/webm" | "video/webm" => "webm",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/x-msvideo" => "avi",
        "video/x-matroska" => "mkv",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

/// `parseDataUrl`: `data:<mime>;base64,<payload>` after a JavaScript `trim`, the MIME type
/// lowercased, the payload one line, decoded as Node's `Buffer.from(_, 'base64')` decodes.
/// `None` for anything else or for an empty decode.
pub fn parse_data_url(input: &str) -> Option<(String, Vec<u8>)> {
    let input = input.trim_matches(super::schema::is_js_whitespace);
    let head = input.get(..5)?;
    if !head.eq_ignore_ascii_case("data:") {
        return None;
    }
    let rest = &input[5..];
    let semi = rest.find(';')?;
    let (mime, tail) = rest.split_at(semi);
    let marker = tail.get(..8)?;
    if !marker.eq_ignore_ascii_case(";base64,") {
        return None;
    }
    let payload = &tail[8..];
    let mime_ok = !mime.is_empty()
        && mime
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".+/-".contains(&b));
    // The regex's `.` stops at a line terminator.
    let line = !payload.is_empty() && !payload.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    if !mime_ok || !line {
        return None;
    }
    let bytes = node_base64(payload);
    (!bytes.is_empty()).then(|| (mime.to_ascii_lowercase(), bytes))
}

/// Node's lenient base64: both alphabets, every other character skipped, decoding stops at the
/// first `=`, and a trailing partial group yields what bits it completes.
fn node_base64(payload: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() / 4 * 3 + 2);
    let (mut acc, mut n) = (0u32, 0u8);
    for byte in payload.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(value);
        n += 1;
        if n == 4 {
            out.extend_from_slice(&[(acc >> 16) as u8, (acc >> 8) as u8, acc as u8]);
            (acc, n) = (0, 0);
        }
    }
    match n {
        2 => out.push((acc >> 4) as u8),
        3 => out.extend_from_slice(&[(acc >> 10) as u8, (acc >> 2) as u8]),
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests;
