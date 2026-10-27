// Hide the console window of release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::profile_identifier;

fn main() {
    // Must stay the first statement: on a Velopack install/update/uninstall hook it handles the
    // hook argument and exits; outside a Velopack install it logs and returns.
    velopack::VelopackApp::build().run();

    // Step 35 (#3552): --cli dispatch
    if let Some(code) = memry_tauri::guards::crash_dump::monitor_entry() {
        std::process::exit(code);
    }

    memry_tauri::install_crypto_provider();
    #[cfg(windows)]
    memry_tauri::set_app_user_model_id();

    let env = launch_env();
    let mut context = tauri::generate_context!();
    let base = context.config().identifier.clone();
    context.config_mut().identifier =
        profile_identifier(&base, &env, !tauri::is_dev(), env!("MEMRY_CHECKOUT_DIR"));
    memry_tauri::run(env, context);
}

/// The launch switches of this run. The e2e build overlays its control file before the profile
/// identifier, paths and logging read them.
fn launch_env() -> LaunchEnv {
    #[cfg(feature = "e2e")]
    {
        let mut env = LaunchEnv::from_process();
        if let Err(error) = memry_tauri::e2e::prepare_launch_env(&mut env) {
            eprintln!("ERROR e2e control file: {error}");
            std::process::exit(2);
        }
        env
    }
    #[cfg(not(feature = "e2e"))]
    LaunchEnv::from_process()
}
