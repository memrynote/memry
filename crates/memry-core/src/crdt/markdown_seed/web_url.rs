//! The parts of the WHATWG `new URL(...)` desktop reads from an image or
//! embed address: the scheme, the host and the path, for the plain
//! `scheme://host/path?query` shapes. An address outside those shapes, which
//! the WHATWG parser would rewrite (percent-encoding, IDNA, backslashes, a
//! special scheme without `//`), is [`Url::Unknown`], and the caller keeps
//! the source text rather than guess what desktop decided.

use crate::domain::journal_rules::js_trim;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Url {
    /// `new URL` throws: there is no scheme.
    Invalid,
    /// A shape this module does not decide.
    Unknown,
    Parsed(Parts),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Parts {
    /// Lowercased, without the `:`.
    pub scheme: String,
    /// `hostname`: lowercased for a special scheme, as written otherwise.
    pub host: String,
    /// `pathname`.
    pub path: String,
    /// `search` without the `?`; `None` when there is no `?`.
    pub query: Option<String>,
}

const SPECIAL: &[&str] = &["http", "https", "ws", "wss", "ftp", "file"];

pub(super) fn parse(raw: &str) -> Url {
    let url = js_trim(raw);
    let Some(colon) = url.find(':') else {
        return Url::Invalid;
    };
    let scheme = &url[..colon];
    let scheme_ok = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !scheme_ok {
        return Url::Invalid;
    }
    if url
        .chars()
        .any(|c| c.is_control() || !c.is_ascii() || c == '\\')
    {
        return Url::Unknown;
    }
    let scheme = scheme.to_ascii_lowercase();
    let special = SPECIAL.contains(&scheme.as_str());
    let rest = &url[colon + 1..];
    let (before_fragment, _) = rest.split_once('#').unwrap_or((rest, ""));
    let (body, query) = match before_fragment.split_once('?') {
        Some((body, query)) => (body, Some(query.to_owned())),
        None => (before_fragment, None),
    };
    let Some(after) = body.strip_prefix("//") else {
        if special {
            return Url::Unknown;
        }
        return Url::Parsed(Parts {
            scheme,
            host: String::new(),
            path: body.to_owned(),
            query,
        });
    };
    if special && after.starts_with('/') {
        return Url::Unknown;
    }
    let (authority, path) = match after.find('/') {
        Some(at) => (&after[..at], &after[at..]),
        None => (after, ""),
    };
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match host_port.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
        _ if host_port.contains(':') => return Url::Unknown,
        _ => host_port,
    };
    let forbidden = |c: char| {
        matches!(
            c,
            ' ' | '#' | '%' | '/' | ':' | '<' | '>' | '?' | '@' | '[' | '\\' | ']' | '^' | '|'
        )
    };
    if host.contains(forbidden) || (special && host.is_empty()) {
        return Url::Unknown;
    }
    let path = if special && path.is_empty() {
        "/".to_owned()
    } else {
        path.to_owned()
    };
    Url::Parsed(Parts {
        host: if special {
            host.to_ascii_lowercase()
        } else {
            host.to_owned()
        },
        scheme,
        path,
        query,
    })
}

/// `URLSearchParams.get(name)` on a `search` string, for the plain
/// `name=value` pairs a YouTube address carries. `None` when the value would
/// need decoding.
pub(super) fn query_value(query: &str, name: &str) -> Option<Option<String>> {
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key.contains(['%', '+']) {
            return None;
        }
        if key == name {
            if value.contains(['%', '+']) {
                return None;
            }
            return Some(Some(value.to_owned()));
        }
    }
    Some(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(raw: &str) -> Parts {
        match parse(raw) {
            Url::Parsed(parts) => parts,
            other => panic!("{raw}: {other:?}"),
        }
    }

    #[test]
    fn a_special_address_lowercases_its_host_and_has_a_path() {
        let url = parts("https://WWW.Example.com:8080/a/b.png?x=1#f");
        assert_eq!(url.host, "www.example.com");
        assert_eq!(url.path, "/a/b.png");
        assert_eq!(url.query.as_deref(), Some("x=1"));
        assert_eq!(parts("http://e.com").path, "/");
    }

    #[test]
    fn a_relative_path_is_not_an_address() {
        assert_eq!(parse("assets/a.png"), Url::Invalid);
        assert_eq!(parse("a b.png"), Url::Invalid);
        assert_eq!(parse("https:e.com"), Url::Unknown);
        assert_eq!(parse("https://ü.com/x"), Url::Unknown);
    }

    #[test]
    fn a_custom_scheme_keeps_its_host_and_path() {
        let url = parts("memry-file://Abc/v.MOV");
        assert_eq!((url.host.as_str(), url.path.as_str()), ("Abc", "/v.MOV"));
        assert_eq!(parts("mailto:a@b.c").path, "a@b.c");
    }
}
