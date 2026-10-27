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
use url::Url;

use super::file_open::{OpenError, open_under_root};
use super::file_serve::{
    FRAME_PERMISSIONS_POLICY, HTML_EMBED_CSP, Head, ServePlan, TRANSPARENT_PNG_BASE64, head,
    html_content_type, is_html_path, is_image_path, plan,
};
use super::local_scheme::{
    LocalScheme, Located, attachment_parts, find_heal_candidate, locate, normalize_absolute,
    remap_cross_device, resolve_local_scheme_path,
};

/// The most an embedded HTML file may weigh. Larger is refused rather than read into memory.
const MAX_HTML_BYTES: u64 = 32 * 1024 * 1024;

/// What a URL may name and who may read the answer: the open vault and the app data directory, and
/// the origins of the app's own pages (`tauri://localhost`, `https://tauri.localhost`, the dev
/// server). Only a page on one of those origins may read an answer.
#[derive(Debug, Clone)]
pub struct Roots {
    pub vault: Option<PathBuf>,
    pub app_data: PathBuf,
    pub app_origins: Vec<String>,
    /// The origin the main window's page has on this platform and build: what an answer to a
    /// request that shows no `Origin` header allows. WebView2 does not put `Origin` on the request
    /// it hands a custom-scheme handler, so the browser's own CORS check against this value is what
    /// stops a `null`-origin embed from reading the answer there.
    pub reply_origin: String,
}

/// The parts of a request that decide who may read: all of them are request input.
#[derive(Debug, Default, Clone, Copy)]
pub struct FileRequest<'a> {
    pub range: Option<&'a str>,
    /// The `Origin` header. `null` comes from a sandboxed frame.
    pub origin: Option<&'a str>,
    /// The `Sec-Fetch-Dest` header, where the engine sends one.
    pub fetch_dest: Option<&'a str>,
    /// The launch token the URL's `t` query parameter must carry, when the engine gives the
    /// handler no `Origin` and no `Sec-Fetch-Dest` to tell the app's own loads from a sandboxed
    /// embed's (WebView2). Only the app's page holds it (the init script of the top frame), so a
    /// `<script src>`, `<link>` or `<img>` an embed points at a vault file is answered 403.
    pub required_token: Option<&'a str>,
}

/// How much one response may hold. A custom scheme answers with bytes in memory, so it caps a
/// range and refuses a whole file that is too big; the streaming loopback server caps nothing.
#[derive(Debug, Clone, Copy)]
pub struct Caps {
    /// A longer range is answered with a shorter 206.
    pub range_chunk: u64,
    /// A request without a usable range for a larger file is answered 413, never a truncated 206.
    pub whole_file: u64,
}

impl Caps {
    pub const UNBOUNDED: Self = Self {
        range_chunk: u64::MAX,
        whole_file: u64::MAX,
    };
}

/// Whether `url` carries `expected` in its `t` query parameter.
fn carries_token(url: &str, expected: &str) -> bool {
    Url::parse(url).is_ok_and(|url| {
        url.query_pairs()
            .any(|(name, value)| name == "t" && value == expected)
    })
}

/// Loads that run or render a file instead of reading it as data. The embed's `<script src>` and
/// `<link>` reach `https://memry-file.localhost` on Windows; the app itself never loads a vault
/// file this way.
const BLOCKED_FETCH_DESTS: &[&str] = &[
    "script",
    "style",
    "worker",
    "sharedworker",
    "serviceworker",
    "audioworklet",
    "paintworklet",
    "iframe",
    "frame",
    "object",
    "embed",
    "document",
    "xslt",
    "manifest",
    "report",
];

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

/// A [`Served`] with its body read: what a scheme handler puts on the wire.
#[derive(Debug)]
pub struct Settled {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub bytes: Vec<u8>,
    pub failure: Option<String>,
}

impl Served {
    /// Reads the body. A read that fails is a 404 with an error code (never a path) and only the
    /// CORS headers: the planned `Content-Length` and `Content-Range` described bytes that never
    /// came, and without `Access-Control-Allow-Origin` the app's `fetch` would see a network error
    /// instead of the 404.
    pub fn settle(self) -> Settled {
        let Self {
            status,
            headers,
            body,
            failure,
        } = self;
        let bytes = match body {
            Body::Empty => Vec::new(),
            Body::Bytes(bytes) => bytes,
            Body::File {
                mut file,
                start,
                len,
            } => match read_range(&mut file, start, len) {
                Ok(bytes) => bytes,
                Err(error) => {
                    return Settled {
                        status: 404,
                        headers: headers
                            .into_iter()
                            .filter(|(name, _)| {
                                matches!(*name, "Access-Control-Allow-Origin" | "Vary")
                            })
                            .collect(),
                        bytes: Vec::new(),
                        failure: Some(format!("{:?}", error.kind())),
                    };
                }
            },
        };
        Settled {
            status,
            headers,
            bytes,
            failure,
        }
    }
    fn status(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
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

/// Answers `url` for `request`. A request from an origin that is not the app's, or one that would
/// run or render the file, is refused 403 without a CORS header: a sandboxed embed (origin
/// `null`) cannot read a file even where the file's origin is an `https:` host its CSP allows.
/// Every answer carries `Access-Control-Allow-Origin` for one app origin only, never `*`.
pub fn serve_file(
    url: &str,
    request: &FileRequest<'_>,
    roots: &Roots,
    windows: bool,
    caps: Caps,
) -> Served {
    if request
        .required_token
        .is_some_and(|expected| !carries_token(url, expected))
    {
        return Served::status(403);
    }
    if request.fetch_dest.is_some_and(|dest| {
        BLOCKED_FETCH_DESTS
            .iter()
            .any(|b| b.eq_ignore_ascii_case(dest))
    }) {
        return Served::status(403);
    }
    let allow_origin = match request.origin {
        None => roots.reply_origin.as_str(),
        Some(origin) if roots.app_origins.iter().any(|app| app == origin) => origin,
        Some(_) => return Served::status(403),
    };
    let mut served = serve_checked(url, request.range, roots, windows, caps);
    served
        .headers
        .push(("Access-Control-Allow-Origin", allow_origin.to_owned()));
    served.headers.push(("Vary", "Origin".to_owned()));
    served
}

fn serve_checked(
    url: &str,
    range: Option<&str>,
    roots: &Roots,
    windows: bool,
    caps: Caps,
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
    let planned = match plan(range, size) {
        ServePlan::Full if size > caps.whole_file => return too_large(),
        planned => bounded(planned, caps.range_chunk),
    };
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

/// A range longer than `max_len` becomes a shorter 206 of `max_len` bytes; the client reads the
/// rest with further ranges, as it does from any server that caps one.
fn bounded(planned: ServePlan, max_len: u64) -> ServePlan {
    match planned {
        ServePlan::Partial { start, end } if end - start + 1 > max_len => ServePlan::Partial {
            start,
            end: start + max_len - 1,
        },
        other => other,
    }
}

/// A file too big to answer in one body, asked for whole. Never a 206 the client did not ask for.
fn too_large() -> Served {
    tracing::warn!(
        scope = "MemryFile",
        "a whole-file request is over the response limit"
    );
    Served::status(413)
}

fn blank_png() -> Served {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(TRANSPARENT_PNG_BASE64)
        .unwrap_or_default();
    Served {
        status: 200,
        headers: vec![("Content-Type", "image/png".to_owned())],
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
                ("Permissions-Policy", FRAME_PERMISSIONS_POLICY.to_owned()),
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
