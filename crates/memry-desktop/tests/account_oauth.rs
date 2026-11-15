//! Google sign-in over the loopback (Step 19 A2): the init request read without following its
//! redirect, the browser's one callback, the exchange, and how an attempt ends
//! (`apps/desktop/src/main/ipc/auth-oauth-handlers.ts`). The browser is a local HTTP client.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use memry_core::api::auth::AuthState;
use memry_core::api::errors::TransportError;
use memry_core::seams::transport::{HttpRequest, HttpResponse};
use memry_desktop::account::{AccountError, AccountService, FirstDevice, OAuthEvent, device};
use memry_desktop::registry::config::AppConfig;
use memry_desktop::seams::transport::{NoRedirect, app_transports};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::account_service::{Keychain, MASTER, Script, access_token, setup_token};
use crate::oauth_loopback::get;

const GOOGLE: &str = "https://accounts.google.com/o/oauth2/v2/auth?client_id=c&state=";

/// The server's answer to `GET /auth/oauth/google`: a 302 to `location`, recorded.
#[derive(Default)]
struct Probe {
    location: Mutex<Option<String>>,
    urls: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl NoRedirect for Probe {
    async fn send_no_redirect(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        assert_eq!(request.method, "GET");
        self.urls.lock().unwrap().push(request.url);
        let mut headers = HashMap::new();
        if let Some(location) = self.location.lock().unwrap().clone() {
            headers.insert("location".to_owned(), location);
        }
        Ok(HttpResponse {
            status: 302,
            headers,
            body: Vec::new(),
        })
    }
}

impl Probe {
    fn to(location: &str) -> Self {
        let probe = Self::default();
        *probe.location.lock().unwrap() = Some(location.to_owned());
        probe
    }

    /// The `redirect_uri` of the last init request.
    fn redirect_uri(&self) -> String {
        let url = url::Url::parse(self.urls.lock().unwrap().last().unwrap()).unwrap();
        url.query_pairs()
            .find(|(key, _)| key == "redirect_uri")
            .map(|(_, value)| value.into_owned())
            .unwrap()
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    script: Arc<Script>,
    service: Arc<AccountService>,
}

fn fixture(keychain: Keychain) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let script = Arc::new(Script::default());
    let service = AccountService::new(
        script.clone(),
        Arc::new(keychain),
        "https://sync.test".into(),
        device::descriptor("1.0.0"),
        Arc::new(AppConfig::load(dir.path().join("memry-config.json"))),
    )
    .unwrap();
    Fixture {
        _dir: dir,
        script,
        service: Arc::new(service),
    }
}

type Events = mpsc::UnboundedReceiver<OAuthEvent>;

impl Fixture {
    async fn start(&self, probe: &Probe) -> Result<(String, Events), AccountError> {
        let (sender, events) = mpsc::unbounded_channel();
        let started = self
            .service
            .init_oauth(probe, move |event| {
                let _ = sender.send(event);
            })
            .await?;
        Ok((started.state, events))
    }

    fn state(&self) -> AuthState {
        self.service.session().state()
    }

    fn answer_callback(&self, needs_setup: bool, known_device: bool) {
        self.script.answer(
            200,
            json!({
                "success": true, "isNewUser": needs_setup, "needsSetup": needs_setup,
                "knownDevice": known_device, "setupToken": setup_token(),
            }),
        );
    }
}

/// Whether anything still listens at `redirect_uri`.
async fn listening(redirect_uri: &str) -> bool {
    get(&format!("{redirect_uri}?code=x&state=x")).await.is_ok()
}

#[tokio::test]
async fn the_provider_url_opens_an_attempt_and_its_one_callback_is_exchanged_once() {
    let f = fixture(Keychain::default());
    let probe = Probe::to(&format!("{GOOGLE}state-1"));

    let (state, mut events) = f.start(&probe).await.unwrap();

    assert_eq!(state, "state-1");
    let urls = probe.urls.lock().unwrap().clone();
    assert_eq!(urls.len(), 1);
    assert!(
        urls[0].starts_with(
            "https://sync.test/auth/oauth/google?redirect_uri=http%3A%2F%2F127.0.0.1%3A"
        ),
        "{}",
        urls[0]
    );
    let redirect_uri = probe.redirect_uri();
    assert!(redirect_uri.ends_with("/callback"), "{redirect_uri}");
    assert!(matches!(f.state(), AuthState::AwaitingProviderToken { .. }));
    assert_eq!(
        f.service.oauth_retry_url("state-1").unwrap(),
        format!("{GOOGLE}state-1")
    );
    assert!(matches!(
        f.service.oauth_retry_url("state-2"),
        Err(AccountError::OAuthExpired)
    ));

    let (status, _) = get(&format!("{redirect_uri}?code=code-1&state=state-1"))
        .await
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(
        events.recv().await.unwrap(),
        OAuthEvent::Callback {
            code: "code-1".into(),
            state: "state-1".into()
        }
    );
    // A code arrived: the browser is not reopened for this attempt.
    assert!(matches!(
        f.service.oauth_retry_url("state-1"),
        Err(AccountError::OAuthExpired)
    ));

    f.answer_callback(false, false);
    let first = f
        .service
        .setup_first_device("code-1".into(), "state-1".into())
        .await
        .unwrap();
    assert_eq!(
        first,
        FirstDevice {
            needs_recovery_setup: true,
            needs_recovery_input: true,
            device_id: None
        }
    );
    assert_eq!(f.script.count("/auth/oauth/google/callback"), 1);
    assert_eq!(f.state(), AuthState::SetupPending);

    // The same code again is refused before any request.
    let again = f
        .service
        .setup_first_device("code-1".into(), "state-1".into())
        .await;
    assert!(again.is_err());
    assert_eq!(f.script.count("/auth/oauth/google/callback"), 1);
}

#[tokio::test]
async fn a_callback_for_another_state_is_refused_without_a_request() {
    let f = fixture(Keychain::default());
    let probe = Probe::to(&format!("{GOOGLE}state-1"));
    let _events = f.start(&probe).await.unwrap();

    let refused = f
        .service
        .setup_first_device("code".into(), "forged".into())
        .await;

    assert!(refused.is_err());
    assert!(!f.script.called("/auth/oauth/google/callback"));
    assert!(matches!(f.state(), AuthState::AwaitingProviderToken { .. }));
    assert!(f.service.oauth_retry_url("state-1").is_ok());
}

#[tokio::test]
async fn a_new_account_from_google_is_set_up_and_its_phrase_held() {
    let f = fixture(Keychain::default());
    let probe = Probe::to(&format!("{GOOGLE}state-1"));
    let (state, _events) = f.start(&probe).await.unwrap();
    f.answer_callback(true, false);
    f.script.answer(
        200,
        json!({
            "success": true, "deviceId": "server-device-1",
            "accessToken": access_token("server-device-1"), "refreshToken": "refresh-1",
        }),
    );
    f.script.answer(200, json!({ "success": true }));

    let first = f
        .service
        .setup_first_device("code-1".into(), state)
        .await
        .unwrap();

    assert_eq!(
        first,
        FirstDevice {
            needs_recovery_setup: true,
            needs_recovery_input: false,
            device_id: Some("server-device-1".into())
        }
    );
    assert!(f.service.recovery_phrase().is_some());
    assert!(f.script.called("/auth/setup"));
}

#[tokio::test]
async fn a_known_device_from_google_signs_back_in_without_the_phrase() {
    let f = fixture(Keychain::holding_keys(Some(MASTER)));
    let probe = Probe::to(&format!("{GOOGLE}state-1"));
    let (state, _events) = f.start(&probe).await.unwrap();
    f.answer_callback(false, true);
    f.script.answer(
        200,
        json!({
            "kdfSalt": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [7u8; 16]),
            "keyVerifier": memry_core::crypto::keys::account_key_verifier(&MASTER).unwrap(),
        }),
    );
    f.script.answer(
        200,
        json!({
            "success": true, "deviceId": "server-device-1",
            "accessToken": access_token("server-device-1"), "refreshToken": "refresh-1",
        }),
    );

    let first = f
        .service
        .setup_first_device("code-1".into(), state)
        .await
        .unwrap();

    assert_eq!(
        first,
        FirstDevice {
            needs_recovery_setup: false,
            needs_recovery_input: false,
            device_id: Some("server-device-1".into())
        }
    );
    assert_eq!(f.state(), AuthState::Registered);
}

#[tokio::test]
async fn a_declined_consent_ends_the_attempt_as_cancelled() {
    let f = fixture(Keychain::default());
    let probe = Probe::to(&format!("{GOOGLE}state-1"));
    let (_, mut events) = f.start(&probe).await.unwrap();

    let (status, _) = get(&format!(
        "{}?error=access_denied&state=state-1",
        probe.redirect_uri()
    ))
    .await
    .unwrap();

    assert_eq!(status, 200);
    assert_eq!(events.recv().await.unwrap(), OAuthEvent::Cancelled);
    assert_eq!(f.state(), AuthState::SignedOut);
    assert!(f.service.oauth_retry_url("state-1").is_err());
}

#[tokio::test(start_paused = true)]
async fn an_attempt_with_no_callback_expires_after_ten_minutes() {
    let f = fixture(Keychain::default());
    let probe = Probe::to(&format!("{GOOGLE}state-1"));
    let (_, mut events) = f.start(&probe).await.unwrap();
    let started = tokio::time::Instant::now();

    assert_eq!(events.recv().await.unwrap(), OAuthEvent::Expired);

    assert!(started.elapsed() >= memry_desktop::account::OAUTH_ATTEMPT_TTL);
    assert_eq!(f.state(), AuthState::SignedOut);
    assert!(f.service.oauth_retry_url("state-1").is_err());
}

#[tokio::test]
async fn an_unusable_provider_url_opens_no_attempt_and_closes_the_loopback() {
    for location in [
        None,
        Some("http://accounts.google.com/o/oauth2/v2/auth?state=s".to_owned()),
        Some("https://accounts.google.com/o/oauth2/v2/auth?client_id=c".to_owned()),
        Some("https://accounts.google.com/o/oauth2/v2/auth?state=".to_owned()),
        Some("not a url".to_owned()),
    ] {
        let f = fixture(Keychain::default());
        let probe = Probe::default();
        *probe.location.lock().unwrap() = location.clone();

        let error = f.start(&probe).await.unwrap_err();

        assert!(
            matches!(error, AccountError::OAuthInvalidResponse),
            "{location:?}: {error:?}"
        );
        assert_eq!(f.state(), AuthState::SignedOut, "{location:?}");
        assert!(!listening(&probe.redirect_uri()).await, "{location:?}");
    }
}

#[tokio::test]
async fn a_new_start_or_an_email_code_ends_the_attempt_in_flight() {
    let f = fixture(Keychain::default());
    let first = Probe::to(&format!("{GOOGLE}state-1"));
    let _first = f.start(&first).await.unwrap();

    let second = Probe::to(&format!("{GOOGLE}state-2"));
    let (state, _second) = f.start(&second).await.unwrap();

    assert_eq!(state, "state-2");
    assert!(f.service.oauth_retry_url("state-1").is_err());
    assert!(!listening(&first.redirect_uri()).await);
    assert!(listening(&second.redirect_uri()).await);

    f.script
        .answer(200, json!({ "success": true, "expiresIn": 600 }));
    f.service
        .request_otp("kaan@example.com".into())
        .await
        .unwrap();

    assert!(matches!(f.state(), AuthState::AwaitingOtp { .. }));
    assert!(f.service.oauth_retry_url("state-2").is_err());
    assert!(!listening(&second.redirect_uri()).await);
}

/// The real transport against a server whose 302 points at a host the transport may follow:
/// the init reads the `location` and never requests it.
#[tokio::test]
async fn the_init_request_does_not_follow_the_redirect() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = requests.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut head = vec![0u8; 4096];
            let read = stream.read(&mut head).await.unwrap_or(0);
            let line = String::from_utf8_lossy(&head[..read])
                .lines()
                .next()
                .unwrap_or_default()
                .to_owned();
            seen.lock().unwrap().push(line);
            let reply = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/provider?state=state-1\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
            let _ = stream.write_all(reply.as_bytes()).await;
        }
    });
    struct NoPins;
    impl memry_desktop::seams::tls::PinFailureSink for NoPins {
        fn pin_failed(&self, _failure: memry_desktop::seams::tls::PinFailure) {}
    }
    let (transport, no_redirect) = app_transports(&["127.0.0.1".to_owned()], Arc::new(NoPins));
    let dir = tempfile::tempdir().unwrap();
    let service = Arc::new(
        AccountService::new(
            transport,
            Arc::new(Keychain::default()),
            format!("http://127.0.0.1:{port}"),
            device::descriptor("1.0.0"),
            Arc::new(AppConfig::load(dir.path().join("memry-config.json"))),
        )
        .unwrap(),
    );

    // The provider URL is `http` here, so the init refuses it; what matters is that it was
    // read from the 302 and never fetched.
    let result = service.init_oauth(no_redirect.as_ref(), |_| {}).await;

    assert!(
        matches!(result, Err(AccountError::OAuthInvalidResponse)),
        "{:?}",
        result.err()
    );
    let requests = requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert!(
        requests[0].starts_with("GET /auth/oauth/google?redirect_uri=http%3A%2F%2F127.0.0.1%3A"),
        "{requests:?}"
    );
}
