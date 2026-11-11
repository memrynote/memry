//! `encodeURIComponent` and `decodeURIComponent`, shared by the article extractor and the
//! attachment services.

/// `decodeURIComponent(s)`; `None` for the `URIError` of a malformed escape or UTF-8 sequence.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
            // `from_str_radix` accepts a leading `+`; a hex pair does not.
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `encodeURIComponent(s)`: everything but letters, digits and `-_.!~*'()`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            out.push(c);
        } else {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_like_node() {
        // Read from Node 24.
        assert_eq!(
            encode_uri_component("é/ü?x=1&y=ü"),
            "%C3%A9%2F%C3%BC%3Fx%3D1%26y%3D%C3%BC"
        );
    }
}
