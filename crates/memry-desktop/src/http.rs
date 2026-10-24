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

fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .tls_backend_rustls()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("MemryNote/", env!("CARGO_PKG_VERSION")))
}
