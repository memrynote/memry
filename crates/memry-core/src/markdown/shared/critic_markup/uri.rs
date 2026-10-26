//! `encodeURIComponent` and `decodeURIComponent`.

use std::fmt::Write as _;

pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn hex(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|d| d as u8)
}

/// `None` where JavaScript throws `URIError`: a `%` without two hex digits, or
/// escaped bytes that are not well-formed UTF-8.
pub fn decode_uri_component(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut run: Vec<u8> = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex(*bytes.get(index + 1)?)?;
            let low = hex(*bytes.get(index + 2)?)?;
            run.push(high * 16 + low);
            index += 3;
            continue;
        }
        if !run.is_empty() {
            out.push_str(std::str::from_utf8(&run).ok()?);
            run.clear();
        }
        let ch = text[index..].chars().next()?;
        out.push(ch);
        index += ch.len_utf8();
    }
    if !run.is_empty() {
        out.push_str(std::str::from_utf8(&run).ok()?);
    }
    Some(out)
}
