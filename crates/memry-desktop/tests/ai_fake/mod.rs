//! A local fake AI provider for the structured-call and proxy tests: each request is recorded
//! and gets the next scripted reply (the last one repeats), or no head at all.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::proxy::AiProxy;
use memry_desktop::ai::settings::InlineAiSettings;
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// Watchdog on one wait, not a budget.
pub const WAIT: Duration = Duration::from_secs(10);
/// The stored key: a test value, never a real one.
pub const KEY: &str = "test-key-not-real-42";

#[derive(Clone)]
pub enum Reply {
    Answer {
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: Vec<u8>,
    },
    /// No head until the client leaves.
    NoHead,
}

impl Reply {
    pub fn json(status: u16, body: &Value) -> Self {
        Self::Answer {
            status,
            headers: vec![("content-type", "application/json".to_owned())],
            body: body.to_string().into_bytes(),
        }
    }

    /// A chat completion whose message is `content`.
    pub fn chat(content: &str) -> Self {
        Self::json(
            200,
            &json!({ "choices": [{ "message": { "role": "assistant", "content": content } }] }),
        )
    }

    pub fn status(status: u16) -> Self {
        Self::json(
            status,
            &json!({ "error": { "message": format!("status {status}") } }),
        )
    }

    pub fn with_header(mut self, name: &'static str, value: &str) -> Self {
        if let Self::Answer { headers, .. } = &mut self {
            headers.push((name, value.to_owned()));
        }
        self
    }
}

/// One request the provider got.
#[derive(Clone)]
pub struct Seen {
    pub path: String,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Seen {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("a JSON request body")
    }
}

pub struct Fake {
    /// The base a settings' `base_url` names: `http://127.0.0.1:<port>/v1`.
    pub base: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl Fake {
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// Waits until the provider got `count` requests.
    pub async fn wait_for(&self, count: usize) {
        tokio::time::timeout(WAIT, async {
            while self.seen.lock().unwrap().len() < count {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the provider got the request");
    }
}

pub async fn fake(replies: Vec<Reply>) -> Fake {
    assert!(!replies.is_empty());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let app = {
        let seen = seen.clone();
        Router::new().fallback(move |uri: Uri, headers: HeaderMap, body: Bytes| {
            let (seen, replies) = (seen.clone(), replies.clone());
            async move {
                let reply = {
                    let mut seen = seen.lock().unwrap();
                    seen.push(Seen {
                        path: uri.path().to_owned(),
                        headers,
                        body: body.to_vec(),
                    });
                    replies[(seen.len() - 1).min(replies.len() - 1)].clone()
                };
                answer(reply).await
            }
        })
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    Fake {
        base: format!("http://127.0.0.1:{port}/v1"),
        seen,
    }
}

async fn answer(reply: Reply) -> Response {
    match reply {
        Reply::NoHead => std::future::pending().await,
        Reply::Answer {
            status,
            headers,
            body,
        } => {
            let mut response = (StatusCode::from_u16(status).unwrap(), body).into_response();
            for (name, value) in headers {
                response
                    .headers_mut()
                    .insert(name, value.parse().expect("a header value"));
            }
            response
        }
    }
}

/// A base on this host that nothing listens on.
pub async fn closed_base() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    format!("http://127.0.0.1:{port}/v1")
}

pub fn proxy() -> Arc<AiProxy> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    AiProxy::new(memry_desktop::http::builder().no_proxy())
}

pub fn settings(provider: AiProvider, base: &str, key: &str) -> InlineAiSettings {
    InlineAiSettings {
        enabled: true,
        provider,
        model: "m".to_owned(),
        api_key: key.to_owned(),
        base_url: base.to_owned(),
    }
}
