//! Port of `packages/editor-schema/src/blocks/rewrite-note-refs.ts`: a moved note's relative
//! refs re-pointed at the files they named (`rewriteNoteRefsForMove`).
//!
//! Desktop writes an attachment ref relative to the note (`../attachments/<noteId>/x.pdf`), so
//! it is right only from the folder the note was in. A move to `notes/archive/2026/` leaves
//! every `../attachments/...` one level short. The fix is arithmetic: resolve each ref from the
//! old folder to the vault path it named, then write that path from the new folder.
//!
//! What is rewritten: the `url` of a file block marker line (`<!-- file:{...} -->`) and the ref
//! of every `![alt](ref)`. Left as written: a ref with a scheme (`https:`, `data:`,
//! `memry-file:`, `C:`), one rooted at `/` or `\`, one that climbs above the vault root, a
//! mobile vault-root ref to the note's own attachments when asked to keep those, and every
//! `[[wiki link]]`, which names a title. A ref whose path does not change keeps its bytes, so
//! a percent escape is never re-encoded for nothing.
//!
//! Untrusted input: the text is a vault file. The scan does not recurse, looks at each byte a
//! bounded number of times ([`ref_steps`]), and the text grows to at most three times its
//! length plus [`ref_growth`] bytes per rewritten ref: a raw `(` or space in a marker's `url`
//! is written `%28` or `%20`, and the new folder's depth sets the `../` a ref gains. A
//! marker's JSON goes through `serde_json`, whose recursion limit refuses a deep payload.

use std::cell::Cell;

use serde_json::Value;

use super::file::{
    escape_comment_terminator, is_file_block_line, json_string, parse_file_block_marker,
};
use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};

/// `RewriteNoteRefsOptions`.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoteRefsOptions<'a> {
    /// The note whose mobile vault-root refs are `attachments/<id>/...`.
    pub source_note_id: Option<&'a str>,
    /// Keep those refs vault-root relative when the note itself moves.
    pub preserve_root_relative_attachments: bool,
}

/// `rewriteNoteRefsForMove`: `body`, a note file with its frontmatter, with every
/// vault-internal relative ref re-pointed from `old_note_path` to `new_note_path` (both clean
/// vault-relative paths: no `..` segment, no leading `/`), or `None` when nothing changed, so
/// nothing is written.
pub fn rewrite_note_refs_for_move(
    body: &str,
    old_note_path: &str,
    new_note_path: &str,
    options: NoteRefsOptions<'_>,
) -> Option<String> {
    let old_dir = dir_of(old_note_path);
    if old_dir == dir_of(new_note_path) || body.is_empty() {
        return None;
    }
    let refs = Refs {
        old_dir: &old_dir,
        new_note_path,
        options,
    };
    let mut changed = false;
    let lines: Vec<String> = body
        .split('\n')
        .map(|line| refs.line(line, &mut changed))
        .collect();
    changed.then(|| lines.join("\n"))
}

/// The most bytes one rewritten ref adds: a `../` per folder of the new path, and the old
/// folder (each byte percent-encoded at worst) with its `/`.
#[doc(hidden)]
pub fn ref_growth(old_note_path: &str, new_note_path: &str) -> usize {
    3 * new_note_path.split(['/', '\\']).count() + 3 * (dir_of(old_note_path).len() + 1)
}

thread_local! {
    static REF_STEPS: Cell<usize> = const { Cell::new(0) };
}

/// Bytes the image-ref scan has looked at on this thread, for the complexity tests.
#[doc(hidden)]
pub fn ref_steps() -> usize {
    REF_STEPS.with(Cell::get)
}

fn step(n: usize) {
    REF_STEPS.with(|steps| steps.set(steps.get() + n));
}

struct Refs<'a> {
    old_dir: &'a str,
    new_note_path: &'a str,
    options: NoteRefsOptions<'a>,
}

impl Refs<'_> {
    fn line(&self, line: &str, changed: &mut bool) -> String {
        let trimmed = js_trim(line);
        if is_file_block_line(trimmed) {
            return self.marker(line, trimmed, changed);
        }
        self.image_refs(line, changed)
    }

    /// The `url` member alone is replaced, so every other member keeps its bytes.
    fn marker(&self, line: &str, trimmed: &str, changed: &mut bool) -> String {
        let Some(props) = parse_file_block_marker(trimmed) else {
            return line.to_owned();
        };
        let Some(next) = props
            .get("url")
            .and_then(Value::as_str)
            .and_then(|url| self.rewrite_ref(url))
        else {
            return line.to_owned();
        };
        *changed = true;
        let Some((start, end)) = marker_url_span(line) else {
            return line.to_owned();
        };
        let url = escape_comment_terminator(&format!("\"url\":{}", json_string(&next)));
        format!("{}{url}{}", &line[..start], &line[end..])
    }

    /// `line.replace(/(!\[[^\]]*\]\()([^()\s]*)(\))/g, ...)`, as a linear scan with the same
    /// leftmost, non-overlapping matches. Every start between a failed start and its `]` shares
    /// that `]`, and fails the same way, so the scan resumes past it: each `]` is looked for
    /// once.
    fn image_refs(&self, line: &str, changed: &mut bool) -> String {
        let mut out = String::new();
        let mut copied = 0;
        let mut pos = 0;
        while let Some(found) = line[pos..].find("![") {
            step(found + 2);
            let open = pos + found;
            let alt = open + 2;
            let Some(at) = line[alt..].find(']') else {
                break;
            };
            step(at + 1);
            let bracket = alt + at;
            if line.as_bytes().get(bracket + 1) != Some(&b'(') {
                pos = bracket + 1;
                continue;
            }
            let ref_start = bracket + 2;
            let ref_len = line[ref_start..]
                .find(|c: char| c == '(' || c == ')' || is_js_whitespace(c))
                .unwrap_or(line.len() - ref_start);
            step(ref_len + 1);
            let ref_end = ref_start + ref_len;
            if line.as_bytes().get(ref_end) != Some(&b')') {
                pos = ref_start;
                continue;
            }
            if let Some(next) = self.rewrite_ref(&line[ref_start..ref_end]) {
                *changed = true;
                out.push_str(&line[copied..ref_start]);
                out.push_str(&next);
                copied = ref_end;
            }
            pos = ref_end + 1;
        }
        out.push_str(&line[copied..]);
        out
    }

    /// `rewriteRef`: the ref re-pointed and encoded, or `None` when it is not ours or its path
    /// does not change.
    fn rewrite_ref(&self, reference: &str) -> Option<String> {
        if reference.is_empty() || has_scheme(reference) || reference.starts_with(['/', '\\']) {
            return None;
        }
        let decoded = decode_uri_component(reference).unwrap_or_else(|| reference.to_owned());
        let root_relative = self.is_own_root_attachment(&decoded);
        let target = resolve_against(if root_relative { "" } else { self.old_dir }, &decoded)?;
        if root_relative && self.options.preserve_root_relative_attachments {
            return None;
        }
        let next = relative(&dir_of(self.new_note_path), &target);
        if next.is_empty() || next == decoded {
            return None;
        }
        Some(encode_attachment_url(&next))
    }

    /// `isRootRelativeAttachmentRef`.
    fn is_own_root_attachment(&self, decoded: &str) -> bool {
        let Some(note_id) = self.options.source_note_id.filter(|id| !id.is_empty()) else {
            return false;
        };
        let normalized = decoded.replace('\\', "/");
        let Some(rest) = normalized
            .strip_prefix("attachments/")
            .and_then(|rest| rest.strip_prefix(note_id))
        else {
            return false;
        };
        rest.is_empty() || rest.starts_with('/')
    }
}

/// `/"url":"(?:[^"\\]|\\.)*"/`: the byte span of the first `url` member of a marker line that
/// parsed as JSON. There, the first `"url":"` opens the `url` key's string value: a quote
/// inside a string is escaped, and a string's closing quote is never followed by `url`.
fn marker_url_span(line: &str) -> Option<(usize, usize)> {
    const KEY: &str = "\"url\":\"";
    let start = line.find(KEY)?;
    let mut chars = line[start + KEY.len()..].char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            '"' => return Some((start, start + KEY.len() + at + 1)),
            '\\' => match chars.next() {
                Some((_, '\n' | '\r' | '\u{2028}' | '\u{2029}')) | None => return None,
                Some(_) => {}
            },
            _ => {}
        }
    }
    None
}

/// `path.posix.dirname` of the `/`-separated path, `""` for the vault root.
fn dir_of(note_path: &str) -> String {
    debug_assert!(is_clean(note_path), "not a clean vault path: {note_path}");
    let path = note_path.replace('\\', "/");
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(at) => trimmed[..at].trim_end_matches('/').to_owned(),
        None => String::new(),
    }
}

/// `^[a-zA-Z][a-zA-Z\d+\-.]*:`.
fn has_scheme(reference: &str) -> bool {
    let Some((scheme, _)) = reference.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// `decodeURIComponent`, or `None` where it throws: a `%` without two hex digits, or bytes
/// that are not UTF-8.
fn decode_uri_component(text: &str) -> Option<String> {
    if !text.contains('%') {
        return Some(text.to_owned());
    }
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

/// `resolveAgainstNoteDir`: `path.posix.normalize(path.posix.join(dir, reference))` as a vault
/// path, or `None` when it climbs above the root, is absolute or names the root itself.
fn resolve_against(dir: &str, reference: &str) -> Option<String> {
    let reference = reference.replace('\\', "/");
    let joined = if dir.is_empty() {
        reference
    } else {
        format!("{dir}/{reference}")
    };
    if joined.starts_with('/') {
        return None;
    }
    let mut segments: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            // A `..` past the root climbs out of the vault.
            ".." => {
                segments.pop()?;
            }
            segment => segments.push(segment),
        }
    }
    // `path.posix.normalize` keeps a trailing `/`: `x/../` is `./`, the vault root, not `.`.
    if segments.is_empty() && !joined.ends_with('/') {
        return None;
    }
    Some(segments.join("/"))
}

/// A vault path with no `..` segment and no leading `/`, as the paths of the vault's rows are.
fn is_clean(path: &str) -> bool {
    !path.starts_with(['/', '\\']) && !path.split(['/', '\\']).any(|segment| segment == "..")
}

/// `path.posix.relative(from, to)` of two vault paths that do not climb above the root.
fn relative(from: &str, to: &str) -> String {
    debug_assert!(
        is_clean(from) && is_clean(to),
        "not clean vault paths: {from}, {to}"
    );
    let from: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let to: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    std::iter::repeat_n("..", from.len() - common)
        .chain(to[common..].iter().copied())
        .collect::<Vec<_>>()
        .join("/")
}

/// `encodeAttachmentUrl`: a space or a parenthesis would end the markdown link.
fn encode_attachment_url(url: &str) -> String {
    url.replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
}
