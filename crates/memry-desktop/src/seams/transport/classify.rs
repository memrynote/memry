//! One failure of `reqwest` or `tungstenite` in the seam's vocabulary. The core branches on the
//! variant, so the mapping is the seam's own judgement: a certificate or pin refusal is
//! `Tls`, which the core never retries, because retrying it would re-offer a connection that a
//! possible interception already failed.

use memry_core::api::errors::TransportError;
use tokio_tungstenite::tungstenite::Error as WsError;

/// RFC 6455 §7.4.1: 1006 is "closed abnormally".
pub const ABNORMAL_CLOSURE: u16 = 1006;

pub fn http_failure(error: &reqwest::Error, timeout_ms: u64) -> TransportError {
    if error.is_timeout() {
        return TransportError::Timeout {
            elapsed_ms: timeout_ms,
        };
    }
    if let Some(what) = tls_failure(error) {
        return TransportError::Tls { what };
    }
    TransportError::Failed {
        what: error.to_string(),
    }
}

/// A `rustls::Error` anywhere in the source chain, directly or inside an `io::Error`.
fn tls_failure(error: &(dyn std::error::Error + 'static)) -> Option<String> {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = source {
        if let Some(tls) = rustls_error(error) {
            return Some(tls.to_string());
        }
        source = error.source();
    }
    None
}

/// The rustls error, or an `io::Error` wrapping it (tokio-rustls wraps a handshake failure in
/// `InvalidData`, hyper wraps that again in `Other`).
fn rustls_error<'a>(error: &'a (dyn std::error::Error + 'static)) -> Option<&'a rustls::Error> {
    let mut current = error;
    loop {
        if let Some(tls) = current.downcast_ref::<rustls::Error>() {
            return Some(tls);
        }
        current = current.downcast_ref::<std::io::Error>()?.get_ref()?;
    }
}

pub fn socket_failure(error: &WsError) -> TransportError {
    match error {
        WsError::ConnectionClosed | WsError::AlreadyClosed => TransportError::SocketClosed {
            code: ABNORMAL_CLOSURE,
            reason: error.to_string(),
        },
        WsError::Http(response) => TransportError::HandshakeRejected {
            status: response.status().as_u16(),
        },
        WsError::Tls(error) => TransportError::Tls {
            what: error.to_string(),
        },
        WsError::Io(error) => match tls_failure(error) {
            Some(what) => TransportError::Tls { what },
            None => TransportError::Failed {
                what: error.to_string(),
            },
        },
        other => TransportError::Failed {
            what: other.to_string(),
        },
    }
}
