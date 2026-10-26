//! Redaction of text and log fields before anything leaves the device. A port of
//! `packages/contracts/src/redact.ts` and the `redactSensitive` family of
//! `telemetry-api.ts`, pinned byte for byte by `redact.json` and
//! `safe-dimension.json`.
//!
//! JS `\b`, `\w`, `\d` and `\s` are ASCII or a fixed whitespace set there, so the
//! patterns spell them out instead of using the Unicode forms of the `regex` crate.
//! The two lookaheads of the TypeScript are explicit checks in code.

mod fields;
mod patterns;

pub use fields::{RedactedLine, redact_log_line};

use std::borrow::Cow;

use sha2::{Digest, Sha256};

use patterns::{
    API_KEY, AUTH_ASSIGN, BEARER, CONTENT_FILE, EMAIL, HOME_UNIX, HOME_WIN, IPV4, IPV6, JWT,
    LONG_SECRET, QUERY_SECRET, URL_QUERY, UUID,
};

/// The salted one-way hash: `sha256(salt ++ 0x00 ++ value)` as hex, first 10 characters.
pub fn salted_hash(salt: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update([0u8]);
    hasher.update(value.as_bytes());
    let mut hex = hex::encode(hasher.finalize());
    hex.truncate(10);
    hex
}

/// Redaction context. With a `hash`, placeholders correlate; without one they are
/// fixed masks (`<email>`, `<id>`, `[name].ext`).
#[derive(Default)]
pub struct RedactOptions<'a> {
    pub vault_root: Option<&'a str>,
    pub hash: Option<&'a dyn Fn(&str) -> String>,
}

impl RedactOptions<'_> {
    fn mask_email(&self, raw: &str) -> String {
        match self.hash {
            Some(hash) => format!("[email:{}]", take(&hash(raw), 8)),
            None => "<email>".to_owned(),
        }
    }

    fn mask_id(&self, raw: &str) -> String {
        match self.hash {
            Some(hash) => take(&hash(raw), 10),
            None => "<id>".to_owned(),
        }
    }
}

fn take(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

pub fn redact_text(text: &str, opts: &RedactOptions) -> String {
    if text.is_empty() {
        return String::new();
    }
    // Secrets first (dropped), so nothing below hashes one.
    let mut out = JWT.replace_all(text, "<redacted>").into_owned();
    out = BEARER.replace_all(&out, "<redacted>").into_owned();
    out = AUTH_ASSIGN.replace_all(&out, "<redacted>").into_owned();
    out = API_KEY.replace_all(&out, "<redacted>").into_owned();
    out = QUERY_SECRET
        .replace_all(&out, "${1}<redacted>")
        .into_owned();
    out = URL_QUERY.replace_all(&out, "${1}").into_owned();
    if let Some(root) = opts.vault_root.filter(|root| !root.is_empty()) {
        out = out.replace(root, "<vault>");
    }
    out = replace_home_unix(&out);
    out = HOME_WIN.replace_all(&out, "~").into_owned();
    out = EMAIL
        .replace_all(&out, |caps: &regex::Captures| opts.mask_email(&caps[0]))
        .into_owned();
    out = CONTENT_FILE
        .replace_all(&out, |caps: &regex::Captures| match opts.hash {
            Some(hash) => format!("[name:{}].{}", take(&hash(&caps[1]), 8), &caps[2]),
            None => format!("[name].{}", &caps[2]),
        })
        .into_owned();
    out = UUID
        .replace_all(&out, |caps: &regex::Captures| opts.mask_id(&caps[0]))
        .into_owned();
    out = IPV4.replace_all(&out, "<ip>").into_owned();
    out = IPV6.replace_all(&out, "<ip>").into_owned();
    LONG_SECRET.replace_all(&out, "<redacted>").into_owned()
}

/// `/root` only counts when a slash or a non-word character follows, which is
/// the lookahead `(?=\/|\b)` of the TypeScript.
fn replace_home_unix(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for found in HOME_UNIX.find_iter(text) {
        out.push_str(&text[last..found.start()]);
        let root = found.as_str() == "/root";
        let boundary = text[found.end()..]
            .chars()
            .next()
            .is_none_or(|next| !(next.is_ascii_alphanumeric() || next == '_'));
        out.push_str(if root && !boundary {
            found.as_str()
        } else {
            "~"
        });
        last = found.end();
    }
    out.push_str(&text[last..]);
    out
}

pub fn redact_path_value(value: &str, opts: &RedactOptions) -> String {
    redact_text(value, opts)
}

/// `redactSensitive` of `telemetry-api.ts`: the coarse scrub used for error detail.
pub fn redact_sensitive(input: &str) -> String {
    use patterns::sensitive::{BEARER, EMAIL, HOME_UNIX, HOME_WIN, JWT, UUID};
    let out: Cow<str> = JWT.replace_all(input, "<jwt>");
    let out = BEARER.replace_all(&out, "Bearer <token>");
    let out = EMAIL.replace_all(&out, "<email>");
    let out = UUID.replace_all(&out, "<uuid>");
    let out = HOME_UNIX.replace_all(&out, "~");
    HOME_WIN.replace_all(&out, "~").into_owned()
}

/// UTF-16 length, the unit every JS limit counts in.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `String.prototype.slice(0, max)` over UTF-16 units. A cut through a surrogate
/// pair drops the whole character, since a Rust string cannot hold half of one.
pub(crate) fn cap(text: &str, max: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for ch in text.chars() {
        used += ch.len_utf16();
        if used > max {
            break;
        }
        out.push(ch);
    }
    out
}

fn is_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `SAFE_TOKEN` and `SAFE_DIMENSION_VALUE`: no `@`, `://`, `/` or `\`, no line
/// terminator, 1 to 64 UTF-16 units.
pub fn is_safe_token(value: &str) -> bool {
    let units = utf16_len(value);
    (1..=64).contains(&units)
        && !value.contains(['@', '/', '\\'])
        && !value.contains("://")
        && !value.chars().any(is_line_terminator)
}

/// `SafeDimensionValueSchema`: a safe token that also holds no UUID-shaped run.
pub fn is_safe_dimension_value(value: &str) -> bool {
    is_safe_token(value) && !patterns::UUID_SHAPED.is_match(value)
}
