//! A `((mention:…))` payload
//! (`packages/editor-schema/src/inline/link-mention.ts` `parseLinkMentionToken`,
//! `link-mention-normalize.ts` `extractDomain`).

use crate::crdt::markdown_seed::web_url::{self, Hostname};
use crate::domain::journal_rules::is_js_whitespace;

use super::{Fate, InlineToken};

/// `parseLinkMentionToken`, then the node `createLinkMentionContent` makes.
pub(super) fn fate(encoded: &str) -> Fate {
    // `WELL_FORMED_PAYLOAD`, `/^[^\s\\]+$/`: everything the serializer emits.
    let url = if !encoded.contains(|c: char| c == '\\' || is_js_whitespace(c)) {
        match decode_uri_component(encoded) {
            Some(url) if !url.is_empty() => url,
            _ => return Fate::Text,
        }
    } else {
        // A legacy token with remark escapes or stray whitespace: repaired
        // only when what is left is spelled in a token alphabet and decodes
        // to a URL.
        let repaired: String = encoded
            .chars()
            .filter(|c| *c != '\\' && !is_js_whitespace(*c))
            .collect();
        let alphabet = |c: char| c.is_ascii_alphanumeric() || ".%!'*~_-".contains(c);
        if repaired.is_empty() || !repaired.chars().all(alphabet) {
            return Fate::Text;
        }
        let Some(url) = decode_uri_component(&repaired) else {
            return Fate::Text;
        };
        match web_url::hostname(&url) {
            Hostname::Throws => return Fate::Text,
            Hostname::Unknown => return Fate::Undecided,
            Hostname::Host(_) => url,
        }
    };
    // `extractDomain`: the hostname with its first `www.` removed, or the URL
    // itself when `new URL` throws.
    let domain = match web_url::hostname(&url) {
        Hostname::Host(host) => host.replacen("www.", "", 1),
        Hostname::Throws => url.clone(),
        Hostname::Unknown => return Fate::Undecided,
    };
    Fate::Node(InlineToken::Link { url, domain })
}

/// `decodeURIComponent`: every `%XX` decoded, `None` where it throws (a `%`
/// without two hex digits after it, or bytes that are not UTF-8).
///
/// Decoding the whole string to bytes and checking them once is the same
/// test as the per-escape one: a literal character starts with a lead byte,
/// so it cannot complete an escaped sequence, and an escaped continuation
/// byte cannot follow a complete one.
fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = bytes.get(at + 1..at + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(payload: &str) -> Fate {
        fate(payload)
    }

    fn node(url: &str, domain: &str) -> Fate {
        Fate::Node(InlineToken::Link {
            url: url.to_owned(),
            domain: domain.to_owned(),
        })
    }

    #[test]
    fn a_payload_decodes_to_its_url_and_domain() {
        assert_eq!(
            link("https%3A%2F%2Fwww.Example.com%2Fx%5Fy"),
            node("https://www.Example.com/x_y", "example.com")
        );
        assert_eq!(link("n1|Note"), node("n1|Note", "n1|Note"));
        assert_eq!(link("mailto%3Aa%40www.b"), node("mailto:a@www.b", ""));
        assert_eq!(
            link("https%3A%2F%2Fa.com%2F%C3%A9"),
            node("https://a.com/é", "a.com")
        );
        assert_eq!(
            link("http%3A%2F%2Fa.com%3A99999"),
            node("http://a.com:99999", "http://a.com:99999")
        );
    }

    #[test]
    fn a_legacy_payload_is_repaired_only_into_a_url() {
        assert_eq!(
            link("https%3A%2F%2Fa.com%2Fx\\_y"),
            node("https://a.com/x_y", "a.com")
        );
        assert_eq!(link(" see http://x.com"), Fate::Text);
        assert_eq!(link(" see below"), Fate::Text);
        assert_eq!(link("a b"), Fate::Text);
    }

    #[test]
    fn a_malformed_escape_is_refused() {
        assert_eq!(link("%E0%A4%A"), Fate::Text);
        assert_eq!(link("%C3"), Fate::Text);
        assert_eq!(link("%ZZ"), Fate::Text);
        assert_eq!(link("%2B%"), Fate::Text);
    }

    #[test]
    fn a_host_this_port_does_not_normalize_is_undecided() {
        assert_eq!(link("http%3A%2F%2F127.1%2F"), Fate::Undecided);
        assert_eq!(link("http%3A%2F%2F%C3%A9.com%2F"), Fate::Undecided);
    }
}
