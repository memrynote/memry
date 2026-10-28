//! Certificate pinning against a local rustls server with a test CA (`seams::tls`): the pin table
//! decides after the chain and the hostname were accepted, never instead of them.

mod support;

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::api::errors::TransportError;
use memry_core::seams::transport::{HttpRequest, Transport};
use memry_desktop::seams::transport::NativeTransport;
use rcgen::{CertifiedIssuer, KeyPair};
use support::{Chain, RecordingSink, Server, ca, leaf, pin_of, serve, setup};
use tokio::io::AsyncWriteExt;

async fn ok_server(chain: &Chain) -> Server {
    serve(
        chain.presented(),
        chain.leaf_key.clone_key(),
        |mut tls| async move {
            let _ = support::read_head(&mut tls).await;
            let _ = tls
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                .await;
            let _ = tls.shutdown().await;
        },
    )
    .await
}

fn get(server: &Server) -> HttpRequest {
    HttpRequest {
        method: "GET".into(),
        url: format!("https://localhost:{}/", server.port),
        headers: HashMap::new(),
        body: None,
        timeout_ms: 5_000,
    }
}

fn transport(
    roots: &[&rustls::pki_types::CertificateDer<'static>],
    pins: &[String],
    active: bool,
) -> (NativeTransport, Arc<RecordingSink>) {
    let sink = Arc::new(RecordingSink::default());
    let transport = NativeTransport::with_setup(
        setup(roots, "localhost", pins, active),
        sink.clone(),
        &["localhost"],
    )
    .unwrap();
    (transport, sink)
}

#[tokio::test]
async fn a_leaf_pin_connects() {
    let chain = Chain::new("localhost");
    let server = ok_server(&chain).await;
    let (transport, sink) = transport(&[chain.root.der()], &[chain.leaf_pin()], true);
    let response = transport.send(get(&server)).await.unwrap();
    assert_eq!((response.status, response.body), (200, b"ok".to_vec()));
    assert!(sink.failures().is_empty());
}

#[tokio::test]
async fn a_valid_certificate_with_another_pin_fails_as_tls_and_tells_the_sink_once() {
    let chain = Chain::new("localhost");
    let other = Chain::new("localhost");
    let server = ok_server(&chain).await;
    let pins = [other.leaf_pin(), other.intermediate_pin()];
    let (transport, sink) = transport(&[chain.root.der()], &pins, true);
    let error = transport.send(get(&server)).await.unwrap_err();
    assert!(
        matches!(&error, TransportError::Tls { what } if what.contains("pin mismatch")),
        "{error:?}"
    );
    let failures = sink.failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].hostname, "localhost");
    assert_eq!(failures[0].actual_hash, chain.leaf_pin());
    assert_eq!(failures[0].expected_hashes, pins);
}

#[tokio::test]
async fn an_intermediate_pin_connects() {
    let chain = Chain::new("localhost");
    let server = ok_server(&chain).await;
    let (transport, sink) = transport(&[chain.root.der()], &[chain.intermediate_pin()], true);
    assert_eq!(transport.send(get(&server)).await.unwrap().status, 200);
    assert!(sink.failures().is_empty());
}

#[tokio::test]
async fn a_host_with_placeholder_pins_or_no_entry_connects_on_standard_tls() {
    let chain = Chain::new("localhost");
    let server = ok_server(&chain).await;
    let placeholder = ["sha256/PLACEHOLDER_PRIMARY_CERT_HASH_BASE64".to_owned()];
    let (transport, sink) = transport(&[chain.root.der()], &placeholder, true);
    assert_eq!(transport.send(get(&server)).await.unwrap().status, 200);
    let (unlisted, _) = transport_for_other_host(&chain);
    assert_eq!(unlisted.send(get(&server)).await.unwrap().status, 200);
    assert!(sink.failures().is_empty());
}

fn transport_for_other_host(chain: &Chain) -> (NativeTransport, Arc<RecordingSink>) {
    let sink = Arc::new(RecordingSink::default());
    let transport = NativeTransport::with_setup(
        setup(
            &[chain.root.der()],
            "other.example",
            &[chain.leaf_pin()],
            true,
        ),
        sink.clone(),
        &["localhost"],
    )
    .unwrap();
    (transport, sink)
}

#[tokio::test]
async fn pinning_is_off_when_inactive() {
    let chain = Chain::new("localhost");
    let other = Chain::new("localhost");
    let server = ok_server(&chain).await;
    let (transport, sink) = transport(&[chain.root.der()], &[other.leaf_pin()], false);
    assert_eq!(transport.send(get(&server)).await.unwrap().status, 200);
    assert!(sink.failures().is_empty());
}

#[tokio::test]
async fn an_expired_certificate_fails_before_the_pin_check() {
    let root = ca("Expiry Root", None);
    let (expired, key) = leaf("localhost", &root, true);
    let server = serve(vec![expired.clone()], key, |mut tls| async move {
        let _ = support::read_head(&mut tls).await;
    })
    .await;
    // The pin matches: only the chain check can refuse it.
    let (transport, sink) = transport(&[root.der()], &[pin_of(&expired)], true);
    let error = transport.send(get(&server)).await.unwrap_err();
    assert!(matches!(error, TransportError::Tls { .. }), "{error:?}");
    assert!(
        sink.failures().is_empty(),
        "the platform check failed first"
    );
}

#[tokio::test]
async fn a_wrong_hostname_fails_before_the_pin_check() {
    let chain = Chain::new("somewhere-else.test");
    let server = ok_server(&chain).await;
    let (transport, sink) = transport(&[chain.root.der()], &[chain.leaf_pin()], true);
    let error = transport.send(get(&server)).await.unwrap_err();
    assert!(matches!(error, TransportError::Tls { .. }), "{error:?}");
    assert!(sink.failures().is_empty());
}

/// The pinned intermediate of a host is public. A leaf misissued by another trusted CA, sent
/// with that intermediate appended, passes the chain check; the pin must still refuse it because
/// the intermediate is not on the leaf's issuance path.
#[tokio::test]
async fn a_pinned_intermediate_appended_to_a_foreign_chain_does_not_match() {
    let real = Chain::new("localhost");
    let rogue_root: CertifiedIssuer<'static, KeyPair> = ca("Rogue Root", None);
    let (rogue_leaf, rogue_key) = leaf("localhost", &rogue_root, false);
    let presented = vec![rogue_leaf, real.intermediate.der().clone()];
    let server = serve(presented, rogue_key, |mut tls| async move {
        let _ = support::read_head(&mut tls).await;
    })
    .await;
    // The client trusts both roots (the rogue one stands for any CA the OS trusts).
    let (transport, sink) = transport(
        &[real.root.der(), rogue_root.der()],
        &[real.intermediate_pin()],
        true,
    );
    let error = transport.send(get(&server)).await.unwrap_err();
    assert!(
        matches!(&error, TransportError::Tls { what } if what.contains("pin mismatch")),
        "{error:?}"
    );
    assert_eq!(sink.failures().len(), 1);
}

mod chain_guards {
    use memry_desktop::seams::tls::spki::{ChainError, MAX_CHAIN, MAX_DER, issuance_path_pins};
    use proptest::prelude::*;

    use super::{Chain, ca, leaf, pin_of};

    #[test]
    fn the_path_is_the_leaf_and_its_issuers_in_order() {
        let chain = Chain::new("localhost");
        let ders: Vec<&[u8]> = vec![
            chain.leaf.as_ref(),
            chain.intermediate.der().as_ref(),
            chain.root.der().as_ref(),
        ];
        // Presented in any order after the leaf.
        let shuffled = vec![ders[0], ders[2], ders[1]];
        for presented in [ders, shuffled] {
            assert_eq!(
                issuance_path_pins(&presented).unwrap(),
                [
                    chain.leaf_pin(),
                    chain.intermediate_pin(),
                    pin_of(chain.root.der())
                ]
            );
        }
    }

    #[test]
    fn a_certificate_that_did_not_issue_the_one_below_is_not_on_the_path() {
        let chain = Chain::new("localhost");
        let stranger = ca("Stranger", None);
        let path = issuance_path_pins(&[chain.leaf.as_ref(), stranger.der().as_ref()]).unwrap();
        assert_eq!(path, [chain.leaf_pin()]);
    }

    #[test]
    fn more_certificates_than_a_chain_can_hold_are_refused_unread() {
        let chain = Chain::new("localhost");
        let many: Vec<&[u8]> = (0..=MAX_CHAIN).map(|_| chain.leaf.as_ref()).collect();
        assert_eq!(issuance_path_pins(&many), Err(ChainError::TooLong));
        assert!(issuance_path_pins(&many[..MAX_CHAIN]).is_ok());
    }

    #[test]
    fn an_oversized_certificate_is_refused_unread() {
        let chain = Chain::new("localhost");
        let huge = vec![0x30_u8; MAX_DER + 1];
        assert_eq!(
            issuance_path_pins(&[chain.leaf.as_ref(), &huge]),
            Err(ChainError::TooLarge)
        );
    }

    #[test]
    fn trailing_bytes_and_garbage_are_malformed() {
        let chain = Chain::new("localhost");
        let mut padded = chain.leaf.to_vec();
        padded.push(0);
        assert_eq!(issuance_path_pins(&[&padded]), Err(ChainError::Malformed));
        assert_eq!(
            issuance_path_pins(&[&[1, 2, 3]]),
            Err(ChainError::Malformed)
        );
        assert_eq!(issuance_path_pins(&[]), Err(ChainError::Malformed));
    }

    /// Certificates that name each other as issuer cannot loop the walk.
    #[test]
    fn a_cycle_of_certificates_ends_the_walk() {
        let a = ca("Same Name", None);
        let (copy_one, _) = leaf("localhost", &a, false);
        let presented: Vec<&[u8]> = vec![
            copy_one.as_ref(),
            a.der().as_ref(),
            a.der().as_ref(),
            a.der().as_ref(),
        ];
        let path = issuance_path_pins(&presented).unwrap();
        assert!(path.len() <= presented.len());
    }

    /// The walk runs on the 2 MiB stack a webview app's main thread may be left with.
    #[test]
    fn the_walk_runs_on_a_two_mib_stack() {
        let chain = Chain::new("localhost");
        let (leaf, intermediate, root) = (
            chain.leaf.to_vec(),
            chain.intermediate.der().to_vec(),
            chain.root.der().to_vec(),
        );
        let path = std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || issuance_path_pins(&[&leaf, &intermediate, &root]).unwrap())
            .unwrap()
            .join()
            .expect("the chain walk overflowed a 2 MiB stack or panicked");
        assert_eq!(path.len(), 3);
    }

    proptest! {
        /// Random bytes, and a real certificate with bytes flipped, never panic: the answer is a
        /// path or an error (CI fixes the seed with `PROPTEST_RNG_SEED`).
        #[test]
        fn arbitrary_bytes_never_panic(blobs in proptest::collection::vec(proptest::collection::vec(any::<u8>(), 0..200), 0..12)) {
            let chain: Vec<&[u8]> = blobs.iter().map(Vec::as_slice).collect();
            let _ = issuance_path_pins(&chain);
        }

        #[test]
        fn a_mutated_certificate_never_panics(flips in proptest::collection::vec((0_usize..400, any::<u8>()), 1..8)) {
            let chain = Chain::new("localhost");
            let mut der = chain.leaf.to_vec();
            for (at, byte) in flips {
                let at = at % der.len();
                der[at] = byte;
            }
            let _ = issuance_path_pins(&[&der, chain.intermediate.der().as_ref()]);
        }
    }
}
