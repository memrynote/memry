//! The Unsplash service against `unsplash_server`, a local TLS server standing in for the API and
//! the image CDN.

mod unsplash_server;

use std::sync::{Arc, Mutex};

use memry_desktop::notes::unsplash::{
    InvalidSearch, SearchPage, SearchRequest, Unsplash, UnsplashFailure, UnsplashPhoto,
};
use serde_json::{Value, json};
use unsplash_server::{Reply, serve};

const KEY: &str = "test-access-key";

fn raw(id: &str) -> Value {
    json!({
        "id": id,
        "urls": {
            "thumb": format!("https://images.unsplash.com/{id}?w=200"),
            "small": format!("https://images.unsplash.com/{id}?w=400"),
            "regular": format!("https://images.unsplash.com/{id}?w=1080"),
        },
        "links": {
            "download_location": format!("https://api.unsplash.com/photos/{id}/download"),
            "html": format!("https://unsplash.com/photos/{id}"),
        },
        "user": { "name": "Ada Lovelace" },
        "blur_hash": "LKO2ll",
        "width": 4000,
        "height": 3000,
    })
}

fn photo(id: &str) -> UnsplashPhoto {
    UnsplashPhoto {
        id: id.to_owned(),
        thumb_url: format!("https://images.unsplash.com/{id}?w=200"),
        preview_url: format!("https://images.unsplash.com/{id}?w=400"),
        full_url: format!("https://images.unsplash.com/{id}?w=1080"),
        download_location: format!("https://api.unsplash.com/photos/{id}/download"),
        author_name: "Ada Lovelace".to_owned(),
        html_url: format!("https://unsplash.com/photos/{id}"),
        blur_hash: Some("LKO2ll".to_owned()),
        width: 4000,
        height: 3000,
    }
}

fn request(query: &str, page: u32) -> SearchRequest {
    SearchRequest::parse(query, Some(page)).expect("a valid search")
}

fn results(ids: &[&str]) -> Reply {
    Reply::json(&json!({ "results": ids.iter().map(|id| raw(id)).collect::<Vec<_>>() }))
}

fn ids(page: &SearchPage) -> Vec<&str> {
    page.photos.iter().map(|p| p.id.as_str()).collect()
}

#[tokio::test]
async fn without_a_key_nothing_is_sent_and_the_probe_still_answers_not_configured() {
    let server = serve(|_| results(&["a"])).await;
    let unsplash = server.service(None);

    assert!(!unsplash.is_available());
    assert_eq!(
        unsplash.search(&request("mountains", 1)).await,
        Err(UnsplashFailure::NotConfigured)
    );
    // The empty query is the renderer's capability probe: without a key it must say so.
    assert_eq!(
        unsplash.search(&request("", 1)).await,
        Err(UnsplashFailure::NotConfigured)
    );
    assert_eq!(
        unsplash.fetch_photo(&photo("a")).await,
        Err(UnsplashFailure::NotConfigured)
    );
    assert!(server.seen().is_empty());
}

#[tokio::test]
async fn a_blank_query_with_a_key_answers_empty_without_a_request() {
    let server = serve(|_| results(&["a"])).await;
    let unsplash = server.service(Some(KEY));

    let page = unsplash
        .search(&request("   ", 1))
        .await
        .expect("empty page");

    assert_eq!(page.photos, []);
    assert_eq!(page.rate_limit_remaining, None);
    assert!(server.seen().is_empty());
    assert!(
        Unsplash::new(server.client.clone(), Some("  ".to_owned()))
            .search(&request("", 1))
            .await
            == Err(UnsplashFailure::NotConfigured)
    );
}

#[tokio::test]
async fn a_search_sends_the_client_id_and_returns_the_photos_with_the_remaining_quota() {
    let server = serve(|_| results(&["a", "b"]).with_header("X-Ratelimit-Remaining", "47")).await;
    let unsplash = server.service(Some(KEY));

    let page = unsplash
        .search(&request("  big mountains ", 2))
        .await
        .expect("a page");

    assert_eq!(page.photos, [photo("a"), photo("b")]);
    assert_eq!(page.rate_limit_remaining, Some(47));
    let seen = server.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].host, "api.unsplash.com");
    assert_eq!(
        seen[0].authorization.as_deref(),
        Some("Client-ID test-access-key")
    );
    assert_eq!(seen[0].accept_version.as_deref(), Some("v1"));
    let url = url::Url::parse(&format!("https://x{}", seen[0].target)).expect("target");
    assert_eq!(url.path(), "/search/photos");
    let query: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert_eq!(
        query,
        [
            ("query".to_owned(), "big mountains".to_owned()),
            ("page".to_owned(), "2".to_owned()),
            ("per_page".to_owned(), "30".to_owned()),
            ("content_filter".to_owned(), "high".to_owned()),
        ]
    );
}

#[tokio::test]
async fn a_missing_quota_header_is_none() {
    let server = serve(|_| results(&["a"])).await;
    let page = server
        .service(Some(KEY))
        .search(&request("mountains", 1))
        .await
        .expect("a page");
    assert_eq!(page.rate_limit_remaining, None);
}

#[tokio::test]
async fn a_result_that_names_a_foreign_host_or_an_unsafe_id_is_dropped() {
    let mut foreign_ping = raw("evil1");
    foreign_ping["links"]["download_location"] = json!("https://other.example/steal");
    let mut foreign_image = raw("evil2");
    foreign_image["urls"]["regular"] = json!("https://other.example/photo.jpg");
    let mut http_image = raw("evil3");
    http_image["urls"]["thumb"] = json!("http://images.unsplash.com/photo.jpg");
    let mut credentials = raw("evil4");
    credentials["urls"]["small"] = json!("https://images.unsplash.com@other.example/photo.jpg");
    let mut traversal = raw("../../evil5");
    traversal["id"] = json!("../../evil5");
    let body = json!({ "results": [foreign_ping, foreign_image, http_image, credentials, traversal, raw("good")] });
    let server = serve(move |_| Reply::json(&body)).await;

    let page = server
        .service(Some(KEY))
        .search(&request("mountains", 1))
        .await
        .expect("a page");

    assert_eq!(ids(&page), ["good"]);
}

#[tokio::test]
async fn a_repeated_query_and_page_is_served_from_the_cache_and_another_page_is_not() {
    let server = serve(|_| results(&["a"])).await;
    let unsplash = server.service(Some(KEY));

    unsplash
        .search(&request("mountains", 2))
        .await
        .expect("first");
    unsplash
        .search(&request("mountains", 2))
        .await
        .expect("cached");
    assert_eq!(server.seen().len(), 1);

    unsplash
        .search(&request("mountains", 1))
        .await
        .expect("page 1");
    unsplash
        .search(&request("lakes", 2))
        .await
        .expect("other query");
    assert_eq!(server.seen().len(), 3);
}

#[tokio::test]
async fn the_cache_holds_fifty_searches_and_forgets_the_oldest() {
    let server = serve(|_| results(&["a"])).await;
    let unsplash = server.service(Some(KEY));

    for n in 0..51 {
        unsplash
            .search(&request(&format!("query {n}"), 1))
            .await
            .expect("page");
    }
    assert_eq!(server.seen().len(), 51);
    unsplash
        .search(&request("query 50", 1))
        .await
        .expect("newest");
    assert_eq!(server.seen().len(), 51, "the newest is still cached");
    unsplash
        .search(&request("query 0", 1))
        .await
        .expect("oldest");
    assert_eq!(server.seen().len(), 52, "the oldest was evicted");
}

#[tokio::test]
async fn a_failure_is_not_cached() {
    let calls = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&calls);
    let server = serve(move |_| {
        let mut n = counter.lock().expect("n");
        *n += 1;
        if *n == 1 {
            Reply::status(500)
        } else {
            results(&["a"])
        }
    })
    .await;
    let unsplash = server.service(Some(KEY));

    assert_eq!(
        unsplash.search(&request("mountains", 1)).await,
        Err(UnsplashFailure::Failed)
    );
    assert!(unsplash.search(&request("mountains", 1)).await.is_ok());
    assert_eq!(server.seen().len(), 2);
}

#[tokio::test]
async fn http_failures_map_to_the_contracts_reasons() {
    type Case = (&'static str, fn() -> Reply, UnsplashFailure);
    let cases: [Case; 8] = [
        ("429", || Reply::status(429), UnsplashFailure::RateLimited),
        (
            "403 with the quota spent",
            || Reply::status(403).with_header("X-Ratelimit-Remaining", "0"),
            UnsplashFailure::RateLimited,
        ),
        (
            "403 saying rate limit",
            || Reply::Ok {
                status: 403,
                headers: Vec::new(),
                body: br#"{"errors":["Rate Limit Exceeded"]}"#.to_vec(),
            },
            UnsplashFailure::RateLimited,
        ),
        (
            "403 for another reason",
            || Reply::Ok {
                status: 403,
                headers: Vec::new(),
                body: br#"{"errors":["Forbidden"]}"#.to_vec(),
            },
            UnsplashFailure::Failed,
        ),
        ("500", || Reply::status(500), UnsplashFailure::Failed),
        (
            "no results array",
            || Reply::json(&json!({ "errors": ["nope"] })),
            UnsplashFailure::Failed,
        ),
        (
            "not json",
            || Reply::image("text/html", b"<html>"),
            UnsplashFailure::Failed,
        ),
        ("a hangup", || Reply::Hangup, UnsplashFailure::Offline),
    ];
    for (name, reply, expected) in cases {
        let server = serve(move |_| reply()).await;
        assert_eq!(
            server
                .service(Some(KEY))
                .search(&request("mountains", 1))
                .await,
            Err(expected),
            "{name}"
        );
    }
}

#[tokio::test]
async fn an_unreachable_network_is_offline() {
    let server = serve(|_| results(&["a"])).await;
    let dead = {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        probe.local_addr().expect("addr")
    };
    let client = reqwest::Client::builder()
        .tls_backend_rustls()
        .no_proxy()
        .resolve("api.unsplash.com", dead)
        .build()
        .expect("client");
    drop(server);

    assert_eq!(
        Unsplash::new(client, Some(KEY.to_owned()))
            .search(&request("mountains", 1))
            .await,
        Err(UnsplashFailure::Offline)
    );
}

#[tokio::test]
async fn a_redirect_away_from_the_api_fails_and_never_carries_the_key() {
    let server = serve(|seen| {
        if seen.host == "api.unsplash.com" {
            Reply::status(302).with_header("location", "https://other.example/search/photos")
        } else {
            results(&["a"])
        }
    })
    .await;

    assert_eq!(
        server
            .service(Some(KEY))
            .search(&request("mountains", 1))
            .await,
        Err(UnsplashFailure::Failed)
    );
    for seen in server.seen().iter().filter(|s| s.host == "other.example") {
        assert_eq!(seen.authorization, None, "the key followed the redirect");
    }
}

#[tokio::test]
async fn a_download_pings_once_with_the_key_then_fetches_the_bytes_without_it() {
    let server = serve(|seen| {
        if seen.host == "api.unsplash.com" {
            Reply::json(&json!({ "url": "https://images.unsplash.com/a" }))
        } else {
            Reply::image("image/png; charset=binary", &[9, 9])
        }
    })
    .await;

    let fetched = server
        .service(Some(KEY))
        .fetch_photo(&photo("abc123"))
        .await
        .expect("a photo");

    assert_eq!(fetched.bytes, [9, 9]);
    assert_eq!(fetched.filename, "unsplash-abc123.png");
    assert_eq!(fetched.credit.name, "Ada Lovelace");
    assert_eq!(fetched.credit.url, "https://unsplash.com/photos/abc123");
    let seen = server.seen();
    assert_eq!(
        seen.iter()
            .map(|s| (s.host.as_str(), s.target.as_str()))
            .collect::<Vec<_>>(),
        [
            ("api.unsplash.com", "/photos/abc123/download"),
            ("images.unsplash.com", "/abc123?w=1080"),
        ]
    );
    assert_eq!(
        seen[0].authorization.as_deref(),
        Some("Client-ID test-access-key")
    );
    assert_eq!(seen[1].authorization, None, "the CDN never sees the key");
}

#[tokio::test]
async fn a_failed_ping_does_not_block_the_cover() {
    for ping in [|| Reply::status(500), || Reply::Hangup] {
        let server = serve(move |seen| {
            if seen.host == "api.unsplash.com" {
                ping()
            } else {
                Reply::image("image/webp", &[1, 2, 3])
            }
        })
        .await;

        let fetched = server
            .service(Some(KEY))
            .fetch_photo(&photo("abc123"))
            .await
            .expect("the cover is saved anyway");

        assert_eq!(fetched.filename, "unsplash-abc123.webp");
        assert_eq!(server.seen().len(), 2);
    }
}

#[tokio::test]
async fn a_body_that_is_not_an_image_is_refused() {
    for content_type in [
        "text/html; charset=utf-8",
        "application/octet-stream",
        "image/svg+xml",
    ] {
        let server = serve(move |seen| {
            if seen.host == "api.unsplash.com" {
                Reply::status(200)
            } else {
                Reply::image(content_type, b"<html>sign in to the wifi</html>")
            }
        })
        .await;
        assert_eq!(
            server
                .service(Some(KEY))
                .fetch_photo(&photo("abc123"))
                .await,
            Err(UnsplashFailure::Failed),
            "{content_type}"
        );
    }
}

#[tokio::test]
async fn a_photo_redirected_off_the_image_hosts_is_refused() {
    let server = serve(|seen| match seen.host.as_str() {
        "api.unsplash.com" => Reply::status(200),
        "images.unsplash.com" => {
            Reply::status(302).with_header("location", "https://other.example/photo.jpg")
        }
        _ => Reply::image("image/jpeg", &[1, 2, 3]),
    })
    .await;

    assert_eq!(
        server
            .service(Some(KEY))
            .fetch_photo(&photo("abc123"))
            .await,
        Err(UnsplashFailure::Failed)
    );
}

#[tokio::test]
async fn a_photo_that_leaves_the_allowlist_is_refused_before_any_request() {
    let server = serve(|_| Reply::status(200)).await;
    let unsplash = server.service(Some(KEY));
    let mut steals_the_key = photo("a");
    steals_the_key.download_location = "https://other.example/steal".to_owned();
    let mut foreign_bytes = photo("b");
    foreign_bytes.full_url = "https://other.example/b.jpg".to_owned();
    let mut plain_http = photo("c");
    plain_http.download_location = "http://api.unsplash.com/photos/c/download".to_owned();
    let mut odd_id = photo("d");
    odd_id.id = "../d".to_owned();

    for bad in [steals_the_key, foreign_bytes, plain_http, odd_id] {
        assert_eq!(
            unsplash.fetch_photo(&bad).await,
            Err(UnsplashFailure::Failed)
        );
    }
    assert!(server.seen().is_empty(), "{:?}", server.seen());
}

#[tokio::test]
async fn a_photo_fetch_maps_a_rate_limit_and_a_server_error() {
    for (status, expected) in [
        (429, UnsplashFailure::RateLimited),
        (500, UnsplashFailure::Failed),
    ] {
        let server = serve(move |seen| {
            if seen.host == "api.unsplash.com" {
                Reply::status(200)
            } else {
                Reply::status(status)
            }
        })
        .await;
        assert_eq!(
            server.service(Some(KEY)).fetch_photo(&photo("a")).await,
            Err(expected)
        );
    }
}

#[tokio::test]
async fn a_search_body_over_the_cap_fails_whether_or_not_it_declares_its_length() {
    let declared = serve(|_| Reply::Ok {
        status: 200,
        headers: Vec::new(),
        // Valid JSON, so only the cap can fail it.
        body: format!(
            r#"{{"results":[],"pad":"{}"}}"#,
            "x".repeat(4 * 1024 * 1024)
        )
        .into_bytes(),
    })
    .await;
    assert_eq!(
        declared
            .service(Some(KEY))
            .search(&request("mountains", 1))
            .await,
        Err(UnsplashFailure::Failed)
    );

    let undeclared = serve(|_| Reply::Undeclared {
        head: r#"{"results":[],"pad":""#,
        bytes: 4 * 1024 * 1024,
        tail: r#""}"#,
    })
    .await;
    assert_eq!(
        undeclared
            .service(Some(KEY))
            .search(&request("mountains", 1))
            .await,
        Err(UnsplashFailure::Failed)
    );
}

#[tokio::test]
async fn a_photo_over_the_cap_fails_whether_or_not_it_declares_its_length() {
    const OVER: usize = 16 * 1024 * 1024 + 1;
    for undeclared in [false, true] {
        let server = serve(move |seen| {
            if seen.host == "api.unsplash.com" {
                Reply::status(200)
            } else if undeclared {
                Reply::Undeclared {
                    head: "",
                    bytes: OVER,
                    tail: "",
                }
            } else {
                Reply::image("image/jpeg", &vec![b'x'; OVER])
            }
        })
        .await;
        assert_eq!(
            server.service(Some(KEY)).fetch_photo(&photo("a")).await,
            Err(UnsplashFailure::Failed),
            "undeclared: {undeclared}"
        );
    }
}

#[test]
fn a_deeply_nested_body_fails_closed_on_a_small_stack() {
    let outcome = memry_test_kit::on_small_stack(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let depth = 200_000;
                let body = format!(
                    r#"{{"results":{}{}}}"#,
                    "[".repeat(depth),
                    "]".repeat(depth)
                );
                let server = serve(move |_| Reply::Ok {
                    status: 200,
                    headers: Vec::new(),
                    body: body.clone().into_bytes(),
                })
                .await;
                server
                    .service(Some(KEY))
                    .search(&request("mountains", 1))
                    .await
            })
    });
    assert_eq!(outcome, Err(UnsplashFailure::Failed));
}

#[test]
fn a_search_is_bounded_like_the_contract() {
    let long = "x".repeat(201);
    assert_eq!(
        SearchRequest::parse(&long, None),
        Err(InvalidSearch::QueryTooLong)
    );
    assert!(SearchRequest::parse(&"x".repeat(200), None).is_ok());
    assert!(SearchRequest::parse(&"é".repeat(200), None).is_ok());
    for page in [0, 101] {
        assert_eq!(
            SearchRequest::parse("a", Some(page)),
            Err(InvalidSearch::PageOutOfRange)
        );
    }
    assert!(SearchRequest::parse("a", Some(1)).is_ok());
    assert!(SearchRequest::parse("a", Some(100)).is_ok());
}
