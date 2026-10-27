//! Paths in `memry-file://` and `memry-html://` URLs: port of `resolveLocalSchemePath`,
//! `isPathInsideDirs`, `remapCrossDeviceAttachmentPath` and `healAttachmentPath`
//! (`apps/desktop/src/main/lib/external-url.ts`, `attachment-path-remap.ts`,
//! `vault/attachment-heal.ts`).
//!
//! A URL is renderer input and a note body is peer input: the path in it is untrusted. This
//! module only turns text into a normalized path and a (root, relative path) pair. Nothing here
//! opens a file; `file_open::open_under_root` is the gate that does, so a decision made here is
//! never the only check. Paths are plain strings with the separators of the platform a note was
//! written for (`windows` selects the flavor), so the Windows forms are tested on every host.

use percent_encoding::percent_decode_str;
use url::Url;

/// A URL longer than this is refused unparsed. Real attachment URLs are a few hundred bytes; the
/// longest path an OS accepts is 32 KiB, and nothing stored by the app approaches the limit.
pub const MAX_URL_LEN: usize = 16 * 1024;

/// The `{6-char nanoid}-` prefix every stored attachment name carries.
const STORED_PREFIX_LEN: usize = 7;

/// A `memry-file` or `memry-html` URL as it reaches a handler: the canonical
/// `memry-file://local/<path>` form, or the form WebView2 and WebKitGTK use,
/// `https://memry-file.localhost/local/<path>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalScheme {
    File,
    Html,
}

impl LocalScheme {
    pub const fn name(self) -> &'static str {
        match self {
            Self::File => "memry-file",
            Self::Html => "memry-html",
        }
    }

    /// The host Windows and Linux put in front of the scheme's path.
    pub const fn webview_host(self) -> &'static str {
        match self {
            Self::File => "memry-file.localhost",
            Self::Html => "memry-html.localhost",
        }
    }
}

/// The absolute path a local-scheme URL names, normalized in the flavor of `windows`, or `None`
/// for any other URL, malformed percent-encoding, a NUL, or a path that is not absolute.
///
/// Differs from the Electron port in one case, and only toward refusing: a Windows path without a
/// drive or UNC root resolved against the process directory there, and is `None` here.
pub fn resolve_local_scheme_path(raw: &str, scheme: LocalScheme, windows: bool) -> Option<String> {
    if raw.len() > MAX_URL_LEN {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    let encoded = if url.scheme() == scheme.name() {
        url.path()
    } else if matches!(url.scheme(), "http" | "https")
        && url.host_str() == Some(scheme.webview_host())
    {
        url.path().strip_prefix("/local")?
    } else {
        return None;
    };
    if !escapes_are_well_formed(encoded) {
        return None;
    }
    let decoded = percent_decode_str(encoded).decode_utf8().ok()?;
    if decoded.contains('\0') {
        return None;
    }
    normalize_absolute(&decoded, windows)
}

/// `decodeURIComponent` throws on a `%` without two hex digits; `percent_decode_str` would keep it
/// literally, which names a different file than the one the writer meant.
fn escapes_are_well_formed(encoded: &str) -> bool {
    let bytes = encoded.as_bytes();
    bytes.iter().enumerate().all(|(i, b)| {
        *b != b'%'
            || (bytes.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
                && bytes.get(i + 2).is_some_and(u8::is_ascii_hexdigit))
    })
}

/// `path.resolve(path.normalize(p))` for an absolute path of either flavor. Iterative, linear in
/// the input, no recursion: a path of a million `..` segments costs a million steps.
pub fn normalize_absolute(path: &str, windows: bool) -> Option<String> {
    if windows {
        normalize_windows(path)
    } else {
        normalize_posix(path)
    }
}

fn normalize_posix(path: &str) -> Option<String> {
    // The URL path starts with `/`; a decoded one that does not is made absolute, as Electron did.
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    Some(format!("/{}", out.join("/")))
}

fn normalize_windows(path: &str) -> Option<String> {
    // `/C:/x` from the URL loses its leading slash; `//server/share` is a UNC path.
    let trimmed = path.strip_prefix('/').unwrap_or(path);
    let unc = trimmed.starts_with('/') || trimmed.starts_with('\\');
    let mut segments = trimmed
        .split(['/', '\\'])
        .filter(|s| !s.is_empty() && *s != ".");
    let (root, mut out): (String, Vec<&str>) = if unc {
        let server = segments.next()?;
        let share = segments.next()?;
        (format!("\\\\{server}\\{share}"), Vec::new())
    } else {
        let first = segments.next()?;
        let bytes = first.as_bytes();
        if bytes.len() != 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
            return None;
        }
        (first.to_owned(), Vec::new())
    };
    for segment in segments {
        if segment == ".." {
            out.pop();
        } else {
            out.push(segment);
        }
    }
    let mut joined = root;
    if out.is_empty() {
        joined.push('\\');
    }
    for segment in out {
        joined.push('\\');
        joined.push_str(segment);
    }
    Some(joined)
}

/// Where a path sits under an allowed root: the index of the root and the relative path with
/// forward slashes. `roots` must be normalized (`normalize_absolute`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub root: usize,
    pub rel: String,
}

/// Port of `isPathInsideDirs`, returning where. The root itself is inside with an empty
/// relative path. A sibling that only shares a prefix (`/v` and `/v2`) is not inside.
pub fn locate(path: &str, roots: &[String], windows: bool) -> Option<Located> {
    let sep = if windows { '\\' } else { '/' };
    roots.iter().enumerate().find_map(|(root, dir)| {
        let rest = path.strip_prefix(dir.as_str())?;
        let rest = if rest.is_empty() || dir.ends_with(sep) {
            rest
        } else {
            rest.strip_prefix(sep)?
        };
        Some(Located {
            root,
            rel: if windows {
                rest.replace('\\', "/")
            } else {
                rest.to_owned()
            },
        })
    })
}

/// `remapCrossDeviceAttachmentPath`: a note synced from another machine carries that machine's
/// absolute path, but the bytes sit at `attachments/<noteId>/<file>` of this vault. The tail
/// after the last `/attachments/` is returned as a relative path of the vault, or `None` when
/// there is no tail or a segment is `.` or `..` (a crafted URL cannot climb out).
pub fn remap_cross_device(requested: &str) -> Option<String> {
    const MARKER: &str = "/attachments/";
    let normalized = requested.replace('\\', "/");
    let at = normalized.rfind(MARKER)?;
    let segments: Vec<&str> = normalized[at + MARKER.len()..]
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    if segments.is_empty() || segments.iter().any(|s| matches!(*s, "." | "..")) {
        return None;
    }
    Some(format!("attachments/{}", segments.join("/")))
}

/// Whether a stored attachment name carries the `{6 lowercase alphanumerics}-` prefix.
fn has_stored_prefix(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() >= STORED_PREFIX_LEN
        && bytes[..6]
            .iter()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase())
        && bytes[6] == b'-'
}

/// The unique prefix or suffix match for a missing attachment among the files of its own
/// `attachments/<noteId>/` folder (`findHealCandidate`): the candidate kept the 6-character
/// prefix and was renamed after it, or kept the name and changed the prefix. The union must be
/// exactly one file; zero or several leave the reference broken. `entries` are the regular
/// files of the folder (a symlink is not one). Reads each entry once.
pub fn find_heal_candidate<'a, I>(entries: I, expected: &str) -> Option<&'a str>
where
    I: IntoIterator<Item = &'a str>,
{
    let (prefix, suffix) = if has_stored_prefix(expected) {
        (
            Some(&expected[..STORED_PREFIX_LEN]),
            &expected[STORED_PREFIX_LEN..],
        )
    } else {
        (None, expected)
    };
    let mut found: Option<&str> = None;
    for name in entries {
        if name.starts_with('.') || name == expected {
            continue;
        }
        let by_prefix = prefix.is_some_and(|p| name.starts_with(p));
        let by_suffix = !suffix.is_empty()
            && (if has_stored_prefix(name) {
                &name[STORED_PREFIX_LEN..]
            } else {
                name
            }) == suffix;
        if by_prefix || by_suffix {
            if found.is_some() {
                return None;
            }
            found = Some(name);
        }
    }
    found
}

/// The folder and file name of a relative path of the exact shape `attachments/<noteId>/<file>`
/// (`healAttachmentPath` heals nothing else: a note body or any other path keeps its plain 404).
pub fn attachment_parts(rel: &str) -> Option<(&str, &str)> {
    let mut parts = rel.split('/');
    let (attachments, note, file, rest) =
        (parts.next()?, parts.next()?, parts.next()?, parts.next());
    (attachments == "attachments" && rest.is_none() && !note.is_empty() && !file.is_empty())
        .then_some((note, file))
}

#[cfg(test)]
mod tests;
