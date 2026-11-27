//! The URL helpers of `@metascraper/helpers` 5.49.21: `isUrl` (`url-regex-safe` 4.0.0, exact,
//! with parentheses), `normalizeUrl` (`normalize-url` 6.1.0 with metascraper's options),
//! `is-uri` 1.2.12, the media extension tables and the `url` and `image` mappers.

use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};
use url::Url;

/// `url-regex-safe({ exact: true, parens: true })` translated to the `regex` crate. Written by
/// `scripts/generate-metadata-vectors.mjs` from the installed package and its `tlds` list; never
/// edit it by hand.
const URL_REGEX: &str = include_str!("url_regex.txt");

static IS_URL: LazyLock<Regex> = LazyLock::new(|| {
    RegexBuilder::new(URL_REGEX.trim_end())
        .size_limit(64 << 20)
        .build()
        .expect("generated pattern")
});

/// `isUrl(value)`.
pub fn is_url(value: &str) -> bool {
    IS_URL.is_match(value)
}

/// `url(value, { url })`: the value resolved against the page URL and normalized when that gives
/// a URL `isUrl` accepts, else the value itself when it is a URI.
pub fn url(value: &str, base: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    if let Some(absolute) = normalize_url(base, value)
        && is_url(&absolute)
    {
        return Some(absolute);
    }
    let mut sanitized = value.to_owned();
    if value.starts_with("data:") {
        if !is_data_uri(value) {
            return None;
        }
        // `value.split(',')` destructured into two: data after a second comma is dropped.
        let mut parts = value.split(',');
        let header = parts.next().unwrap_or_default();
        let data: String = parts
            .next()
            .unwrap_or_default()
            .chars()
            .filter(|c| !crate::web::extract::utils::js::is_js_whitespace(*c))
            .collect();
        sanitized = format!("{header},{data}");
    }
    is_uri(&sanitized).then_some(sanitized)
}

/// `image(value, { url })` (and `logo`): a URL that is not an audio or video file, and a data URI
/// only when its payload is not empty.
pub fn image(value: &str, base: &str) -> Option<String> {
    let found = url(value, base)?;
    if is_url(&found) && matches!(media_type(&found), Some(Media::Audio | Media::Video)) {
        return None;
    }
    if is_data_uri(&found) && !data_uri_has_bytes(&found) {
        return None;
    }
    Some(found)
}

/// `normalizeUrl(baseUrl, relativePath)`: `new URL(relativePath, baseUrl)` through normalize-url,
/// `None` where either throws.
fn normalize_url(base: &str, relative: &str) -> Option<String> {
    let absolute = Url::parse(base).ok()?.join(relative).ok()?;
    sanitize_url(absolute.as_str())
}

/// normalize-url 6.1.0 with `stripWWW`, `sortQueryParameters`, `removeSingleSlash` and
/// `removeTrailingSlash` off. A data URL normalizes to a data URL, which `isUrl` rejects, so it
/// ends as `None` here; `view-source:` throws there.
fn sanitize_url(input: &str) -> Option<String> {
    let mut text = input
        .trim_matches(crate::web::extract::utils::js::is_js_whitespace)
        .to_owned();
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("data:") || lower.starts_with("view-source:") {
        return None;
    }
    // `replace(/^(?!(?:\w+:)?\/\/)|^\/\//, 'http:')`
    if let Some(rest) = text.strip_prefix("//") {
        text = format!("http://{rest}");
    } else if !starts_with_scheme_slashes(&text) {
        text = format!("http:{text}");
    }
    let before = text.clone();
    let mut url = Url::parse(&text).ok()?;
    let _ = url.set_username("");
    let _ = url.set_password(None);
    if let Some(fragment) = url.fragment().filter(|f| !f.is_empty()) {
        let hash = format!("#{fragment}");
        let stripped = strip_text_fragment(&hash);
        let kept = stripped.strip_prefix('#').unwrap_or(&stripped).to_owned();
        url.set_fragment(if stripped.is_empty() {
            None
        } else {
            Some(&kept)
        });
    } else {
        url.set_fragment(None);
    }
    if !url.cannot_be_a_base() && !url.path().is_empty() {
        let collapsed = collapse_slashes(url.path());
        let decoded = decode_uri(&collapsed).unwrap_or(collapsed);
        url.set_path(&decoded);
    }
    if let Some(host) = url.host_str().map(str::to_owned)
        && let Some(trimmed) = host.strip_suffix('.')
    {
        let _ = url.set_host(Some(trimmed));
    }
    remove_utm_parameters(&mut url);
    let mut out = url.as_str().to_owned();
    let hash_empty = url.fragment().is_none_or(str::is_empty);
    if url.path() == "/" && !before.ends_with('/') && hash_empty && out.ends_with('/') {
        out.pop();
    }
    Some(out)
}

fn starts_with_scheme_slashes(text: &str) -> bool {
    let word = text
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
        .count();
    word > 0 && text[word..].starts_with("://")
}

/// `hash.replace(/#?:~:text.*?$/i, '')`.
fn strip_text_fragment(hash: &str) -> String {
    let lower = hash.to_ascii_lowercase();
    match lower.find(":~:text") {
        Some(at) => {
            let start = if at > 0 && hash.as_bytes()[at - 1] == b'#' {
                at - 1
            } else {
                at
            };
            hash[..start].to_owned()
        }
        None => hash.to_owned(),
    }
}

/// `pathname.replace(/(?<!\b(?:[a-z][a-z\d+\-.]{1,50}:))\/{2,}/g, '/')`: runs of slashes become
/// one, except right after something that looks like a scheme (`/https://` in a path).
fn collapse_slashes(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = String::with_capacity(path.len());
    let mut i = 0;
    while i < bytes.len() {
        let run = bytes[i..].iter().take_while(|&&b| b == b'/').count();
        if run >= 2 && !after_scheme(&bytes[..i]) {
            out.push('/');
            i += run;
        } else if run >= 1 {
            out.push('/');
            i += 1;
        } else {
            let next = path[i..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&path[i..i + next]);
            i += next;
        }
    }
    out
}

/// The lookbehind `\b(?:[a-z][a-z\d+\-.]{1,50}:)` ending at the end of `before`.
fn after_scheme(before: &[u8]) -> bool {
    let Some((&b':', head)) = before.split_last() else {
        return false;
    };
    let tail =
        |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.');
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let run = head.iter().rev().take_while(|&&b| tail(b)).count().min(51);
    // A start `s` of the scheme: a lowercase letter, 1 to 50 tail characters after it, and a word
    // boundary before it.
    (2..=run).any(|len| {
        let start = head.len() - len;
        head[start].is_ascii_lowercase() && (start == 0 || !is_word(head[start - 1]))
    })
}

/// `decodeURI`: `None` where it throws a URIError (a malformed escape or invalid UTF-8).
fn decode_uri(value: &str) -> Option<String> {
    const RESERVED: &[u8] = b";/?:@&=+$,#";
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let first = hex_byte(bytes, i)?;
        if first < 0x80 {
            if RESERVED.contains(&first) {
                out.extend_from_slice(&bytes[i..i + 3]);
            } else {
                out.push(first);
            }
            i += 3;
            continue;
        }
        let len = match first {
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            _ => return None,
        };
        let mut seq = vec![first];
        for k in 1..len {
            seq.push(hex_byte(bytes, i + 3 * k)?);
        }
        std::str::from_utf8(&seq).ok()?;
        out.extend_from_slice(&seq);
        i += 3 * len;
    }
    String::from_utf8(out).ok()
}

fn hex_byte(bytes: &[u8], at: usize) -> Option<u8> {
    if bytes.get(at) != Some(&b'%') {
        return None;
    }
    let digits = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
    u8::from_str_radix(digits, 16).ok()
}

/// `searchParams.delete` for every key matching `/^utm_\w+/i`; any deletion re-serializes the
/// query as `application/x-www-form-urlencoded`, and an empty one is dropped.
fn remove_utm_parameters(url: &mut Url) {
    let is_utm = |key: &str| {
        let b = key.as_bytes();
        b.len() > 4
            && b[..4].eq_ignore_ascii_case(b"utm_")
            && (b[4].is_ascii_alphanumeric() || b[4] == b'_')
    };
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    if !pairs.iter().any(|(key, _)| is_utm(key)) {
        return;
    }
    let kept: Vec<_> = pairs.into_iter().filter(|(key, _)| !is_utm(key)).collect();
    if kept.is_empty() {
        url.set_query(None);
        return;
    }
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(kept)
        .finish();
    url.set_query(Some(&query));
}

/// `is-uri` 1.2.12. Punycode turns every label with a non-ASCII character into ASCII first, so
/// only ASCII characters can be illegal.
pub fn is_uri(input: &str) -> bool {
    const LEGAL: &[u8] = b":/?#[]@!$&'()*+,;=.-_~%";
    if input.is_empty() {
        return false;
    }
    if input
        .bytes()
        .any(|b| b.is_ascii() && !b.is_ascii_alphanumeric() && !LEGAL.contains(&b))
    {
        return false;
    }
    let chars: Vec<char> = input.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c != '%' {
            continue;
        }
        match chars.get(i + 1) {
            Some(d) if !d.is_ascii_hexdigit() => return false,
            Some(_) if chars.get(i + 2).is_none_or(|d| !d.is_ascii_hexdigit()) => return false,
            _ => {}
        }
    }
    // parse-uri 2.0.4 (loose): the scheme is `[^:/?#.]+` before the first `:`.
    let Some(colon) = input.find(':') else {
        return false;
    };
    let scheme = &input[..colon];
    if scheme.is_empty() || scheme.contains(['/', '?', '#', '.']) {
        return false;
    }
    let mut scheme_chars = scheme.chars();
    let valid_scheme = scheme_chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme_chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !valid_scheme {
        return false;
    }
    let rest = &input[colon + 1..];
    let before_query = &rest[..rest.find(['?', '#']).unwrap_or(rest.len())];
    match before_query.strip_prefix("//") {
        Some(after) => {
            let authority_end = after.find('/').unwrap_or(after.len());
            // With an empty authority the path must not start with `//`.
            authority_end > 0 || !after.starts_with("//")
        }
        None => true,
    }
}

/// `dataUri.test`: `/^(data:)([\w/+-]*)(;charset=[\w-]+|;base64){0,1},/i` at the start.
pub fn is_data_uri(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("data:") else {
        return false;
    };
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mime = rest
        .bytes()
        .take_while(|&b| word(b) || matches!(b, b'/' | b'+' | b'-'))
        .count();
    let rest = &rest[mime..];
    if rest.starts_with(',') {
        return true;
    }
    if let Some(after) = rest.strip_prefix(";base64") {
        return after.starts_with(',');
    }
    if let Some(after) = rest.strip_prefix(";charset=") {
        let label = after.bytes().take_while(|&b| word(b) || b == b'-').count();
        return label > 0 && after[label..].starts_with(',');
    }
    false
}

/// `dataUriToBuffer(normalize(value)).length > 0`.
fn data_uri_has_bytes(value: &str) -> bool {
    let value = value.replace("\r\n", "").replace('\n', "");
    let Some(comma) = value.find(',') else {
        return false;
    };
    let base64 = value[5..comma].split(';').any(|part| part == "base64");
    let data = &value[comma + 1..];
    if !base64 {
        return !data.is_empty();
    }
    let decoded = percent_encoding::percent_decode_str(data).collect::<Vec<u8>>();
    decoded
        .iter()
        .take_while(|&&b| b != b'=')
        .filter(|&&b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'-' | b'_'))
        .count()
        >= 2
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Media {
    Image,
    Audio,
    Video,
    Pdf,
}

const IMAGE: &[&str] = &[
    "ase", "art", "bmp", "blp", "cd5", "cit", "cpt", "cr2", "cut", "dds", "dib", "djvu", "egt",
    "exif", "gif", "gpl", "grf", "icns", "ico", "iff", "jng", "jpeg", "jpg", "jfif", "jp2", "jps",
    "lbm", "max", "miff", "mng", "msp", "nitf", "ota", "pbm", "pc1", "pc2", "pc3", "pcf", "pcx",
    "pdn", "pgm", "pict", "pct", "pnm", "pns", "ppm", "psb", "psd", "pdd", "psp", "px", "pxm",
    "pxr", "qfx", "raw", "rle", "sct", "sgi", "rgb", "int", "bw", "tga", "tiff", "tif", "vtf",
    "xbm", "xcf", "xpm", "3dv", "amf", "ai", "awg", "cgm", "cdr", "cmx", "dxf", "e2d", "eps", "fs",
    "gbr", "odg", "svg", "stl", "vrml", "x3d", "sxd", "v2d", "vnd", "wmf", "emf", "xar", "png",
    "webp", "jxr", "hdp", "wdp", "cur", "ecw", "liff", "nrrd", "pam", "pgf", "rgba", "inta", "sid",
    "ras", "sun", "avif",
];
const AUDIO: &[&str] = &[
    "wav", "bwf", "raw", "aiff", "flac", "m4a", "pac", "tta", "wv", "ast", "aac", "mp2", "mp3",
    "amr", "s3m", "3gp", "act", "au", "dct", "dss", "gsm", "m4p", "mmf", "mpc", "ogg", "oga",
    "opus", "ra", "sln", "vox", "mpga",
];
const VIDEO: &[&str] = &[
    "3g2", "3gp", "aaf", "asf", "avchd", "avi", "drc", "flv", "m2v", "m3u8", "m4p", "m4v", "mkv",
    "mng", "mov", "mp2", "mp4", "mpe", "mpeg", "mpg", "mpv", "mxf", "nsv", "ogg", "ogv", "qt",
    "rm", "rmvb", "roq", "svi", "vob", "webm", "wmv", "yuv",
];

/// `EXTENSIONS[extension(url)]`: the image, audio and video tables merged in that order, so a
/// later table wins (`ogg` is video, `raw` audio).
fn media_type(value: &str) -> Option<Media> {
    let ext = extension(value);
    if VIDEO.contains(&ext.as_str()) {
        Some(Media::Video)
    } else if AUDIO.contains(&ext.as_str()) {
        Some(Media::Audio)
    } else if IMAGE.contains(&ext.as_str()) {
        Some(Media::Image)
    } else if ext == "pdf" {
        Some(Media::Pdf)
    } else {
        None
    }
}

/// `extension(url)`: `file-extension` of the URL without its query and hash.
fn extension(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return String::new();
    };
    url.set_query(None);
    url.set_fragment(None);
    let text = url.as_str();
    let start = text.rfind(['.', '/', '\\']).map_or(0, |at| at + 1);
    text[start..].to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values: the helpers in node on the same input.
    #[test]
    fn normalize_url_follows_normalize_url_6() {
        let base = "https://example.com/a/b";
        assert_eq!(
            url("/img.png?utm_source=x&b=1#:~:text=hi", base).as_deref(),
            Some("https://example.com/img.png?b=1")
        );
        assert_eq!(
            url("//cdn.example.com//x//y.jpg", base).as_deref(),
            Some("https://cdn.example.com/x/y.jpg")
        );
        assert_eq!(
            url("https://example.com/r/https://x.com", base).as_deref(),
            Some("https://example.com/r/https://x.com")
        );
        assert_eq!(
            url("https://example.com?a=1", base).as_deref(),
            Some("https://example.com/?a=1")
        );
    }

    #[test]
    fn media_and_data_uris() {
        assert_eq!(
            image("https://example.com/a.mp4", "https://example.com/"),
            None
        );
        assert_eq!(
            image("data:image/png;base64,", "https://example.com/"),
            None
        );
        assert_eq!(
            image("data:image/png;base64,iVBO RQ==", "https://example.com/").as_deref(),
            Some("data:image/png;base64,iVBORQ==")
        );
    }
}
