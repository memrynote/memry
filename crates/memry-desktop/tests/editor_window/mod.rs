//! A window's copy of a note's document, as the renderer's editor holds it: built from the state
//! `open` returns, it types text and returns the update the editor would send.

#![allow(dead_code, reason = "each test binary uses a part of it")]

use memry_core::crdt::BODY_FRAGMENT;
use yrs::updates::decoder::Decode as _;
use yrs::updates::encoder::Encode as _;
use yrs::{
    Doc, ReadTxn as _, Text as _, Transact as _, Update, XmlFragment as _, XmlOut, XmlTextRef,
};

pub struct Window(Doc);

impl Window {
    pub fn from_state(state: &[u8]) -> Self {
        let doc = Doc::new();
        doc.transact_mut()
            .apply_update(Update::decode_v1(state).unwrap())
            .unwrap();
        Self(doc)
    }

    /// Types `text` at the start of the first block's text and returns the update the editor
    /// sends.
    pub fn type_text(&self, text: &str) -> Vec<u8> {
        let fragment = self.0.get_or_insert_xml_fragment(BODY_FRAGMENT);
        let before = self.0.transact().state_vector();
        let mut txn = self.0.transact_mut();
        let first = (0..fragment.len(&txn))
            .find_map(|i| {
                fragment
                    .get(&txn, i)
                    .and_then(|node| first_text(&txn, node))
            })
            .expect("a block with text");
        first.insert(&mut txn, 0, text);
        drop(txn);
        self.0.transact().encode_diff_v1(&before)
    }

    pub fn state_vector(&self) -> Vec<u8> {
        self.0.transact().state_vector().encode_v1()
    }
}

/// The first text node under `node`, depth first: blocks nest (group, container, content).
fn first_text(txn: &impl yrs::ReadTxn, node: XmlOut) -> Option<XmlTextRef> {
    match node {
        XmlOut::Text(text) => Some(text),
        XmlOut::Element(element) => {
            (0..element.len(txn)).find_map(|i| element.get(txn, i).and_then(|n| first_text(txn, n)))
        }
        XmlOut::Fragment(_) => None,
    }
}
