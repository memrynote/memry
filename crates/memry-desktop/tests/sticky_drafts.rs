//! The sticky's drafts (`stickies/drafts.ts`) through the desktop owner over a vault the session
//! opened: a profile that has never written a synced record mints its device identity on the
//! first draft, as Electron's first sticky does, and the draft reads back.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use memry_core::seams::secure_store::SecureStoreKey;
use memry_desktop::sticky::drafts::{self, StickyKind};
use vault_env::env;

#[test]
fn a_profile_without_a_device_identity_saves_its_first_draft() {
    let mut e = env(|_| None);
    e.open();
    let open = e.session.current().expect("open");
    let identity = device_key::without_device_key();

    let store = drafts::open(&open, identity.clone()).expect("the drafts");
    assert!(
        identity
            .get(SecureStoreKey::DeviceSigningKey)
            .expect("read")
            .is_some(),
        "opening the drafts minted this device's identity"
    );
    let saved = store
        .save(None, "Call the dentist".into(), StickyKind::Task)
        .expect("save");
    assert_eq!(
        drafts::open(&open, identity)
            .expect("again")
            .list()
            .expect("list"),
        vec![saved]
    );
}
