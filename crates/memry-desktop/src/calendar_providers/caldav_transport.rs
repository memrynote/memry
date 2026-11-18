//! The one HTTP path every CalDAV request takes (`caldav/caldav-transport.ts`, #1399). It owns
//! what a plain client gets wrong for CalDAV:
//!
//! 1. **Credentials across redirects.** iCloud answers discovery with a redirect to a
//!    per-account partition host (`p67-caldav.icloud.com`). Redirects are followed here, by hand,
//!    and credentials go only to hosts inside the account's [`CredentialScope`].
//! 2. **Digest.** Answered from the server's challenge ([`super::caldav_digest`]).
//! 3. **Deadlines.** Each request, its body included, has [`TIMEOUT`]; a body past [`MAX_BODY`]
//!    is refused before it is read in full.
//!
//! The password stays in this struct (zeroized on drop) and in the `Authorization` header of a
//! request to an in-scope host; it is never logged.

use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use reqwest::header::{
    AUTHORIZATION, CONTENT_TYPE, HeaderValue, LOCATION, RETRY_AFTER, WWW_AUTHENTICATE,
};
use reqwest::{Method, StatusCode};
use url::{Host, Url};
use zeroize::Zeroizing;

use super::caldav_digest::{self, Answer, Challenge};
use crate::http::{ReadError, read_capped};

/// `DEFAULT_TIMEOUT_MS`: one request, its body included.
pub const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;
/// The largest answer read. A calendar listing of 500 collections is well under 2 MiB; Electron
/// read any size.
pub const MAX_BODY: usize = 16 * 1024 * 1024;

/// Providers that spread one account over several hosts inside a domain they own outright.
const MULTI_HOST_PROVIDER_DOMAINS: [&str; 5] = [
    "icloud.com",
    "me.com",
    "fastmail.com",
    "yahoo.com",
    "zoho.com",
];

fn within_domain(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|rest| rest.ends_with('.'))
}

/// `createCredentialScope`: the origins that may receive the account's credentials. The exact
/// origin the user connected to (scheme, host and port), plus, for a known multi-host provider,
/// the rest of that provider's own domain over HTTPS on 443; never a parent domain in general
/// (`myname.synology.me` must not reach `other.synology.me`). Electron matched the host alone for
/// HTTPS, so another port or an upgrade from plain HTTP kept the credentials; here they do not.
#[derive(Debug, Clone)]
pub struct CredentialScope {
    scheme: String,
    host: String,
    port: Option<u16>,
    provider_domain: Option<&'static str>,
}

impl CredentialScope {
    pub fn new(server: &Url) -> Self {
        let host = server.host_str().unwrap_or_default().to_ascii_lowercase();
        let provider_domain = match server.host() {
            Some(Host::Domain(_)) => MULTI_HOST_PROVIDER_DOMAINS
                .into_iter()
                .find(|domain| within_domain(&host, domain)),
            _ => None,
        };
        Self {
            scheme: server.scheme().to_owned(),
            host,
            port: server.port_or_known_default(),
            provider_domain,
        }
    }

    pub fn allows(&self, target: &Url) -> bool {
        let host = target.host_str().unwrap_or_default().to_ascii_lowercase();
        let port = target.port_or_known_default();
        let same_origin = matches!(target.scheme(), "http" | "https")
            && target.scheme() == self.scheme
            && host == self.host
            && port == self.port;
        let provider_host = target.scheme() == "https"
            && port == Some(443)
            && self
                .provider_domain
                .is_some_and(|domain| within_domain(&host, domain));
        same_origin || provider_host
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("the CalDAV server did not answer in time")]
    Timeout,
    #[error("could not reach the CalDAV server: {0}")]
    Network(#[source] reqwest::Error),
    #[error("the CalDAV answer is larger than {0} bytes")]
    TooLarge(usize),
    #[error("a CalDAV redirect points nowhere this client can go")]
    BadRedirect,
    /// A user name with a control character cannot go into an `Authorization` header.
    #[error("the credentials cannot be sent in a header")]
    BadHeader,
}

/// The last error status a request ended with, after auth retries (`lastFailure`): what tells a
/// wrong password from a server that is down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub status: u16,
    pub retry_after: Option<String>,
}

pub struct DavRequest {
    pub method: Method,
    pub url: Url,
    pub depth: Option<&'static str>,
    pub body: Option<String>,
    /// `false` hands a 3xx back to the caller (`redirect: 'manual'`).
    pub follow: bool,
}

/// A final answer, its body read.
#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    /// The URL of the request that answered (the last hop).
    pub url: Url,
    pub location: Option<String>,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

/// The client every CalDAV account shares: the app's TLS stack with redirects off.
pub struct CaldavHttp {
    client: reqwest::Client,
    timeout: Duration,
}

impl CaldavHttp {
    pub fn new(builder: reqwest::ClientBuilder, timeout: Duration) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: builder
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            timeout,
        })
    }

    pub fn transport(&self, server: &Url, username: &str, password: &str) -> Transport {
        Transport {
            client: self.client.clone(),
            timeout: self.timeout,
            scope: CredentialScope::new(server),
            username: username.to_owned(),
            password: Zeroizing::new(password.to_owned()),
            digest: Mutex::new(None),
            last_failure: Mutex::new(None),
        }
    }
}

pub struct Transport {
    client: reqwest::Client,
    timeout: Duration,
    scope: CredentialScope,
    username: String,
    password: Zeroizing<String>,
    /// The server's Digest challenge and the nonce count used under it.
    digest: Mutex<Option<(Challenge, u32)>>,
    last_failure: Mutex<Option<Failure>>,
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

fn header(response: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

enum Hop {
    Done(Reply),
    Redirect(Url, u16),
}

impl Transport {
    pub fn last_failure(&self) -> Option<Failure> {
        self.last_failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn uses_digest(&self) -> bool {
        self.digest
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    fn authorization(&self, target: &Url, method: &Method) -> Option<String> {
        if !self.scope.allows(target) {
            return None;
        }
        let mut digest = self.digest.lock().unwrap_or_else(|e| e.into_inner());
        let Some((challenge, count)) = digest.as_mut() else {
            let pair = Zeroizing::new(format!("{}:{}", self.username, self.password.as_str()));
            let encoded = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(pair));
            return Some(format!("Basic {}", encoded.as_str()));
        };
        *count += 1;
        let cnonce = hex::encode(memry_core::crypto::sodium::random_bytes(8));
        let uri = match target.query() {
            Some(query) => format!("{}?{query}", target.path()),
            None => target.path().to_owned(),
        };
        Some(caldav_digest::authorization(
            challenge,
            &Answer {
                username: &self.username,
                password: &self.password,
                method: method.as_str(),
                uri: &uri,
                nonce_count: *count,
                cnonce: &cnonce,
            },
        ))
    }

    async fn send(
        &self,
        url: &Url,
        method: &Method,
        request: &DavRequest,
        body: Option<&str>,
    ) -> Result<reqwest::Response, TransportError> {
        let mut builder = self.client.request(method.clone(), url.clone());
        if let Some(body) = body {
            builder = builder
                .header(CONTENT_TYPE, "text/xml;charset=UTF-8")
                .body(body.to_owned());
        }
        if let Some(depth) = request.depth {
            builder = builder.header("Depth", depth);
        }
        if let Some(authorization) = self.authorization(url, method) {
            let mut value = HeaderValue::from_bytes(authorization.as_bytes())
                .map_err(|_| TransportError::BadHeader)?;
            value.set_sensitive(true);
            builder = builder.header(AUTHORIZATION, value);
        }
        builder
            .send()
            .await
            .map_err(|error| TransportError::Network(error.without_url()))
    }

    /// A 401 with a fresh Digest challenge (first contact, or a stale nonce) earns one retry.
    async fn send_with_auth(
        &self,
        url: &Url,
        method: &Method,
        request: &DavRequest,
        body: Option<&str>,
    ) -> Result<reqwest::Response, TransportError> {
        let response = self.send(url, method, request, body).await?;
        if response.status() != StatusCode::UNAUTHORIZED || !self.scope.allows(url) {
            return Ok(response);
        }
        let offered = response
            .headers()
            .get_all(WWW_AUTHENTICATE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect::<Vec<_>>()
            .join(", ");
        let Some(challenge) = caldav_digest::parse_challenge(&offered) else {
            return Ok(response);
        };
        {
            let mut digest = self.digest.lock().unwrap_or_else(|e| e.into_inner());
            if digest
                .as_ref()
                .is_some_and(|(current, _)| current.nonce == challenge.nonce)
            {
                return Ok(response);
            }
            *digest = Some((challenge, 0));
        }
        drop(response);
        self.send(url, method, request, body).await
    }

    async fn hop(
        &self,
        url: &Url,
        method: &Method,
        request: &DavRequest,
        body: Option<&str>,
        last: bool,
    ) -> Result<Hop, TransportError> {
        let response = self.send_with_auth(url, method, request, body).await?;
        let status = response.status().as_u16();
        {
            let mut failure = self.last_failure.lock().unwrap_or_else(|e| e.into_inner());
            if status >= 400 && status != 404 {
                *failure = Some(Failure {
                    status,
                    retry_after: header(&response, RETRY_AFTER),
                });
            } else if response.status().is_success() {
                *failure = None;
            }
        }
        let location = header(&response, LOCATION).filter(|l| !l.is_empty());
        if is_redirect(status)
            && request.follow
            && !last
            && let Some(location) = &location
        {
            let mut next = url
                .join(location)
                .map_err(|_| TransportError::BadRedirect)?;
            if !matches!(next.scheme(), "http" | "https") {
                return Err(TransportError::BadRedirect);
            }
            // reqwest would send a target's userinfo as its own Basic header.
            let _ = next.set_username("");
            let _ = next.set_password(None);
            return Ok(Hop::Redirect(next, status));
        }
        let content_type = header(&response, CONTENT_TYPE);
        let body = read_capped(response, MAX_BODY)
            .await
            .map_err(|error| match error {
                ReadError::TooLarge { cap } => TransportError::TooLarge(cap),
                ReadError::Transport(error) => TransportError::Network(error.without_url()),
            })?;
        Ok(Hop::Done(Reply {
            status,
            url: url.clone(),
            location,
            content_type,
            body,
        }))
    }

    /// One request, following up to five redirects unless the caller asked for them; a 303
    /// turns into a `GET` without a body.
    pub async fn request(&self, request: DavRequest) -> Result<Reply, TransportError> {
        let mut url = request.url.clone();
        let mut method = request.method.clone();
        let mut body = request.body.clone();
        let mut hops = 0;
        loop {
            let step = self.hop(
                &url,
                &method,
                &request,
                body.as_deref(),
                hops >= MAX_REDIRECTS,
            );
            hops += 1;
            match tokio::time::timeout(self.timeout, step).await {
                Err(_) => return Err(TransportError::Timeout),
                Ok(Err(error)) => return Err(error),
                Ok(Ok(Hop::Done(reply))) => return Ok(reply),
                Ok(Ok(Hop::Redirect(next, status))) => {
                    url = next;
                    if status == 303 {
                        method = Method::GET;
                        body = None;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(server: &str) -> CredentialScope {
        CredentialScope::new(&Url::parse(server).unwrap())
    }

    fn allows(scope: &CredentialScope, target: &str) -> bool {
        scope.allows(&Url::parse(target).unwrap())
    }

    #[test]
    fn a_multi_host_provider_shares_credentials_inside_its_own_domain_only() {
        let icloud = scope("https://caldav.icloud.com/");
        assert!(allows(
            &icloud,
            "https://p67-caldav.icloud.com/123/calendars/"
        ));
        assert!(allows(&icloud, "https://CALDAV.icloud.com/x"));
        assert!(!allows(&icloud, "https://CALDAV.icloud.com:8443/x"));
        assert!(
            !allows(&icloud, "https://p67-caldav.icloud.com:8443/"),
            "a provider's other hosts on 443 only"
        );
        assert!(!allows(&icloud, "https://icloud.com.evil.example/"));
        assert!(!allows(&icloud, "https://evilicloud.com/"));
        assert!(
            !allows(&icloud, "http://p67-caldav.icloud.com/"),
            "never to http"
        );
    }

    #[test]
    fn a_shared_suffix_host_never_reaches_its_neighbours() {
        let nas = scope("https://myname.synology.me/dav/");
        assert!(allows(&nas, "https://myname.synology.me/other/"));
        assert!(!allows(&nas, "https://other.synology.me/"));
        assert!(!allows(&nas, "https://synology.me/"));
    }

    #[test]
    fn plain_http_gets_credentials_only_at_the_exact_origin_typed() {
        let lan = scope("http://192.168.1.5:5232/");
        assert!(allows(&lan, "http://192.168.1.5:5232/user/"));
        assert!(!allows(&lan, "http://192.168.1.5:5233/"));
        assert!(!allows(&lan, "http://192.168.1.6:5232/"));
        assert!(
            !allows(&lan, "https://192.168.1.5/"),
            "another scheme is another origin"
        );
        let tls = scope("https://dav.example.com/");
        assert!(!allows(&tls, "http://dav.example.com/"));
        assert!(!allows(&tls, "ftp://dav.example.com/"));
    }

    #[test]
    fn another_port_on_the_same_host_gets_no_credentials() {
        let tls = scope("https://dav.example.com/");
        assert!(allows(&tls, "https://dav.example.com:443/a/"));
        assert!(!allows(&tls, "https://dav.example.com:8443/"));
        let custom = scope("https://dav.example.com:8443/dav/");
        assert!(allows(&custom, "https://dav.example.com:8443/other/"));
        assert!(!allows(&custom, "https://dav.example.com/"));
    }

    #[test]
    fn an_ip_address_has_no_provider_domain() {
        let ip = scope("https://17.0.0.1/");
        assert!(!allows(&ip, "https://p1.icloud.com/"));
    }
}
