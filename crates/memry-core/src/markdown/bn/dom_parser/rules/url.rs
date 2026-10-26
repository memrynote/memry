//! `element.src` as jsdom answers it: the `src` attribute resolved against the
//! document's base URL, which is `about:blank`. Nothing relative resolves
//! against that base (it cannot be a base), so a relative value comes back as
//! written, and an absolute URL comes back in the WHATWG URL serialisation,
//! which is what the `url` crate implements (jsdom uses whatwg-url).

use url::Url;

const SPECIAL: [&str; 6] = ["http", "https", "ftp", "ws", "wss", "file"];

/// The scheme of `input` (lower-cased) and what follows its colon.
fn split_scheme(input: &str) -> Option<(String, &str)> {
    let at = input.find(':')?;
    let scheme = &input[..at];
    let valid = scheme
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    valid.then(|| (scheme.to_ascii_lowercase(), &input[at + 1..]))
}

/// whatwg-url 15.1 (jsdom 27.4) fails to parse a non-special URL whose
/// authority has credentials and no host, or a port with a non-digit, which
/// `src` then reports as written. The `url` crate recovers from both.
fn authority_fails(scheme: &str, rest: &str) -> bool {
    if SPECIAL.contains(&scheme) {
        return false;
    }
    let Some(after) = rest.strip_prefix("//") else {
        return false;
    };
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let authority = &after[..end];
    let (credentials, host_port) = match authority.rfind('@') {
        Some(at) => (true, &authority[at + 1..]),
        None => (false, authority),
    };
    // The host ends at the first colon outside an IPv6 literal.
    let colon = match host_port.strip_prefix('[') {
        Some(inner) => inner
            .find(']')
            .and_then(|at| host_port[at + 2..].starts_with(':').then_some(at + 2)),
        None => host_port.find(':'),
    };
    let (host, port) = match colon {
        Some(at) => (&host_port[..at], Some(&host_port[at + 1..])),
        None => (host_port, None),
    };
    let bad_port = port.is_some_and(|p| !p.bytes().all(|b| b.is_ascii_digit()));
    bad_port || (host.is_empty() && (credentials || port.is_some()))
}

/// `^` is in whatwg-url 15.1's path percent-encode set and not in the `url`
/// crate's. Only a hierarchical path is encoded; an opaque one is not.
fn encode_caret_in_path(url: &str) -> String {
    let Some(colon) = url.find(':') else {
        return url.to_owned();
    };
    let rest = &url[colon + 1..];
    let path_start = if let Some(after) = rest.strip_prefix("//") {
        colon + 3 + after.find(['/', '?', '#']).unwrap_or(after.len())
    } else if rest.starts_with('/') {
        colon + 1
    } else {
        return url.to_owned();
    };
    let path_end = url[path_start..]
        .find(['?', '#'])
        .map_or(url.len(), |at| path_start + at);
    format!(
        "{}{}{}",
        &url[..path_start],
        url[path_start..path_end].replace('^', "%5E"),
        &url[path_end..]
    )
}

fn is_drive(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && matches!(bytes[1], b':' | b'|')
}

/// `file:` URLs, by the WHATWG file host and path states as whatwg-url 15.1
/// runs them. The `url` crate differs in three ways this reproduces: it
/// collapses empty path segments (`file:////x`, `file://h//x`), it drops the
/// drive letter at `..` or `.` segments, and it keeps a `C|` drive spelled with
/// a pipe under a named host. The path is walked here segment by segment and
/// only the percent-encoding is left to the crate (`http` URLs share the
/// special-scheme path and query sets). `None` where the parse fails.
fn reflect_file(rest: &str) -> Option<String> {
    // A backslash is a slash up to the query or fragment and a plain
    // character in them (`file:///a?\` keeps its `?\`).
    let rest: String = rest
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let head_end = rest.find(['?', '#']).unwrap_or(rest.len());
    let rest = rest[..head_end].replace('\\', "/") + &rest[head_end..];
    let (host, tail) = match rest.strip_prefix("//") {
        Some(after) => {
            let end = after.find(['/', '?', '#']).unwrap_or(after.len());
            let (host, tail) = after.split_at(end);
            if is_drive(host) {
                // `file://C|/x`: the drive is a path segment, not a host.
                (String::new(), format!("/{host}{tail}"))
            } else if host.is_empty() || host.eq_ignore_ascii_case("localhost") {
                (String::new(), tail.to_owned())
            } else {
                // A port, after an IPv6 literal or not, fails a `file:` host.
                let port = match host.strip_prefix('[') {
                    Some(inner) => inner
                        .split_once(']')
                        .is_none_or(|(_, after)| !after.is_empty()),
                    None => host.contains(':'),
                };
                // `@` would read as credentials to the `http` parse below.
                if port || host.contains('@') {
                    return None;
                }
                let parsed = Url::parse(&format!("http://{host}/")).ok()?;
                (parsed.host_str()?.to_owned(), tail.to_owned())
            }
        }
        None => (String::new(), rest.clone()),
    };
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let (path, after_path) = tail.split_at(path_end);
    let mut segments: Vec<String> = Vec::new();
    let raw = path.strip_prefix('/').unwrap_or(path);
    let parts: Vec<&str> = if path.is_empty() {
        Vec::new()
    } else {
        raw.split('/').collect()
    };
    for (index, part) in parts.iter().enumerate() {
        let last = index + 1 == parts.len();
        let lower = part.to_ascii_lowercase();
        let dot_dot = matches!(lower.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e");
        let dot = matches!(lower.as_str(), "." | "%2e");
        if dot_dot {
            if !(segments.len() == 1 && is_drive(&segments[0])) {
                segments.pop();
            }
            if last {
                segments.push(String::new());
            }
        } else if dot {
            if last {
                segments.push(String::new());
            }
        } else {
            let mut segment = (*part).to_owned();
            if segments.is_empty() && is_drive(&segment) {
                segment = format!("{}:", &segment[..1]);
            }
            segments.push(segment);
        }
    }
    let joined: String = segments.iter().map(|s| format!("/{s}")).collect();
    let joined = if joined.is_empty() {
        "/".to_owned()
    } else {
        joined
    };
    let encoded = Url::parse(&format!("http://h{joined}{after_path}")).ok()?;
    let path_and_rest = encoded.as_str().strip_prefix("http://h")?;
    Some(encode_caret_in_path(&format!(
        "file://{host}{path_and_rest}"
    )))
}

/// whatwg-url 15.1 encodes a space that ends an opaque path before `?` or `#`
/// as `%20`; the `url` crate (2.5.8, the newer spec) trims it away.
fn encode_opaque_trailing_space(scheme: &str, rest: &str) -> Option<String> {
    if SPECIAL.contains(&scheme) || rest.starts_with('/') {
        return None;
    }
    let end = rest.find(['?', '#'])?;
    let path = &rest[..end];
    // Only the one space next to the delimiter: the others stay literal.
    let trimmed = path.strip_suffix(' ')?;
    Some(format!("{scheme}:{trimmed}%20{}", &rest[end..]))
}

/// Dot segments of a hierarchical URL, resolved by the WHATWG path state
/// (`..` pops whatever segment is last: only `file:` protects a drive letter).
/// The `url` crate protects `C|`/`C:` segments under every scheme, so this runs
/// first and leaves it nothing to pop. `rest` is what follows `scheme:`.
fn resolve_dot_segments(scheme: &str, rest: &str) -> Option<String> {
    let special = SPECIAL.contains(&scheme);
    // A special scheme without a base ignores every slash and backslash after
    // the colon: the authority starts at the first other character.
    let squeezed;
    let rest = if special {
        squeezed = format!("//{}", rest.trim_start_matches(['/', '\\']));
        squeezed.as_str()
    } else {
        rest
    };
    let (authority, tail) = match rest.strip_prefix("//") {
        Some(after) => {
            let end = after
                .find(|c| matches!(c, '/' | '?' | '#') || (special && c == '\\'))
                .unwrap_or(after.len());
            (Some(&after[..end]), &after[end..])
        }
        None if rest.starts_with('/') || (special && rest.starts_with('\\')) => (None, rest),
        None => return None,
    };
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let (path, after_path) = tail.split_at(path_end);
    if path.is_empty() {
        return None;
    }
    let path = if special {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    let parts: Vec<&str> = path.strip_prefix('/')?.split('/').collect();
    let mut segments: Vec<&str> = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let last = index + 1 == parts.len();
        let lower = part.to_ascii_lowercase();
        if matches!(lower.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e") {
            segments.pop();
            if last {
                segments.push("");
            }
        } else if matches!(lower.as_str(), "." | "%2e") {
            if last {
                segments.push("");
            }
        } else {
            segments.push(part);
        }
    }
    let joined: String = segments.iter().map(|s| format!("/{s}")).collect();
    // Without an authority, a path that opens with an empty segment would read
    // as one: the serializer guards it with `/.` (the `url` crate adds it back
    // after its own dot-segment pass).
    let guard = if authority.is_none() && joined.starts_with("//") {
        "/."
    } else {
        ""
    };
    let authority = authority.map_or(String::new(), |a| format!("//{a}"));
    Some(format!("{scheme}:{authority}{guard}{joined}{after_path}"))
}

pub fn reflect_url(value: &str) -> String {
    // The URL parser drops tabs and newlines everywhere before it looks at anything.
    let stripped: String = value
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let trimmed = stripped.trim_matches(|c: char| c <= ' ');
    if let Some((scheme, rest)) = split_scheme(trimmed) {
        if authority_fails(&scheme, rest) {
            return value.to_owned();
        }
        if let Some(encoded) = encode_opaque_trailing_space(&scheme, rest) {
            return reflect_url(&encoded);
        }
        if scheme == "file" {
            return reflect_file(rest).unwrap_or_else(|| value.to_owned());
        }
    }
    let resolved = split_scheme(trimmed)
        .filter(|(scheme, _)| scheme != "file")
        .and_then(|(scheme, rest)| resolve_dot_segments(&scheme, rest));
    let base = Url::parse("about:blank").expect("static URL");
    let url = match base.join(resolved.as_deref().unwrap_or(value)) {
        Ok(url) => url.to_string(),
        Err(_) => return value.to_owned(),
    };
    encode_caret_in_path(&url)
}

/// `element.src || undefined`.
pub fn src_property(raw: Option<&str>) -> Option<String> {
    let url = raw.map_or_else(String::new, reflect_url);
    (!url.is_empty()).then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_values_come_back_as_written() {
        assert_eq!(reflect_url("a.png"), "a.png");
        assert_eq!(reflect_url(" ./a b.png "), " ./a b.png ");
        assert_eq!(src_property(None), None);
        assert_eq!(src_property(Some("")), None);
    }

    #[test]
    fn absolute_values_are_serialised() {
        assert_eq!(reflect_url("HTTPS://Example.COM"), "https://example.com/");
        assert_eq!(
            reflect_url("http://a.com:80/x y?q=1 2#f"),
            "http://a.com/x%20y?q=1%202#f"
        );
        assert_eq!(
            reflect_url("data:image/png;base64,AAA="),
            "data:image/png;base64,AAA="
        );
        assert_eq!(reflect_url("#top"), "about:blank#top");
    }
}
