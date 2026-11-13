//! The provider proxy's refusals around `open` (#3539, carry items of VERIFY-4449): a cancel
//! remembered for a request that never opens is let go, a page that went while its request
//! read the settings refuses that request, and a vault that closes before the head, or before
//! the request opens, answers `VaultClosed`, not a user's cancel.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use memry_desktop::ai::provider::AiProvider;
use memry_desktop::ai::proxy::{AiProviderRequest, AiProxy, HttpMethod, Owner, ProxyError, Sink};
use memry_desktop::ai::settings::InlineAiSettings;

use crate::ai_fake::{KEY, Reply, WAIT, fake, proxy, settings};

fn request(id: &str) -> AiProviderRequest {
    AiProviderRequest {
        request_id: id.to_owned(),
        provider: AiProvider::Custom,
        method: HttpMethod::Post,
        path: "/chat/completions".to_owned(),
        headers: Vec::new(),
        body: Some("{}".to_owned()),
    }
}

fn sink() -> Sink {
    let alive = Arc::new(AtomicBool::new(true));
    Box::new(move |_| alive.load(Ordering::SeqCst))
}

async fn open(
    proxy: &Arc<AiProxy>,
    settings: &InlineAiSettings,
    id: &str,
    owner: &Owner,
) -> Result<u16, ProxyError> {
    proxy
        .open(settings, request(id), owner, sink())
        .await
        .map(|(head, _body)| head.status)
}

#[tokio::test]
async fn a_cancel_of_a_request_refused_before_open_is_let_go() {
    let fake = fake(vec![Reply::chat("{}")]).await;
    let proxy = proxy();
    let main = proxy.owner("main");
    let good = settings(AiProvider::Custom, &fake.base, KEY);

    // The renderer aborted while Rust read the settings, and `prepare` then refused the
    // request: no open will ever take the id, so the proxy must not keep it.
    proxy.cancel("refused");
    let mut off = good.clone();
    off.enabled = false;
    assert_eq!(
        open(&proxy, &off, "refused", &main).await,
        Err(ProxyError::Disabled)
    );
    assert_eq!(open(&proxy, &good, "refused", &main).await, Ok(200));

    // The command's settings read failed before `open`: it lets the id go itself.
    proxy.cancel("unread");
    proxy.forget_cancel("unread");
    assert_eq!(open(&proxy, &good, "unread", &main).await, Ok(200));
    assert_eq!(fake.seen().len(), 2);
}

#[tokio::test]
async fn a_page_that_went_while_its_settings_were_read_refuses_the_request() {
    let fake = fake(vec![Reply::chat("{}")]).await;
    let proxy = proxy();
    let good = settings(AiProvider::Custom, &fake.base, KEY);

    // Taken when the command began, before the settings read.
    let main = proxy.owner("main");
    let note = proxy.owner("note-1");
    proxy.cancel_owner("main");
    assert_eq!(
        open(&proxy, &good, "stale", &main).await,
        Err(ProxyError::Cancelled)
    );
    assert!(fake.seen().is_empty());

    // Another page and the reloaded page itself are untouched.
    assert_eq!(open(&proxy, &good, "other", &note).await, Ok(200));
    let fresh = proxy.owner("main");
    assert_eq!(open(&proxy, &good, "fresh", &fresh).await, Ok(200));
    assert_eq!(fake.seen().len(), 2);
}

#[tokio::test]
async fn a_vault_close_before_the_head_is_vault_closed() {
    let fake = fake(vec![Reply::NoHead]).await;
    let proxy = proxy();
    let good = settings(AiProvider::Custom, &fake.base, KEY);

    let opening = {
        let (proxy, good) = (proxy.clone(), good.clone());
        tokio::spawn(async move { open(&proxy, &good, "open", &proxy.owner("main")).await })
    };
    let calling = {
        let (proxy, good) = (proxy.clone(), good.clone());
        tokio::spawn(async move {
            proxy
                .call(&good, request("call"), &proxy.owner("main"), 1024)
                .await
                .map(|answer| answer.status)
        })
    };
    fake.wait_for(2).await;
    proxy.cancel_all();
    for task in [opening, calling] {
        let outcome = tokio::time::timeout(WAIT, task)
            .await
            .expect("ended")
            .unwrap();
        assert_eq!(outcome, Err(ProxyError::VaultClosed));
    }
    assert_eq!(proxy.in_flight(), 0);
}

#[tokio::test]
async fn a_request_taken_before_the_vault_closed_never_opens() {
    let fake = fake(vec![Reply::chat("{}")]).await;
    let proxy = proxy();
    let good = settings(AiProvider::Custom, &fake.base, KEY);

    // Taken when the command began; the vault closed while it waited (a retry's backoff).
    let before = proxy.owner("main");
    proxy.cancel_all();
    assert_eq!(
        open(&proxy, &good, "stale", &before).await,
        Err(ProxyError::VaultClosed)
    );
    assert!(fake.seen().is_empty());

    // The next vault's requests go.
    let after = proxy.owner("main");
    assert_eq!(open(&proxy, &good, "fresh", &after).await, Ok(200));
    assert_eq!(fake.seen().len(), 1);
}
