use std::sync::OnceLock;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The one HTTP client for every non-sync caller. Built once and cloned.
///
/// rustls backend with the process default crypto provider (`ring`, installed by `main`) and
/// certificates verified through the platform verifier. A connect timeout and no total timeout:
/// a slow body is never cut off.
pub fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            builder()
                .build()
                .expect("the shared HTTP client needs a process default rustls crypto provider")
        })
        .clone()
}

/// A client that also trusts `root` and skips system proxies, for tests that talk to a local
/// TLS server.
#[doc(hidden)]
pub fn client_trusting(root: reqwest::Certificate) -> reqwest::Client {
    builder()
        .add_root_certificate(root)
        .no_proxy()
        .build()
        .expect("the test HTTP client needs a process default rustls crypto provider")
}

/// The shared client's settings, for a caller that needs its own policy on the same TLS stack
/// (the Unsplash service adds a redirect policy). Everyone else uses [`client`].
pub fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .tls_backend_rustls()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("MemryNote/", env!("CARGO_PKG_VERSION")))
}

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("the body is larger than {cap} bytes")]
    TooLarge { cap: usize },
    #[error("the connection failed while reading the body")]
    Transport(#[source] reqwest::Error),
}

/// The whole body, or an error as soon as it is known to exceed `cap`: by `Content-Length` before
/// reading, by the running count after. Every body of an untrusted host is read through this.
pub async fn read_capped(
    mut response: reqwest::Response,
    cap: usize,
) -> Result<Vec<u8>, ReadError> {
    if response
        .content_length()
        .is_some_and(|length| length > cap as u64)
    {
        return Err(ReadError::TooLarge { cap });
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(ReadError::Transport)? {
        if body.len() + chunk.len() > cap {
            return Err(ReadError::TooLarge { cap });
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
