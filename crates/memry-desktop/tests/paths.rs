use std::path::PathBuf;

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::{AppPaths, profile_identifier};

const BASE: &str = "com.memrynote.memry";

fn env(pairs: &[(&str, &str)]) -> LaunchEnv {
    let mut env = LaunchEnv::default();
    for (key, value) in pairs {
        env.set(key, value);
    }
    env
}

#[test]
fn launch_env_reads_and_overlays() {
    let mut env = env(&[("MEMRY_DEVICE", "A")]);
    assert_eq!(env.get("MEMRY_DEVICE"), Some("A"));
    env.set("MEMRY_DEVICE", "B");
    assert_eq!(env.get("MEMRY_DEVICE"), Some("B"));
    assert_eq!(env.get("MEMRY_MISSING"), None);
}

#[test]
fn identifier_without_device_is_the_base() {
    assert_eq!(profile_identifier(BASE, &env(&[]), true, "/x"), BASE);
    assert_eq!(
        profile_identifier(BASE, &env(&[("MEMRY_DEVICE", "")]), false, "/x"),
        BASE
    );
}

#[test]
fn identifier_with_device_appends_it() {
    let env = env(&[("MEMRY_DEVICE", "A")]);
    assert_eq!(
        profile_identifier(BASE, &env, false, "/x"),
        "com.memrynote.memry.A"
    );
    assert_eq!(
        profile_identifier(BASE, &env, true, "/x"),
        "com.memrynote.memry.A"
    );
}

// Golden values come from `sha256(path.normalize(dir)).slice(0, 8)`, the rule of
// `resolveDeviceId` in apps/desktop/src/main/index.ts.
#[test]
fn unpackaged_dev_device_hashes_the_checkout() {
    let env = env(&[("MEMRY_DEVICE", "dev")]);
    let a = profile_identifier(BASE, &env, false, "/Users/dev/checkout-a/apps/desktop");
    let b = profile_identifier(BASE, &env, false, "/Users/dev/checkout-b/apps/desktop");
    assert_eq!(a, "com.memrynote.memry.dev-d460368c");
    assert_eq!(b, "com.memrynote.memry.dev-6247bf17");
    assert_ne!(a, b);
}

#[test]
fn packaged_dev_device_is_plain() {
    let env = env(&[("MEMRY_DEVICE", "dev")]);
    assert_eq!(
        profile_identifier(BASE, &env, true, "/Users/dev/checkout-a/apps/desktop"),
        "com.memrynote.memry.dev"
    );
}

#[test]
fn two_identifiers_give_two_dirs_and_overrides_win() {
    let tmp = tempfile::tempdir().expect("temp dir");
    let defaults_for = |id: &str| {
        (
            tmp.path().join("data").join(id),
            tmp.path().join("logs").join(id),
        )
    };

    let (data_a, log_a) = defaults_for(&profile_identifier(
        BASE,
        &env(&[("MEMRY_DEVICE", "A")]),
        true,
        "/x",
    ));
    let (data_b, log_b) = defaults_for(&profile_identifier(
        BASE,
        &env(&[("MEMRY_DEVICE", "B")]),
        true,
        "/x",
    ));
    let plain_a = AppPaths::resolve(&env(&[]), data_a.clone(), log_a.clone());
    let plain_b = AppPaths::resolve(&env(&[]), data_b, log_b);
    assert_ne!(plain_a.data_dir, plain_b.data_dir);
    assert_ne!(plain_a.log_dir, plain_b.log_dir);

    let overridden = AppPaths::resolve(
        &env(&[
            ("MEMRY_DEVICE", "A"),
            ("MEMRY_APP_DATA_DIR", "/override/data"),
            ("MEMRY_TEST_LOG_DIR", "/override/logs"),
        ]),
        data_a,
        log_a,
    );
    assert_eq!(overridden.data_dir, PathBuf::from("/override/data"));
    assert_eq!(overridden.log_dir, PathBuf::from("/override/logs"));
}

#[test]
fn empty_override_falls_back_to_the_default() {
    let paths = AppPaths::resolve(
        &env(&[("MEMRY_APP_DATA_DIR", "")]),
        PathBuf::from("/default/data"),
        PathBuf::from("/default/log"),
    );
    assert_eq!(paths.data_dir, PathBuf::from("/default/data"));
}
