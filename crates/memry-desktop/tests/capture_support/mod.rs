//! The capture server over a real loopback socket: a temp vault in a real session, a fake
//! keychain, a scripted consent prompt, and a raw HTTP/1.1 client that sends the exact bytes a
//! test writes (duplicate headers, a missing `Host`) and reads the whole answer, since every
//! answer closes the connection.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use memry_core::api::errors::SecureStoreError;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::registry::{AppConfig, VaultRegistry};
use memry_desktop::seams::secure_store::GenericSecrets;
use memry_desktop::services::capture::pairing::{ACCOUNT, Pairing, SERVICE};
use memry_desktop::services::capture::{self, CaptureDeps, CaptureFiler, CaptureServer};
use memry_desktop::session::{OpenSource, OpenVault, Session};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::device_key;

pub const CHROME: &str = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
pub const OTHER_CHROME: &str = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
pub const FIREFOX: &str = "moz-extension://5f2c8f9e-6a1b-4b8e-9d3a-0c1e2f3a4b5c";
/// How long a test waits for the consent prompt to be shown: a hang guard, not a bound.
const WAIT: Duration = Duration::from_secs(20);

/// An in-memory keychain that can be locked and counts writes.
#[derive(Default)]
pub struct Keychain {
    entries: Mutex<HashMap<(String, String), Vec<u8>>>,
    pub locked: AtomicBool,
    pub writes: AtomicUsize,
}

impl Keychain {
    pub fn put(&self, service: &str, account: &str, value: &[u8]) {
        let key = (service.to_owned(), account.to_owned());
        self.entries.lock().unwrap().insert(key, value.to_vec());
    }

    pub fn token(&self) -> Option<String> {
        let key = (SERVICE.to_owned(), ACCOUNT.to_owned());
        let entries = self.entries.lock().unwrap();
        entries
            .get(&key)
            .map(|v| String::from_utf8(v.clone()).unwrap())
    }

    fn check(&self) -> Result<(), SecureStoreError> {
        match self.locked.load(Ordering::SeqCst) {
            true => Err(SecureStoreError::Locked),
            false => Ok(()),
        }
    }
}

impl GenericSecrets for Keychain {
    fn get_secret(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Vec<u8>>, SecureStoreError> {
        self.check()?;
        let key = (service.to_owned(), account.to_owned());
        Ok(self.entries.lock().unwrap().get(&key).cloned())
    }

    fn set_secret(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> Result<(), SecureStoreError> {
        self.check()?;
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.put(service, account, value);
        Ok(())
    }

    fn delete_secret(&self, service: &str, account: &str) -> Result<(), SecureStoreError> {
        self.check()?;
        let key = (service.to_owned(), account.to_owned());
        self.entries.lock().unwrap().remove(&key);
        Ok(())
    }
}

/// The consent prompt: each call reports its origin on `asked` and waits for the test's answer.
pub struct Prompt {
    pub asked: mpsc::Receiver<String>,
    answers: mpsc::Sender<bool>,
}

impl Prompt {
    pub fn shown(&self) -> String {
        self.asked.recv_timeout(WAIT).expect("the consent prompt")
    }

    pub fn answer(&self, allow: bool) {
        self.answers.send(allow).unwrap();
    }

    pub fn not_shown(&self) -> bool {
        self.asked.try_recv().is_err()
    }
}

/// Files a capture by recording it, so routing that reaches the filer is visible.
#[derive(Default)]
pub struct Filer(pub Mutex<Vec<(String, String)>>);

impl CaptureFiler for Filer {
    fn file(&self, _: &OpenVault, item_id: &str, folder: &str) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .push((item_id.to_owned(), folder.to_owned()));
        Ok(())
    }
}

pub struct Env {
    pub _dir: tempfile::TempDir,
    pub vault: PathBuf,
    pub session: Session,
    pub store: Arc<dyn SecureStore>,
    pub config: Arc<AppConfig>,
    pub keychain: Arc<Keychain>,
    pub pairing: Arc<Pairing>,
    pub prompt: Prompt,
    consent: capture::Consent,
}

/// A temp vault open in a new session, with `config` (Electron's `memry-config.json` text, or
/// none) as the app config.
pub fn env_with_config(config: Option<&str>) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().join("Clippings Vault");
    fs::create_dir_all(&vault).unwrap();
    fs::create_dir_all(dir.path().join("app")).unwrap();
    let config_path = dir.path().join("app/memry-config.json");
    if let Some(text) = config {
        fs::write(&config_path, text).unwrap();
    }
    let config = Arc::new(AppConfig::load(config_path));
    let session = Session::new(VaultRegistry::new(config.clone()));
    session.open(&vault, OpenSource::Select).unwrap();
    let keychain = Arc::new(Keychain::default());
    let pairing = Arc::new(Pairing::new(keychain.clone(), None, config.clone()));
    let (asked_tx, asked) = mpsc::channel();
    let (answers, answers_rx) = mpsc::channel::<bool>();
    let answers_rx = Mutex::new(answers_rx);
    let consent: capture::Consent = Arc::new(move |origin: &str| {
        asked_tx.send(origin.to_owned()).unwrap();
        answers_rx.lock().unwrap().recv().unwrap_or(false)
    });
    Env {
        _dir: dir,
        vault,
        session,
        store: device_key::with_device_key(),
        config,
        keychain,
        pairing,
        prompt: Prompt { asked, answers },
        consent,
    }
}

pub fn env() -> Env {
    env_with_config(None)
}

impl Env {
    pub fn deps(&self, filer: Option<Arc<dyn CaptureFiler>>) -> CaptureDeps {
        CaptureDeps {
            session: self.session.clone(),
            store: self.store.clone(),
            pairing: self.pairing.clone(),
            consent: self.consent.clone(),
            version: "1.2.3".to_owned(),
            hero: None,
            filer,
            telemetry: None,
        }
    }

    /// The server on an ephemeral port.
    pub async fn start(&self) -> CaptureServer {
        capture::start_in(self.deps(None), 0, 1).await.unwrap()
    }

    /// `origin` paired with the token the server mints, as a finished pairing leaves it.
    pub fn paired(&self, origin: &str) -> String {
        self.pairing
            .open_window_for(Some(origin), Duration::from_secs(60));
        self.pairing.claim(origin).unwrap().unwrap().to_string()
    }

    pub fn config_json(&self) -> Value {
        serde_json::from_str(&fs::read_to_string(self.config.path()).unwrap()).unwrap()
    }
}

/// A loopback port another program holds, low enough that the seven after it exist.
pub async fn busy_port() -> (tokio::net::TcpListener, u16) {
    loop {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        if port < 65_000 {
            return (listener, port);
        }
    }
}

/// A multi-threaded runtime, so the blocking session calls of a test never run on it.
pub fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// A request built byte for byte. `Host: 127.0.0.1:<port>` comes first unless `no_host`.
pub struct Req {
    head: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    host: bool,
}

pub fn req(method: &str, target: &str) -> Req {
    Req {
        head: format!("{method} {target} HTTP/1.1"),
        headers: Vec::new(),
        body: Vec::new(),
        host: true,
    }
}

impl Req {
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub fn no_host(mut self) -> Self {
        self.host = false;
        self
    }

    /// The headers `captureHeaders(token)` sets, plus the `Origin` the browser adds.
    pub fn authed(self, origin: &str, token: &str) -> Self {
        self.header("Origin", origin)
            .header("Content-Type", "application/json")
            .header("Authorization", &format!("Bearer {token}"))
            .header("X-Memry-Capture", "1")
    }

    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }

    pub fn json(self, value: &Value) -> Self {
        self.body(value.to_string())
    }

    pub async fn send(self, port: u16) -> Resp {
        let mut bytes = format!("{}\r\n", self.head).into_bytes();
        if self.host {
            bytes.extend(format!("Host: 127.0.0.1:{port}\r\n").into_bytes());
        }
        for (name, value) in &self.headers {
            bytes.extend(format!("{name}: {value}\r\n").into_bytes());
        }
        bytes.extend(format!("Content-Length: {}\r\n\r\n", self.body.len()).into_bytes());
        bytes.extend(&self.body);
        send_raw(port, &bytes).await
    }
}

#[derive(Debug)]
pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

impl Resp {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The status and the `error` code, as the extension reads a refusal.
    pub fn refused(&self) -> (u16, &str) {
        (self.status, self.body["error"].as_str().unwrap_or(""))
    }
}

pub async fn send_raw(port: u16, bytes: &[u8]) -> Resp {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(bytes).await.unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    let text = String::from_utf8(answer).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").expect("a full answer");
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().split(' ').nth(1).unwrap();
    let headers = lines
        .map(|line| {
            let (name, value) = line.split_once(": ").unwrap();
            (name.to_owned(), value.to_owned())
        })
        .collect();
    Resp {
        status: status.parse().unwrap(),
        headers,
        body: serde_json::from_str(body).unwrap_or(Value::Null),
    }
}

/// A capture as `mapToArticleCapture` builds it (`packages/article-extract/src/map.ts`).
pub fn article(url: &str) -> Value {
    serde_json::json!({
        "url": url,
        "mode": "article",
        "contentMarkdown": "# Title\n\nBody text.",
        "excerpt": "Body text.",
        "extractionStatus": "full",
        "properties": {
            "title": "Title",
            "source": url,
            "author": "A. Writer",
            "published": "2026-11-01",
            "created": "2026-11-18",
            "description": "A page"
        },
        "tags": ["clippings"]
    })
}
