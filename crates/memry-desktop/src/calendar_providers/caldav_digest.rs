//! HTTP Digest (RFC 7616, with RFC 2617 MD5) for the CalDAV transport (`caldav/caldav-digest.ts`).
//! Some self-hosted servers (older Baïkal, some Radicale set-ups) only offer Digest, so the
//! transport answers the server's challenge here.

use md5::Md5;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

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

/// `parseDigestChallenge`: the best `Digest` challenge of a `WWW-Authenticate` value (SHA-256
/// over MD5, RFC 7616 §3.7), or `None` when none is usable (no realm, an empty nonce, an
/// algorithm other than MD5 and SHA-256). Electron read every parameter after the first `Digest`,
/// so a later challenge's `realm` or `algorithm` overrode it; here each challenge is read alone.
pub fn parse_challenge(header: &str) -> Option<Challenge> {
    let offered = challenges(header)
        .into_iter()
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("digest"))
        .filter_map(|(_, params)| digest(params))
        .collect::<Vec<_>>();
    offered
        .iter()
        .find(|c| c.algorithm == Algorithm::Sha256)
        .or(offered.first())
        .cloned()
}

/// RFC 9110 §11.6.1: each challenge's auth-scheme and the text of its parameters. A scheme is a
/// token at the start of a list item that no `=` follows.
fn challenges(header: &str) -> Vec<(&str, &str)> {
    let bytes = header.as_bytes();
    let mut schemes: Vec<(usize, usize)> = Vec::new();
    let (mut i, mut at_item, mut quoted) = (0, true, false);
    while i < bytes.len() {
        let b = bytes[i];
        if quoted {
            match b {
                b'\\' => i += 1,
                b'"' => quoted = false,
                _ => {}
            }
            i += 1;
            continue;
        }
        match b {
            b'"' => {
                quoted = true;
                at_item = false;
                i += 1;
            }
            b',' => {
                at_item = true;
                i += 1;
            }
            _ if b.is_ascii_whitespace() || !at_item => i += 1,
            _ => {
                let start = i;
                while i < bytes.len()
                    && !matches!(bytes[i], b',' | b'=' | b'"')
                    && !bytes[i].is_ascii_whitespace()
                {
                    i += 1;
                }
                let next = bytes[i..].iter().find(|b| !b.is_ascii_whitespace());
                if i > start && next != Some(&b'=') {
                    schemes.push((start, i));
                }
                at_item = false;
                i = i.max(start + 1);
            }
        }
    }
    schemes
        .iter()
        .enumerate()
        .map(|(n, &(start, end))| {
            let stop = schemes.get(n + 1).map_or(header.len(), |&(next, _)| next);
            (&header[start..end], &header[end..stop])
        })
        .collect()
}

/// One `Digest` challenge's parameters.
fn digest(text: &str) -> Option<Challenge> {
    let params = parameters(text);
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
    let ha1 = algorithm.hash(&Zeroizing::new(format!(
        "{}:{}:{}",
        answer.username, challenge.realm, answer.password
    )));
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
    fn prefers_sha_256_over_md5_whatever_the_order() {
        for header in [
            "Digest realm=\"a\", nonce=\"n1\", algorithm=SHA-256, Digest realm=\"b\", nonce=\"n2\", algorithm=MD5",
            "Digest realm=\"b\", nonce=\"n2\", algorithm=MD5, Digest realm=\"a\", nonce=\"n1\", algorithm=SHA-256",
        ] {
            let challenge = parse_challenge(header).unwrap();
            assert_eq!(
                (
                    challenge.algorithm,
                    challenge.realm.as_str(),
                    challenge.nonce.as_str()
                ),
                (Algorithm::Sha256, "a", "n1"),
                "{header}"
            );
        }
    }

    #[test]
    fn another_scheme_after_digest_keeps_its_own_parameters() {
        let challenge = parse_challenge(
            "Digest realm=\"dav\", nonce=\"n, 1\", qop=\"auth\", Bearer realm=\"other\"",
        )
        .unwrap();
        assert_eq!(
            (challenge.realm.as_str(), challenge.nonce.as_str()),
            ("dav", "n, 1")
        );
        assert!(challenge.qop_auth);
        let after_basic =
            parse_challenge("Negotiate, Basic realm=\"x\", Digest realm=\"r\", nonce=\"n\"");
        assert_eq!(after_basic.map(|c| c.realm), Some("r".to_owned()));
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
