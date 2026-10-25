//! `element.src` as jsdom answers it: the `src` attribute resolved against the
//! document's base URL, which is `about:blank`. Nothing relative resolves
//! against that base, so a relative value comes back as written, and an
//! absolute URL comes back in the WHATWG URL serialisation.
//!
//! Only the parts of that serialisation a pasted `<img src>` shows are
//! covered: the lower-cased scheme and host, a dropped default port, `/` for an
//! empty path of a special scheme, and percent-encoding of spaces, controls
//! and non-ASCII in the path, query and fragment. Dot segments, IDNA hosts
//! and IPv4/IPv6 forms are left as written.

fn is_special(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "ftp" | "ws" | "wss" | "file")
}

fn default_port(scheme: &str) -> Option<&'static str> {
    match scheme {
        "http" | "ws" => Some("80"),
        "https" | "wss" => Some("443"),
        "ftp" => Some("21"),
        _ => None,
    }
}

fn encode(text: &str, extra: &[char]) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c <= ' ' || c == '\u{7f}' || !c.is_ascii() || extra.contains(&c) {
            let mut buf = [0u8; 4];
            for byte in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn reflect_url(value: &str) -> String {
    let input: String = value
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let scheme_len = input.find(':').filter(|at| {
        let scheme = &input[..*at];
        scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    });
    let Some(at) = scheme_len else {
        if let Some(fragment) = input.strip_prefix('#') {
            return format!("about:blank#{}", encode(fragment, &['"', '<', '>', '`']));
        }
        return value.to_owned();
    };
    let scheme = input[..at].to_ascii_lowercase();
    let rest = &input[at + 1..];
    if !is_special(&scheme) {
        return format!("{scheme}:{rest}");
    }
    let rest = rest.trim_start_matches(['/', '\\']);
    let end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let (userinfo, host_port) = match authority.rfind('@') {
        Some(i) => (&authority[..=i], &authority[i + 1..]),
        None => ("", authority),
    };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if p.bytes().all(|b| b.is_ascii_digit()) => (h, p),
        _ => (host_port, ""),
    };
    if host.is_empty() && scheme != "file" {
        return value.to_owned();
    }
    let port = port.trim_start_matches('0');
    let port = if default_port(&scheme) == Some(port) || port.is_empty() {
        String::new()
    } else {
        format!(":{port}")
    };
    let (before_fragment, fragment) = match tail.split_once('#') {
        Some((a, f)) => (a, Some(f)),
        None => (tail, None),
    };
    let (path, query) = match before_fragment.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (before_fragment, None),
    };
    let path = path.replace('\\', "/");
    let path = if path.is_empty() {
        "/".to_owned()
    } else {
        encode(&path, &['"', '<', '>', '`', '{', '}', '#', '?'])
    };
    let mut out = format!(
        "{scheme}://{userinfo}{}{port}{path}",
        host.to_ascii_lowercase()
    );
    if let Some(q) = query {
        out.push('?');
        out.push_str(&encode(q, &['"', '<', '>', '#', '\'']));
    }
    if let Some(f) = fragment {
        out.push('#');
        out.push_str(&encode(f, &['"', '<', '>', '`']));
    }
    out
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
