//! HTTP Digest (RFC 7616, with RFC 2617 MD5) for the CalDAV transport (`caldav/caldav-digest.ts`).
//! Some self-hosted servers (older Baïkal, some Radicale set-ups) only offer Digest, so the
//! transport answers the server's challenge here.

use md5::Md5;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Algorithm {
    Md5,
    Sha256,
}

impl Algorithm {
    fn name(self) -> &'static str {
        match self {
            Self::Md5 => "MD5",
            Self::Sha256 => "SHA-256",
        }
    }

    fn hash(self, value: &str) -> String {
        match self {
            Self::Md5 => hex::encode(Md5::digest(value.as_bytes())),
            Self::Sha256 => hex::encode(Sha256::digest(value.as_bytes())),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Challenge {
    pub realm: String,
    pub nonce: String,
    /// The server offered `qop=auth`.
    pub qop_auth: bool,
    pub opaque: Option<String>,
    pub algorithm: Algorithm,
}

/// `parseDigestChallenge`: the `Digest` part of a `WWW-Authenticate` value, or `None` when it
/// offers no usable Digest (no realm, an empty nonce, an algorithm other than MD5 and SHA-256).
pub fn parse_challenge(header: &str) -> Option<Challenge> {
    let params = parameters(digest_tail(header)?);
    let get = |name: &str| {
        params
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let realm = get("realm")?.to_owned();
    let nonce = get("nonce").filter(|n| !n.is_empty())?.to_owned();
    let algorithm = match get("algorithm")
        .unwrap_or("MD5")
        .to_ascii_uppercase()
        .as_str()
    {
        "MD5" => Algorithm::Md5,
        "SHA-256" => Algorithm::Sha256,
        _ => return None,
    };
    Some(Challenge {
        realm,
        nonce,
        qop_auth: get("qop")
            .unwrap_or("")
            .split(',')
            .any(|qop| qop.trim() == "auth"),
        opaque: get("opaque").map(str::to_owned),
        algorithm,
    })
}

/// `/Digest\s+(.*)$/i`: what follows the first `Digest` that whitespace follows.
fn digest_tail(header: &str) -> Option<&str> {
    let lower = header.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find("digest") {
        let start = from + at + "digest".len();
        let rest = &header[start..];
        let trimmed = rest.trim_start();
        if trimmed.len() < rest.len() {
            return Some(trimmed);
        }
        from = start;
    }
    None
}

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// `/([a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/gi`, each name lowercased.
fn parameters(text: &str) -> Vec<(String, String)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if !is_name_byte(bytes[i]) {
            i += 1;
            continue;
        }
        let name_start = i;
        while i < bytes.len() && is_name_byte(bytes[i]) {
            i += 1;
        }
        let name = &text[name_start..i];
        let mut j = i;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if bytes.get(j) != Some(&b'=') {
            continue;
        }
        j += 1;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        let quoted_end = (bytes.get(j) == Some(&b'"'))
            .then(|| text[j + 1..].find('"').map(|end| j + 1 + end))
            .flatten();
        let value = match quoted_end {
            Some(end) => {
                let value = &text[j + 1..end];
                i = end + 1;
                value
            }
            None => {
                let end = text[j..]
                    .find(|c: char| c == ',' || c.is_ascii_whitespace())
                    .map_or(text.len(), |end| j + end);
                i = end;
                &text[j..end]
            }
        };
        out.push((name.to_ascii_lowercase(), value.to_owned()));
    }
    out
}

/// RFC 7616 quoted-string: backslash and double quote are escaped.
fn quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        if c == '\\' || c == '"' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

pub struct Answer<'a> {
    pub username: &'a str,
    pub password: &'a str,
    pub method: &'a str,
    /// The request's path and query.
    pub uri: &'a str,
    pub nonce_count: u32,
    pub cnonce: &'a str,
}

/// `digestAuthorization`: the `Authorization` header answering `challenge` for one request.
pub fn authorization(challenge: &Challenge, answer: &Answer<'_>) -> String {
    let algorithm = challenge.algorithm;
    let nc = format!("{:08x}", answer.nonce_count);
    let ha1 = algorithm.hash(&format!(
        "{}:{}:{}",
        answer.username, challenge.realm, answer.password
    ));
    let ha2 = algorithm.hash(&format!("{}:{}", answer.method, answer.uri));
    let response = if challenge.qop_auth {
        algorithm.hash(&format!(
            "{ha1}:{}:{nc}:{}:auth:{ha2}",
            challenge.nonce, answer.cnonce
        ))
    } else {
        algorithm.hash(&format!("{ha1}:{}:{ha2}", challenge.nonce))
    };
    let mut parts = vec![
        format!("username={}", quoted(answer.username)),
        format!("realm={}", quoted(&challenge.realm)),
        format!("nonce={}", quoted(&challenge.nonce)),
        format!("uri={}", quoted(answer.uri)),
        format!("algorithm={}", algorithm.name()),
        format!("response=\"{response}\""),
    ];
    if challenge.qop_auth {
        parts.push("qop=auth".to_owned());
        parts.push(format!("nc={nc}"));
        parts.push(format!("cnonce={}", quoted(answer.cnonce)));
    }
    if let Some(opaque) = &challenge.opaque {
        parts.push(format!("opaque={}", quoted(opaque)));
    }
    format!("Digest {}", parts.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_challenge_after_another_scheme() {
        let challenge = parse_challenge(
            "Basic realm=\"x\", Digest realm=\"r@h\", qop=\"auth,auth-int\", \
             nonce=\"n1\", opaque=\"o\", algorithm=sha-256",
        )
        .unwrap();
        assert_eq!(challenge.realm, "r@h");
        assert_eq!(challenge.nonce, "n1");
        assert!(challenge.qop_auth);
        assert_eq!(challenge.opaque.as_deref(), Some("o"));
        assert_eq!(challenge.algorithm, Algorithm::Sha256);
    }

    #[test]
    fn refuses_what_the_electron_parser_refuses() {
        assert_eq!(parse_challenge("Basic realm=\"x\""), None);
        assert_eq!(parse_challenge("Digest nonce=\"n\""), None, "no realm");
        assert_eq!(parse_challenge("Digest realm=\"r\", nonce=\"\""), None);
        assert_eq!(
            parse_challenge("Digest realm=\"r\", nonce=\"n\", algorithm=SHA-512"),
            None
        );
        let unquoted = parse_challenge("Digest realm=, nonce=abc").unwrap();
        assert_eq!(
            (unquoted.realm.as_str(), unquoted.nonce.as_str()),
            ("", "abc")
        );
        assert!(!unquoted.qop_auth);
    }

    /// The public example credential of RFC 2617 §3.5.
    const RFC_2617_EXAMPLE: &str = concat!("Circle ", "Of Life");

    /// RFC 2617 §3.5's worked example (MD5, qop=auth).
    #[test]
    fn answers_the_rfc_2617_example() {
        let challenge = parse_challenge(
            "Digest realm=\"testrealm@host.com\", qop=\"auth,auth-int\", \
             nonce=\"dcd98b7102dd2f0e8b11d0f600bfb0c093\", opaque=\"5ccc069c403ebaf9f0171e9517f40e41\"",
        )
        .unwrap();
        let header = authorization(
            &challenge,
            &Answer {
                username: "Mufasa",
                password: RFC_2617_EXAMPLE,
                method: "GET",
                uri: "/dir/index.html",
                nonce_count: 1,
                cnonce: "0a4f113b",
            },
        );
        assert!(header.contains("response=\"6629fae49393a05397450978507c4ef1\""));
        assert!(header.contains("nc=00000001"));
        assert!(header.starts_with("Digest username=\"Mufasa\", realm=\"testrealm@host.com\""));
        assert!(header.ends_with("opaque=\"5ccc069c403ebaf9f0171e9517f40e41\""));
    }

    #[test]
    fn quotes_escape_backslash_and_double_quote() {
        assert_eq!(quoted(r#"a"b\c"#), r#""a\"b\\c""#);
    }
}
