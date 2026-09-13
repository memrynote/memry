//! Fakes for the `Transport`, `SecureStore` and sleep seams.
//!
//! The core owns no networking, so every test of the HTTP and auth tiers
//! drives a scripted `Transport` (Constitution I, research R5). Nothing here
//! reaches a network, and nothing here is a mock of the core's own logic: the
//! script is what a server said, and the assertions are about what the core
//! did with it.
//!
//! Each test binary compiles this module separately, so a helper only one of
//! them needs is dead code in the other. That is the cost of sharing fakes
//! across test binaries, not a sign of an unused helper.

#![allow(dead_code)]

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use memry_core::api::errors::{SecureStoreError, TransportError};
use memry_core::protocol::http::Sleeper;
use memry_core::seams::secure_store::{SecureStore, SecureStoreKey};
use memry_core::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};

/// A transport that answers from a script, in order, and records what it was
/// asked. Running past the end of the script is a test bug, so it panics
/// rather than inventing a response.
pub struct FakeTransport {
    script: Mutex<VecDeque<Result<HttpResponse, TransportError>>>,
    calls: Mutex<Vec<HttpRequest>>,
    /// Held inside `send`, so a concurrency test can keep a call in flight.
    pause_ms: u64,
}

impl FakeTransport {
    pub fn new(script: Vec<Result<HttpResponse, TransportError>>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into()),
            calls: Mutex::new(Vec::new()),
            pause_ms: 0,
        })
    }

    pub fn slow(script: Vec<Result<HttpResponse, TransportError>>, pause_ms: u64) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into()),
            calls: Mutex::new(Vec::new()),
            pause_ms,
        })
    }

    /// Appends to the script after construction.
    ///
    /// Needed by any flow whose later response depends on what the core sent
    /// earlier — device linking's `complete` body is sealed under a shared
    /// secret that only exists once the core has generated its ephemeral key
    /// and posted the public half, so it cannot be written before the run.
    pub fn push(&self, item: Result<HttpResponse, TransportError>) {
        self.script.lock().unwrap().push_back(item);
    }

    pub fn calls(&self) -> Vec<HttpRequest> {
        self.calls.lock().unwrap().clone()
    }

    pub fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }

    pub fn calls_to(&self, path_suffix: &str) -> Vec<HttpRequest> {
        self.calls()
            .into_iter()
            .filter(|c| c.url.ends_with(path_suffix))
            .collect()
    }
}

#[async_trait::async_trait]
impl Transport for FakeTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        self.calls.lock().unwrap().push(request.clone());
        let next = self.script.lock().unwrap().pop_front();
        if self.pause_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(self.pause_ms)).await;
        }
        next.unwrap_or_else(|| panic!("unscripted request to {}", request.url))
    }

    fn open_socket(
        &self,
        _request: SocketRequest,
        _listener: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "the fake transport opens no sockets".to_string(),
        })
    }
}

pub fn response(status: u16, body: &str) -> Result<HttpResponse, TransportError> {
    Ok(HttpResponse {
        status,
        headers: HashMap::new(),
        body: body.as_bytes().to_vec(),
    })
}

pub fn response_with_header(
    status: u16,
    body: &str,
    header: (&str, &str),
) -> Result<HttpResponse, TransportError> {
    let mut headers = HashMap::new();
    headers.insert(header.0.to_string(), header.1.to_string());
    Ok(HttpResponse {
        status,
        headers,
        body: body.as_bytes().to_vec(),
    })
}

/// The chapter 00 §0.4 object form.
pub fn error_response(
    status: u16,
    code: &str,
    message: &str,
) -> Result<HttpResponse, TransportError> {
    response(
        status,
        &format!(r#"{{"error":{{"code":"{code}","message":"{message}"}}}}"#),
    )
}

/// Records what the retry ladder asked to wait, without waiting.
#[derive(Default)]
pub struct RecordingSleeper {
    slept: Mutex<Vec<u64>>,
}

impl RecordingSleeper {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn slept(&self) -> Vec<u64> {
        self.slept.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Sleeper for RecordingSleeper {
    async fn sleep_ms(&self, ms: u64) {
        self.slept.lock().unwrap().push(ms);
    }
}

/// An in-memory secure store. `lock()` makes every read fail the way a device
/// with its passcode removed does — "locked", never "absent" (data-model §B).
#[derive(Default)]
pub struct FakeSecureStore {
    entries: Mutex<HashMap<SecureStoreKey, Vec<u8>>>,
    locked: Mutex<bool>,
}

impl FakeSecureStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn lock_device(&self) {
        *self.locked.lock().unwrap() = true;
    }

    /// The other half of `lock_device`. A locked store is a *transient* answer
    /// — the device gets unlocked — so a test that only ever locks cannot
    /// assert the retry that fact exists for.
    pub fn unlock_device(&self) {
        *self.locked.lock().unwrap() = false;
    }

    pub fn text(&self, key: SecureStoreKey) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .get(&key)
            .map(|v| String::from_utf8(v.clone()).unwrap())
    }

    pub fn put_text(&self, key: SecureStoreKey, value: &str) {
        self.entries
            .lock()
            .unwrap()
            .insert(key, value.as_bytes().to_vec());
    }
}

impl SecureStore for FakeSecureStore {
    fn get(&self, key: SecureStoreKey) -> Result<Option<Vec<u8>>, SecureStoreError> {
        if *self.locked.lock().unwrap() {
            return Err(SecureStoreError::Locked);
        }
        Ok(self.entries.lock().unwrap().get(&key).cloned())
    }

    fn set(&self, key: SecureStoreKey, value: Vec<u8>) -> Result<(), SecureStoreError> {
        if *self.locked.lock().unwrap() {
            return Err(SecureStoreError::Locked);
        }
        self.entries.lock().unwrap().insert(key, value);
        Ok(())
    }

    fn delete(&self, key: SecureStoreKey) -> Result<(), SecureStoreError> {
        self.entries.lock().unwrap().remove(&key);
        Ok(())
    }

    fn clear(&self) -> Result<(), SecureStoreError> {
        self.entries.lock().unwrap().clear();
        Ok(())
    }
}

/// An unsigned JWT with the given payload. The client never verifies a token
/// it holds — the signing key is the server's (chapter 02 §2.2) — so the
/// signature segment only has to exist.
pub fn jwt(payload: serde_json::Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"EdDSA","typ":"JWT"}"#);
    let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    format!("{header}.{body}.c2lnbmF0dXJl")
}

pub fn body_json(request: &HttpRequest) -> serde_json::Value {
    serde_json::from_slice(request.body.as_ref().expect("request has a body")).unwrap()
}
