use super::*;

#[test]
fn no_range_or_a_range_it_cannot_read_serves_the_whole_file() {
    for header in [
        None,
        Some(""),
        Some("items=0-9"),
        Some("bytes"),
        Some("bytes="),
        Some("bytes=-"),
        Some("bytes=abc-def"),
        Some("bytes=5-2"),
        Some("bytes=99999999999999999999999-"),
        Some("bytes=0"),
    ] {
        assert_eq!(plan(header, 100), ServePlan::Full, "{header:?}");
    }
}

#[test]
fn serves_open_closed_and_clamped_ranges() {
    assert_eq!(
        plan(Some("bytes=0-9"), 100),
        ServePlan::Partial { start: 0, end: 9 }
    );
    assert_eq!(
        plan(Some("bytes=10-"), 100),
        ServePlan::Partial { start: 10, end: 99 }
    );
    assert_eq!(
        plan(Some("bytes=90-5000"), 100),
        ServePlan::Partial { start: 90, end: 99 }
    );
    assert_eq!(
        plan(Some("BYTES=0-0"), 100),
        ServePlan::Partial { start: 0, end: 0 }
    );
    assert_eq!(
        plan(Some(" bytes=1-2 "), 100),
        ServePlan::Partial { start: 1, end: 2 }
    );
    // The first of several ranges.
    assert_eq!(
        plan(Some("bytes=0-1,5-9"), 100),
        ServePlan::Partial { start: 0, end: 1 }
    );
}

#[test]
fn a_suffix_range_is_the_last_bytes_not_the_first() {
    assert_eq!(
        plan(Some("bytes=-10"), 100),
        ServePlan::Partial { start: 90, end: 99 }
    );
    assert_eq!(
        plan(Some("bytes=-500"), 100),
        ServePlan::Partial { start: 0, end: 99 }
    );
    assert_eq!(plan(Some("bytes=-0"), 100), ServePlan::Unsatisfiable);
    assert_eq!(plan(Some("bytes=-5"), 0), ServePlan::Unsatisfiable);
}

#[test]
fn a_range_past_the_end_is_unsatisfiable() {
    assert_eq!(plan(Some("bytes=100-"), 100), ServePlan::Unsatisfiable);
    assert_eq!(plan(Some("bytes=0-"), 0), ServePlan::Unsatisfiable);
    assert_eq!(plan(Some("bytes=5000-6000"), 100), ServePlan::Unsatisfiable);
}

#[test]
fn an_oversize_header_is_ignored_without_being_read() {
    let long = format!("bytes=0-1,{}", "1-2,".repeat(10_000));
    assert_eq!(plan(Some(&long), 100), ServePlan::Full);
}

#[test]
fn a_range_never_reaches_past_the_file() {
    for size in [0u64, 1, 2, 100, u64::MAX] {
        for header in [
            "bytes=0-",
            "bytes=-1",
            "bytes=1-1",
            "bytes=0-18446744073709551615",
        ] {
            match plan(Some(header), size) {
                ServePlan::Partial { start, end } => {
                    assert!(start <= end && end < size, "{header} {size}");
                }
                ServePlan::Full | ServePlan::Unsatisfiable => {}
            }
        }
    }
}

#[test]
fn heads_carry_the_range_headers_and_the_body_length() {
    let full = head("/v/a.png", 1000, ServePlan::Full);
    assert_eq!(full.status, 200);
    assert!(
        full.headers
            .contains(&("Content-Length", "1000".to_owned()))
    );
    assert!(
        full.headers
            .contains(&("Content-Type", "image/png".to_owned()))
    );
    assert!(
        full.headers
            .contains(&("Accept-Ranges", "bytes".to_owned()))
    );
    assert!(
        full.headers
            .contains(&("Access-Control-Allow-Origin", "*".to_owned()))
    );

    let part = head("/v/a.mp4", 1000, ServePlan::Partial { start: 10, end: 19 });
    assert_eq!(part.status, 206);
    assert!(
        part.headers
            .contains(&("Content-Range", "bytes 10-19/1000".to_owned()))
    );
    assert!(part.headers.contains(&("Content-Length", "10".to_owned())));

    let none = head("/v/a.mp4", 1000, ServePlan::Unsatisfiable);
    assert_eq!(none.status, 416);
    assert!(
        none.headers
            .contains(&("Content-Range", "bytes */1000".to_owned()))
    );
    assert!(none.headers.contains(&("Content-Length", "0".to_owned())));
}

#[test]
fn an_attached_html_file_is_text_with_nosniff_never_a_page() {
    for path in ["/v/a.html", "/v/a.HTM"] {
        let h = head(path, 5, ServePlan::Full);
        assert!(
            h.headers
                .contains(&("Content-Type", "text/plain; charset=utf-8".to_owned()))
        );
        assert!(
            h.headers
                .contains(&("X-Content-Type-Options", "nosniff".to_owned()))
        );
    }
    let png = head("/v/a.png", 5, ServePlan::Full);
    assert!(
        !png.headers
            .iter()
            .any(|(name, _)| *name == "X-Content-Type-Options")
    );
}

#[test]
fn content_types_follow_the_extension_with_a_binary_default() {
    assert_eq!(content_type("/v/a.pdf"), "application/pdf");
    assert_eq!(content_type("/v/a.mp3"), "audio/mpeg");
    assert_eq!(content_type("/v/a.mp4"), "video/mp4");
    assert_eq!(content_type("/v/a.unknownext"), "application/octet-stream");
    assert_eq!(content_type("/v/noextension"), "application/octet-stream");
}

#[test]
fn images_and_html_are_told_apart_case_insensitively() {
    assert!(is_image_path("/v/a.PNG") && is_image_path("/v/a.webp"));
    assert!(!is_image_path("/v/a.svg") && !is_image_path("/v/a.pdf"));
    assert!(is_html_path("/v/a.Html") && !is_html_path("/v/a.html.txt"));
}

#[test]
fn html_is_utf8_unless_it_declares_a_charset_near_the_top() {
    assert_eq!(
        html_content_type(b"<html><body>hi</body>"),
        "text/html; charset=utf-8"
    );
    assert_eq!(
        html_content_type(b"<meta charset=\"windows-1254\">"),
        "text/html"
    );
    assert_eq!(
        html_content_type(b"<meta http-equiv=x content='text/html; CHARSET = iso-8859-9'>"),
        "text/html"
    );
    // The word alone, or a declaration past the first KiB, does not count.
    assert_eq!(
        html_content_type(b"charset is a word"),
        "text/html; charset=utf-8"
    );
    let late = [vec![b' '; 2000], b"charset=x".to_vec()].concat();
    assert_eq!(html_content_type(&late), "text/html; charset=utf-8");
}

#[test]
fn the_blank_png_decodes_to_a_png() {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(TRANSPARENT_PNG_BASE64)
        .unwrap();
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
}

#[test]
fn the_embed_policy_sandboxes_without_same_origin_and_excludes_vault_schemes() {
    assert!(HTML_EMBED_CSP.starts_with("sandbox allow-scripts allow-forms allow-popups;"));
    assert!(!HTML_EMBED_CSP.contains("allow-same-origin"));
    assert!(!HTML_EMBED_CSP.contains("memry-file") && !HTML_EMBED_CSP.contains("memry-html"));
    assert!(
        HTML_EMBED_CSP.contains("form-action 'none'")
            && HTML_EMBED_CSP.contains("object-src 'none'")
    );
    assert!(!HTML_EMBED_CSP.contains(" http:"));
}
