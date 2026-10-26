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

/// The `file:` quirks the `url` crate does not share with whatwg-url 15.1: a
/// drive letter written `C|` becomes `C:` under any host, a named host with a
/// drive letter is kept, and `file:////` keeps its empty first path segment.
fn reflect_file(rest: &str) -> Option<String> {
    let rest = rest.replace('\\', "/");
    if rest.starts_with("////") {
        let inner = Url::parse(&format!("file:{}", &rest[1..])).ok()?;
        return Some(encode_caret_in_path(&inner.as_str().replacen(
            "file:///",
            "file:////",
            1,
        )));
    }
    let drive = |path: &str| {
        let mut chars = path.chars();
        chars.next() == Some('/')
            && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.next().is_some_and(|c| c == ':' || c == '|')
            && chars.next().is_none_or(|c| matches!(c, '/' | '?' | '#'))
    };
    if let Some(after) = rest.strip_prefix("//") {
        let end = after.find(['/', '?', '#']).unwrap_or(after.len());
        let (host, tail) = after.split_at(end);
        let named = !host.is_empty() && !host.eq_ignore_ascii_case("localhost");
        if named && !host.contains(['[', ':', '|', '%']) && host.is_ascii() && drive(tail) {
            let fixed = tail.replacen('|', ":", 1);
            let inner = Url::parse(&format!("file://{fixed}")).ok()?;
            let path = inner.as_str().strip_prefix("file://")?;
            return Some(encode_caret_in_path(&format!(
                "file://{}{path}",
                host.to_ascii_lowercase()
            )));
        }
    }
    None
}

pub fn reflect_url(value: &str) -> String {
    let trimmed = value.trim_matches(|c: char| c <= ' ');
    if let Some((scheme, rest)) = split_scheme(trimmed) {
        if authority_fails(&scheme, rest) {
            return value.to_owned();
        }
        if scheme == "file"
            && let Some(url) = reflect_file(rest)
        {
            return url;
        }
    }
    let base = Url::parse("about:blank").expect("static URL");
    let mut url = match base.join(value) {
        Ok(url) => url.to_string(),
        Err(_) => return value.to_owned(),
    };
    // A drive letter written `C|` is `C:` in the path of a file URL.
    if url.starts_with("file:///") {
        let path = &url["file://".len()..];
        let mut chars = path.chars();
        if chars.next() == Some('/')
            && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.next() == Some('|')
            && chars.next().is_none_or(|c| matches!(c, '/' | '?' | '#'))
        {
            url = format!("file:///{}:{}", &path[1..2], &path[3..]);
        }
    }
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
