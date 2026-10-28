//! The realtime hint socket. It moves frames and nothing else: ping and heartbeat stay in the
//! core (`sync/socket_run.rs`).

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use memry_core::api::errors::TransportError;
use memry_core::seams::transport::{SocketHandle, SocketListener, SocketRequest};
use rustls::ClientConfig;
use tokio::runtime::Handle;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, Request};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::{Connector, connect_async_tls_with_config};

use super::classify::{ABNORMAL_CLOSURE, socket_failure};

const NORMAL_CLOSURE: u16 = 1000;
/// A socket frame is a hint; the server's largest (`DEFAULT_SOCKET_ITEMS_MAX_BYTES`) is 64 KiB.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

pub fn wire_request(request: &SocketRequest) -> Result<Request<()>, TransportError> {
    let mut wire = request
        .url
        .as_str()
        .into_client_request()
        .map_err(|error| TransportError::Failed {
            what: format!("unusable socket url `{}`: {error}", request.url),
        })?;
    for (name, value) in &request.headers {
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|error| TransportError::Failed {
                what: format!("unusable header name `{name}`: {error}"),
            })?;
        let value = HeaderValue::from_str(value).map_err(|error| TransportError::Failed {
            what: format!("unusable value for header `{name}`: {error}"),
        })?;
        wire.headers_mut().insert(name, value);
    }
    Ok(wire)
}

/// What the core asked the socket to do. Dropping every sender ends the pump, which is how
/// "dropping the handle closes the socket" is implemented.
enum Outbound {
    Send(Vec<u8>),
    Close,
}

struct NativeSocket {
    outbound: UnboundedSender<Outbound>,
}

impl SocketHandle for NativeSocket {
    fn send(&self, payload: Vec<u8>) -> Result<(), TransportError> {
        self.outbound
            .send(Outbound::Send(payload))
            .map_err(|_| TransportError::SocketClosed {
                code: ABNORMAL_CLOSURE,
                reason: "the socket task has ended".to_owned(),
            })
    }

    fn close(&self) {
        let _ = self.outbound.send(Outbound::Close);
    }
}

/// Starts the pump on `runtime` and returns the handle at once; readiness and failure reach the
/// listener (`on_open`, `on_error`). `tls` offers `http/1.1` only.
pub fn open(
    runtime: &Handle,
    wire: Request<()>,
    listener: Arc<dyn SocketListener>,
    tls: Arc<ClientConfig>,
) -> Arc<dyn SocketHandle> {
    let (outbound, inbound) = mpsc::unbounded_channel();
    runtime.spawn(pump(wire, listener, inbound, tls));
    Arc::new(NativeSocket { outbound })
}

/// Reads frames up to the listener and writes the core's frames down. The listener's methods run
/// synchronously on this task, the seam's contract: a shell never re-enters the core from one.
async fn pump(
    request: Request<()>,
    listener: Arc<dyn SocketListener>,
    mut outbound: UnboundedReceiver<Outbound>,
    tls: Arc<ClientConfig>,
) {
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES));
    let connecting =
        connect_async_tls_with_config(request, Some(config), false, Some(Connector::Rustls(tls)));
    let stream = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
        Ok(Ok((stream, _response))) => stream,
        Ok(Err(error)) => {
            listener.on_error(socket_failure(&error));
            return;
        }
        Err(_elapsed) => {
            listener.on_error(TransportError::Timeout {
                elapsed_ms: u64::try_from(CONNECT_TIMEOUT.as_millis()).unwrap_or(u64::MAX),
            });
            return;
        }
    };
    listener.on_open();
    let (mut writer, mut reader) = stream.split();

    loop {
        tokio::select! {
            command = outbound.recv() => match command {
                Some(Outbound::Send(payload)) => {
                    if let Err(error) = writer.send(Message::Binary(payload.into())).await {
                        listener.on_error(socket_failure(&error));
                        break;
                    }
                }
                // `None` is every handle dropped, which the seam defines as a close.
                Some(Outbound::Close) | None => {
                    let _ = writer.close().await;
                    listener.on_closed(NORMAL_CLOSURE, "closed by the core".to_owned());
                    break;
                }
            },
            frame = reader.next() => match frame {
                // Text and binary are the same to the core: the socket is a hint channel and the
                // payload is never parsed here (chapter 09).
                Some(Ok(Message::Binary(bytes))) => listener.on_message(bytes.to_vec()),
                Some(Ok(Message::Text(text))) => listener.on_message(text.as_bytes().to_vec()),
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = match frame {
                        Some(frame) => (frame.code.into(), frame.reason.to_string()),
                        None => (ABNORMAL_CLOSURE, String::new()),
                    };
                    listener.on_closed(code, reason);
                    break;
                }
                // Ping, pong and continuation: tungstenite answers pings itself.
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    listener.on_error(socket_failure(&error));
                    break;
                }
                None => {
                    listener.on_closed(ABNORMAL_CLOSURE, "the socket ended".to_owned());
                    break;
                }
            },
        }
    }
}
