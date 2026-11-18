//! The Readwise client and token against a local HTTP server, through the real `reqwest` client
//! (`apps/desktop/src/main/readwise/client.test.ts`, `connection.test.ts`, `secrets.test.ts`).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_core::api::errors::SecureStoreError;
use memry_desktop::readwise::client::{
    MAX_PAGE_BYTES, ReadwiseClient, ReadwiseError, ReadwiseErrorKind,
};
use memry_desktop::readwise::limiter::RequestLimiter;
use memry_desktop::readwise::token::{
    ConnectError, NoVaultPath, ReadwiseToken, TOKEN_SERVICE, token_account,
};
use memry_desktop::seams::secure_store::GenericSecrets;
use memry_test_kit::on_small_stack;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use url::Url;

#[derive(Debug, Clone)]
struct Seen {
    target: String,
    authorization: Option<String>,
}

impl Seen {
    fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }

    fn query(&self) -> Vec<(String, String)> {
        let url = Url::parse(&format!("http://h{}", self.target)).unwrap();
        url.query_pairs().into_owned().collect()
    }

    fn param(&self, name: &str) -> Option<String> {
        self.query()
            .into_iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }
}

enum Reply {
    Answer {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
    },
    /// Closes the connection without answering.
    Hangup,
    /// Declares a body of this many bytes and closes the connection without sending it.
    Declared(usize),
    /// Reads the request and never answers, holding the connection.
    Stall,
}

impl Reply {
    fn json(status: u16, value: &Value) -> Self {
        Self::Answer {
            status,
            headers: Vec::new(),
            body: value.to_string().into_bytes(),
        }
    }

    fn status(status: u16) -> Self {
        Self::Answer {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    fn page(results: Value, next: Option<&str>) -> Self {
        Self::json(200, &json!({ "results": results, "nextPageCursor": next }))
    }

    fn retry_after(value: Option<&str>) -> Self {
        Self::Answer {
            status: 429,
            headers: value
                .map(|v| ("retry-after", v.to_owned()))
                .into_iter()
                .collect(),
            body: Vec::new(),
        }
    }
}

type Script = Arc<dyn Fn(&Seen, usize) -> Reply + Send + Sync>;

struct Server {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    async fn start(script: impl Fn(&Seen, usize) -> Reply + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let script: Script = Arc::new(script);
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let (script, log) = (Arc::clone(&script), Arc::clone(&log));
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match socket.read(&mut buf).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    let head = String::from_utf8_lossy(&head).into_owned();
                    let mut lines = head.split("\r\n");
                    let target = lines.next().unwrap().split(' ').nth(1).unwrap().to_owned();
                    let authorization = lines
                        .filter_map(|line| line.split_once(':'))
                        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                        .map(|(_, value)| value.trim().to_owned());
                    let seen = Seen {
                        target,
                        authorization,
                    };
                    let n = {
                        let mut log = log.lock().unwrap();
                        log.push(seen.clone());
                        log.len() - 1
                    };
                    let response = match script(&seen, n) {
                        Reply::Hangup => return,
                        Reply::Stall => {
                            tokio::time::sleep(Duration::from_secs(3600)).await;
                            return;
                        }
                        Reply::Declared(len) => format!(
                            "HTTP/1.1 200 OK\r\ncontent-length: {len}\r\nconnection: close\r\n\r\n"
                        )
                        .into_bytes(),
                        Reply::Answer {
                            status,
                            headers,
                            body,
                        } => {
                            let mut out = format!(
                                "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n",
                                body.len()
                            );
                            for (name, value) in headers {
                                out.push_str(&format!("{name}: {value}\r\n"));
                            }
                            out.push_str("\r\n");
                            let mut out = out.into_bytes();
                            out.extend_from_slice(&body);
                            out
                        }
                    };
                    let _ = socket.write_all(&response).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self { addr, seen }
    }

    fn client(&self) -> ReadwiseClient {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = memry_desktop::http::builder().no_proxy().build().unwrap();
        ReadwiseClient::with_origin(http, Url::parse(&format!("http://{}", self.addr)).unwrap())
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn never() -> CancellationToken {
    CancellationToken::new()
}

fn books(ids: impl IntoIterator<Item = i64>) -> Value {
    ids.into_iter()
        .map(|id| json!({ "user_book_id": id, "title": format!("Book {id}"), "highlights": [] }))
        .collect()
}

fn reader_limiter() -> Arc<RequestLimiter> {
    Arc::new(RequestLimiter::new(1000, Duration::from_secs(60)))
}

#[tokio::test(flavor = "multi_thread")]
async fn verify_token_sends_the_token_header_to_the_auth_endpoint_and_accepts_204() {
    let server = Server::start(|_, _| Reply::status(204)).await;
    server.client().verify_token("abc", &never()).await.unwrap();
    let seen = server.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].target, "/api/v2/auth/");
    assert_eq!(seen[0].authorization.as_deref(), Some("Token abc"));
}

#[tokio::test(flavor = "multi_thread")]
async fn each_failure_has_its_kind() {
    let server = Server::start(|seen, _| match seen.authorization.as_deref() {
        Some("Token bad") => Reply::json(401, &json!({ "detail": "Invalid token." })),
        Some("Token lapsed") => {
            Reply::json(403, &json!({ "detail": "Your subscription has expired" }))
        }
        Some("Token html") => Reply::Answer {
            status: 401,
            headers: Vec::new(),
            body: b"<html>".to_vec(),
        },
        Some("Token boom") => Reply::status(502),
        _ => Reply::Hangup,
    })
    .await;
    let client = server.client();
    let kind = |token: &'static str| {
        let client = client.clone();
        async move { client.verify_token(token, &never()).await.unwrap_err() }
    };
    assert!(matches!(
        kind("bad").await,
        ReadwiseError::InvalidToken { status: 401 }
    ));
    assert!(matches!(
        kind("lapsed").await,
        ReadwiseError::SubscriptionExpired { status: 403 }
    ));
    assert!(matches!(
        kind("html").await,
        ReadwiseError::InvalidToken { status: 401 }
    ));
    assert!(matches!(
        kind("boom").await,
        ReadwiseError::Status { status: 502 }
    ));
    let hung = kind("hang").await;
    assert_eq!(hung.kind(), Some(ReadwiseErrorKind::Network));
    // A token no header can carry fails at send, as Electron's `fetch` throws.
    assert_eq!(kind("a\nb").await.kind(), Some(ReadwiseErrorKind::Network));
    assert_eq!(
        ReadwiseError::Status { status: 502 }.kind(),
        Some(ReadwiseErrorKind::Server)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn export_pages_follow_the_cursor_and_send_the_filters_only_when_asked() {
    let server = Server::start(|seen, _| match seen.param("pageCursor").as_deref() {
        None => Reply::page(books([1]), Some("c1")),
        Some("c1") => Reply::page(books([2]), Some("c2")),
        _ => Reply::page(books([3]), None),
    })
    .await;
    let client = server.client();
    let mut pages = client.export_pages("t", Some("2026-01-01T00:00:00Z"), true);
    let mut ids = Vec::new();
    while let Some(page) = pages.next(&never()).await.unwrap() {
        ids.extend(page.iter().map(|book| book.user_book_id));
    }
    assert_eq!(ids, [1, 2, 3]);
    let seen = server.seen();
    assert_eq!(seen.len(), 3);
    for request in &seen {
        assert_eq!(request.path(), "/api/v2/export/");
        assert_eq!(
            request.param("updatedAfter").as_deref(),
            Some("2026-01-01T00:00:00Z")
        );
        assert_eq!(request.param("includeDeleted").as_deref(), Some("true"));
    }
    assert_eq!(seen[2].param("pageCursor").as_deref(), Some("c2"));

    let mut pages = client.export_pages("t", None, false);
    while pages.next(&never()).await.unwrap().is_some() {}
    let first = &server.seen()[3];
    assert_eq!(first.query(), Vec::<(String, String)>::new());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repeated_cursor_ends_the_paging_after_handing_out_its_page() {
    // Past 50 requests the server fails, so a client without the guard ends on HTTP 500.
    let server = Server::start(|seen, n| match (n, seen.param("pageCursor")) {
        (50.., _) => Reply::status(500),
        (_, None) => Reply::page(books([1]), Some("c1")),
        (_, Some(_)) => Reply::page(books([2]), Some("c1")),
    })
    .await;
    let mut pages = server.client().export_pages("t", None, false);
    assert!(pages.next(&never()).await.unwrap().is_some());
    assert!(pages.next(&never()).await.unwrap().is_some());
    let error = pages.next(&never()).await.unwrap_err();
    assert!(matches!(error, ReadwiseError::RepeatedCursor), "{error:?}");
    // The error ends the stream: no restart from page 1 past the guard.
    assert!(pages.next(&never()).await.unwrap().is_none());
    assert_eq!(server.seen().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_page_in_an_unknown_shape_is_a_server_error() {
    let server = Server::start(|_, _| Reply::json(200, &json!({ "results": "nope" }))).await;
    let error = server
        .client()
        .export_pages("t", None, false)
        .next(&never())
        .await
        .unwrap_err();
    assert!(matches!(error, ReadwiseError::UnknownShape), "{error:?}");
    assert_eq!(error.kind(), Some(ReadwiseErrorKind::Server));
}

#[tokio::test(flavor = "multi_thread")]
async fn export_books_dedupes_batches_by_100_and_pages_inside_a_batch() {
    let server = Server::start(|seen, _| match seen.param("pageCursor") {
        None if seen.param("ids").unwrap().starts_with("1,") => {
            Reply::page(books([1]), Some("more"))
        }
        _ => Reply::page(books([]), None),
    })
    .await;
    let client = server.client();
    let ids: Vec<i64> = (1..=250).chain([5, 250, 1]).collect();
    let mut pages = client.export_books("t", &ids);
    while pages.next(&never()).await.unwrap().is_some() {}
    let batches: Vec<(Vec<i64>, Option<String>)> = server
        .seen()
        .iter()
        .map(|seen| {
            let ids = seen.param("ids").unwrap();
            (
                ids.split(',').map(|id| id.parse().unwrap()).collect(),
                seen.param("pageCursor"),
            )
        })
        .collect();
    assert_eq!(batches.len(), 4);
    assert_eq!(batches[0], ((1..=100).collect(), None));
    assert_eq!(batches[1], ((1..=100).collect(), Some("more".to_owned())));
    assert_eq!(batches[2], ((101..=200).collect(), None));
    assert_eq!(batches[3], ((201..=250).collect(), None));

    let mut none = client.export_books("t", &[]);
    assert!(none.next(&never()).await.unwrap().is_none());
    assert_eq!(server.seen().len(), 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_429_waits_and_retries_three_times_then_reports_its_capped_wait() {
    let server = Server::start(|_, n| match n {
        0..=2 => Reply::retry_after(Some("0")),
        _ => Reply::status(204),
    })
    .await;
    server.client().verify_token("t", &never()).await.unwrap();
    assert_eq!(server.seen().len(), 4);

    // The fourth 429 fails at once and reports the wait it asked for: 60 s when it named none.
    let server = Server::start(|_, n| match n {
        0..=2 => Reply::retry_after(Some("0")),
        _ => Reply::retry_after(None),
    })
    .await;
    let error = server
        .client()
        .verify_token("t", &never())
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            ReadwiseError::RateLimited {
                retry_after_secs: 60
            }
        ),
        "{error:?}"
    );
    assert_eq!(server.seen().len(), 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_oversized_retry_after_is_reported_capped_at_120_s() {
    let server = Server::start(|_, n| match n {
        0..=2 => Reply::retry_after(Some("0")),
        _ => Reply::retry_after(Some("999")),
    })
    .await;
    let error = server
        .client()
        .verify_token("t", &never())
        .await
        .unwrap_err();
    assert!(
        matches!(
            error,
            ReadwiseError::RateLimited {
                retry_after_secs: 120
            }
        ),
        "{error:?}"
    );
    assert_eq!(error.kind(), Some(ReadwiseErrorKind::RateLimited));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_with_no_answer_times_out_as_a_network_failure() {
    let server = Server::start(|_, _| Reply::Stall).await;
    let client = server
        .client()
        .with_request_timeout(Duration::from_millis(200));
    let error = client.verify_token("t", &never()).await.unwrap_err();
    assert!(
        matches!(&error, ReadwiseError::Network(source) if source.is_timeout()),
        "{error:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_throttle_is_awaited_before_every_attempt_a_retry_included() {
    let server = Server::start(|_, n| match n {
        0 | 1 => Reply::retry_after(Some("0")),
        _ => Reply::page(json!([{ "id": "d" }]), None),
    })
    .await;
    let limiter = Arc::new(RequestLimiter::new(2, Duration::from_secs(3600)));
    let cancel = CancellationToken::new();
    let call = {
        let (client, cancel) = (server.client(), cancel.clone());
        tokio::spawn(async move {
            client
                .reader_document("t", "d", false, limiter, &cancel)
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    cancel.cancel();
    let error = call.await.unwrap().unwrap_err();
    assert!(matches!(error, ReadwiseError::Cancelled), "{error:?}");
    assert_eq!(server.seen().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancel_during_the_retry_after_wait_ends_the_call_with_no_second_request() {
    let asked = Arc::new(Notify::new());
    let heard = Arc::clone(&asked);
    let server = Server::start(move |_, _| {
        heard.notify_one();
        Reply::retry_after(Some("100"))
    })
    .await;
    let cancel = CancellationToken::new();
    let call = {
        let (client, cancel) = (server.client(), cancel.clone());
        tokio::spawn(async move { client.verify_token("t", &cancel).await })
    };
    asked.notified().await;
    cancel.cancel();
    let error = call.await.unwrap().unwrap_err();
    assert!(matches!(error, ReadwiseError::Cancelled), "{error:?}");
    assert_eq!(error.kind(), None);
    assert_eq!(server.seen().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hostile_cursor_reaches_the_next_request_as_one_encoded_value() {
    let server = Server::start(|seen, _| match seen.param("pageCursor") {
        None => Reply::page(books([1]), Some("x&ids=1#f /?pageCursor=y")),
        Some(_) => Reply::page(books([]), None),
    })
    .await;
    let mut pages = server.client().export_pages("t", None, false);
    while pages.next(&never()).await.unwrap().is_some() {}
    let second = &server.seen()[1];
    assert_eq!(second.path(), "/api/v2/export/");
    assert_eq!(
        second.query(),
        [(
            "pageCursor".to_owned(),
            "x&ids=1#f /?pageCursor=y".to_owned()
        )]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_page_declared_over_the_cap_is_refused_before_it_is_read() {
    let server = Server::start(|_, _| Reply::Declared(MAX_PAGE_BYTES + 1)).await;
    let error = server
        .client()
        .export_pages("t", None, false)
        .next(&never())
        .await
        .unwrap_err();
    assert!(matches!(error, ReadwiseError::TooLarge), "{error:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn reader_pages_every_location_and_drops_children_and_feed_items() {
    let server = Server::start(|seen, _| {
        let location = seen.param("location");
        let results = match location.as_deref() {
            Some("new") => json!([
                { "id": "top", "location": "new", "tags": { "ai": { "name": "ai" } }, "html_content": "<p>x</p>" },
                { "id": "child", "parent_id": "top" },
                { "id": "fed", "location": "feed" },
            ]),
            Some(location) => json!([{ "id": location, "location": location }]),
            None => json!([]),
        };
        Reply::page(results, None)
    })
    .await;
    let mut documents =
        server
            .client()
            .reader_documents("t", Some("2026-02-02"), true, reader_limiter());
    let mut ids = Vec::new();
    while let Some(page) = documents.next(&never()).await.unwrap() {
        ids.extend(page.into_iter().map(|document| {
            if document.id == "top" {
                assert_eq!(document.html_content.as_deref(), Some("<p>x</p>"));
            }
            document.id
        }));
    }
    assert_eq!(ids, ["top", "later", "shortlist", "archive"]);
    let seen = server.seen();
    let locations: Vec<_> = seen.iter().map(|s| s.param("location").unwrap()).collect();
    assert_eq!(locations, ["new", "later", "shortlist", "archive"]);
    for request in &seen {
        assert_eq!(request.path(), "/api/v3/list/");
        assert_eq!(request.param("limit").as_deref(), Some("100"));
        assert_eq!(request.param("withHtmlContent").as_deref(), Some("true"));
        assert_eq!(request.param("updatedAfter").as_deref(), Some("2026-02-02"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reader_page_with_a_tag_electrons_schema_refuses_is_an_unknown_shape() {
    let server =
        Server::start(|_, _| Reply::page(json!([{ "id": "d", "tags": { "a": null } }]), None))
            .await;
    let mut documents = server
        .client()
        .reader_documents("t", None, false, reader_limiter());
    let error = documents.next(&never()).await.unwrap_err();
    assert!(matches!(error, ReadwiseError::UnknownShape), "{error:?}");
    assert!(documents.next(&never()).await.unwrap().is_none());
    assert_eq!(server.seen().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn reader_document_finds_a_top_level_document_by_id() {
    let server = Server::start(|seen, _| {
        let id = seen.param("id").unwrap();
        let row = match id.as_str() {
            "child" => json!({ "id": "child", "parent_id": "p" }),
            "gone" => json!({ "id": "other" }),
            _ => json!({ "id": id }),
        };
        Reply::page(json!([row]), None)
    })
    .await;
    let client = server.client();
    let get = |id: &'static str| {
        let client = client.clone();
        async move {
            client
                .reader_document("t", id, false, reader_limiter(), &never())
                .await
                .unwrap()
        }
    };
    assert_eq!(get("doc").await.map(|d| d.id).as_deref(), Some("doc"));
    assert!(get("child").await.is_none());
    assert!(get("gone").await.is_none());
    assert_eq!(
        server.seen()[0].query(),
        [("id".to_owned(), "doc".to_owned())]
    );
}

/// Each page is parsed on the thread that runs the client. On a 2 MiB stack, Reader `tags` (kept
/// as any JSON) nested far past `serde_json`'s recursion limit fail as an unknown shape, and an
/// unknown field nested as deep is skipped without recursion.
#[tokio::test(flavor = "multi_thread")]
async fn a_deeply_nested_page_fails_closed_on_a_small_stack() {
    let deep = |depth: usize| format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    let reader = format!(r#"{{"results":[{{"id":"d","tags":{}}}]}}"#, deep(200_000));
    let export = format!(
        r#"{{"results":[{{"user_book_id":1,"unknown":{}}}]}}"#,
        deep(200_000)
    );
    let server = Server::start(move |seen, _| Reply::Answer {
        status: 200,
        headers: Vec::new(),
        body: if seen.path() == "/api/v3/list/" {
            reader.clone()
        } else {
            export.clone()
        }
        .into_bytes(),
    })
    .await;
    let client = server.client();
    let errors = on_small_stack(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let reader = client
                .reader_documents("t", None, false, reader_limiter())
                .next(&never())
                .await;
            let export = client.export_pages("t", None, false).next(&never()).await;
            (reader.map(drop), export.map(drop))
        })
    });
    assert!(
        matches!(errors.0, Err(ReadwiseError::UnknownShape)),
        "{:?}",
        errors.0
    );
    assert!(errors.1.is_ok(), "{:?}", errors.1);
}

#[derive(Default)]
struct Keychain(Mutex<HashMap<(String, String), Vec<u8>>>);

impl GenericSecrets for Keychain {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Vec<u8>>, SecureStoreError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(&(service.to_owned(), account.to_owned()))
            .cloned())
    }

    fn set_secret(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<(), SecureStoreError> {
        self.0
            .lock()
            .unwrap()
            .insert((service.to_owned(), account.to_owned()), value.to_vec());
        Ok(())
    }

    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
        self.0
            .lock()
            .unwrap()
            .remove(&(service.to_owned(), account.to_owned()));
        Ok(())
    }
}

#[test]
fn the_token_account_is_electrons_derivation() {
    // `readwiseTokenAccountKey` in Node: sha256 of the path's UTF-8, first 16 hex digits.
    let notes = Path::new("/Users/kaan/Notes");
    assert_eq!(
        token_account(notes, None).unwrap(),
        "token-0bcb62358ecbb0c9"
    );
    assert_eq!(
        token_account(notes, Some("")).unwrap(),
        "token-0bcb62358ecbb0c9"
    );
    assert_eq!(
        token_account(notes, Some("b")).unwrap(),
        "token-0bcb62358ecbb0c9-b"
    );
    let turkish = Path::new("C:\\Users\\Kağan\\Notlar");
    assert_eq!(
        token_account(turkish, None).unwrap(),
        "token-57c3935ae14d51af"
    );
    assert_eq!(TOKEN_SERVICE, "com.memrynote.memry.readwise");
    // A blank path is refused, as `readwiseTokenAccountKey` throws.
    assert_eq!(token_account(Path::new(""), None), Err(NoVaultPath));
    assert_eq!(token_account(Path::new(" \t"), Some("b")), Err(NoVaultPath));
}

#[tokio::test(flavor = "multi_thread")]
async fn connect_stores_the_trimmed_token_only_after_readwise_accepts_it() {
    let server = Server::start(|seen, _| match seen.authorization.as_deref() {
        Some("Token good") => Reply::status(204),
        _ => Reply::json(401, &json!({ "detail": "Invalid token." })),
    })
    .await;
    let client = server.client();
    let keychain = Arc::new(Keychain::default());
    let vault = Path::new("/Users/kaan/Notes");
    let token = ReadwiseToken::new(keychain.clone(), vault, Some("a")).unwrap();

    let refused = token
        .connect(&client, "  wrong \n", &never())
        .await
        .unwrap_err();
    assert!(matches!(
        refused,
        ConnectError::Readwise(ReadwiseError::InvalidToken { .. })
    ));
    assert!(keychain.0.lock().unwrap().is_empty());
    assert!(token.read().unwrap().is_none());

    assert!(matches!(
        token.connect(&client, " \t", &never()).await,
        Err(ConnectError::Empty)
    ));
    assert_eq!(server.seen().len(), 1);

    token.connect(&client, "  good \n", &never()).await.unwrap();
    assert_eq!(
        server.seen()[1].authorization.as_deref(),
        Some("Token good")
    );
    let account = (
        "com.memrynote.memry.readwise".to_owned(),
        "token-0bcb62358ecbb0c9-a".to_owned(),
    );
    assert_eq!(
        keychain.0.lock().unwrap().get(&account).map(Vec::as_slice),
        Some(&b"good"[..])
    );
    assert_eq!(token.read().unwrap().as_deref(), Some("good"));

    token.disconnect().unwrap();
    assert!(token.read().unwrap().is_none());
}

#[test]
fn a_stored_token_that_is_not_utf8_reads_as_absent() {
    let keychain = Arc::new(Keychain::default());
    let vault = Path::new("/v");
    keychain
        .set_secret(
            TOKEN_SERVICE,
            &token_account(vault, None).unwrap(),
            &[0xff, 0xfe],
        )
        .unwrap();
    assert!(
        ReadwiseToken::new(keychain, vault, None)
            .unwrap()
            .read()
            .unwrap()
            .is_none()
    );
}
