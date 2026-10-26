//! The profile directory is byte-identical (path, size, sha256) after every reader has run.

use super::*;
use crate::electron_import::secrets::{FixedKeySource, NoKeytar, read_all_secrets};
use crate::electron_import::{
    CustomDictionary, ElectronConfig, LocalStorageSnapshot, ProfileLock, YStoreReader,
};

#[test]
fn no_reader_changes_the_profile_tree() {
    for slug in ["new", "legacy"] {
        let f = macos_fixture(slug);
        let before = tree_snapshot(&f.profile.dir);
        ProfileLock::probe(&f.profile).unwrap();
        ElectronConfig::read(&f.profile).unwrap().unwrap();
        CustomDictionary::read(&f.profile).unwrap().unwrap();
        LocalStorageSnapshot::read(&f.profile, "file://", &f.scratch)
            .unwrap()
            .unwrap();
        YStoreReader::open(&f.profile, &f.expected.vault_uuid, None, &f.scratch)
            .unwrap()
            .unwrap();
        YStoreReader::open_legacy(&f.profile, &f.scratch)
            .unwrap()
            .unwrap();
        let mut keys = FixedKeySource::default();
        keys.passwords.insert(
            "memrynote".into(),
            f.expected.macos_password.clone().unwrap().into_bytes(),
        );
        read_all_secrets(&f.profile, &keys, &NoKeytar).unwrap();
        read_all_secrets(&f.profile, &FixedKeySource::default(), &NoKeytar).unwrap();
        assert_eq!(tree_snapshot(&f.profile.dir), before, "{slug}");
    }
}

#[test]
fn locating_a_profile_writes_nothing() {
    let f = macos_fixture("legacy");
    let before = tree_snapshot(f._dir.path());
    let env = ProfileEnv {
        app_data: f._dir.path().to_owned(),
        override_dir: None,
        host: HostOs::MacOs,
    };
    let _ = locate_profile(&env).unwrap();
    assert_eq!(tree_snapshot(f._dir.path()), before);
}
