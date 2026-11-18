//! Remote images of an imported HTML page: `safeRemoteAssetUrl` and the `fetch` of
//! `apps/desktop/src/main/import/html/html-importer.ts`.
//!
//! The page is untrusted, so a URL in it must not reach the person's own network: only https,
//! and no host that is or resolves to a loopback, private, link-local or otherwise non-public
//! address. Electron compared the host name as text; here the literal address is classified,
//! every name resolves through [`PublicOnly`], and each redirect is checked again.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::redirect;
use url::{Host, Url};

use crate::http::{ReadError, read_capped};

/// Node's `fetch` follows at most 20 redirects.
const MAX_REDIRECTS: usize = 20;
/// Electron had no deadline: a stalled host held the import until the person cancelled it.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(120);

/// Why a remote image was not downloaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteError {
    /// Not an `ok` status: skipped as `HTTP <status>`.
    Status(u16),
    TooLarge,
    /// No response: skipped with this reason, as Node's `fetch failed`.
    Unreachable(String),
    /// The body broke off: the item fails, as Electron's `arrayBuffer()` throw did.
    Body(String),
}

/// Downloads a URL [`safe_remote_asset_url`] accepted. A trait so the importer tests run
/// without a network.
pub trait RemoteAssets: Send + Sync {
    fn fetch(&self, url: &Url, cap: usize) -> Result<Vec<u8>, RemoteError>;
}

/// `safeRemoteAssetUrl`: the parsed URL when it is https to a public host.
pub fn safe_remote_asset_url(reference: &str) -> Option<Url> {
    let url = Url::parse(reference).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    match url.host()? {
        Host::Domain(name) => {
            let name = name.to_ascii_lowercase();
            (name != "localhost" && !name.ends_with(".localhost")).then_some(url)
        }
        Host::Ipv4(ip) => is_public(IpAddr::V4(ip)).then_some(url),
        Host::Ipv6(ip) => is_public(IpAddr::V6(ip)).then_some(url),
    }
}

/// An address on the public internet: not loopback, private, link-local, shared (CGNAT),
/// benchmarking, multicast, unspecified, reserved, discard or documentation space, in either
/// family, nor a NAT64 or 6to4 address that reaches one.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public_v4(v4),
            None => is_public_v6(v6),
        },
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || a >= 240
        || (a == 100 && (64..128).contains(&b))
        || (a == 198 && b & 0xfe == 18)
        || (a == 192 && b == 0 && ip.octets()[2] == 0))
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let seg = ip.segments();
    let first = seg[0];
    // 6to4 (`2002::/16`) carries the IPv4 address it reaches in its next 32 bits.
    let six_to_four = Ipv4Addr::from((u32::from(seg[1]) << 16) | u32::from(seg[2]));
    !(ip.is_loopback()
        // NAT64: `64:ff9b::/96` and the local-use `64:ff9b:1::/48` reach any IPv4 address.
        || (first == 0x0064 && seg[1] == 0xff9b)
        || (first == 0x2002 && !is_public_v4(six_to_four))
        || (first == 0x0100 && seg[1..4] == [0, 0, 0])
        || ip.is_unspecified()
        || ip.is_multicast()
        || first & 0xfe00 == 0xfc00
        || first & 0xffc0 == 0xfe80
        || first & 0xffc0 == 0xfec0
        || (first == 0x2001 && ip.segments()[1] == 0x0db8)
        || ip.to_ipv4().is_some_and(|v4| !is_public_v4(v4)))
}

/// Name resolution that drops every non-public address, so a public name that points at the
/// person's network is refused at connect time.
struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let found = tokio::net::lookup_host((name.as_str(), 0)).await?;
            let public: Vec<SocketAddr> = found.filter(|addr| is_public(addr.ip())).collect();
            if public.is_empty() {
                return Err("the host has no public address".into());
            }
            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

/// The production [`RemoteAssets`]: the shared TLS stack with no system proxy (Node's `fetch`
/// used none), the resolver above and a re-check of every redirect.
#[derive(Default)]
pub struct HttpRemoteAssets {
    client: OnceLock<Result<reqwest::Client, String>>,
}

impl HttpRemoteAssets {
    /// The importer's policy over `base` instead of [`crate::http::builder`]: tests pass one
    /// that trusts a local TLS server.
    #[doc(hidden)]
    pub fn with_builder(base: reqwest::ClientBuilder) -> Self {
        Self {
            client: OnceLock::from(build(base)),
        }
    }

    fn client(&self) -> Result<&reqwest::Client, RemoteError> {
        self.client
            .get_or_init(|| build(crate::http::builder()))
            .as_ref()
            .map_err(|error| RemoteError::Unreachable(error.clone()))
    }
}

fn build(base: reqwest::ClientBuilder) -> Result<reqwest::Client, String> {
    base.no_proxy()
        .dns_resolver(Arc::new(PublicOnly))
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if safe_remote_asset_url(attempt.url().as_str()).is_some() {
                attempt.follow()
            } else {
                attempt.error("redirect to an unsafe URL")
            }
        }))
        .read_timeout(READ_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())
}

impl RemoteAssets for HttpRemoteAssets {
    /// Runs on the importer's blocking thread, inside the runner's runtime.
    fn fetch(&self, url: &Url, cap: usize) -> Result<Vec<u8>, RemoteError> {
        let client = self.client()?;
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| RemoteError::Unreachable("fetch failed".to_owned()))?;
        runtime.block_on(async {
            let response = client.get(url.clone()).send().await.map_err(|error| {
                tracing::warn!(
                    scope = "import",
                    "remote image fetch failed: {}",
                    error.without_url()
                );
                RemoteError::Unreachable("fetch failed".to_owned())
            })?;
            if !response.status().is_success() {
                return Err(RemoteError::Status(response.status().as_u16()));
            }
            read_capped(response, cap)
                .await
                .map_err(|error| match error {
                    ReadError::TooLarge { .. } => RemoteError::TooLarge,
                    ReadError::Transport(error) => {
                        RemoteError::Body(error.without_url().to_string())
                    }
                })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_resolver_refuses_a_name_with_only_private_addresses() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let name: Name = "localhost".parse().unwrap();
        let resolved = runtime.block_on(PublicOnly.resolve(name));
        assert!(resolved.is_err());
    }
}
