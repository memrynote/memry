//! The pure helpers of `ingest`, against what Node 22 gives for the same input (`Buffer.from`
//! with `'base64'`, the regex of `parse-data-url.ts`, `sanitizeFilename`).

use super::{node_base64, parse_data_url, sanitize, stem};

#[test]
fn base64_decodes_as_node_does() {
    let hex = |s: &str| hex::encode(node_base64(s));
    assert_eq!(hex("aGVsbG8="), "68656c6c6f");
    assert_eq!(hex("aGVsbG8"), "68656c6c6f");
    assert_eq!(hex("aGVs bG8="), "68656c6c6f");
    assert_eq!(hex("aGVs*bG8="), "68656c6c6f");
    assert_eq!(hex("aGVsbG8=AAAA"), "68656c6c6f");
    assert_eq!(hex("aGVs!!!!bG8"), "68656c6c6f");
    assert_eq!(hex("a-_b"), "6befdb");
    assert_eq!(hex("===="), "");
}

#[test]
fn data_urls_parse_as_parse_data_url_does() {
    assert_eq!(
        parse_data_url("  DATA:Image/PNG;BASE64,aGVsbG8=\n"),
        Some(("image/png".to_owned(), b"hello".to_vec()))
    );
    assert_eq!(parse_data_url("data:image/png;base64,"), None);
    assert_eq!(parse_data_url("data:image/png;base64,===="), None);
    assert_eq!(parse_data_url("data:image/png;base64,aGVs\nbG8="), None);
    assert_eq!(parse_data_url("data:;base64,aGVsbG8="), None);
    assert_eq!(parse_data_url("data:image/p ng;base64,aGVsbG8="), None);
    assert_eq!(parse_data_url("data:image/png,aGVsbG8="), None);
    assert_eq!(parse_data_url("https://example.com/a.png"), None);
}

#[test]
fn file_names_are_sanitized_as_desktop_stores_them() {
    assert_eq!(stem("report.final.pdf"), "report.final");
    assert_eq!(stem("a."), "a.");
    assert_eq!(stem(".pdf"), "");
    assert_eq!(sanitize("my report (v2)"), "my_report_v2_");
    assert_eq!(sanitize("Ünïcode 😀 name"), "_n_code_name");
    assert_eq!(sanitize(&"x".repeat(150)).len(), 100);
}
