//! A test PKI and local TLS servers for the seam tests. The client under test trusts the test
//! root through a `WebPkiServerVerifier` in place of the OS trust store, so the pinning and
//! transport code runs unchanged.
#![allow(dead_code)]

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use memry_desktop::seams::tls::pins::PinTable;
use memry_desktop::seams::tls::spki::spki_pin;
use memry_desktop::seams::tls::{PinFailure, PinFailureSink, TlsSetup};
use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, DnType, IsCa, KeyPair, KeyUsagePurpose,
    date_time_ymd,
};
use rustls::RootCertStore;
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;
use x509_parser::prelude::FromDer;

pub fn ring() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

pub fn ca(
    name: &str,
    parent: Option<&CertifiedIssuer<'static, KeyPair>>,
) -> CertifiedIssuer<'static, KeyPair> {
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    params.distinguished_name.push(DnType::CommonName, name);
    let key = KeyPair::generate().unwrap();
    match parent {
        Some(parent) => CertifiedIssuer::signed_by(params, key, parent).unwrap(),
        None => CertifiedIssuer::self_signed(params, key).unwrap(),
    }
}

/// A leaf for `host` signed by `issuer`. `expired` backdates it.
pub fn leaf(
    host: &str,
    issuer: &CertifiedIssuer<'static, KeyPair>,
    expired: bool,
) -> (CertificateDer<'static>, PrivateKeyDer<'static>) {
    let mut params = CertificateParams::new(vec![host.to_owned()]).unwrap();
    params.distinguished_name.push(DnType::CommonName, host);
    if expired {
        params.not_before = date_time_ymd(1990, 1, 1);
        params.not_after = date_time_ymd(2000, 1, 1);
    }
    let key = KeyPair::generate().unwrap();
    let cert = params.signed_by(&key, issuer).unwrap();
    (
        cert.der().clone(),
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
    )
}

pub fn pin_of(der: &CertificateDer<'_>) -> String {
    let (_, cert) = x509_parser::certificate::X509Certificate::from_der(der.as_ref()).unwrap();
    spki_pin(&cert)
}

/// `root -> intermediate -> leaf(host)`.
pub struct Chain {
    pub root: CertifiedIssuer<'static, KeyPair>,
    pub intermediate: CertifiedIssuer<'static, KeyPair>,
    pub leaf: CertificateDer<'static>,
    pub leaf_key: PrivateKeyDer<'static>,
}

impl Chain {
    pub fn new(host: &str) -> Self {
        let root = ca("Test Root", None);
        let intermediate = ca("Test Intermediate", Some(&root));
        let (leaf, leaf_key) = leaf(host, &intermediate, false);
        Self {
            root,
            intermediate,
            leaf,
            leaf_key,
        }
    }

    pub fn leaf_pin(&self) -> String {
        pin_of(&self.leaf)
    }

    pub fn intermediate_pin(&self) -> String {
        pin_of(self.intermediate.der())
    }

    /// What a server presents: the leaf and the intermediate.
    pub fn presented(&self) -> Vec<CertificateDer<'static>> {
        vec![self.leaf.clone(), self.intermediate.der().clone()]
    }
}

/// The client side: the OS trust store replaced by `roots`, the pin table by `pins` for `host`.
pub fn setup(
    roots: &[&CertificateDer<'static>],
    host: &str,
    pins: &[String],
    active: bool,
) -> TlsSetup {
    let mut store = RootCertStore::empty();
    for root in roots {
        store.add((*root).clone()).unwrap();
    }
    let inner = WebPkiServerVerifier::builder_with_provider(Arc::new(store), ring())
        .build()
        .unwrap();
    TlsSetup {
        inner,
        table: PinTable::new([(host.to_owned(), pins.to_vec())]),
        active,
    }
}

#[derive(Default)]
pub struct RecordingSink(pub std::sync::Mutex<Vec<PinFailure>>);

impl PinFailureSink for RecordingSink {
    fn pin_failed(&self, failure: PinFailure) {
        self.0.lock().unwrap().push(failure);
    }
}

impl RecordingSink {
    pub fn failures(&self) -> Vec<PinFailure> {
        self.0.lock().unwrap().clone()
    }
}

pub struct Server {
    pub port: u16,
    /// TCP connections accepted, before any TLS.
    pub accepted: Arc<AtomicUsize>,
}

impl Server {
    pub fn accepted(&self) -> usize {
        self.accepted.load(Ordering::SeqCst)
    }
}

/// A TLS server presenting `presented` with `key`. `handler` gets each connection after the
/// handshake; a failed handshake is dropped.
pub async fn serve<H, Fut>(
    presented: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
    handler: H,
) -> Server
where
    H: Fn(TlsStream<TcpStream>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let config = rustls::ServerConfig::builder_with_provider(ring())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(presented, key)
        .unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let counter = accepted.clone();
    let handler = Arc::new(handler);
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                return;
            };
            counter.fetch_add(1, Ordering::SeqCst);
            let (acceptor, handler) = (acceptor.clone(), handler.clone());
            tokio::spawn(async move {
                if let Ok(tls) = acceptor.accept(tcp).await {
                    handler(tls).await;
                }
            });
        }
    });
    Server { port, accepted }
}

/// Reads one request head (up to the blank line) and returns it.
pub async fn read_head(stream: &mut (impl tokio::io::AsyncRead + Unpin)) -> String {
    use tokio::io::AsyncReadExt;
    let mut head = Vec::new();
    let mut byte = [0_u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.unwrap_or(0) == 0 {
            break;
        }
        head.push(byte[0]);
    }
    String::from_utf8_lossy(&head).into_owned()
}
