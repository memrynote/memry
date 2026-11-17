//! Port of `export-image-inliner.ts`: every `<img src>` of an exported note
//! that names a readable local image becomes a `data:` URI, so the exported
//! document carries its images wherever it goes.
//!
//! Only the image extensions below are inlined. A note is data, and a synced or
//! imported one can name any path its author liked, so without the allowlist an
//! `<img src="file:///…/id_rsa">` would put those bytes into a document the user
//! then sends on. The extension is the gate, as in Electron.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use regex::{Captures, Regex};

/// Where an exported note's relative image refs resolve.
#[derive(Debug, Clone, Copy, Default)]
pub struct ImageSource<'a> {
    /// The note's vault-relative path, e.g. `Folder/Note.md`.
    pub note_path: Option<&'a str>,
    /// Absolute path of the open vault.
    pub vault_path: Option<&'a Path>,
}

fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

static IMG_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<img\b[^>]*>").expect("valid regex"));
/// `(\ssrc\s*=\s*)(["'])([^"']*)\2` without the back-reference.
static SRC_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(\ssrc\s*=\s*)(?:"([^"']*)"|'([^"']*)')"#).expect("valid regex")
});
/// Matches `https:`, `data:`, `memry-file:`, and `C:` on Windows.
static HAS_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z][a-zA-Z\d+\-.]*:").expect("valid regex"));
static WINDOWS_DRIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z]:[/\\]").expect("valid regex"));

fn is_separator(c: char) -> bool {
    c == '/' || c == '\\'
}

/// `getExtension`: the text after the path's last `.`, lowercased.
fn extension(path: &str) -> String {
    match path.rfind('.') {
        Some(dot) if dot + 1 < path.len() => path[dot + 1..].to_lowercase(),
        _ => String::new(),
    }
}

/// `decodeURIComponent`, `None` where it throws.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Join the note's vault-relative directory with a relative ref, collapsing
/// `.` and `..`. `None` when the ref climbs above the vault root.
fn join_within_vault(dir: &str, reference: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for segment in dir.split(is_separator).chain(reference.split(is_separator)) {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            _ => out.push(segment.to_owned()),
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Node's `fileURLToPath`, which refuses an encoded separator.
fn file_url_to_path(url: &str) -> Option<PathBuf> {
    let parsed = url::Url::parse(url).ok()?;
    let path = parsed.path().to_ascii_lowercase();
    if path.contains("%2f") || (cfg!(windows) && path.contains("%5c")) {
        return None;
    }
    parsed.to_file_path().ok()
}

fn memry_file_url_to_path(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let decoded = decode_uri_component(parsed.path())?;
    if cfg!(windows) {
        Some(decoded.strip_prefix('/').unwrap_or(&decoded).to_owned())
    } else if decoded.starts_with('/') {
        Some(decoded)
    } else {
        Some(format!("/{decoded}"))
    }
}

/// The on-disk file an `<img src>` names, or `None` when the src is not a local
/// file to read: a remote or already-inlined URL, an unknown scheme, or a
/// relative ref that escapes the vault.
fn resolve_local_path(src: &str, source: ImageSource<'_>) -> Option<PathBuf> {
    let reference = super::js_trim(src);
    if reference.is_empty() {
        return None;
    }
    if WINDOWS_DRIVE.is_match(reference) {
        return Some(PathBuf::from(reference));
    }
    if HAS_SCHEME.is_match(reference) {
        let scheme = reference[..reference.find(':')?].to_lowercase();
        return match scheme.as_str() {
            "file" => file_url_to_path(reference),
            "memry-file" => memry_file_url_to_path(reference).map(PathBuf::from),
            _ => None,
        };
    }
    if reference.starts_with('/') || reference.starts_with('\\') {
        return Some(PathBuf::from(reference));
    }

    let (note_path, vault_path) = (source.note_path?, source.vault_path?);
    if note_path.is_empty() {
        return None;
    }
    let decoded = decode_uri_component(reference).unwrap_or_else(|| reference.to_owned());
    let mut note_dir: Vec<&str> = note_path.split(is_separator).collect();
    note_dir.pop();
    let segments = join_within_vault(&note_dir.join("/"), &decoded)?;
    Some(
        segments
            .iter()
            .fold(vault_path.to_path_buf(), |path, segment| path.join(segment)),
    )
}

fn src_of<'h>(found: &Captures<'h>) -> &'h str {
    found
        .get(2)
        .or_else(|| found.get(3))
        .map_or("", |m| m.as_str())
}

/// V8's longest string (`buffer.constants.MAX_STRING_LENGTH` in Electron 43):
/// Electron could not build a longer `data:` URI and left the reference as
/// written.
pub const MAX_DATA_URI_LEN: u64 = 536_870_888;

/// Checked before reading: a regular file (a FIFO named `x.png` would block
/// the read forever) whose `data:` URI fits in [`MAX_DATA_URI_LEN`].
fn readable_image(path: &Path, prefix_len: usize) -> std::io::Result<()> {
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    if prefix_len as u64 + 4 * metadata.len().div_ceil(3) > MAX_DATA_URI_LEN {
        return Err(std::io::Error::other("too large to inline"));
    }
    Ok(())
}

fn inline_one(src: &str, source: ImageSource<'_>) -> Option<String> {
    let file_path = resolve_local_path(src, source)?;
    let Some(mime) = image_mime(&extension(&file_path.to_string_lossy())) else {
        tracing::warn!(
            src,
            file_path = %file_path.display(),
            "Export skipped a reference that is not a known image type"
        );
        return None;
    };
    let prefix = format!("data:{mime};base64,");
    match readable_image(&file_path, prefix.len()).and_then(|()| std::fs::read(&file_path)) {
        Ok(bytes) => Some(prefix + &STANDARD.encode(bytes)),
        Err(error) => {
            tracing::warn!(
                src,
                file_path = %file_path.display(),
                %error,
                "Export could not inline an image, leaving the reference as written"
            );
            None
        }
    }
}

/// Rewrites every `<img src>` in a rendered note to a `data:` URI holding the
/// file's bytes. A src that names no readable local file is left as written.
pub fn inline_export_images(html: &str, source: ImageSource<'_>) -> String {
    let refs: HashSet<&str> = IMG_TAG
        .find_iter(html)
        .filter_map(|tag| SRC_ATTR.captures(tag.as_str()).map(|found| src_of(&found)))
        .filter(|src| !src.is_empty())
        .collect();
    if refs.is_empty() {
        return html.to_owned();
    }
    let inlined: HashMap<&str, String> = refs
        .into_iter()
        .filter_map(|src| inline_one(src, source).map(|uri| (src, uri)))
        .collect();
    if inlined.is_empty() {
        return html.to_owned();
    }
    IMG_TAG
        .replace_all(html, |tag: &Captures<'_>| {
            let tag = &tag[0];
            let Some(found) = SRC_ATTR.captures(tag) else {
                return tag.to_owned();
            };
            let whole = found.get(0).expect("group 0");
            let quote = if found.get(2).is_some() { '"' } else { '\'' };
            match inlined.get(src_of(&found)) {
                Some(uri) => format!(
                    "{}{}{quote}{uri}{quote}{}",
                    &tag[..whole.start()],
                    &found[1],
                    &tag[whole.end()..]
                ),
                None => tag.to_owned(),
            }
        })
        .into_owned()
}
