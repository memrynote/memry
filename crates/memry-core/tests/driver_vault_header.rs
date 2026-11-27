//! The desktop driver's requests carry the bound server vault (chapter 05
//! §5.2), its policy poll included. A `GET /sync/status` with no vault, on an
//! account that has no vault yet, makes the server create a `default` vault
//! next to the one the device binds.

use crate::driver_fakes::Desktop;

#[tokio::test]
async fn every_sync_request_of_a_pass_carries_the_bound_vault() {
    let desktop = Desktop::open(&["task"], |_| Ok(())).await;
    desktop.pass().await;

    let sync: Vec<_> = desktop
        .server
        .vault_headers()
        .into_iter()
        .filter(|(route, _)| route.starts_with("/sync/"))
        .collect();
    assert!(
        sync.iter().any(|(route, _)| route == "/sync/status"),
        "the pass polled the policy: {sync:?}"
    );
    for (route, vault) in &sync {
        assert_eq!(vault.as_deref(), Some("vault-1"), "{route}");
    }
}
