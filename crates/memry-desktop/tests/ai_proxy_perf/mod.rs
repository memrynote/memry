//! The inline AI provider proxy's rows (#3539, "Performance"), against a local axum provider:
//! what `AiProxy::open` adds to the head latency of a direct reqwest call with the same client
//! settings, sampled in pairs so both see the same machine load, and the delay from the moment
//! the provider yields its first body byte until the sink holds it. Budgets are p99: 5 ms each.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::response::IntoResponse;
use axum::routing::post;
use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::proxy::{AiProviderRequest, AiProxy, Frame, HeaderPair, HttpMethod};
use memry_desktop::ai::settings::InlineAiSettings;
use tokio::net::TcpListener;

use super::Report;

const SAMPLES: usize = 300;
/// The stored key the proxy adds; the direct call sends the same header itself.
const KEY: &str = "bench-key";
const BODY: &str = r#"{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;

type FirstByte = Arc<Mutex<Option<Instant>>>;

/// A provider whose answer is a head and one SSE chunk. `first_byte` holds when the chunk left
/// the handler's stream.
async fn provider(first_byte: FirstByte) -> String {
    let app = Router::new().route(
        "/v1/chat",
        post(move || {
            let first_byte = first_byte.clone();
            async move {
                let stream = futures_util::stream::once(async move {
                    *first_byte.lock().unwrap() = Some(Instant::now());
                    Ok::<_, Infallible>(Bytes::from_static(b"data: {\"x\":1}\n\n"))
                });
                (
                    [("content-type", "text/event-stream")],
                    Body::from_stream(stream),
                )
                    .into_response()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://127.0.0.1:{port}/v1")
}

fn request(n: usize) -> AiProviderRequest {
    AiProviderRequest {
        request_id: format!("bench-{n}"),
        provider: AiProvider::Custom,
        method: HttpMethod::Post,
        path: "/chat".to_owned(),
        headers: vec![HeaderPair {
            name: "content-type".to_owned(),
            value: "application/json".to_owned(),
        }],
        body: Some(BODY.to_owned()),
    }
}

/// One proxied request: the head latency and the first byte's delay to the sink.
async fn proxied(
    proxy: &Arc<AiProxy>,
    settings: &InlineAiSettings,
    n: usize,
    first_byte: &FirstByte,
) -> (Duration, Duration) {
    let received: FirstByte = Arc::default();
    let sink = {
        let received = received.clone();
        Box::new(move |frame: Frame| {
            if matches!(frame, Frame::Data(_)) {
                received.lock().unwrap().get_or_insert_with(Instant::now);
            }
            true
        })
    };
    let start = Instant::now();
    let (head, body) = proxy
        .open(settings, request(n), sink)
        .await
        .expect("proxied head");
    let head_latency = start.elapsed();
    assert_eq!(head.status, 200);
    body.await;
    let sent = first_byte
        .lock()
        .unwrap()
        .take()
        .expect("the provider sent a byte");
    let got = received.lock().unwrap().expect("the sink got a byte");
    (head_latency, got.saturating_duration_since(sent))
}

async fn direct(client: &reqwest::Client, url: &str) -> Duration {
    let start = Instant::now();
    let response = client
        .post(url)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {KEY}"))
        .body(BODY)
        .send()
        .await
        .expect("direct head");
    let took = start.elapsed();
    response.bytes().await.expect("direct body");
    took
}

pub fn run(report: &mut Report) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let first_byte: FirstByte = Arc::default();
        let base = provider(first_byte.clone()).await;
        let settings = InlineAiSettings {
            enabled: true,
            provider: AiProvider::Custom,
            model: "m".to_owned(),
            api_key: KEY.to_owned(),
            base_url: base.clone(),
        };
        let proxy = AiProxy::new(memry_desktop::http::builder().no_proxy());
        let client = memry_desktop::http::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let url = format!("{base}/chat");

        // Warms both connection pools; not measured.
        for n in 0..10 {
            proxied(&proxy, &settings, n, &first_byte).await;
            direct(&client, &url).await;
        }
        let (mut proxy_heads, mut direct_heads, mut overhead, mut to_sink) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for n in 0..SAMPLES {
            let (head, delay) = proxied(&proxy, &settings, 10 + n, &first_byte).await;
            let plain = direct(&client, &url).await;
            proxy_heads.push(head);
            direct_heads.push(plain);
            overhead.push(head.saturating_sub(plain));
            to_sink.push(delay);
        }
        let p = |samples: &[Duration], q: usize| {
            let mut sorted = samples.to_vec();
            sorted.sort();
            sorted[sorted.len() * q / 100]
        };
        println!(
            "ai proxy head: p50 {:?}, p99 {:?}; direct reqwest head: p50 {:?}, p99 {:?}",
            p(&proxy_heads, 50),
            p(&proxy_heads, 99),
            p(&direct_heads, 50),
            p(&direct_heads, 99)
        );
        report.row_at(
            "ai proxy head overhead vs direct reqwest",
            overhead,
            99,
            5.0,
        );
        report.row_at("ai proxy first upstream byte to sink", to_sink, 99, 5.0);
    });
}
