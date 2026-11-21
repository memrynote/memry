use memry_test_kit::proptest_config;
use proptest::prelude::*;
use serde_json::json;

use super::*;

fn client() -> ReadwiseClient {
    let _ = rustls::crypto::ring::default_provider().install_default();
    ReadwiseClient::new()
}

#[test]
fn retry_after_takes_whole_seconds_rounded_up_capped_at_120_and_60_otherwise() {
    let cases: [(Option<&str>, u64); 13] = [
        (Some("5"), 5),
        (Some(" 7 "), 7),
        (Some("0.2"), 1),
        (Some(".5"), 1),
        (Some("+5"), 5),
        (Some("1e1"), 10),
        (Some("0"), 0),
        (Some("-0"), 0),
        (Some("999"), 120),
        (Some("-3"), 60),
        (Some("Infinity"), 60),
        (Some("Wed, 21 Oct 2015 07:28:00 GMT"), 60),
        (None, 60),
    ];
    for (header, want) in cases {
        assert_eq!(retry_after_secs(header), want, "{header:?}");
    }
}

#[test]
fn only_a_detail_naming_the_subscription_is_an_expired_subscription() {
    let says = |body: Value| says_subscription_expired(body.to_string().as_bytes());
    assert!(says(json!({ "detail": "Your SUBSCRIPTION has lapsed" })));
    assert!(says(json!({ "detail": "Trial expired" })));
    assert!(!says(json!({ "detail": "Invalid token." })));
    assert!(!says(json!({ "detail": ["subscription"] })));
    assert!(!says(json!(["subscription"])));
    assert!(!says_subscription_expired(b"subscription expired"));
    // JS `/i` without `u` folds no non-ASCII letter onto an ASCII one: U+017F is not `s`.
    assert!(!says(json!({ "detail": "\u{17f}ubscription" })));
}

#[test]
fn reader_tags_are_refused_in_the_shapes_electrons_schema_refuses() {
    let page = |tags: Value| {
        let body = json!({ "results": [{ "id": "d1", "tags": tags }] }).to_string();
        let (documents, _) = parse_page::<ReaderDocument>(body.as_bytes()).unwrap();
        check_reader_page(&documents).is_ok()
    };
    assert!(page(json!(null)));
    assert!(page(json!({})));
    assert!(page(
        json!({ "a": { "name": "a" }, "b": { "name": null }, "c": { "x": 1 } })
    ));
    assert!(!page(json!({ "a": null })));
    assert!(!page(json!({ "a": { "name": 3 } })));
    assert!(!page(json!({ "a": [] })));
    assert!(!page(json!([])));
    assert!(!page(json!("tag")));
}

#[test]
fn a_page_cursor_reaches_the_url_as_one_encoded_value() {
    let client = client();
    let hostile = "x&ids=1#frag /?pageCursor=y";
    let url = client.url("/api/v2/export/", &[("pageCursor", hostile.to_owned())]);
    assert_eq!(url.host_str(), Some("readwise.io"));
    assert_eq!(url.path(), "/api/v2/export/");
    assert_eq!(url.fragment(), None);
    let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    assert_eq!(pairs, [("pageCursor".to_owned(), hostile.to_owned())]);
}

#[test]
fn the_token_header_is_sensitive() {
    let client = client();
    let request = client.http.get(client.url("/api/v2/auth/", &[]));
    let request = with_token(request, "secret-token").build().unwrap();
    let header = request.headers().get(AUTHORIZATION).unwrap();
    assert_eq!(header, "Token secret-token");
    assert!(header.is_sensitive());
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn retry_after_is_always_a_bounded_wait(header in any::<Option<String>>()) {
        prop_assert!(retry_after_secs(header.as_deref()) <= MAX_RETRY_AFTER_SECS);
    }

    #[test]
    fn any_cursor_stays_one_query_value_on_the_readwise_origin(cursor in any::<String>()) {
        let client = client();
        let url = client.url("/api/v3/list/", &[("location", "new".to_owned()), ("pageCursor", cursor.clone())]);
        prop_assert_eq!(url.origin().ascii_serialization(), READWISE_ORIGIN);
        prop_assert_eq!(url.path(), "/api/v3/list/");
        prop_assert_eq!(url.fragment(), None);
        let pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        prop_assert_eq!(pairs, vec![("location".to_owned(), "new".to_owned()), ("pageCursor".to_owned(), cursor)]);
    }

    #[test]
    fn any_body_parses_or_is_an_unknown_shape(body in proptest::collection::vec(any::<u8>(), 0..512)) {
        let books = parse_page::<ReadwiseBook>(&body);
        prop_assert!(books.is_ok() || matches!(books, Err(ReadwiseError::UnknownShape)));
        let documents = parse_page::<ReaderDocument>(&body);
        prop_assert!(documents.is_ok() || matches!(documents, Err(ReadwiseError::UnknownShape)));
    }
}
