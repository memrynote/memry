//! The Inbox web client against a local HTTP server: Electron's request headers, status and size
//! rules, deadlines, the Reddit rules (host names pinned to the server, so the production host
//! checks run), hero image downloads and the article extractor's blocking `Fetcher`.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use memry_desktop::services::web_fetch::{
    BlockingFetcher, CHROME_USER_AGENT, Limits, WebFetch, WebFetchError, decode_text,
    reddit_json_url, reddit_metadata_from_listing, rewrite_url_for_fetch,
};
use memry_desktop::web::extract::fetch::{FetchRequest, Fetcher};
use memry_test_kit::{on_small_stack, proptest_config};
use proptest::prelude::*;
use serde_json::{Value, json};

#[derive(Debug, Clone)]
struct Seen {
    method: String,
    host: String,
    target: String,
    headers: HeaderMap,
    body: Vec<u8>,
}

struct Server {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

const SMALL: Limits = Limits {
    page_timeout: Duration::from_millis(300),
    image_timeout: Duration::from_millis(300),
    max_html_bytes: 1024,
    max_image_bytes: 512,
};

fn listing() -> Value {
    json!([{ "data": { "children": [{ "data": {
        "title": "Rust 2.0 &amp; you",
        "selftext": "body text",
        "preview": { "images": [{ "source": { "url": "https://i.redd.it/x.png?a=1&amp;b=2" } }] },
        "thumbnail": "https://b.thumbs.redditmedia.com/t.jpg",
        "author": "ferris",
        "subreddit_name_prefixed": "r/rust",
        "created_utc": 1_700_000_000.0
    }}]}}])
}

async fn route(method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    let path = uri.path().to_owned();
    match path.as_str() {
        "/page" => (
            [("content-type", "text/html; charset=windows-1254")],
            b"<title>\xfd</title>".to_vec(),
        )
            .into_response(),
        "/forbidden" => (StatusCode::FORBIDDEN, "blocked").into_response(),
        "/declared-big" => ([("content-type", "text/html")], vec![b'x'; 2048]).into_response(),
        "/streamed-big" => {
            let chunks = (0..8).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![b'y'; 200])));
            Body::from_stream(futures_util::stream::iter(chunks)).into_response()
        }
        "/stall" => std::future::pending().await,
        "/redirect" => (StatusCode::FOUND, [("location", "/page")]).into_response(),
        "/echo" => (
            StatusCode::CREATED,
            format!(
                "{} {} {}",
                method,
                headers
                    .get("x-probe")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("-"),
                String::from_utf8_lossy(&body)
            ),
        )
            .into_response(),
        "/r/rust/comments/abc/title.json" => (
            [("content-type", "application/json")],
            listing().to_string(),
        )
            .into_response(),
        "/r/rust/comments/bad/title.json" => {
            (StatusCode::TOO_MANY_REQUESTS, "slow down").into_response()
        }
        "/r/rust/comments/deep/title.json" => "[".repeat(100_000).into_response(),
        "/r/rust/comments/bad/title/" => {
            ([("content-type", "text/html")], "<title>old</title>").into_response()
        }
        "/hero.png" => ([("content-type", "image/png")], vec![7u8; 100]).into_response(),
        "/hero-untyped.webp" => vec![8u8; 100].into_response(),
        "/hero-big" => ([("content-type", "image/png")], vec![9u8; 600]).into_response(),
        "/hero-streamed-big" => {
            let chunks = (0..6).map(|_| Ok::<_, std::io::Error>(Bytes::from(vec![9u8; 100])));
            Body::from_stream(futures_util::stream::iter(chunks)).into_response()
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn start() -> Server {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    let app = axum::Router::new().fallback(
        move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let record = record.clone();
            async move {
                record.lock().unwrap().push(Seen {
                    method: method.to_string(),
                    host: headers
                        .get("host")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_owned(),
                    target: uri.to_string(),
                    headers: headers.clone(),
                    body: body.to_vec(),
                });
                route(method, uri, headers, body).await
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server { addr, seen }
}

fn client(server: &Server) -> WebFetch {
    WebFetch::for_tests(
        SMALL,
        &[
            ("www.reddit.com", server.addr),
            ("reddit.com", server.addr),
            ("old.reddit.com", server.addr),
        ],
    )
    .unwrap()
}

#[tokio::test]
async fn article_html_sends_electrons_headers_and_decodes_the_declared_charset() {
    let server = start().await;
    let html = client(&server)
        .article_html(&server.url("/page"))
        .await
        .unwrap();
    assert_eq!(html, "<title>ı</title>");
    let seen = server.seen();
    let headers = &seen[0].headers;
    assert_eq!(headers["user-agent"], CHROME_USER_AGENT);
    assert_eq!(
        headers["accept"],
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    );
    assert_eq!(headers["accept-language"], "en-US,en;q=0.5");
}

#[tokio::test]
async fn a_refused_page_reports_the_status_without_the_url() {
    let server = start().await;
    let web = client(&server);
    let url = server.url("/forbidden");
    let article = web.article_html(&url).await.unwrap_err();
    let metadata = web.metadata_page(&url).await.unwrap_err();
    assert_eq!(article.to_string(), "Failed to fetch article HTML: 403");
    assert_eq!(metadata.to_string(), "HTTP 403");
    let missing = web
        .article_html("http://127.0.0.1:1/nothing-listens")
        .await
        .unwrap_err();
    assert!(matches!(missing, WebFetchError::Network(_)), "{missing:?}");
    assert!(!missing.to_string().contains("127.0.0.1"), "{missing}");
    assert_eq!(web.reddit_metadata("http://reddit.com:1/r/a").await, None);
}

#[tokio::test]
async fn html_over_the_cap_is_refused_by_length_and_while_streaming() {
    let server = start().await;
    let web = client(&server);
    assert_eq!(
        web.article_html(&server.url("/declared-big")).await,
        Err(WebFetchError::DeclaredTooLarge(2048))
    );
    assert_eq!(
        web.metadata_page(&server.url("/streamed-big")).await,
        Err(WebFetchError::TooLarge(1024))
    );
}

#[tokio::test]
async fn a_page_that_never_answers_times_out() {
    let server = start().await;
    let web = client(&server);
    assert_eq!(
        web.article_html(&server.url("/stall")).await,
        Err(WebFetchError::Timeout)
    );
}

#[tokio::test]
async fn redirects_are_followed() {
    let server = start().await;
    let html = client(&server)
        .metadata_page(&server.url("/redirect"))
        .await
        .unwrap();
    assert_eq!(html, "<title>ı</title>");
}

#[tokio::test]
async fn a_reddit_post_comes_from_its_json_listing() {
    let server = start().await;
    let port = server.addr.port();
    let url = format!("http://www.reddit.com:{port}/r/rust/comments/abc/title/?utm=1");
    let metadata = client(&server).reddit_metadata(&url).await.unwrap();
    assert_eq!(
        server.seen()[0].target,
        "/r/rust/comments/abc/title.json?utm=1"
    );
    assert_eq!(server.seen()[0].headers["user-agent"], CHROME_USER_AGENT);
    assert_eq!(metadata.title.as_deref(), Some("Rust 2.0 &amp; you"));
    assert_eq!(metadata.description.as_deref(), Some("body text"));
    assert_eq!(
        metadata.image.as_deref(),
        Some("https://i.redd.it/x.png?a=1&b=2")
    );
    assert_eq!(metadata.author.as_deref(), Some("u/ferris"));
    assert_eq!(metadata.publisher.as_deref(), Some("r/rust"));
    assert_eq!(metadata.date.as_deref(), Some("2023-11-14T22:13:20.000Z"));
    assert_eq!(
        metadata.logo.as_deref(),
        Some("https://www.redditstatic.com/desktop2x/img/favicon/favicon-32x32.png")
    );
    assert_eq!(metadata.url.as_deref(), Some(url.as_str()));
}

#[tokio::test]
async fn a_failed_reddit_listing_falls_back_to_old_reddit_html() {
    let server = start().await;
    let port = server.addr.port();
    let web = client(&server);
    let url = format!("http://www.reddit.com:{port}/r/rust/comments/bad/title/");
    assert_eq!(web.reddit_metadata(&url).await, None);
    let deep = format!("http://reddit.com:{port}/r/rust/comments/deep/title");
    assert_eq!(web.reddit_metadata(&deep).await, None);
    assert_eq!(web.metadata_page(&url).await.unwrap(), "<title>old</title>");
    let seen = server.seen();
    let last = seen.last().unwrap();
    assert_eq!(last.host, format!("old.reddit.com:{port}"));
    assert_eq!(last.target, "/r/rust/comments/bad/title/");
}

#[test]
fn reddit_urls_are_rewritten_like_electron() {
    assert_eq!(
        reddit_json_url("https://www.reddit.com/r/a/comments/b/c/"),
        "https://www.reddit.com/r/a/comments/b/c.json"
    );
    assert_eq!(
        reddit_json_url("https://reddit.com/r/a/comments/b/c?x=1/2"),
        "https://reddit.com/r/a/comments/b/c.json?x=1/2"
    );
    assert_eq!(
        reddit_json_url("https://reddit.com/r/a"),
        "https://reddit.com/r/a.json"
    );
    assert_eq!(
        rewrite_url_for_fetch("https://www.reddit.com/r/a?b#c"),
        "https://old.reddit.com/r/a?b#c"
    );
    assert_eq!(
        rewrite_url_for_fetch("https://REDDIT.com/r/a"),
        "https://old.reddit.com/r/a"
    );
    assert_eq!(
        rewrite_url_for_fetch("https://old.reddit.com/r/a"),
        "https://old.reddit.com/r/a"
    );
    assert_eq!(
        rewrite_url_for_fetch("https://example.com/x"),
        "https://example.com/x"
    );
    assert_eq!(rewrite_url_for_fetch("not a url"), "not a url");
}

#[test]
fn reddit_listing_fields_follow_electrons_fallbacks() {
    let url = "https://www.reddit.com/r/x/comments/1/t/";
    let self_post = json!([{ "data": { "children": [{ "data": {
        "title": "", "selftext": "", "thumbnail": "self", "author": "", "created_utc": 0
    }}]}}]);
    let metadata = reddit_metadata_from_listing(&self_post, url).unwrap();
    assert_eq!(metadata.title, None);
    assert_eq!(metadata.description, None);
    assert_eq!(metadata.image, None);
    assert_eq!(metadata.author, None);
    assert_eq!(metadata.date, None);
    assert_eq!(metadata.publisher.as_deref(), Some("Reddit"));

    let thumb_only = json!([{ "data": { "children": [{ "data": { "thumbnail": "https://t/x.jpg", "preview": { "images": [{ "source": { "url": "" } }] } } }] } }]);
    assert_eq!(
        reddit_metadata_from_listing(&thumb_only, url)
            .unwrap()
            .image
            .as_deref(),
        Some("https://t/x.jpg")
    );

    let out_of_range =
        json!([{ "data": { "children": [{ "data": { "title": "t", "created_utc": 1e13 } }] } }]);
    assert_eq!(
        reddit_metadata_from_listing(&out_of_range, url),
        None,
        "toISOString throws"
    );

    for empty in [
        json!([]),
        json!({}),
        json!([{ "data": { "children": [] } }]),
        json!(null),
        json!("x"),
    ] {
        assert_eq!(reddit_metadata_from_listing(&empty, url), None, "{empty}");
    }
}

#[tokio::test]
async fn a_hero_image_is_saved_as_thumbnail_with_its_extension() {
    let server = start().await;
    let web = client(&server);
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("attachments/inbox/item-1");
    assert_eq!(
        web.download_image(&server.url("/hero.png"), &dest)
            .await
            .as_deref(),
        Some("thumbnail.png")
    );
    assert_eq!(
        std::fs::read(dest.join("thumbnail.png")).unwrap(),
        vec![7u8; 100]
    );
    assert_eq!(server.seen()[0].headers["accept"], "image/*");
    assert_eq!(
        web.download_image(&server.url("/hero-untyped.webp"), &dest)
            .await
            .as_deref(),
        Some("thumbnail.webp")
    );
}

#[tokio::test]
async fn a_failed_hero_download_leaves_no_file() {
    let server = start().await;
    let web = client(&server);
    let dir = tempfile::tempdir().unwrap();
    for path in ["/missing.png", "/hero-big", "/hero-streamed-big", "/stall"] {
        assert_eq!(
            web.download_image(&server.url(path), dir.path()).await,
            None,
            "{path}"
        );
    }
    assert_eq!(
        web.download_image("data:image/png;base64,AAAA", dir.path())
            .await,
        None
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_blocking_fetcher_serves_extraction_from_a_blocking_thread() {
    let server = start().await;
    let fetcher = BlockingFetcher::new(client(&server), tokio::runtime::Handle::current());
    let echo = server.url("/echo");
    let missing = server.url("/missing");
    let (posted, absent) = tokio::task::spawn_blocking(move || {
        let posted = fetcher.fetch(FetchRequest {
            url: echo,
            method: "POST".into(),
            headers: vec![("x-probe".into(), "yes".into())],
            body: Some(b"payload".to_vec()),
        });
        let absent = fetcher.fetch(FetchRequest {
            url: missing,
            method: "GET".into(),
            headers: Vec::new(),
            body: None,
        });
        (posted, absent)
    })
    .await
    .unwrap();
    let posted = posted.unwrap();
    assert_eq!(
        (posted.status, posted.ok, posted.text.as_str()),
        (201, true, "POST yes payload")
    );
    let absent = absent.unwrap();
    assert_eq!((absent.status, absent.ok), (404, false));
    assert_eq!(server.seen()[0].method, "POST");
    assert_eq!(server.seen()[0].body, b"payload");
}

#[test]
fn a_deeply_nested_reddit_listing_fails_closed_on_a_small_stack() {
    let outcome = on_small_stack(|| {
        let nested = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
        serde_json::from_str::<Value>(&nested)
            .ok()
            .and_then(|listing| reddit_metadata_from_listing(&listing, "https://reddit.com/r/a"))
    });
    assert_eq!(outcome, None);
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn decoding_any_body_never_fails(body in proptest::collection::vec(any::<u8>(), 0..512), label in "[a-z0-9-]{0,16}") {
        let text = decode_text(&body, Some(&format!("text/html; charset={label}")));
        prop_assert!(text.len() <= body.len() * 3 + 3);
    }

    #[test]
    fn the_json_url_ends_the_path_in_json(path in "[a-z/]{0,20}", query in proptest::option::of("[a-z=&/?]{0,12}")) {
        let url = format!("https://reddit.com/{path}{}", query.as_deref().map(|q| format!("?{q}")).unwrap_or_default());
        let base = format!("https://reddit.com/{path}");
        let expected = format!(
            "{}.json{}",
            base.strip_suffix('/').unwrap_or(&base),
            query.map(|q| format!("?{q}")).unwrap_or_default()
        );
        prop_assert_eq!(reddit_json_url(&url), expected);
    }
}
