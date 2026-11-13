//! The inline chat's provider proxy against a local fake provider: a path cannot leave the
//! provider's address, the renderer's auth headers are dropped and the stored key is added in
//! the provider's own header, the body streams through as it arrives, and a cancel, a gone
//! renderer or a vault close ends the upstream request.

use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::proxy::{
    AiProviderRequest, AiProxy, Frame, HeaderPair, HttpMethod, ProxyError, prepare, target,
};
use memry_desktop::ai::settings::InlineAiSettings;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

/// Watchdog on one wait, not a budget.
const WAIT: Duration = Duration::from_secs(10);
const KEY: &str = "sk-stored-secret";

fn proxy() -> Arc<AiProxy> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    AiProxy::new(memry_desktop::http::builder().no_proxy())
}

fn settings(provider: AiProvider, base: &str, key: &str) -> InlineAiSettings {
    InlineAiSettings {
        enabled: true,
        provider,
        model: "m".to_owned(),
        api_key: key.to_owned(),
        base_url: base.to_owned(),
    }
}

fn request(id: &str, provider: AiProvider, path: &str) -> AiProviderRequest {
    AiProviderRequest {
        request_id: id.to_owned(),
        provider,
        method: HttpMethod::Post,
        path: path.to_owned(),
        headers: vec![
            pair("content-type", "application/json"),
            pair("Authorization", "Bearer renderer-dummy"),
            pair("x-api-key", "renderer-dummy"),
            pair("X-Goog-Api-Key", "renderer-dummy"),
            pair("host", "evil.example"),
            pair("accept-encoding", "gzip"),
        ],
        body: Some(r#"{"stream":true}"#.to_owned()),
    }
}

fn pair(name: &str, value: &str) -> HeaderPair {
    HeaderPair {
        name: name.to_owned(),
        value: value.to_owned(),
    }
}

/// Frames into a channel the test reads; `alive` false makes the sink report the renderer gone.
fn sink(
    alive: Arc<AtomicBool>,
) -> (
    memry_desktop::ai::proxy::Sink,
    mpsc::UnboundedReceiver<Frame>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    let sink = Box::new(move |frame: Frame| {
        let _ = tx.send(frame);
        alive.load(Ordering::SeqCst)
    });
    (sink, rx)
}

async fn next(rx: &mut mpsc::UnboundedReceiver<Frame>) -> Frame {
    tokio::time::timeout(WAIT, rx.recv())
        .await
        .expect("a frame in time")
        .expect("the sink is open")
}

/// Set when the provider's response body is dropped: the client went away.
#[derive(Clone, Default)]
struct Dropped(Arc<AtomicBool>);

struct DropFlag(Dropped);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.0.store(true, Ordering::SeqCst);
    }
}

impl Dropped {
    async fn wait(&self) {
        tokio::time::timeout(WAIT, async {
            while !self.0.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the upstream request ended");
    }
}

/// What the fake provider does on `POST /v1/chat`.
#[derive(Clone, Copy)]
enum Answer {
    /// Three chunks, one per `release`, then the end.
    Chunks,
    /// One chunk, then nothing until the client leaves.
    Hang,
    /// No head until the client leaves.
    NoHead,
    /// A redirect to `/v1/elsewhere`.
    Redirect,
}

struct Fake {
    base: String,
    seen: Arc<Mutex<Vec<HeaderMap>>>,
    elsewhere: Arc<AtomicBool>,
    dropped: Dropped,
    release: mpsc::UnboundedSender<()>,
}

async fn fake(answer: Answer) -> Fake {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let elsewhere = Arc::new(AtomicBool::new(false));
    let dropped = Dropped::default();
    let (release, gate) = mpsc::unbounded_channel::<()>();
    let gate = Arc::new(tokio::sync::Mutex::new(gate));
    let app = {
        let (seen, dropped, elsewhere) = (seen.clone(), dropped.clone(), elsewhere.clone());
        Router::new()
            .route(
                "/v1/chat",
                post(move |headers: HeaderMap| {
                    let (seen, dropped, gate) = (seen.clone(), dropped.clone(), gate.clone());
                    async move {
                        seen.lock().unwrap().push(headers);
                        let flag = DropFlag(dropped);
                        match answer {
                            Answer::NoHead => {
                                let _flag = flag;
                                std::future::pending::<()>().await;
                                unreachable!()
                            }
                            Answer::Redirect => (
                                StatusCode::FOUND,
                                [(axum::http::header::LOCATION, "/v1/elsewhere")],
                            )
                                .into_response(),
                            Answer::Chunks | Answer::Hang => {
                                let stream = futures_util::stream::unfold(
                                    (0, flag, gate),
                                    move |(n, flag, gate)| async move {
                                        if n == 3 || (n == 1 && matches!(answer, Answer::Hang)) {
                                            if matches!(answer, Answer::Hang) {
                                                std::future::pending::<()>().await;
                                            }
                                            return None;
                                        }
                                        gate.lock().await.recv().await?;
                                        let chunk = Bytes::from(format!("data: {n}\n\n"));
                                        Some((Ok::<_, Infallible>(chunk), (n + 1, flag, gate)))
                                    },
                                );
                                (
                                    StatusCode::OK,
                                    [("content-type", "text/event-stream")],
                                    Body::from_stream(stream),
                                )
                                    .into_response()
                            }
                        }
                    }
                }),
            )
            .route(
                "/v1/elsewhere",
                post(move || {
                    elsewhere.store(true, Ordering::SeqCst);
                    async { "followed" }
                }),
            )
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    Fake {
        base: format!("http://127.0.0.1:{port}/v1"),
        seen,
        elsewhere,
        dropped,
        release,
    }
}

fn header(headers: &HeaderMap, name: &str) -> Vec<String> {
    headers
        .get_all(name)
        .iter()
        .map(|value| value.to_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_path_cannot_leave_the_provider_address() {
    let base = "https://api.openai.com/v1";
    for path in [
        "chat",
        "/../admin",
        "/a/../../admin",
        "/%2e%2e/admin",
        "/%2E%2E/admin",
        "//evil.example/v1/chat",
        "/x//y",
        "/https://evil.example/",
        "/x\\..\\admin",
        "/chat#frag",
        "/chat\n",
        "/chat?alt=sse\r\nx: y",
        "/chat?q=\u{7f}",
    ] {
        assert!(
            matches!(target(base, path), Err(ProxyError::Invalid(_))),
            "{path:?} was accepted"
        );
    }
    assert_eq!(
        target(base, "/chat/completions").unwrap().as_str(),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        target(
            "https://generativelanguage.googleapis.com/v1beta",
            "/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        )
        .unwrap()
        .as_str(),
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
    // A query may name anything; it never changes the host.
    assert_eq!(
        target(base, "/chat?next=//evil.example/../x")
            .unwrap()
            .host_str(),
        Some("api.openai.com")
    );
    assert!(matches!(
        target("http://user:pw@127.0.0.1:1/v1", "/chat"),
        Err(ProxyError::Invalid(message)) if !message.contains("pw")
    ));
}

#[test]
fn each_provider_gets_only_its_own_auth_header_from_the_stored_key() {
    let cases = [
        (
            AiProvider::Openai,
            "authorization",
            "Bearer sk-stored-secret",
        ),
        (AiProvider::Anthropic, "x-api-key", KEY),
        (AiProvider::Google, "x-goog-api-key", KEY),
        (
            AiProvider::Custom,
            "authorization",
            "Bearer sk-stored-secret",
        ),
    ];
    let auth = ["authorization", "x-api-key", "x-goog-api-key"];
    for (provider, name, value) in cases {
        let prepared = prepare(
            &settings(provider, "https://openrouter.ai/api/v1", KEY),
            &request("r", provider, "/chat"),
        )
        .unwrap_or_else(|error| panic!("{provider:?}: {error}"));
        let headers = &prepared.headers;
        assert_eq!(header(headers, name), [value], "{provider:?}");
        for other in auth.iter().filter(|other| **other != name) {
            assert!(
                header(headers, other).is_empty(),
                "{provider:?} sent {other}"
            );
        }
        assert!(header(headers, "host").is_empty(), "{provider:?}");
        assert!(
            header(headers, "accept-encoding").is_empty(),
            "{provider:?}"
        );
        assert_eq!(header(headers, "content-type"), ["application/json"]);
    }
    let ollama = prepare(
        &settings(AiProvider::Ollama, "", KEY),
        &request("r", AiProvider::Ollama, "/chat/completions"),
    )
    .expect("ollama");
    assert_eq!(
        ollama.url.as_str(),
        "http://localhost:11434/v1/chat/completions"
    );
    for name in auth {
        assert!(
            header(&ollama.headers, name).is_empty(),
            "ollama sent {name}"
        );
    }
    // OpenAI, Anthropic and Google ignore a stored base URL.
    let openai = prepare(
        &settings(AiProvider::Openai, "http://evil.example/v1", KEY),
        &request("r", AiProvider::Openai, "/responses"),
    )
    .expect("openai");
    assert_eq!(openai.url.as_str(), "https://api.openai.com/v1/responses");
}

#[test]
fn requests_that_cannot_be_sent_name_the_provider_never_the_key() {
    let refused = |settings: InlineAiSettings, request: AiProviderRequest| {
        prepare(&settings, &request).err().expect("refused")
    };
    assert_eq!(
        refused(
            settings(AiProvider::Anthropic, "", ""),
            request("r", AiProvider::Anthropic, "/messages")
        ),
        ProxyError::KeyMissing {
            provider: "Anthropic".to_owned()
        }
    );
    assert_eq!(
        refused(
            settings(AiProvider::Openai, "", KEY),
            request("r", AiProvider::Anthropic, "/messages")
        ),
        ProxyError::ProviderChanged
    );
    let mut off = settings(AiProvider::Openai, "", KEY);
    off.enabled = false;
    assert_eq!(
        refused(off, request("r", AiProvider::Openai, "/responses")),
        ProxyError::Disabled
    );
    let mut large = request("r", AiProvider::Openai, "/responses");
    large.body = Some("x".repeat(25 * 1024 * 1024 + 1));
    assert_eq!(
        refused(settings(AiProvider::Openai, "", KEY), large),
        ProxyError::TooLarge
    );
    let error = refused(
        settings(AiProvider::Openai, "", "bad\nkey-sk-stored-secret"),
        request("r", AiProvider::Openai, "/responses"),
    );
    assert!(!format!("{error} {error:?}").contains(KEY), "{error:?}");
}

#[tokio::test]
async fn the_body_streams_through_as_it_arrives_with_the_stored_key() {
    let fake = fake(Answer::Chunks).await;
    let proxy = proxy();
    let (sink, mut frames) = sink(Arc::new(AtomicBool::new(true)));
    let (head, body) = proxy
        .open(
            &settings(AiProvider::Custom, &fake.base, KEY),
            request("stream", AiProvider::Custom, "/chat"),
            sink,
        )
        .await
        .expect("head");
    assert_eq!(head.status, 200);
    assert!(
        head.headers
            .iter()
            .any(|pair| pair.name == "content-type" && pair.value == "text/event-stream")
    );
    let headers = fake.seen.lock().unwrap()[0].clone();
    assert_eq!(
        header(&headers, "authorization"),
        ["Bearer sk-stored-secret"]
    );
    assert!(header(&headers, "x-api-key").is_empty());
    assert!(header(&headers, "x-goog-api-key").is_empty());

    tokio::spawn(body);
    // Each chunk reaches the sink before the provider sends the next one.
    for n in 0..3 {
        fake.release.send(()).unwrap();
        assert_eq!(
            next(&mut frames).await,
            Frame::Data(format!("data: {n}\n\n").into_bytes())
        );
    }
    assert_eq!(next(&mut frames).await, Frame::End);
    tokio::time::timeout(WAIT, async {
        while proxy.in_flight() != 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the finished request left the map");
}

#[tokio::test]
async fn a_cancel_ends_the_upstream_request_mid_stream() {
    let fake = fake(Answer::Hang).await;
    let proxy = proxy();
    let (sink, mut frames) = sink(Arc::new(AtomicBool::new(true)));
    let (_, body) = proxy
        .open(
            &settings(AiProvider::Custom, &fake.base, KEY),
            request("hang", AiProvider::Custom, "/chat"),
            sink,
        )
        .await
        .expect("head");
    let body = tokio::spawn(body);
    fake.release.send(()).unwrap();
    assert!(matches!(next(&mut frames).await, Frame::Data(_)));
    assert_eq!(proxy.in_flight(), 1);
    proxy.cancel("hang");
    tokio::time::timeout(WAIT, body)
        .await
        .expect("body ended")
        .expect("no panic");
    fake.dropped.wait().await;
    assert_eq!(proxy.in_flight(), 0);
}

#[tokio::test]
async fn a_cancel_before_the_head_ends_the_upstream_request() {
    let fake = fake(Answer::NoHead).await;
    let proxy = proxy();
    let opening = {
        let proxy = proxy.clone();
        let settings = settings(AiProvider::Custom, &fake.base, KEY);
        tokio::spawn(async move {
            let (sink, _frames) = sink(Arc::new(AtomicBool::new(true)));
            proxy
                .open(
                    &settings,
                    request("slow", AiProvider::Custom, "/chat"),
                    sink,
                )
                .await
                .map(|_| ())
        })
    };
    tokio::time::timeout(WAIT, async {
        while fake.seen.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the provider got the request");
    proxy.cancel("slow");
    let outcome = tokio::time::timeout(WAIT, opening)
        .await
        .expect("ended")
        .unwrap();
    assert_eq!(outcome, Err(ProxyError::Cancelled));
    fake.dropped.wait().await;
}

#[tokio::test]
async fn a_gone_renderer_and_a_vault_close_end_the_upstream_request() {
    // The sink reports the channel closed on the first chunk.
    let fake_gone = fake(Answer::Hang).await;
    let proxy = proxy();
    let (sink_gone, _frames) = sink(Arc::new(AtomicBool::new(false)));
    let (_, body) = proxy
        .open(
            &settings(AiProvider::Custom, &fake_gone.base, KEY),
            request("gone", AiProvider::Custom, "/chat"),
            sink_gone,
        )
        .await
        .expect("head");
    let body = tokio::spawn(body);
    fake_gone.release.send(()).unwrap();
    tokio::time::timeout(WAIT, body)
        .await
        .expect("body ended")
        .expect("no panic");
    fake_gone.dropped.wait().await;

    // The `ai-proxy` close hook cancels every request.
    let fake_open = fake(Answer::Hang).await;
    let (sink_open, mut frames) = sink(Arc::new(AtomicBool::new(true)));
    let (_, body) = proxy
        .open(
            &settings(AiProvider::Custom, &fake_open.base, KEY),
            request("open", AiProvider::Custom, "/chat"),
            sink_open,
        )
        .await
        .expect("head");
    let body = tokio::spawn(body);
    fake_open.release.send(()).unwrap();
    assert!(matches!(next(&mut frames).await, Frame::Data(_)));
    proxy.cancel_all();
    tokio::time::timeout(WAIT, body)
        .await
        .expect("body ended")
        .expect("no panic");
    fake_open.dropped.wait().await;
    assert_eq!(proxy.in_flight(), 0);
}

#[tokio::test]
async fn a_redirect_is_answered_never_followed() {
    let fake = fake(Answer::Redirect).await;
    let (sink, _frames) = sink(Arc::new(AtomicBool::new(true)));
    let (head, _body) = proxy()
        .open(
            &settings(AiProvider::Custom, &fake.base, KEY),
            request("redirect", AiProvider::Custom, "/chat"),
            sink,
        )
        .await
        .expect("head");
    assert_eq!(head.status, 302);
    assert!(!fake.elsewhere.load(Ordering::SeqCst));
}

#[tokio::test]
async fn an_unreachable_provider_is_named_without_the_key_and_a_running_id_is_refused() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    let base = format!("http://127.0.0.1:{port}/v1");
    let (sink_closed, _frames) = sink(Arc::new(AtomicBool::new(true)));
    let error = proxy()
        .open(
            &settings(AiProvider::Custom, &base, KEY),
            request("closed", AiProvider::Custom, "/chat"),
            sink_closed,
        )
        .await
        .err()
        .expect("unreachable");
    assert_eq!(
        error,
        ProxyError::Unreachable {
            provider: format!("127.0.0.1:{port}")
        }
    );
    assert!(!format!("{error} {error:?}").contains(KEY));

    let fake = fake(Answer::Hang).await;
    let proxy = proxy();
    let (sink_first, _first) = sink(Arc::new(AtomicBool::new(true)));
    let (_, _body) = proxy
        .open(
            &settings(AiProvider::Custom, &fake.base, KEY),
            request("same", AiProvider::Custom, "/chat"),
            sink_first,
        )
        .await
        .expect("head");
    let (sink_second, _second) = sink(Arc::new(AtomicBool::new(true)));
    let second = proxy
        .open(
            &settings(AiProvider::Custom, &fake.base, KEY),
            request("same", AiProvider::Custom, "/chat"),
            sink_second,
        )
        .await
        .err()
        .expect("refused");
    assert!(matches!(second, ProxyError::Invalid(_)), "{second:?}");
}
