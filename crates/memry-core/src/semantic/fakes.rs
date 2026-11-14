//! A model host over the `Transport` seam, serving ranges of in-memory files
//! the way Hugging Face's CDN does, for the download and API tests.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};

use super::model::{Manifest, ModelDir, ModelFile};
use crate::api::errors::TransportError;
use crate::seams::reachability::{Reachability, ReachabilityObserver, Reachable};
use crate::seams::transport::{
    HttpRequest, HttpResponse, SocketHandle, SocketListener, SocketRequest, Transport,
};

pub(crate) const BASE: &str = "https://models.test/repo/";

/// A file over two ranges, a file in one, and the bytes each serves.
pub(crate) fn files() -> Vec<(&'static str, Vec<u8>)> {
    let big = (0..super::download::RANGE_BYTES + 1000)
        .map(|i| (i % 251) as u8)
        .collect();
    vec![
        ("onnx/model.onnx_data", big),
        ("tokenizer.json", b"{\"vocab\":1}".to_vec()),
    ]
}

pub(crate) fn manifest(files: &[(&'static str, Vec<u8>)]) -> &'static Manifest {
    let files: Vec<ModelFile> = files
        .iter()
        .map(|(path, bytes)| ModelFile {
            path,
            size: bytes.len() as u64,
            sha256: Box::leak(hex::encode(Sha256::digest(bytes)).into_boxed_str()),
        })
        .collect();
    Box::leak(Box::new(Manifest {
        id: "test-model-1",
        base_url: BASE,
        vector_key: "test-key",
        files: Box::leak(files.into_boxed_slice()),
    }))
}

pub(crate) struct Scratch(pub(crate) PathBuf);

impl Scratch {
    pub(crate) fn new() -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "memry-semantic-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        Self(dir)
    }

    pub(crate) fn models(&self, manifest: &'static Manifest) -> ModelDir {
        ModelDir::with_manifest(self.0.join("models"), manifest)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) struct Wifi(pub(crate) Mutex<Reachable>);

impl Wifi {
    pub(crate) fn on() -> Arc<Self> {
        Arc::new(Self(Mutex::new(Reachable::Wifi)))
    }

    pub(crate) fn set(&self, reachable: Reachable) {
        *self.0.lock().unwrap() = reachable;
    }
}

impl Reachability for Wifi {
    fn current(&self) -> Reachable {
        *self.0.lock().unwrap()
    }
    fn observe(&self, _: Arc<dyn ReachabilityObserver>) {}
}

type Hook =
    Box<dyn Fn(usize, &HttpRequest) -> Option<Result<HttpResponse, TransportError>> + Send + Sync>;

/// Answers `BASE` + path with a 302 to the CDN, and the CDN with a 206 for
/// the asked range. A hook sees each call first and can answer it instead.
pub(crate) struct Cdn {
    files: HashMap<String, Vec<u8>>,
    pub(crate) requests: Mutex<Vec<HttpRequest>>,
    hook: Mutex<Option<Hook>>,
}

impl Cdn {
    pub(crate) fn new(files: &[(&'static str, Vec<u8>)]) -> Arc<Self> {
        Arc::new(Self {
            files: files
                .iter()
                .map(|(path, bytes)| ((*path).to_owned(), bytes.clone()))
                .collect(),
            requests: Mutex::new(Vec::new()),
            hook: Mutex::new(None),
        })
    }

    pub(crate) fn hook(
        &self,
        hook: impl Fn(usize, &HttpRequest) -> Option<Result<HttpResponse, TransportError>>
        + Send
        + Sync
        + 'static,
    ) {
        *self.hook.lock().unwrap() = Some(Box::new(hook));
    }

    pub(crate) fn ranges(&self) -> Vec<(String, String)> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.url.starts_with("https://cdn.test/"))
            .map(|request| (request.url.clone(), request.headers["range"].clone()))
            .collect()
    }

    fn serve(&self, request: &HttpRequest) -> HttpResponse {
        if let Some(path) = request.url.strip_prefix(BASE) {
            return response(
                302,
                &[("location", &format!("https://cdn.test/{path}"))],
                vec![],
            );
        }
        let path = request
            .url
            .strip_prefix("https://cdn.test/")
            .expect("known host");
        let bytes = &self.files[path];
        let (first, last) = request.headers["range"]
            .strip_prefix("bytes=")
            .and_then(|range| range.split_once('-'))
            .map(|(a, b)| (a.parse::<usize>().unwrap(), b.parse::<usize>().unwrap()))
            .expect("a range request");
        let last = last.min(bytes.len() - 1);
        response(
            206,
            &[(
                "content-range",
                &format!("bytes {first}-{last}/{}", bytes.len()),
            )],
            bytes[first..=last].to_vec(),
        )
    }
}

pub(crate) fn response(status: u16, headers: &[(&str, &str)], body: Vec<u8>) -> HttpResponse {
    HttpResponse {
        status,
        headers: headers
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect(),
        body,
    }
}

#[async_trait::async_trait]
impl Transport for Cdn {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let call = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request.clone());
            requests.len() - 1
        };
        if let Some(answer) = self
            .hook
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|hook| hook(call, &request))
        {
            return answer;
        }
        Ok(self.serve(&request))
    }

    fn open_socket(
        &self,
        _: SocketRequest,
        _: Arc<dyn SocketListener>,
    ) -> Result<Arc<dyn SocketHandle>, TransportError> {
        Err(TransportError::Failed {
            what: "no sockets".into(),
        })
    }
}
