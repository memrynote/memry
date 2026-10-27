//! Serving a vault or app file for a `memry-file://` or `memry-html://` URL: port of
//! `serveMemryFile` and `serveHtmlEmbed`. One function answers the scheme handler and the
//! loopback media route, so both apply the same roots, the same remap and heal, and the same
//! `open_under_root` gate. The answer is a plain value, [`Served`]; the adapters turn it into a
//! Tauri or an axum response and read the body from the file it holds.
//!
//! Every file is opened once through [`open_under_root`], so a link that leaves its root, or a
//! file swapped for such a link after the check, is refused with 403 instead of served.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use base64::Engine;

use super::file_open::{OpenError, open_under_root};
use super::file_serve::{
    HTML_EMBED_CSP, Head, ServePlan, TRANSPARENT_PNG_BASE64, head, html_content_type, is_html_path,
    is_image_path, plan,
};
use super::local_scheme::{
    LocalScheme, Located, attachment_parts, find_heal_candidate, locate, normalize_absolute,
    remap_cross_device, resolve_local_scheme_path,
};

/// The most an embedded HTML file may weigh. Larger is refused rather than read into memory.
const MAX_HTML_BYTES: u64 = 32 * 1024 * 1024;

/// The directories a URL may name: the open vault and the app data directory.
#[derive(Debug, Clone)]
pub struct Roots {
    pub vault: Option<PathBuf>,
    pub app_data: PathBuf,
}

/// The body of an answer.
#[derive(Debug)]
pub enum Body {
    Empty,
    Bytes(Vec<u8>),
    /// `len` bytes of `file` from `start`. The reader seeks and reads; nothing is buffered here.
    File {
        file: File,
        start: u64,
        len: u64,
    },
}

#[derive(Debug)]
pub struct Served {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Body,
    /// An error code for telemetry (`MemryFile/serve_failed`) when a read failed. Never a path.
    pub failure: Option<String>,
}

impl Served {
    fn status(status: u16) -> Self {
        // A refusal still carries the CORS header: without it a `fetch` from the app's origin
        // fails as a network error and the page cannot tell 403 from a dead server.
        Self {
            status,
            headers: vec![("Access-Control-Allow-Origin", "*".to_owned())],
            body: Body::Empty,
            failure: None,
        }
    }

    pub fn not_found() -> Self {
        Self::status(404)
    }

    fn failed(error: &io::Error) -> Self {
        Self {
            failure: Some(format!("{:?}", error.kind())),
            ..Self::status(404)
        }
    }
}

fn open_failure(error: OpenError) -> Served {
    match error {
        OpenError::Outside => {
            tracing::warn!(
                scope = "MemryFile",
                "refused a file linked outside its root"
            );
            Served::status(403)
        }
        // A file with several hard links is not provably inside the root.
        OpenError::HardLinked => Served::status(403),
        OpenError::NotRegular => Served::status(404),
        OpenError::KeptChanging => Served::failed(&io::Error::other("kept changing")),
        OpenError::Io(error) => Served::failed(&error),
    }
}

fn normalized_roots(
    roots: &Roots,
    windows: bool,
) -> Option<(Vec<String>, Vec<PathBuf>, Option<usize>)> {
    let mut texts = Vec::new();
    let mut paths = Vec::new();
    let mut vault_index = None;
    if let Some(vault) = &roots.vault {
        texts.push(normalize_absolute(&vault.to_string_lossy(), windows)?);
        paths.push(vault.clone());
        vault_index = Some(0);
    }
    texts.push(normalize_absolute(
        &roots.app_data.to_string_lossy(),
        windows,
    )?);
    paths.push(roots.app_data.clone());
    Some((texts, paths, vault_index))
}

/// Where a requested path lives: inside a root, or remapped onto this vault when a note synced
/// from another device carries that device's absolute path.
fn place(
    requested: &str,
    texts: &[String],
    paths: &[PathBuf],
    vault_index: Option<usize>,
    windows: bool,
) -> Option<Located> {
    if let Some(found) = locate(requested, texts, windows) {
        return Some(found);
    }
    let vault = vault_index?;
    let rel = remap_cross_device(requested)?;
    paths[vault]
        .join(&rel)
        .exists()
        .then_some(Located { root: vault, rel })
}

/// The regular files of `<root>/attachments/<note>/`, named, for `find_heal_candidate`.
fn list_attachment_folder(root: &Path, note: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root.join("attachments").join(note)) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect()
}

/// A renamed attachment found again in its note's folder: the relative path of the one match.
fn heal(root: &Path, rel: &str) -> Option<String> {
    let (note, file) = attachment_parts(rel)?;
    let names = list_attachment_folder(root, note);
    find_heal_candidate(names.iter().map(String::as_str), file)
        .map(|healed| format!("attachments/{note}/{healed}"))
}

/// Answers `url` for `range`. `max_len` caps the bytes of one response (a scheme handler cannot
/// stream, so it asks for a bounded chunk; the loopback server passes `u64::MAX`).
pub fn serve_file(
    url: &str,
    range: Option<&str>,
    roots: &Roots,
    windows: bool,
    max_len: u64,
) -> Served {
    let Some(requested) = resolve_local_scheme_path(url, LocalScheme::File, windows) else {
        return Served::status(404);
    };
    let Some((texts, paths, vault_index)) = normalized_roots(roots, windows) else {
        return Served::status(404);
    };
    let Some(Located { root, mut rel }) = place(&requested, &texts, &paths, vault_index, windows)
    else {
        tracing::warn!(
            scope = "MemryFile",
            "blocked a path outside the allowed directories"
        );
        return Served::status(403);
    };
    let root_path = &paths[root];
    let mut opened = match open_under_root(root_path, &rel) {
        Ok(opened) => opened,
        Err(error) => return open_failure(error),
    };
    if opened.is_none()
        && vault_index == Some(root)
        && let Some(healed) = heal(root_path, &rel)
    {
        rel = healed;
        opened = match open_under_root(root_path, &rel) {
            Ok(opened) => opened,
            Err(error) => return open_failure(error),
        };
    }
    let Some(file) = opened else {
        if is_image_path(&requested) {
            return blank_png();
        }
        return Served::status(404);
    };
    let size = match file.metadata() {
        Ok(meta) => meta.len(),
        Err(error) => return Served::failed(&error),
    };
    let planned = bounded(plan(range, size), size, max_len);
    let Head { status, headers } = head(&requested, size, planned);
    let body = match planned {
        ServePlan::Unsatisfiable => Body::Empty,
        ServePlan::Full => Body::File {
            file,
            start: 0,
            len: size,
        },
        ServePlan::Partial { start, end } => Body::File {
            file,
            start,
            len: end - start + 1,
        },
    };
    Served {
        status,
        headers,
        body,
        failure: None,
    }
}

/// A whole-file answer or a range longer than `max_len` becomes a partial answer of `max_len`
/// bytes. A client reads the rest with further ranges, as it does from any server that caps one.
fn bounded(planned: ServePlan, size: u64, max_len: u64) -> ServePlan {
    match planned {
        ServePlan::Full if size > max_len => ServePlan::Partial {
            start: 0,
            end: max_len - 1,
        },
        ServePlan::Partial { start, end } if end - start + 1 > max_len => ServePlan::Partial {
            start,
            end: start + max_len - 1,
        },
        other => other,
    }
}

fn blank_png() -> Served {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(TRANSPARENT_PNG_BASE64)
        .unwrap_or_default();
    Served {
        status: 200,
        headers: vec![
            ("Content-Type", "image/png".to_owned()),
            ("Access-Control-Allow-Origin", "*".to_owned()),
        ],
        body: Body::Bytes(bytes),
        failure: None,
    }
}

/// The attached HTML document of a `memry-html://` URL, sandboxed by its own CSP. Only `.html`
/// and `.htm` files under `<vault>/attachments/` qualify.
pub fn serve_html(url: &str, is_get: bool, vault: Option<&Path>, windows: bool) -> Served {
    if !is_get {
        return Served::status(405);
    }
    let (Some(vault), Some(requested)) = (
        vault,
        resolve_local_scheme_path(url, LocalScheme::Html, windows),
    ) else {
        return Served::status(404);
    };
    if !is_html_path(&requested) {
        return Served::status(404);
    }
    let Some(vault_text) = normalize_absolute(&vault.to_string_lossy(), windows) else {
        return Served::status(404);
    };
    let attachments = if vault_text.ends_with(['/', '\\']) {
        format!("{vault_text}attachments")
    } else {
        format!(
            "{vault_text}{}attachments",
            if windows { '\\' } else { '/' }
        )
    };
    let mut rel = match locate(&requested, &[attachments], windows) {
        Some(Located { rel, .. }) if !rel.is_empty() => format!("attachments/{rel}"),
        _ => match remap_cross_device(&requested) {
            Some(rel) => rel,
            None => return Served::status(404),
        },
    };
    let mut opened = match open_under_root(vault, &rel) {
        Ok(opened) => opened,
        Err(error) => return html_failure(error),
    };
    if opened.is_none()
        && let Some(healed) = heal(vault, &rel)
    {
        rel = healed;
        opened = match open_under_root(vault, &rel) {
            Ok(opened) => opened,
            Err(error) => return html_failure(error),
        };
    }
    let Some(file) = opened.filter(|_| is_html_path(&rel)) else {
        return Served::status(404);
    };
    read_html(file)
}

/// An embed that cannot be served is a plain 404; the reason is only logged.
fn html_failure(error: OpenError) -> Served {
    tracing::warn!(scope = "HtmlEmbed", "memry-html refused: {error}");
    Served::status(404)
}

fn read_html(file: File) -> Served {
    let mut bytes = Vec::new();
    match file.take(MAX_HTML_BYTES + 1).read_to_end(&mut bytes) {
        Ok(_) if bytes.len() as u64 > MAX_HTML_BYTES => Served::status(404),
        Ok(_) => Served {
            status: 200,
            headers: vec![
                ("Content-Type", html_content_type(&bytes).to_owned()),
                ("Content-Security-Policy", HTML_EMBED_CSP.to_owned()),
                // The URL carries this machine's absolute vault path (and username).
                ("Referrer-Policy", "no-referrer".to_owned()),
                ("X-Content-Type-Options", "nosniff".to_owned()),
                ("Cache-Control", "no-store".to_owned()),
            ],
            body: Body::Bytes(bytes),
            failure: None,
        },
        Err(error) => Served::failed(&error),
    }
}

/// Reads the `len` bytes of a [`Body::File`] from `start`. For callers that cannot stream.
pub fn read_range(file: &mut File, start: u64, len: u64) -> io::Result<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(len).read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests;
