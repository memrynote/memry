// Hide the console window of release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::profile_identifier;

fn main() {
    // Must stay the first statement: on a Velopack install/update/uninstall hook it handles the
    // hook argument and exits; outside a Velopack install it logs and returns.
    velopack::VelopackApp::build().run();

    // Step 35 (#3552): --cli dispatch
    // Step 11 (#3528): --crash-monitor

    memry_tauri::install_crypto_provider();

    let env = LaunchEnv::from_process();
    let mut context = tauri::generate_context!();
    let base = context.config().identifier.clone();
    context.config_mut().identifier =
        profile_identifier(&base, &env, !tauri::is_dev(), env!("MEMRY_CHECKOUT_DIR"));
    memry_tauri::run(env, context);
}
