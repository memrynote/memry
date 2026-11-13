//! The inline AI connection test and model list against a local fake provider: each provider
//! gets its own auth header and nothing else, a custom endpoint gets its key only at its own URL,
//! and the outcome classes match `writing-assist.ts:55-62` (401 and 403 unauthorized, no answer
//! unreachable, the rest other).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use memry_desktop::ai::catalog::{ProbeClient, ProbeFailure, list_models, probe, test_connection};
use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::settings::InlineAiSettings;
use tokio::net::TcpListener;

const WAIT: Duration = Duration::from_secs(10);

fn client() -> ProbeClient {
    let _ = rustls::crypto::ring::default_provider().install_default();
    ProbeClient::new(memry_desktop::http::builder().no_proxy())
}

/// A provider at `127.0.0.1:<port>` whose `/models` answers `status` with `body` and records the
/// request headers.
async fn provider(status: StatusCode, body: &'static str) -> (String, Arc<Mutex<Vec<HeaderMap>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    let app = Router::new().route(
        "/v1/models",
        get(move |headers: HeaderMap| {
            let record = record.clone();
            async move {
                record.lock().unwrap().push(headers);
                (status, body)
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    (format!("http://127.0.0.1:{port}/v1"), seen)
}

/// A port nothing listens on.
async fn closed_port() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    format!("http://127.0.0.1:{port}/v1")
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .map(|value| value.to_str().unwrap().to_owned())
}

#[tokio::test]
async fn each_provider_sends_only_its_own_auth_header() {
    let cases = [
        (AiProvider::Openai, "authorization", "Bearer sk-1"),
        (AiProvider::Anthropic, "x-api-key", "sk-1"),
        (AiProvider::Google, "x-goog-api-key", "sk-1"),
    ];
    let auth_names = ["authorization", "x-api-key", "x-goog-api-key"];
    for (provider_id, name, value) in cases {
        let (base, seen) = provider(StatusCode::OK, r#"{"data":[]}"#).await;
        probe(&client(), provider_id, &base, Some("sk-1"), WAIT)
            .await
            .expect("ok");
        let headers = seen.lock().unwrap()[0].clone();
        assert_eq!(
            header(&headers, name).as_deref(),
            Some(value),
            "{provider_id:?}"
        );
        for other in auth_names.iter().filter(|other| **other != name) {
            assert_eq!(
                header(&headers, other),
                None,
                "{provider_id:?} sent {other}"
            );
        }
        let version = header(&headers, "anthropic-version");
        assert_eq!(
            version.is_some(),
            provider_id == AiProvider::Anthropic,
            "{provider_id:?}"
        );
    }
}

/// A provider whose `/models` redirects to `target`.
async fn redirecting_to(target: String) -> String {
    let app = Router::new().route(
        "/v1/models",
        get(move || {
            let target = target.clone();
            async move { (StatusCode::FOUND, [(axum::http::header::LOCATION, target)]) }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    format!("http://127.0.0.1:{port}/v1")
}

#[tokio::test]
async fn a_redirect_never_carries_the_key_to_another_host() {
    for provider_id in [
        AiProvider::Openai,
        AiProvider::Anthropic,
        AiProvider::Google,
        AiProvider::Custom,
    ] {
        let (elsewhere, seen) = provider(StatusCode::OK, r#"{"data":[]}"#).await;
        let base = redirecting_to(format!("{elsewhere}/models")).await;
        let failure = probe(&client(), provider_id, &base, Some("sk-1"), WAIT)
            .await
            .expect_err("a redirect is not an answer");
        assert!(
            matches!(&failure, ProbeFailure::Other(text) if text.contains("302")),
            "{provider_id:?}: {failure:?}"
        );
        assert!(
            seen.lock().unwrap().is_empty(),
            "{provider_id:?} followed the redirect"
        );
    }
}

#[tokio::test]
async fn ollama_lists_its_models_with_no_auth_header() {
    let (base, seen) = provider(
        StatusCode::OK,
        r#"{"object":"list","data":[{"id":"llama3.2"},{"id":""},{"name":"x"},{"id":"qwen2.5:7b"}]}"#,
    )
    .await;
    let models = list_models(&client(), &ollama(&base))
        .await
        .expect("models");
    assert_eq!(models, ["llama3.2", "qwen2.5:7b"]);
    let headers = seen.lock().unwrap()[0].clone();
    assert_eq!(header(&headers, "authorization"), None);
}

#[tokio::test]
async fn failures_are_classified_without_the_key() {
    for (status, expected) in [
        (StatusCode::UNAUTHORIZED, ProbeFailure::Unauthorized),
        (StatusCode::FORBIDDEN, ProbeFailure::Unauthorized),
    ] {
        let (base, _) = provider(status, "no").await;
        let failure = probe(
            &client(),
            AiProvider::Openai,
            &base,
            Some("sk-secret"),
            WAIT,
        )
        .await
        .expect_err("refused");
        assert_eq!(failure, expected);
    }
    let (base, _) = provider(StatusCode::INTERNAL_SERVER_ERROR, "boom").await;
    let failure = probe(
        &client(),
        AiProvider::Openai,
        &base,
        Some("sk-secret"),
        WAIT,
    )
    .await
    .expect_err("500");
    assert!(matches!(&failure, ProbeFailure::Other(text) if !text.contains("sk-secret")));

    let failure = list_models(&client(), &ollama(&closed_port().await))
        .await
        .expect_err("nothing listening");
    assert_eq!(failure, ProbeFailure::Unreachable);
}

#[tokio::test]
async fn a_cloud_provider_without_a_key_is_not_contacted() {
    let settings = InlineAiSettings {
        provider: AiProvider::Anthropic,
        ..InlineAiSettings::default()
    };
    assert_eq!(
        test_connection(&client(), &settings).await,
        Err(ProbeFailure::KeyMissing)
    );
}

#[test]
fn only_ollama_and_custom_take_the_stored_base_url() {
    let base = |provider: AiProvider, stored: &str| provider.base_url(stored);
    assert_eq!(
        base(AiProvider::Ollama, "").as_deref(),
        Some("http://localhost:11434/v1")
    );
    assert_eq!(
        base(AiProvider::Ollama, "http://box:11434/v1/").as_deref(),
        Some("http://box:11434/v1")
    );
    assert_eq!(
        base(AiProvider::Custom, " https://openrouter.ai/api/v1/ ").as_deref(),
        Some("https://openrouter.ai/api/v1")
    );
    assert_eq!(base(AiProvider::Custom, " "), None);
    assert_eq!(
        base(AiProvider::Openai, "http://evil.example/v1").as_deref(),
        Some("https://api.openai.com/v1")
    );
    assert_eq!(
        base(AiProvider::Anthropic, "http://evil.example").as_deref(),
        Some("https://api.anthropic.com/v1")
    );
    assert_eq!(
        base(AiProvider::Google, "http://evil.example").as_deref(),
        Some("https://generativelanguage.googleapis.com/v1beta")
    );
}

fn ollama(base: &str) -> InlineAiSettings {
    InlineAiSettings {
        base_url: base.to_owned(),
        ..InlineAiSettings::default()
    }
}

fn custom(base: &str, key: &str) -> InlineAiSettings {
    InlineAiSettings {
        provider: AiProvider::Custom,
        model: "openai/gpt-5".to_owned(),
        api_key: key.to_owned(),
        base_url: base.to_owned(),
        ..InlineAiSettings::default()
    }
}

#[tokio::test]
async fn a_custom_endpoint_gets_its_key_as_a_bearer_token_and_works_without_one() {
    let (base, seen) = provider(StatusCode::OK, r#"{"data":[{"id":"openai/gpt-5"}]}"#).await;
    let models = list_models(&client(), &custom(&format!("{base}/"), "sk-or"))
        .await
        .expect("models");
    assert_eq!(models, ["openai/gpt-5"]);
    test_connection(&client(), &custom(&base, ""))
        .await
        .expect("a custom endpoint takes no key");

    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(
        header(&seen[0], "authorization").as_deref(),
        Some("Bearer sk-or")
    );
    assert_eq!(header(&seen[0], "x-api-key"), None);
    assert_eq!(header(&seen[0], "x-goog-api-key"), None);
    assert_eq!(header(&seen[1], "authorization"), None);
}

#[tokio::test]
async fn a_custom_endpoint_without_a_url_is_not_contacted() {
    for blank in ["", "  "] {
        let failure = list_models(&client(), &custom(blank, "sk-secret"))
            .await
            .expect_err("no URL");
        assert_eq!(
            failure,
            ProbeFailure::Other("Custom provider URL required".to_owned())
        );
    }
}

#[tokio::test]
async fn a_custom_endpoint_failure_never_carries_the_key() {
    let key = "sk-secret-custom";
    let (server_error, _) = provider(StatusCode::INTERNAL_SERVER_ERROR, "sk-secret-custom").await;
    let (unreadable, _) = provider(StatusCode::OK, "sk-secret-custom is not a list").await;
    let (elsewhere, seen) = provider(StatusCode::OK, r#"{"data":[]}"#).await;
    let redirect = redirecting_to(format!("{elsewhere}/models")).await;
    let bases = [
        server_error,
        unreadable,
        redirect,
        closed_port().await,
        "not a url".to_owned(),
        format!("http://user:{key}@[::1"),
    ];
    for base in bases {
        let failure = list_models(&client(), &custom(&base, key))
            .await
            .expect_err("fails");
        assert!(
            !format!("{failure} {failure:?}").contains(key),
            "{base}: {failure:?}"
        );
    }
    assert!(seen.lock().unwrap().is_empty(), "followed the redirect");
}

#[tokio::test]
async fn a_model_list_in_the_gemini_shape_reads_by_name() {
    let (base, _) = provider(
        StatusCode::OK,
        r#"{"models":[{"name":"models/gemini-2.5-flash"},{"name":""},{"name":"models/gemini-2.5-pro"}]}"#,
    )
    .await;
    let models = list_models(&client(), &custom(&base, ""))
        .await
        .expect("models");
    assert_eq!(models, ["gemini-2.5-flash", "gemini-2.5-pro"]);
}
