//! The `memrynote-cli` sidecar: the command line with no app around it.

fn main() {
    let args = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    // A release build is what the installers ship; only a `dev` device profile tells them apart.
    let deps = memrynote_cli::CliDeps::from_env(
        &memry_desktop::launch_env::LaunchEnv::from_process(),
        !cfg!(debug_assertions),
    );
    std::process::exit(memrynote_cli::run_process(args, &deps));
}
