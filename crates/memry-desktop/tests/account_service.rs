//! `AccountService` (Step 19 A1) over a scripted transport, an in-memory keychain and a real
//! `memry-config.json`: email sign-in, first-device setup, the phrase, and the known-device path
//! of Electron's `sync/device-registration.ts:285-327`.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD};
use memry_core::api::errors::{SecureStoreError, TransportError};
use memry_core::crypto::{keys, sodium};
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};
use memry_desktop::account::otp_clipboard::{OtpClipboardWatch, POLL, TIMEOUT};
use memry_desktop::account::{AccountError, AccountService, device};
use memry_desktop::registry::config::AppConfig;
use memry_desktop::seams::transport::NativeTransport;
use memry_desktop::telemetry::ios_beta::{self, IosBetaJoinInput, IosBetaSource};
use memry_desktop::telemetry::report::{self, FeedbackSubmit};
use memry_desktop::telemetry::service::{Context, Sender, Service};
use serde_json::{Value, json};

pub(crate) const MASTER: [u8; 32] = [9; 32];

#[derive(Default)]
pub(crate) struct Script {
    answers: Mutex<VecDeque<(u16, String)>>,
    paths: Mutex<Vec<String>>,
    /// The `authorization` header of each request, by path.
    bearers: Mutex<Vec<(String, Option<String>)>>,
    /// Method, path and JSON body of each request.
    requests: Mutex<Vec<(String, String, Value)>>,
}

#[async_trait::async_trait]
impl Transport for Script {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let path = request
            .url
            .trim_start_matches("https://sync.test")
            .to_owned();
        self.paths.lock().unwrap().push(path.clone());
        self.requests.lock().unwrap().push((
            request.method.clone(),
            path.clone(),
            request
                .body
                .as_deref()
                .and_then(|b| serde_json::from_slice(b).ok())
                .unwrap_or(Value::Null),
        ));
        self.bearers
            .lock()
            .unwrap()
            .push((path.clone(), request.headers.get("authorization").cloned()));
        let (status, body) = self
            .answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("no answer scripted for {path}"));
        Ok(HttpResponse {
            status,
            headers: HashMap::new(),
            body: body.into_bytes(),
        })
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "no sockets".into(),
        })
    }
}

impl Script {
    pub(crate) fn answer(&self, status: u16, body: Value) {
        self.answers
            .lock()
            .unwrap()
            .push_back((status, body.to_string()));
    }

    /// `(method, path, body)` of every request so far.
    pub(crate) fn requests(&self) -> Vec<(String, String, Value)> {
        self.requests.lock().unwrap().clone()
    }

    pub(crate) fn called(&self, path: &str) -> bool {
        self.count(path) > 0
    }

    pub(crate) fn count(&self, path: &str) -> usize {
        self.paths
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.starts_with(path))
            .count()
    }
}

/// The keychain, with an optional locked master key and entries it refuses to delete.
#[derive(Default)]
pub(crate) struct Keychain {
    items: Mutex<HashMap<SecureStoreKey, Vec<u8>>>,
    master_locked: bool,
    access_locked: AtomicBool,
    undeletable: Mutex<Vec<SecureStoreKey>>,
}

impl SecureStore for Keychain {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if (self.master_locked && key == SecureStoreKey::MasterKey)
            || (key == SecureStoreKey::AccessToken && self.access_locked.load(Ordering::SeqCst))
        {
            return Err(SecureStoreError::Locked);
        }
        Ok(self.items.lock().unwrap().get(&key).cloned())
    }
    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        self.items.lock().unwrap().insert(key, value);
        Ok(())
    }
    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        if self.undeletable.lock().unwrap().contains(&key) {
            return Err(SecureStoreError::Failed {
                what: "the keychain refused".into(),
            });
        }
        self.items.lock().unwrap().remove(&key);
        Ok(())
    }
    /// Every entry, one after another; the first refusal is returned (`KeyringStore::clear`).
    fn clear(&self) -> Result<(), SecureStoreError> {
        let keys: Vec<_> = self.items.lock().unwrap().keys().copied().collect();
        keys.into_iter()
            .map(|key| self.delete(key))
            .fold(Ok(()), Result::and)
    }
}

impl Keychain {
    pub(crate) fn refuse_delete(&self, keys: &[SecureStoreKey]) {
        self.undeletable.lock().unwrap().extend_from_slice(keys);
    }
    pub(crate) fn has(&self, key: SecureStoreKey) -> bool {
        self.items.lock().unwrap().contains_key(&key)
    }
    pub(crate) fn holding_keys(master: Option<[u8; 32]>) -> Self {
        let keychain = Self::default();
        let (_, secret) = sodium::sign_seed_keypair(&[7; 32]).unwrap();
        keychain
            .set(SecureStoreKey::DeviceSigningKey, secret.to_vec())
            .unwrap();
        if let Some(master) = master {
            keychain
                .set(SecureStoreKey::MasterKey, master.to_vec())
                .unwrap();
        }
        keychain
    }
}

fn jwt(payload: Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"JWT"}"#);
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    format!("{header}.{body}.c2ln")
}

pub(crate) fn setup_token() -> String {
    jwt(json!({ "sub": "u", "jti": "jti-1", "exp": 4_102_444_800u64, "type": "setup" }))
}

pub(crate) fn access_token(device: &str) -> String {
    jwt(json!({ "sub": "u", "device_id": device, "exp": 4_102_444_800u64 }))
}

struct Fixture {
    _dir: tempfile::TempDir,
    script: Arc<Script>,
    keychain: Arc<Keychain>,
    config: Arc<AppConfig>,
    service: AccountService,
}

fn fixture(keychain: Keychain) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let config = Arc::new(AppConfig::load(dir.path().join("memry-config.json")));
    let script = Arc::new(Script::default());
    let keychain = Arc::new(keychain);
    let service = AccountService::new(
        script.clone(),
        keychain.clone(),
        "https://sync.test".into(),
        device::descriptor("1.0.0"),
        config.clone(),
    )
    .unwrap();
    Fixture {
        _dir: dir,
        script,
        keychain,
        config,
        service,
    }
}

impl Fixture {
    fn sync(&self, key: &str) -> Value {
        self.config
            .read(|c| c.get("sync").and_then(|s| s.get(key)).cloned())
            .unwrap_or(Value::Null)
    }

    /// Requests and verifies a code; the server answers `verify`.
    async fn verify(
        &self,
        verify: Value,
    ) -> Result<memry_desktop::account::OtpVerified, AccountError> {
        let mut answer = json!({ "success": true, "setupToken": setup_token() });
        answer
            .as_object_mut()
            .unwrap()
            .extend(verify.as_object().unwrap().clone());
        {
            let mut answers = self.script.answers.lock().unwrap();
            answers.push_front((200, answer.to_string()));
            answers.push_front((
                200,
                json!({ "success": true, "expiresIn": 600 }).to_string(),
            ));
        }
        self.service
            .request_otp("kaan@example.com".into())
            .await
            .unwrap();
        self.service.verify_otp("123456".into()).await
    }

    fn answer_recovery_info(&self, master: [u8; 32]) {
        self.script.answer(
            200,
            json!({
                "kdfSalt": BASE64.encode([7u8; 16]),
                "keyVerifier": keys::account_key_verifier(&master).unwrap(),
            }),
        );
    }

    fn answer_registration(&self, device: &str) {
        self.script.answer(
            200,
            json!({
                "success": true, "deviceId": device,
                "accessToken": access_token(device), "refreshToken": "refresh-1",
            }),
        );
    }
}

fn known() -> Value {
    json!({ "needsSetup": false, "knownDevice": true })
}

#[tokio::test]
async fn a_verified_code_keeps_the_setup_token_and_the_email() {
    let f = fixture(Keychain::default());
    let verified = f
        .verify(json!({ "needsSetup": true, "isNewUser": true }))
        .await
        .unwrap();

    assert!(verified.needs_setup && verified.is_new_user && !verified.needs_recovery_input);
    assert!(f.keychain.has(SecureStoreKey::SetupToken));
    assert_eq!(f.sync("email"), "kaan@example.com");
}

#[tokio::test]
async fn a_known_device_signs_back_in_without_the_phrase_and_records_its_server_id() {
    let f = fixture(Keychain::holding_keys(Some(MASTER)));
    f.answer_recovery_info(MASTER);
    f.answer_registration("server-device-1");

    let verified = f.verify(known()).await.unwrap();

    assert_eq!(verified.device_id.as_deref(), Some("server-device-1"));
    assert!(!verified.needs_recovery_input);
    assert_eq!(f.sync("deviceId"), "server-device-1");
    assert_eq!(
        f.sync("accountKeyVerifier"),
        keys::account_key_verifier(&MASTER).unwrap().as_str()
    );
}

#[tokio::test]
async fn a_device_without_its_master_key_is_asked_for_the_phrase() {
    let f = fixture(Keychain::holding_keys(None));
    let verified = f.verify(known()).await.unwrap();

    assert!(verified.needs_recovery_input && verified.device_id.is_none());
    assert!(!f.script.called("/auth/recovery-info") && !f.script.called("/auth/devices"));
}

#[tokio::test]
async fn a_master_key_that_is_not_the_accounts_is_asked_for_the_phrase() {
    let f = fixture(Keychain::holding_keys(Some(MASTER)));
    f.answer_recovery_info([1; 32]);

    let verified = f.verify(known()).await.unwrap();

    assert!(verified.needs_recovery_input);
    assert!(!f.script.called("/auth/devices"));
    assert_eq!(f.sync("deviceId"), Value::Null);
}

#[tokio::test]
async fn an_unreadable_recovery_info_is_asked_for_the_phrase() {
    let f = fixture(Keychain::holding_keys(Some(MASTER)));
    f.script.answer(400, json!({ "error": "no keys" }));

    let verified = f.verify(known()).await.unwrap();

    assert!(verified.needs_recovery_input);
    assert!(!f.script.called("/auth/devices"));
}

#[tokio::test]
async fn a_locked_master_key_is_keychain_unavailable_and_writes_nothing() {
    let mut keychain = Keychain::holding_keys(Some(MASTER));
    keychain.master_locked = true;
    let f = fixture(keychain);

    let error = f.verify(known()).await.unwrap_err();

    assert!(
        matches!(error, AccountError::KeychainUnavailable),
        "{error:?}"
    );
    assert!(!f.script.called("/auth/devices"));
    assert_eq!(f.sync("deviceId"), Value::Null);
}

#[tokio::test]
async fn a_failed_registration_keeps_the_device_key_it_had() {
    let f = fixture(Keychain::holding_keys(Some(MASTER)));
    let before = f.keychain.get(SecureStoreKey::DeviceSigningKey).unwrap();
    f.answer_recovery_info(MASTER);
    f.script.answer(400, json!({ "error": "VALIDATION_ERROR" }));

    let verified = f.verify(known()).await.unwrap();

    assert!(verified.needs_recovery_input);
    assert_eq!(
        f.keychain.get(SecureStoreKey::DeviceSigningKey).unwrap(),
        before
    );
}

#[tokio::test]
async fn first_device_setup_stores_the_key_and_holds_the_phrase_until_confirmed() {
    let f = fixture(Keychain::default());
    f.verify(json!({ "needsSetup": true })).await.unwrap();
    f.answer_registration("server-device-1");
    f.script.answer(200, json!({ "success": true }));

    let device = f.service.setup_new_account().await.unwrap();

    assert_eq!(device, "server-device-1");
    let master = f.keychain.get(SecureStoreKey::MasterKey).unwrap().unwrap();
    assert_eq!(
        f.sync("accountKeyVerifier"),
        keys::account_key_verifier(&master).unwrap().as_str()
    );
    assert_eq!(f.sync("recoveryPhraseConfirmed"), false);
    assert!(f.service.info().needs_recovery_confirmation);
    let phrase = f.service.recovery_phrase().expect("the phrase waits");
    assert_eq!(phrase.split_whitespace().count(), 24);

    f.service.confirm_recovery_phrase(true).unwrap();
    assert_eq!(f.sync("recoveryPhraseConfirmed"), true);
    assert!(f.service.recovery_phrase().is_none());
}

/// A phrase another device set up the account with, and the account's key material for it.
fn account_phrase() -> (String, Value) {
    let phrase = memry_core::crypto::recovery::generate_phrase().to_string();
    let salt = [3u8; 16];
    let seed = memry_core::crypto::recovery::phrase_to_seed(&phrase).unwrap();
    let master = keys::derive_master_key(seed.as_slice(), &salt).unwrap();
    let material = json!({
        "kdfSalt": BASE64.encode(salt),
        "keyVerifier": keys::account_key_verifier(&master).unwrap(),
    });
    (phrase, material)
}

/// A 409 on `/auth/setup` leaves this device registered with no master key: it is not signed in,
/// its phrase is dropped, and the account's phrase links it as the device it already is.
#[tokio::test]
async fn a_setup_another_device_finished_first_links_with_the_accounts_phrase() {
    let f = fixture(Keychain::default());
    f.verify(json!({ "needsSetup": true })).await.unwrap();
    f.answer_registration("server-device-1");
    f.script.answer(409, json!({ "error": "ALREADY_SET_UP" }));

    let error = f.service.setup_new_account().await.unwrap_err();

    assert!(matches!(error, AccountError::SetupConflict), "{error:?}");
    assert!(f.service.recovery_phrase().is_none());
    assert!(!f.keychain.has(SecureStoreKey::MasterKey));
    assert!(!f.service.info().signed_in);

    let (phrase, material) = account_phrase();
    f.script.answer(200, material.clone());
    let device = f.service.link_via_recovery(phrase).await.unwrap();

    assert_eq!(device, "server-device-1");
    assert_eq!(f.script.count("/auth/devices"), 1);
    assert!(f.script.called("/auth/key-verifier"));
    assert!(f.keychain.has(SecureStoreKey::MasterKey));
    assert_eq!(f.sync("accountKeyVerifier"), material["keyVerifier"]);
    assert!(f.service.info().signed_in);
}

/// A setup that failed before a device was registered gives way to a new sign-in without a
/// restart; only its setup token goes.
#[tokio::test]
async fn a_failed_setup_gives_way_to_a_new_code() {
    let f = fixture(Keychain::default());
    f.verify(json!({ "needsSetup": true })).await.unwrap();
    f.script
        .answer(400, json!({ "error": { "code": "VALIDATION_ERROR" } }));
    f.service.setup_new_account().await.unwrap_err();
    assert!(f.keychain.has(SecureStoreKey::SetupToken));
    f.script
        .answer(200, json!({ "success": true, "expiresIn": 600 }));

    let expires = f.service.request_otp("kaan@example.com".into()).await;

    assert_eq!(expires.unwrap(), Some(600));
    assert_eq!(f.script.count("/auth/otp/request"), 2);
    assert!(!f.keychain.has(SecureStoreKey::SetupToken));
    assert!(f.keychain.has(SecureStoreKey::DeviceSigningKey));
}

/// A setup token whose own `exp` passed while the user looked for the phrase is renewed before
/// the phrase is checked, not spent on a `401` first (`sync/setup-token.ts:109-113`).
#[tokio::test]
async fn a_setup_token_that_aged_out_is_renewed_before_the_phrase_is_checked() {
    let f = fixture(Keychain::default());
    let aged = jwt(json!({ "sub": "u", "jti": "jti-old", "exp": 1u64, "type": "setup" }));
    f.verify(json!({ "needsSetup": false, "setupToken": aged }))
        .await
        .unwrap();
    let (phrase, material) = account_phrase();
    f.script
        .answer(200, json!({ "success": true, "setupToken": setup_token() }));
    f.script.answer(200, material);
    f.answer_registration("server-device-1");

    let device = f.service.link_via_recovery(phrase).await.unwrap();

    assert_eq!(device, "server-device-1");
    let paths = f.script.paths.lock().unwrap().clone();
    assert_eq!(
        &paths[2..],
        [
            "/auth/setup-token/renew",
            "/auth/recovery-info",
            "/auth/devices"
        ]
    );
}

/// Once the keys may be published, a config that cannot be written does not take the phrase
/// with it: the phrase waits and the master key is stored (`device-registration.ts:178-187`).
#[tokio::test]
async fn a_config_write_that_fails_after_setup_keeps_the_phrase() {
    let f = fixture(Keychain::default());
    f.verify(json!({ "needsSetup": true })).await.unwrap();
    f.answer_registration("server-device-1");
    f.script.answer(200, json!({ "success": true }));
    std::fs::write(f._dir.path().join("memry-config.json"), "[]").unwrap();

    let device = f.service.setup_new_account().await.unwrap();

    assert_eq!(device, "server-device-1");
    assert!(f.keychain.has(SecureStoreKey::MasterKey));
    let phrase = f.service.recovery_phrase().expect("the phrase waits");
    assert_eq!(phrase.split_whitespace().count(), 24);
}

#[tokio::test]
async fn a_phrase_that_is_not_the_accounts_registers_nothing() {
    let f = fixture(Keychain::default());
    f.verify(json!({ "needsSetup": false })).await.unwrap();
    f.answer_recovery_info(MASTER);
    let phrase = memry_core::crypto::recovery::generate_phrase().to_string();

    let error = f.service.link_via_recovery(phrase).await.unwrap_err();

    assert!(matches!(error, AccountError::PhraseMismatch), "{error:?}");
    assert!(!f.script.called("/auth/devices"));
    assert!(!f.keychain.has(SecureStoreKey::MasterKey));
}

/// Sends feedback and a beta join with the account's bearer, and returns the `authorization`
/// header both carried.
async fn send_both(f: &Fixture, telemetry: &Service) -> Option<String> {
    f.script.answer(200, json!({ "success": true }));
    f.script.answer(200, json!({ "success": true }));
    let bearer = f.service.access_token_if_signed_in().await;
    let feedback = FeedbackSubmit {
        message: "hi".into(),
        email: None,
        app_version: None,
        platform: None,
    };
    let url = "https://sync.test/feedback";
    let sent = report::submit_feedback(&*f.script, url, feedback, bearer.as_deref()).await;
    assert!(sent.success, "{sent:?}");
    let input = IosBetaJoinInput {
        email: "me@example.com".into(),
        source: IosBetaSource::Settings,
    };
    let url = "https://sync.test/ios-beta/join";
    let joined = ios_beta::join(&*f.script, url, input, Some(telemetry), bearer.as_deref()).await;
    assert!(joined.success, "{joined:?}");
    let bearers = f.script.bearers.lock().unwrap();
    let [feedback, join] = &bearers[bearers.len() - 2..] else {
        unreachable!()
    };
    assert_eq!(feedback.0, "/feedback");
    assert_eq!(join.0, "/ios-beta/join");
    assert_eq!(feedback.1, join.1);
    feedback.1.clone()
}

/// Feedback and the iPhone beta invite (`ipc/feedback-handlers.ts:23-27`,
/// `ios-beta/join-ios-beta.ts:32-33`): the bearer when signed in; none signed out or when the
/// token cannot be read, and the request still goes.
#[tokio::test]
async fn feedback_and_the_beta_invite_carry_the_bearer_only_while_it_can_be_read() {
    let dir = tempfile::tempdir().unwrap();
    let telemetry = Service::start(
        dir.path(),
        Context {
            install_id: "i".into(),
            session_id: "s".into(),
            app_version: "1.0.0".into(),
            build_channel: "production".into(),
            platform: "darwin".into(),
            arch: "arm64".into(),
            locale: "en".into(),
            timezone_offset_minutes: 0,
        },
        // Nothing listens there: this test never flushes.
        Sender::new(
            "http://127.0.0.1:9/telemetry/batch",
            NativeTransport::loopback(),
        ),
        false,
    );
    let signed_out = fixture(Keychain::default());
    assert_eq!(send_both(&signed_out, &telemetry).await, None);

    let f = fixture(Keychain::holding_keys(Some(MASTER)));
    f.answer_recovery_info(MASTER);
    f.answer_registration("server-device-1");
    f.verify(known()).await.unwrap();
    assert_eq!(
        send_both(&f, &telemetry).await,
        Some(format!("Bearer {}", access_token("server-device-1")))
    );

    f.keychain.access_locked.store(true, Ordering::SeqCst);
    assert_eq!(send_both(&f, &telemetry).await, None);
}

#[tokio::test(start_paused = true)]
async fn a_copied_code_is_reported_once_per_new_value_until_ten_minutes_pass() {
    let clipboard = Arc::new(Mutex::new("old text".to_owned()));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let watch = OtpClipboardWatch::default();
    let read = clipboard.clone();
    let sink = seen.clone();
    watch.start(
        move || Some(read.lock().unwrap().clone()),
        move |code| sink.lock().unwrap().push(code),
    );
    let set = |text: &str| *clipboard.lock().unwrap() = text.to_owned();
    let step = || tokio::time::sleep(POLL + Duration::from_millis(10));

    set("123456");
    step().await;
    step().await; // the same value again is not a second report
    set("12345");
    step().await;
    set(" 654321 ");
    step().await;
    set("123456");
    step().await;
    assert_eq!(*seen.lock().unwrap(), ["123456", "654321", "123456"]);

    tokio::time::sleep(TIMEOUT).await;
    set("111111");
    step().await;
    assert_eq!(
        seen.lock().unwrap().len(),
        3,
        "the watch stops at ten minutes"
    );
}
