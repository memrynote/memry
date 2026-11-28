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

/// What `new URL(raw).hostname` gives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Hostname {
    /// `new URL` throws.
    Throws,
    Host(String),
    /// A host this module does not normalize, or a shape it does not decide.
    Unknown,
}

/// `new URL(raw).hostname`, decided by the scheme and the authority alone,
/// so the path, query and fragment may hold anything [`parse`] leaves
/// unknown. On top of [`parse`]: a port above 65535 throws, a dotted-quad
/// IPv4 host is kept as it is, and another numeric-looking or a punycode
/// host of a special scheme, which the WHATWG host parser rewrites or
/// validates, is unknown, and so is every `file` host.
pub(crate) fn hostname(raw: &str) -> Hostname {
    // `new URL` strips leading and trailing C0 controls and spaces, and a
    // tab or newline anywhere, which this does not follow.
    let url = raw.trim_matches(|c: char| c <= ' ');
    if url.contains(['\t', '\n', '\r']) {
        return Hostname::Unknown;
    }
    // [`parse`] trims more than that.
    let Some(colon) = url
        .find(':')
        .filter(|_| url.starts_with(|c: char| c.is_ascii_alphabetic()))
    else {
        return Hostname::Throws;
    };
    let head_end = match url[colon + 1..].strip_prefix("//") {
        Some(after) => colon + 3 + after.find(['/', '?', '#']).unwrap_or(after.len()),
        None => colon + 1,
    };
    let head = &url[..head_end];
    let parts = match parse(head) {
        Url::Invalid => return Hostname::Throws,
        Url::Unknown => return Hostname::Unknown,
        Url::Parsed(parts) => parts,
    };
    let authority = head[colon + 1..].trim_start_matches('/');
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, at)| at);
    // [`parse`] took the port as digits.
    let port = host_port
        .rsplit_once(':')
        .map_or("", |(_, port)| port.trim_start_matches('0'));
    if port.len() > 5 || port.parse::<u32>().is_ok_and(|port| port > 65535) {
        return Hostname::Throws;
    }
    if parts.scheme == "file" {
        return Hostname::Unknown;
    }
    if SPECIAL.contains(&parts.scheme.as_str()) {
        let labels: Vec<&str> = parts.host.split('.').collect();
        let dotted_quad = labels.len() == 4
            && labels.iter().all(|label| {
                !label.is_empty()
                    && label.chars().all(|c| c.is_ascii_digit())
                    && (label.len() == 1 || !label.starts_with('0'))
                    && label.parse::<u32>().is_ok_and(|value| value <= 255)
            });
        let last = labels.iter().rev().find(|label| !label.is_empty());
        let numeric = last.is_some_and(|label| {
            label.chars().all(|c| c.is_ascii_digit())
                || label.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("0x"))
        });
        let punycode = labels.iter().any(|label| {
            label
                .get(..4)
                .is_some_and(|p| p.eq_ignore_ascii_case("xn--"))
        });
        if (numeric && !dotted_quad) || punycode {
            return Hostname::Unknown;
        }
    }
    Hostname::Host(parts.host)
}

/// What `img.src` gives for an `<img src>` (jsdom through BlockNote's `Image`
/// parse): the WHATWG serialization of an absolute address, and the attribute
/// as written for one that has no scheme, which fails to resolve against
/// `about:blank`. `None` for an absolute address this port does not
/// serialize, which the caller keeps as literal text.
///
/// Reproduced: the scheme and (for `http`, `https`, `ws`, `wss`, `ftp`) the
/// host lowercased, a default or empty port dropped, an empty path made `/`,
/// dot segments resolved, and the characters each part's percent-encode set
/// covers written as `%XX`. A host other than letters, digits, `.`, `-`, `_`
/// and `~`, an IPv4-looking or punycode host, a userinfo part other than
/// plain words, a backslash or control character, a `file` address and a
/// special scheme without `//` are `None`.
pub(super) fn img_src(raw: &str) -> Option<String> {
    let Some(colon) = raw.find(':') else {
        return Some(raw.to_owned());
    };
    let scheme = &raw[..colon];
    let is_scheme = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !is_scheme {
        return Some(raw.to_owned());
    }
    if raw.contains(|c: char| c.is_control() || c == '\\') {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    let rest = &raw[colon + 1..];
    let special = matches!(scheme.as_str(), "http" | "https" | "ws" | "wss" | "ftp");
    if scheme == "file" {
        return None;
    }
    let Some(after) = rest.strip_prefix("//") else {
        if special {
            return None;
        }
        let (path, tail) = split_path(rest);
        let tail = encode_tail(tail, false);
        return if path.starts_with('/') {
            let path = encode(&resolve_dots(path), path_set);
            (!path.starts_with("//")).then(|| format!("{scheme}:{path}{tail}"))
        } else {
            // An opaque path: only the non-ASCII is encoded.
            Some(format!("{scheme}:{}{tail}", encode(path, |_| false)))
        };
    };
    if special && after.starts_with('/') {
        return None;
    }
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let (authority, remainder) = after.split_at(end);
    let (userinfo, host_port) = match authority.rsplit_once('@') {
        Some((userinfo, host_port)) => (Some(userinfo), host_port),
        None => (None, authority),
    };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (host_port, None),
    };
    let name_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '~');
    if host.is_empty() || !host.chars().all(name_char) {
        return None;
    }
    let port = match port {
        None | Some("") => None,
        Some(digits) if digits.chars().all(|c| c.is_ascii_digit()) && digits.len() <= 6 => {
            Some(digits.parse::<u32>().ok().filter(|port| *port <= 65535)?)
        }
        Some(_) => return None,
    };
    let userinfo = match userinfo {
        None => String::new(),
        Some(info) => {
            let (user, password) = info
                .split_once(':')
                .map_or((info, None), |(u, p)| (u, Some(p)));
            let plain = |text: &str| !text.is_empty() && text.chars().all(name_char);
            if !plain(user) || password.is_some_and(|password| !plain(password)) {
                return None;
            }
            format!("{info}@")
        }
    };
    let (host, port) = if special {
        let last = host
            .rsplit('.')
            .find(|label| !label.is_empty())
            .unwrap_or("");
        let numeric = last.chars().all(|c| c.is_ascii_digit())
            || last.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("0x"));
        let punycode = host.split('.').any(|label| {
            label
                .get(..4)
                .is_some_and(|p| p.eq_ignore_ascii_case("xn--"))
        });
        if numeric || punycode {
            return None;
        }
        let default = match scheme.as_str() {
            "http" | "ws" => 80,
            "https" | "wss" => 443,
            _ => 21,
        };
        (
            host.to_ascii_lowercase(),
            port.filter(|port| *port != default),
        )
    } else {
        (host.to_owned(), port)
    };
    let (path, tail) = split_path(remainder);
    let path = if path.is_empty() {
        if special {
            "/".to_owned()
        } else {
            String::new()
        }
    } else {
        encode(&resolve_dots(path), path_set)
    };
    let tail = encode_tail(tail, special);
    let port = port.map(|port| format!(":{port}")).unwrap_or_default();
    Some(format!("{scheme}://{userinfo}{host}{port}{path}{tail}"))
}

/// `^"<>` and the backtick and braces: the path percent-encode set past the
/// query's.
fn path_set(c: char) -> bool {
    matches!(c, '"' | '<' | '>' | '`' | '{' | '}' | '^' | ' ')
}

/// `text` with each non-ASCII character and each one `in_set` covers written
/// as the `%XX` of its UTF-8 bytes.
fn encode(text: &str, in_set: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii() && !in_set(c) {
            out.push(c);
            continue;
        }
        let mut buffer = [0; 4];
        for byte in c.encode_utf8(&mut buffer).bytes() {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The query and the fragment, each in its own percent-encode set.
fn encode_tail(tail: &str, special: bool) -> String {
    let (query, fragment) = tail.split_at(tail.find('#').unwrap_or(tail.len()));
    let query_set = |c: char| matches!(c, '"' | '<' | '>' | ' ') || (special && c == '\'');
    let fragment_set = |c: char| matches!(c, '"' | '<' | '>' | '`' | ' ');
    format!(
        "{}{}",
        encode(query, query_set),
        encode(fragment, fragment_set)
    )
}

/// The path of `rest` and what follows it: the query and fragment.
fn split_path(rest: &str) -> (&str, &str) {
    rest.split_at(rest.find(['?', '#']).unwrap_or(rest.len()))
}

/// The path with its `.` and `..` segments resolved (`%2e` spells a dot).
fn resolve_dots(path: &str) -> String {
    let segments: Vec<&str> = path[1..].split('/').collect();
    let mut kept: Vec<&str> = Vec::new();
    for (index, segment) in segments.iter().enumerate() {
        let last = index == segments.len() - 1;
        let lower = segment.to_ascii_lowercase();
        match lower.as_str() {
            ".." | ".%2e" | "%2e." | "%2e%2e" => {
                kept.pop();
                if last {
                    kept.push("");
                }
            }
            "." | "%2e" => {
                if last {
                    kept.push("");
                }
            }
            _ => kept.push(segment),
        }
    }
    format!("/{}", kept.join("/"))
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
    fn an_image_address_is_what_the_dom_serializes() {
        let src = |raw: &str| img_src(raw).expect("serialized");
        assert_eq!(src("http://e.com"), "http://e.com/");
        assert_eq!(src("HTTP://E.com:80/x/../y?q=1#f"), "http://e.com/y?q=1#f");
        assert_eq!(
            src("https://u:p@E.com:8080/a/./b/"),
            "https://u:p@e.com:8080/a/b/"
        );
        assert_eq!(src("ftp://e.com:21/x"), "ftp://e.com/x");
        assert_eq!(src("https://e.com??a#b#c"), "https://e.com/??a#b#c");
        assert_eq!(src("memry-file://Abc/v.png"), "memry-file://Abc/v.png");
        assert_eq!(
            src("DATA:image/png;base64,AA+/="),
            "data:image/png;base64,AA+/="
        );
        assert_eq!(src("assets/x.png"), "assets/x.png");
        assert_eq!(src("//e.com/x"), "//e.com/x");
        assert_eq!(src("c:/a/../b.png"), "c:/b.png");
        assert_eq!(
            src("http://e.com/é?q=é#é"),
            "http://e.com/%C3%A9?q=%C3%A9#%C3%A9"
        );
        assert_eq!(
            src("http://e.com/{a}^b`c?x='y'"),
            "http://e.com/%7Ba%7D%5Eb%60c?x=%27y%27"
        );
        for unreproduced in [
            "http://é.com/",
            "http://0x7f.1/",
            "http://127.1/",
            "http:e.com",
            "file:///x.png",
            "http://xn--e.com/",
            "http://e.com/a\\b",
        ] {
            assert_eq!(img_src(unreproduced), None, "{unreproduced}");
        }
    }

    #[test]
    fn a_hostname_is_decided_by_the_scheme_and_authority() {
        let host = |raw: &str| Hostname::Host(raw.to_owned());
        assert_eq!(hostname("https://WWW.A.com/é?q=é#é"), host("www.a.com"));
        assert_eq!(hostname("http://1.2.3.4:80/"), host("1.2.3.4"));
        assert_eq!(hostname("mailto:a@b"), host(""));
        assert_eq!(hostname("foo://Host/x"), host("Host"));
        assert_eq!(hostname(" http://a.com "), host("a.com"));
        assert_eq!(hostname("a.com/x"), Hostname::Throws);
        assert_eq!(hostname("http://a.com:65536/"), Hostname::Throws);
        assert_eq!(hostname("\u{a0}http://a.com"), Hostname::Throws);
        for unknown in [
            "http://127.1/",
            "http://01.2.3.4/",
            "http://xn--e.com/",
            "http://é.com/",
            "http:a.com",
            "file://localhost/x",
            "http://a\n.com/",
        ] {
            assert_eq!(hostname(unknown), Hostname::Unknown, "{unknown}");
        }
    }

    #[test]
    fn a_custom_scheme_keeps_its_host_and_path() {
        let url = parts("memry-file://Abc/v.MOV");
        assert_eq!((url.host.as_str(), url.path.as_str()), ("Abc", "/v.MOV"));
        assert_eq!(parts("mailto:a@b.c").path, "a@b.c");
    }
}
