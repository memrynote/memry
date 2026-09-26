//! Subscribed-calendar links (split from [`super::ics`] at the 600-line
//! ceiling): desktop's `normalizeIcsUrl` and `icsSourceIdForUrl`, so the same
//! pasted link lands on the same source row on every device.

use sha2::{Digest, Sha256};

/// `normalizeIcsUrl`: `webcal(s)://` → `https://`, http(s) only, a host,
/// no fragment. Scheme and host lower case, an empty path becomes `/` and a
/// default port goes, as WHATWG `URL#toString()` writes them, so the same
/// link hashes to the same source id on desktop and here.
pub fn normalize_url(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let lower = trimmed.to_ascii_lowercase();
    let rest = if lower.starts_with("webcals://") {
        format!("https://{}", &trimmed[10..])
    } else if lower.starts_with("webcal://") {
        format!("https://{}", &trimmed[9..])
    } else {
        trimmed.to_owned()
    };
    let (scheme, after) = rest.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let after = after.split('#').next().unwrap_or("");
    let split = after.find(['/', '?']).unwrap_or(after.len());
    let (authority, tail) = after.split_at(split);
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let userinfo = authority.strip_suffix(host_port).unwrap_or("");
    let (host, port) = match host_port.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
            (host, Some(port))
        }
        _ => (host_port, None),
    };
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    let default_port = if scheme == "https" { "443" } else { "80" };
    let port = port
        .filter(|p| *p != default_port)
        .map(|p| format!(":{p}"))
        .unwrap_or_default();
    let tail = if tail.starts_with('/') {
        tail.to_owned()
    } else {
        format!("/{tail}")
    };
    let (path, query) = match tail.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (tail.as_str(), None),
    };
    let mut out = format!(
        "{scheme}://{userinfo}{}{port}{}",
        host.to_ascii_lowercase(),
        percent_encode(path, b"\"<>`{}")
    );
    if let Some(query) = query {
        out.push('?');
        out.push_str(&percent_encode(query, b"\"<>'"));
    }
    Some(out)
}

/// WHATWG's path / query percent-encode sets: controls, space, non-ASCII
/// and the set's own bytes; an existing `%XX` stays.
fn percent_encode(text: &str, extra: &[u8]) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte <= 0x20 || byte >= 0x7F || extra.contains(&byte) {
            out.push_str(&format!("%{byte:02X}"));
        } else {
            out.push(char::from(byte));
        }
    }
    out
}

/// `icsSourceIdForUrl`.
pub fn source_id(normalized_url: &str) -> String {
    let digest = hex::encode(Sha256::digest(normalized_url.as_bytes()));
    format!("ics-calendar:{}", &digest[..32])
}

pub(super) fn host(url: &str) -> String {
    url.split_once("://")
        .map(|(_, rest)| {
            rest.split(['/', '?', ':'])
                .next()
                .unwrap_or(rest)
                .to_owned()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_normalise_like_whatwg() {
        assert_eq!(
            normalize_url("webcal://Example.com/cal.ics").as_deref(),
            Some("https://example.com/cal.ics")
        );
        assert_eq!(
            normalize_url(" HTTPS://example.com:443 ").as_deref(),
            Some("https://example.com/")
        );
        assert_eq!(
            normalize_url("http://example.com:8080/a?b=c#frag").as_deref(),
            Some("http://example.com:8080/a?b=c")
        );
        assert_eq!(normalize_url("ftp://example.com/x"), None);
        assert_eq!(normalize_url("not a url"), None);
        assert_eq!(
            source_id("https://example.com/cal.ics").len(),
            "ics-calendar:".len() + 32
        );
    }
}
