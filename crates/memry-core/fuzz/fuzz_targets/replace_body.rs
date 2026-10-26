//! Replace a seeded body with arbitrary markdown. The input is split at its
//! first NUL byte into the body already in the document and the body that
//! replaces it. Asserts the atomicity promise of #3522: whatever the outcome,
//! a call that does not answer `Replaced` leaves the document's state vector
//! exactly as it was, and nothing panics.

#![no_main]

use std::sync::Arc;

use libfuzzer_sys::fuzz_target;
use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::registry::UpdateSink;
use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::api::{Converter, ReplaceOptions};
use memry_core::markdown::convert::apply::ReplaceOutcome;
use memry_core::markdown::schema::callout_types::CalloutTypes;

fuzz_target!(|input: &str| {
    if input.len() > 64 * 1024 {
        return;
    }
    let (base, replacement) = input.split_once('\0').unwrap_or(("", input));
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-fuzz", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    let converter = Converter::new(CalloutTypes::new(Vec::new()));
    if !converter.seed_body(&document, base, None, None, &NoEmbeds) {
        return;
    }
    let before = (document.encode_state().expect("state"), document.state_vector().expect("sv"));
    let outcome = converter.replace_body(
        &document,
        replacement,
ReplaceOptions::default(),
    );
    if outcome != ReplaceOutcome::Replaced {
        let after = (document.encode_state().expect("state"), document.state_vector().expect("sv"));
        assert_eq!(
            after,
            before,
            "a {outcome:?} replace changed the document"
        );
    }
});
