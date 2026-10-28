//! Certificate pinning against a local rustls server with a test CA (`seams::tls`): the pin table
//! decides after the chain and the hostname were accepted, never instead of them.

mod support;

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::api::errors::TransportError;
use memry_core::seams::transport::{HttpRequest, Transport};
use memry_desktop::seams::transport::NativeTransport;
use rcgen::{
    BasicConstraints, CertificateParams, CertifiedIssuer, DnType, IsCa, KeyPair, KeyUsagePurpose,
};
use rustls::pki_types::CertificateDer;
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

/// A certificate that carries the pinned SPKI and names the leaf's issuer, but did not sign the
/// leaf (its key is the pinned one; nobody but the key's holder can sign with it). The peer
/// appends it as the leaf's parent; the pin must still refuse it, because the link is checked by
/// the signature, not by the names.
fn forged_parent(
    name: &str,
    pinned: &CertifiedIssuer<'static, KeyPair>,
) -> CertificateDer<'static> {
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.distinguished_name.push(DnType::CommonName, name);
    let forger = ca("Forger", None);
    params
        .signed_by(pinned.key(), &forger)
        .unwrap()
        .der()
        .clone()
}

#[tokio::test]
async fn a_forged_parent_carrying_the_pinned_spki_does_not_match() {
    let real = Chain::new("localhost");
    let rogue_root: CertifiedIssuer<'static, KeyPair> = ca("Rogue Root", None);
    let (rogue_leaf, rogue_key) = leaf("localhost", &rogue_root, false);
    let forged = forged_parent("Rogue Root", &real.intermediate);
    assert_eq!(pin_of(&forged), real.intermediate_pin());
    let server = serve(vec![rogue_leaf, forged], rogue_key, |mut tls| async move {
        let _ = support::read_head(&mut tls).await;
    })
    .await;
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

/// M1 of the #3690 review. An attacker holds a root the OS trusts, with key K and the subject
/// `attacker.test`, and gets an end-entity certificate for `attacker.test` over K from the pinned
/// intermediate. A leaf signed with K chains to the rogue root, so the platform accepts it; the
/// end-entity certificate names the leaf's issuer and its key verifies the leaf, but it is not a
/// CA, so the pinned intermediate above it is not on any valid path.
#[tokio::test]
async fn an_end_entity_certificate_is_never_an_issuer_on_the_pinned_path() {
    let real = Chain::new("localhost");
    let mut root_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    root_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    root_params.key_usages = vec![KeyUsagePurpose::KeyCertSign];
    root_params
        .distinguished_name
        .push(DnType::CommonName, "attacker.test");
    let rogue_root =
        CertifiedIssuer::self_signed(root_params, KeyPair::generate().unwrap()).unwrap();
    let mut dv = CertificateParams::new(vec!["attacker.test".to_owned()]).unwrap();
    dv.distinguished_name
        .push(DnType::CommonName, "attacker.test");
    let dv = dv.signed_by(rogue_root.key(), &real.intermediate).unwrap();
    let (rogue_leaf, rogue_key) = leaf("localhost", &rogue_root, false);
    let presented = vec![
        rogue_leaf,
        dv.der().clone(),
        real.intermediate.der().clone(),
    ];
    let server = serve(presented, rogue_key, |mut tls| async move {
        let _ = support::read_head(&mut tls).await;
    })
    .await;
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

/// S2 of the #3690 review: a pin on the root matches when the server does not send the root,
/// because the trust anchor ends the verified path.
#[tokio::test]
async fn a_pin_on_the_trust_anchor_matches_a_chain_that_does_not_carry_it() {
    let chain = Chain::new("localhost");
    let server = ok_server(&chain).await;
    let (transport, sink) = transport(&[chain.root.der()], &[pin_of(chain.root.der())], true);
    let response = transport.send(get(&server)).await.unwrap();
    assert_eq!(response.status, 200);
    assert!(sink.failures().is_empty());
}

mod chain_guards {
    use memry_desktop::seams::tls::spki::{ChainError, MAX_CHAIN, MAX_DER, verified_path_pins};
    use proptest::prelude::*;
    use rcgen::{BasicConstraints, CertificateParams, CertifiedIssuer, DnType, IsCa, KeyPair};
    use rustls::RootCertStore;
    use rustls::pki_types::{CertificateDer, UnixTime};

    use super::{Chain, ca, leaf, pin_of};

    fn verify(
        roots: &[&CertificateDer<'static>],
        presented: &[CertificateDer<'_>],
        accept: &dyn Fn(&[String]) -> bool,
    ) -> Result<Vec<String>, ChainError> {
        let mut store = RootCertStore::empty();
        for root in roots {
            store.add((*root).clone()).unwrap();
        }
        verified_path_pins(
            &store.roots,
            &presented[0],
            &presented[1..],
            UnixTime::now(),
            accept,
        )
    }

    fn every(_: &[String]) -> bool {
        true
    }

    #[test]
    fn the_path_is_the_leaf_its_intermediates_and_the_anchor() {
        let chain = Chain::new("localhost");
        let expected = [
            chain.leaf_pin(),
            chain.intermediate_pin(),
            pin_of(chain.root.der()),
        ];
        let sent = chain.presented();
        let with_root = vec![
            chain.leaf.clone(),
            chain.root.der().clone(),
            chain.intermediate.der().clone(),
        ];
        for presented in [sent, with_root] {
            assert_eq!(
                verify(&[chain.root.der()], &presented, &every).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn a_sent_certificate_that_did_not_issue_the_one_below_is_not_on_the_path() {
        let chain = Chain::new("localhost");
        let stranger = ca("Stranger", None);
        let presented = vec![
            chain.leaf.clone(),
            stranger.der().clone(),
            chain.intermediate.der().clone(),
        ];
        let path = verify(&[chain.root.der()], &presented, &every).unwrap();
        assert!(!path.contains(&pin_of(stranger.der())));
    }

    /// An intermediate cross-signed by two roots gives two valid paths; when the first one
    /// tried is not accepted, the other is.
    #[test]
    fn every_valid_path_is_tried_before_the_answer_is_no() {
        let root_a = ca("Root A", None);
        let root_b = ca("Root B", None);
        let key = KeyPair::generate().unwrap();
        let params = || {
            let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
            params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
            params.distinguished_name.push(DnType::CommonName, "Cross");
            params
        };
        let via_a = params().signed_by(&key, &root_a).unwrap();
        let via_b = CertifiedIssuer::signed_by(params(), key, &root_b).unwrap();
        let (leaf, _) = leaf("localhost", &via_b, false);
        let presented = vec![leaf, via_a.der().clone(), via_b.der().clone()];
        let roots = [root_a.der(), root_b.der()];
        for wanted in [pin_of(root_a.der()), pin_of(root_b.der())] {
            let path = verify(&roots, &presented, &|path| path.contains(&wanted)).unwrap();
            assert_eq!(path.last(), Some(&wanted));
        }
        assert_eq!(
            verify(&roots, &presented, &|_| false),
            Err(ChainError::NotAccepted)
        );
    }

    #[test]
    fn a_chain_to_no_trusted_root_is_unverified() {
        let chain = Chain::new("localhost");
        let other = ca("Other Root", None);
        assert!(matches!(
            verify(&[other.der()], &chain.presented(), &every),
            Err(ChainError::Unverified(_))
        ));
    }

    #[test]
    fn more_certificates_than_a_chain_can_hold_are_refused_unread() {
        let chain = Chain::new("localhost");
        let many: Vec<CertificateDer<'_>> = (0..=MAX_CHAIN).map(|_| chain.leaf.clone()).collect();
        assert_eq!(
            verify(&[chain.root.der()], &many, &every),
            Err(ChainError::TooLong)
        );
    }

    #[test]
    fn an_oversized_certificate_is_refused_unread() {
        let chain = Chain::new("localhost");
        let huge = CertificateDer::from(vec![0x30_u8; MAX_DER + 1]);
        assert_eq!(
            verify(&[chain.root.der()], &[chain.leaf.clone(), huge], &every),
            Err(ChainError::TooLarge)
        );
    }

    #[test]
    fn garbage_is_malformed() {
        let chain = Chain::new("localhost");
        assert_eq!(
            verify(
                &[chain.root.der()],
                &[CertificateDer::from(vec![1, 2, 3])],
                &every
            ),
            Err(ChainError::Malformed)
        );
    }

    /// The path search runs on the 2 MiB stack a webview app's main thread may be left with.
    #[test]
    fn the_search_runs_on_a_two_mib_stack() {
        let chain = Chain::new("localhost");
        let (root, presented) = (chain.root.der().clone(), chain.presented());
        let path = std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || verify(&[&root], &presented, &every).unwrap())
            .unwrap()
            .join()
            .expect("the path search overflowed a 2 MiB stack or panicked");
        assert_eq!(path.len(), 3);
    }

    proptest! {
        /// Random bytes, and a real certificate with bytes flipped, never panic: the answer is a
        /// path or an error (CI fixes the seed with `PROPTEST_RNG_SEED`).
        #[test]
        fn arbitrary_bytes_never_panic(blobs in proptest::collection::vec(proptest::collection::vec(any::<u8>(), 0..200), 1..12)) {
            let chain = Chain::new("localhost");
            let presented: Vec<CertificateDer<'_>> = blobs.into_iter().map(CertificateDer::from).collect();
            let _ = verify(&[chain.root.der()], &presented, &every);
        }

        #[test]
        fn a_mutated_certificate_never_panics(flips in proptest::collection::vec((0_usize..400, any::<u8>()), 1..8)) {
            let chain = Chain::new("localhost");
            let mut der = chain.intermediate.der().to_vec();
            for (at, byte) in flips {
                let at = at % der.len();
                der[at] = byte;
            }
            let _ = verify(&[chain.root.der()], &[chain.leaf.clone(), CertificateDer::from(der)], &every);
        }
    }
}
