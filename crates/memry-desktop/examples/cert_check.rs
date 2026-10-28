//! Prints the certificates a sync host presents and audits its pin entry: the Rust tool that
//! replaces Electron's `pnpm cert:check` and `pnpm cert:extract`.
//!
//! `cargo run -p memry-desktop --example cert_check -- [hostname] [port]` (root: `pnpm cert:check`)
//!
//! It connects with the platform verifier (OS trust store and hostname), then prints each
//! certificate with its depth, subject CN, validity and SPKI pin, and the OS root that ends the
//! path. The certificates on the path webpki verifies against the OS roots are what a pin can match
//! (`seams::tls::spki`), the same check the app runs. Then it prints the audit of the host's entry
//! in `seams::tls::pins`: an error for no entry or a malformed pin, a warning for placeholders (an
//! error with `MEMRY_CERT_PINS_STRICT=1`), and an error when real pins are on no verified path. It
//! exits 1 on any error.
//!
//! Without a hostname it audits the host the build dials: `SYNC_SERVER_URL` from the process, else
//! from `apps/desktop-tauri/.env.<MEMRY_ENV>` (default `production`), else `sync.memrynote.com`,
//! as `apps/desktop/scripts/check-cert-hashes-config.ts` does.

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::path::Path;
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use memry_desktop::seams::tls::Anchors;
use memry_desktop::seams::tls::pins::{
    AuditLevel, DEFAULT_SYNC_HOST, PinTable, audit, normalize_hostname,
};
use memry_desktop::seams::tls::spki::{pin_of_spki, verified_path_pins};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme};
use x509_parser::prelude::{FromDer, X509Certificate};

/// The parser `build.rs` reads the same files with.
#[allow(dead_code)]
#[path = "../../../apps/desktop-tauri/src-tauri/build_env.rs"]
mod build_env;

const TIMEOUT: Duration = Duration::from_secs(10);

/// The platform verifier, keeping the chain it was shown.
#[derive(Debug)]
struct Recording {
    inner: rustls_platform_verifier::Verifier,
    chain: Mutex<Vec<Vec<u8>>>,
}

impl ServerCertVerifier for Recording {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        *self.chain.lock().unwrap() = std::iter::once(end_entity)
            .chain(intermediates)
            .map(|der| der.to_vec())
            .collect();
        self.inner
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

/// The audited host and whether placeholders fail, the way `check-cert-hashes-config.ts` picks
/// them: the process environment wins over the runtime env file.
fn configured_host() -> (String, String, bool) {
    let env = std::env::var("MEMRY_ENV")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "production".to_owned());
    let file_name = format!(".env.{}", env.trim());
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop-tauri")
        .join(&file_name);
    let file = std::fs::read_to_string(&path)
        .map(|text| build_env::parse_env_file(&text))
        .unwrap_or_default();
    let ambient = std::env::var("SYNC_SERVER_URL").unwrap_or_default();
    let (url, source) = match (ambient.trim(), file.get("SYNC_SERVER_URL")) {
        (ambient, _) if !ambient.is_empty() => (ambient.to_owned(), "SYNC_SERVER_URL".to_owned()),
        (_, Some(url)) if !url.trim().is_empty() => (
            url.trim().to_owned(),
            format!("apps/desktop-tauri/{file_name}"),
        ),
        _ => (String::new(), "the default".to_owned()),
    };
    let host = url::Url::parse(&url)
        .ok()
        .and_then(|url| url.host_str().map(normalize_hostname))
        .unwrap_or_else(|| DEFAULT_SYNC_HOST.to_owned());
    let strict = std::env::var("MEMRY_CERT_PINS_STRICT")
        .ok()
        .or_else(|| file.get("MEMRY_CERT_PINS_STRICT").cloned())
        .is_some_and(|value| value == "1");
    (host, source, strict)
}

/// The chain `host` presents, after the platform verifier accepted it.
fn fetch_chain(host: &str, port: u16) -> Result<Vec<Vec<u8>>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let inner = rustls_platform_verifier::Verifier::new(provider.clone())
        .map_err(|error| format!("could not start the platform verifier: {error}"))?;
    let verifier = Arc::new(Recording {
        inner,
        chain: Mutex::new(Vec::new()),
    });
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| error.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_no_client_auth();
    let name = ServerName::try_from(host.to_owned()).map_err(|error| error.to_string())?;
    let mut connection = ClientConnection::new(Arc::new(config), name)
        .map_err(|error| format!("TLS setup failed: {error}"))?;
    let addr = std::net::ToSocketAddrs::to_socket_addrs(&(host, port))
        .map_err(|error| format!("could not resolve {host}: {error}"))?
        .next()
        .ok_or_else(|| format!("{host} has no address"))?;
    let mut socket = TcpStream::connect_timeout(&addr, TIMEOUT)
        .map_err(|error| format!("could not connect to {host}:{port}: {error}"))?;
    socket.set_read_timeout(Some(TIMEOUT)).ok();
    socket.set_write_timeout(Some(TIMEOUT)).ok();
    let mut tls = rustls::Stream::new(&mut connection, &mut socket);
    tls.flush()
        .map_err(|error| format!("the TLS handshake with {host} failed: {error}"))?;
    // A read completes the handshake on TLS 1.3 servers that send nothing first; its answer is
    // not needed.
    let _ = tls.write_all(
        format!("HEAD / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes(),
    );
    let _ = tls.read(&mut [0; 1]);
    let chain = verifier.chain.lock().unwrap().clone();
    if chain.is_empty() {
        return Err(format!("{host} presented no certificate"));
    }
    Ok(chain)
}

fn subject_cn(cert: &X509Certificate<'_>) -> String {
    cert.subject()
        .iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .map_or_else(|| cert.subject().to_string(), str::to_owned)
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (host, source, strict) = match args.next() {
        Some(host) => {
            let strict = std::env::var("MEMRY_CERT_PINS_STRICT").is_ok_and(|value| value == "1");
            (
                normalize_hostname(&host),
                "the command line".to_owned(),
                strict,
            )
        }
        None => configured_host(),
    };
    let port = match args.next().map(|port| port.parse::<u16>()) {
        None => 443,
        Some(Ok(port)) => port,
        Some(Err(_)) => {
            eprintln!("usage: cert_check [hostname] [port]");
            return ExitCode::FAILURE;
        }
    };
    println!("Auditing sync host {host} from {source}.");

    let table = PinTable::production();
    let pins = table.pins_for(&host).to_vec();
    let mut failed = false;

    match fetch_chain(&host, port) {
        Ok(chain) => {
            let real: Vec<&String> = pins
                .iter()
                .filter(|pin| !pin.to_ascii_uppercase().contains("PLACEHOLDER"))
                .collect();
            // The path the app's pin check takes: one through a real pin when the host has any.
            let ders: Vec<CertificateDer<'_>> =
                chain.iter().map(|der| der.as_slice().into()).collect();
            let roots = Anchors::native().roots();
            let wanted =
                |path: &[String]| real.is_empty() || real.iter().any(|pin| path.contains(pin));
            let any_path = |_: &[String]| true;
            let now = UnixTime::now();
            let verified = verified_path_pins(&roots, &ders[0], &ders[1..], now, &wanted);
            let path = match &verified {
                Ok(path) => path.clone(),
                Err(_) => verified_path_pins(&roots, &ders[0], &ders[1..], now, &any_path)
                    .unwrap_or_default(),
            };
            for (depth, der) in chain.iter().enumerate() {
                let Ok((_, cert)) = X509Certificate::from_der(der) else {
                    println!("  [{depth}] could not be read");
                    continue;
                };
                let pin = pin_of_spki(cert.public_key().raw);
                let role = match (depth, path.contains(&pin)) {
                    (0, _) => "end-entity, matchable",
                    (_, true) => "intermediate on the verified path, matchable",
                    (_, false) => "not on the verified path, not matchable",
                };
                let validity = cert.validity();
                println!("  [{depth}] {} ({role})", subject_cn(&cert));
                println!(
                    "      valid {} to {}",
                    validity.not_before, validity.not_after
                );
                let configured = if pins.contains(&pin) {
                    "  <- pinned"
                } else {
                    ""
                };
                println!("      {pin}{configured}");
            }
            match path.last() {
                Some(anchor) if path.len() > 1 => {
                    let configured = if pins.contains(anchor) {
                        "  <- pinned"
                    } else {
                        ""
                    };
                    println!("  [anchor] the OS root that ends the verified path, matchable");
                    println!("      {anchor}{configured}");
                }
                _ => {
                    eprintln!("ERROR: no path from the leaf to an OS root verified.");
                    failed = true;
                }
            }
            if !real.is_empty() && verified.is_err() {
                eprintln!(
                    "ERROR: none of the {} pin(s) of {host} is on a verified path; a release build would refuse this host.",
                    real.len()
                );
                failed = true;
            }
        }
        Err(error) => {
            eprintln!("ERROR: {error}");
            failed = true;
        }
    }

    let result = audit(&host, &pins, strict);
    match result.level {
        AuditLevel::Error => {
            eprintln!("ERROR: {}", result.message);
            failed = true;
        }
        AuditLevel::Warn => println!("WARNING: {}", result.message),
        AuditLevel::Ok => println!("{}", result.message),
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
