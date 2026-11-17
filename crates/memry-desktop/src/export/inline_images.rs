//! Port of `export-image-inliner.ts`: every `<img src>` of an exported note
//! that names a readable local image becomes a `data:` URI, so the exported
//! document carries its images wherever it goes.
//!
//! Only the image extensions below are inlined. A note is data, and a synced or
//! imported one can name any path its author liked, so without the allowlist an
//! `<img src="file:///…/id_rsa">` would put those bytes into a document the user
//! then sends on. The extension is the gate, as in Electron, and the extension
//! of the real file, links followed, must name an image too: it gives the type.
//!
//! A file is read only when its real location, links followed, is inside the open vault or the
//! app's data folder, the two roots the `memry-file` scheme serves. Electron's comment on its
//! inliner names that check as the intent, but the inliner read any path it was given. A
//! network path (`\\host\share`, `//host/share`, `file://host/share`) and a device path
//! (`\\?\`, `\??\`) are refused before the file system is asked anything, so an export never
//! opens a connection to a host a note names.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read as _;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use regex::{Captures, Regex};

use crate::shell::file_open::{FileId, LinkPolicy, OpenError, file_identity, open_checked};

/// Where an exported note's image refs resolve, and the roots a file may be read from.
#[derive(Debug, Clone, Copy, Default)]
pub struct ImageSource<'a> {
    /// The note's vault-relative path, e.g. `Folder/Note.md`.
    pub note_path: Option<&'a str>,
    /// Absolute path of the open vault. An empty path is no vault, as Electron's `!vaultPath`.
    pub vault_path: Option<&'a Path>,
    /// The app's data folder (Electron's `userData`), the other root `memry-file` serves.
    pub app_data: Option<&'a Path>,
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

/// JavaScript's `/i` folds ASCII only: `ſrc` is not `src`.
static IMG_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u:<img)(?-u:\b)[^>]*>").expect("valid regex"));
/// `(\ssrc\s*=\s*)(["'])([^"']*)\2` without the back-reference.
static SRC_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(\s(?i-u:src)\s*=\s*)(?:"([^"']*)"|'([^"']*)')"#).expect("valid regex")
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
/// `.` and `..`. `None` when the ref climbs above the vault root, or names a
/// segment that is not one plain name: `C:` would replace the whole path on
/// Windows, and `a:b` names an alternate data stream there.
fn join_within_vault(dir: &str, reference: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for segment in dir.split(is_separator).chain(reference.split(is_separator)) {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            _ if segment.contains(':') => return None,
            _ => {
                let mut parts = Path::new(segment).components();
                let (Some(Component::Normal(_)), None) = (parts.next(), parts.next()) else {
                    return None;
                };
                out.push(segment.to_owned());
            }
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

/// The file an `<img src>` names, before the roots are checked.
enum Target {
    /// A relative ref: a plain path under the vault, with `/` separators.
    InVault { vault: PathBuf, rel: String },
    /// An absolute path, a `file:` or a `memry-file:` URL.
    Absolute(PathBuf),
}

impl Target {
    fn path(&self) -> PathBuf {
        match self {
            Self::InVault { vault, rel } => vault.join(rel),
            Self::Absolute(path) => path.clone(),
        }
    }
}

fn non_empty(path: Option<&Path>) -> Option<&Path> {
    path.filter(|path| !path.as_os_str().is_empty())
}

/// What an `<img src>` names, or `None` when the src is not a local file to
/// read: a remote or already-inlined URL, an unknown scheme, a relative ref
/// that escapes the vault, or a network or device path.
fn resolve_local_path(src: &str, source: ImageSource<'_>) -> Option<Target> {
    let reference = super::js_trim(src);
    if reference.is_empty() {
        return None;
    }
    let absolute = if WINDOWS_DRIVE.is_match(reference) {
        Some(PathBuf::from(reference))
    } else if HAS_SCHEME.is_match(reference) {
        let scheme = reference[..reference.find(':')?].to_lowercase();
        Some(match scheme.as_str() {
            "file" => file_url_to_path(reference)?,
            "memry-file" => PathBuf::from(memry_file_url_to_path(reference)?),
            _ => return None,
        })
    } else if reference.starts_with('/') || reference.starts_with('\\') {
        Some(PathBuf::from(reference))
    } else {
        None
    };
    if let Some(path) = absolute {
        return (!is_network_or_device(&path.to_string_lossy())).then_some(Target::Absolute(path));
    }

    let (note_path, vault) = (source.note_path?, non_empty(source.vault_path)?);
    if note_path.is_empty() {
        return None;
    }
    let decoded = decode_uri_component(reference).unwrap_or_else(|| reference.to_owned());
    let mut note_dir: Vec<&str> = note_path.split(is_separator).collect();
    note_dir.pop();
    let segments = join_within_vault(&note_dir.join("/"), &decoded)?;
    Some(Target::InVault {
        vault: vault.to_path_buf(),
        rel: segments.join("/"),
    })
}

/// `\\host\share`, `//host/share` and Windows' device paths `\\?\`, `\\.\` and
/// `\??\`, in either separator: a path that starts with a separator and then a
/// second separator or `?`. On Windows, asking about a network path opens an
/// SMB connection, which hands the host the user's NTLM hash.
fn is_network_or_device(path: &str) -> bool {
    let mut chars = path.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some(first), Some(second)) if is_separator(first) && (is_separator(second) || second == '?')
    )
}

/// The target opened through [`open_checked`], which follows links and
/// refuses a real location outside the vault or the app data folder, with the
/// MIME type of the extension of the file it opened and checked, so a link
/// swapped while it is opened gives the type of the file read. A link named like
/// an image to a file that is not one (`db.png` to the vault's database) is
/// refused. `None` when the file does not exist.
fn open_target(
    target: &Target,
    source: ImageSource<'_>,
    between: &mut dyn FnMut(),
) -> std::io::Result<Option<(File, &'static str)>> {
    let outside = || std::io::Error::other("outside the vault and the app data folder");
    let real = match std::fs::canonicalize(target.path()) {
        Ok(real) => real,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let (root, rel) = match target {
        Target::InVault { vault, rel } => (vault.clone(), rel.clone()),
        Target::Absolute(_) => [source.vault_path, source.app_data]
            .into_iter()
            .filter_map(non_empty)
            .filter_map(|root| std::fs::canonicalize(root).ok())
            .find_map(|root| {
                let rel = real.strip_prefix(&root).ok()?;
                let parts: Option<Vec<&str>> = rel
                    .components()
                    .map(|part| match part {
                        Component::Normal(name) => name.to_str(),
                        _ => None,
                    })
                    .collect();
                let rel = parts?.join("/");
                (!rel.is_empty()).then_some((root, rel))
            })
            .ok_or_else(outside)?,
    };
    let opened = open_checked(&root, &rel, LinkPolicy::RejectHardLinks, between).map_err(
        |error| match error {
            OpenError::Io(error) => error,
            other => std::io::Error::other(other.to_string()),
        },
    )?;
    let Some((file, opened_path)) = opened else {
        return Ok(None);
    };
    let mime = image_mime(&extension(&opened_path.to_string_lossy()))
        .ok_or_else(|| std::io::Error::other("the linked file is not a known image type"))?;
    Ok(Some((file, mime)))
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

thread_local! {
    static READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Image files the inliner has read on this thread, for the test that one file
/// named several ways is read once.
#[cfg(feature = "test-hooks")]
pub fn image_reads() -> usize {
    READS.with(std::cell::Cell::get)
}

/// The `data:` URIs of one document. Every src that names the same file shares
/// one URI, and all of them together stay within [`MAX_DATA_URI_LEN`], so a note
/// cannot grow its export without bound by naming one image many ways.
#[derive(Default)]
struct Inliner {
    by_file: HashMap<FileId, String>,
    total: u64,
}

impl Inliner {
    fn inline(
        &mut self,
        src: &str,
        source: ImageSource<'_>,
        between: &mut dyn FnMut(),
    ) -> Option<String> {
        let target = resolve_local_path(src, source)?;
        let file_path = target.path();
        if image_mime(&extension(&file_path.to_string_lossy())).is_none() {
            tracing::warn!(
                src,
                file_path = %file_path.display(),
                "Export skipped a reference that is not a known image type"
            );
            return None;
        }
        match self.read(&target, source, between) {
            Ok(uri) => Some(uri),
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

    /// The file's `data:` URI. Its size is checked before reading: the open
    /// refuses anything but a regular file (a FIFO named `x.png` would block the
    /// read forever).
    fn read(
        &mut self,
        target: &Target,
        source: ImageSource<'_>,
        between: &mut dyn FnMut(),
    ) -> std::io::Result<String> {
        let Some((file, mime)) = open_target(target, source, between)? else {
            return Err(std::io::ErrorKind::NotFound.into());
        };
        let (id, _) = file_identity(&file)?;
        if let Some(uri) = self.by_file.get(&id) {
            return Ok(uri.clone());
        }
        let prefix = format!("data:{mime};base64,");
        let len = file.metadata()?.len();
        let uri_len = prefix.len() as u64 + 4 * len.div_ceil(3);
        if self.total + uri_len > MAX_DATA_URI_LEN {
            return Err(std::io::Error::other("too large to inline"));
        }
        let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
        file.take(len).read_to_end(&mut bytes)?;
        READS.with(|reads| reads.set(reads.get() + 1));
        let uri = prefix + &STANDARD.encode(bytes);
        self.total += uri.len() as u64;
        self.by_file.insert(id, uri.clone());
        Ok(uri)
    }
}

/// Rewrites every `<img src>` in a rendered note to a `data:` URI holding the
/// file's bytes. A src that names no readable local file is left as written.
pub fn inline_export_images(html: &str, source: ImageSource<'_>) -> String {
    inline_images(html, source, &mut || {})
}

/// [`inline_export_images`] with a hook that runs between each file's open and
/// its re-check, so a test can swap the file in that window.
#[cfg(feature = "test-hooks")]
pub fn inline_export_images_between(
    html: &str,
    source: ImageSource<'_>,
    between: &mut dyn FnMut(),
) -> String {
    inline_images(html, source, between)
}

fn inline_images(html: &str, source: ImageSource<'_>, between: &mut dyn FnMut()) -> String {
    let mut seen = HashSet::new();
    let refs: Vec<&str> = IMG_TAG
        .find_iter(html)
        .filter_map(|tag| SRC_ATTR.captures(tag.as_str()).map(|found| src_of(&found)))
        .filter(|src| !src.is_empty() && seen.insert(*src))
        .collect();
    if refs.is_empty() {
        return html.to_owned();
    }
    let mut inliner = Inliner::default();
    let inlined: HashMap<&str, String> = refs
        .into_iter()
        .filter_map(|src| inliner.inline(src, source, between).map(|uri| (src, uri)))
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
