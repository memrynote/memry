//! The compiled-in configuration rules of `build_env.rs`: where values come from, which
//! environment a build is for, and the production release gate that names a missing variable.

#[path = "../build_env.rs"]
mod build_env;

use build_env::{Inputs, environment, parse_env_file, resolve};

fn run(
    profile: &str,
    e2e: bool,
    process: &[(&str, &str)],
    file: Option<&str>,
) -> Result<Vec<(String, String)>, String> {
    let process_env = |name: &str| {
        process
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| (*v).to_owned())
    };
    let env_file = |_: &str| file.map(str::to_owned);
    resolve(&Inputs {
        profile,
        e2e,
        process_env: &process_env,
        env_file: &env_file,
    })
}

#[test]
fn a_production_release_build_without_the_sync_url_fails_and_names_it() {
    let error = run(
        "release",
        false,
        &[
            ("GOOGLE_CALENDAR_CLIENT_ID", "a"),
            ("GOOGLE_CALENDAR_CLIENT_SECRET", "b"),
        ],
        None,
    )
    .expect_err("must fail");
    assert!(error.contains("SYNC_SERVER_URL"), "{error}");
    assert!(!error.contains("https"), "never a value");
}

#[test]
fn the_process_environment_wins_over_the_env_file_and_all_three_pass_the_gate() {
    let pairs = run(
        "release",
        false,
        &[("SYNC_SERVER_URL", "https://from-env"), ("GOOGLE_CALENDAR_CLIENT_ID", "id")],
        Some("# comment\nexport SYNC_SERVER_URL=\"https://from-file\"\nGOOGLE_CALENDAR_CLIENT_SECRET='secret'\nUNSPLASH_ACCESS_KEY=key\n"),
    )
    .expect("complete");
    let get = |name: &str| {
        pairs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(get("MEMRY_BUILD_ENV"), Some("production"));
    assert_eq!(get("MEMRY_BUILD_SYNC_SERVER_URL"), Some("https://from-env"));
    assert_eq!(
        get("MEMRY_BUILD_GOOGLE_CALENDAR_CLIENT_SECRET"),
        Some("secret")
    );
    assert_eq!(get("MEMRY_BUILD_UNSPLASH_ACCESS_KEY"), Some("key"));
    assert_eq!(get("MEMRY_BUILD_ONENOTE_CLIENT_ID"), None);
}

#[test]
fn debug_and_e2e_builds_are_development_and_never_gated() {
    assert_eq!(
        environment(&Inputs {
            profile: "debug",
            e2e: false,
            process_env: &|_| None,
            env_file: &|_| None
        }),
        "development"
    );
    assert_eq!(
        environment(&Inputs {
            profile: "release",
            e2e: true,
            process_env: &|_| None,
            env_file: &|_| None
        }),
        "development"
    );
    assert!(run("debug", false, &[], None).is_ok());
    assert!(run("release", true, &[], None).is_ok());
    // An explicit staging release is not gated either.
    assert!(run("release", false, &[("MEMRY_ENV", "staging")], None).is_ok());
}

#[test]
fn env_files_parse_comments_quotes_and_blank_values() {
    let map = parse_env_file("A=1\n# B=2\n\nC = \"x y\"\nD=\n");
    assert_eq!(
        (
            map.get("A").map(String::as_str),
            map.get("B"),
            map.get("C").map(String::as_str),
            map.get("D").map(String::as_str)
        ),
        (Some("1"), None, Some("x y"), Some(""))
    );
}
