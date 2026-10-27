//! logind on the system bus: `PrepareForSleep(start)` and `PrepareForShutdown(start)`. A machine
//! with no system bus (a container) logs once and goes without power events.
//!
//! A shutdown gives the app no signal it can finish work in: logind announces it and, unless a
//! client holds a delay inhibitor, goes on at once. The shutdown listener therefore takes one
//! (`Inhibit(shutdown, delay)`), and on `PrepareForShutdown(true)` runs the quit sequence. The
//! lock is the file descriptor logind returns; it lives as long as the listener, so the process
//! exit that ends the sequence is what lets the machine go on, bounded by logind's
//! `InhibitDelayMaxSec` (5 s by default).

use memry_desktop::shell::power::{PowerEvent, from_prepare_for_shutdown, from_prepare_for_sleep};
use tauri::{AppHandle, Wry};
use tokio::sync::broadcast::Sender;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::OwnedFd;

const SERVICE: &str = "org.freedesktop.login1";
const PATH: &str = "/org/freedesktop/login1";
const INTERFACE: &str = "org.freedesktop.login1.Manager";

pub fn start(app: &AppHandle<Wry>, sender: &Sender<PowerEvent>) {
    let sleep_sender = sender.clone();
    spawn("PrepareForSleep", move || {
        listen("PrepareForSleep", |start| {
            super::publish(&sleep_sender, from_prepare_for_sleep(start));
        })
    });
    let (app, sender) = (app.clone(), sender.clone());
    spawn("PrepareForShutdown", move || {
        listen("PrepareForShutdown", |start| {
            if let Some(event) = from_prepare_for_shutdown(start) {
                super::publish(&sender, event);
                crate::shutdown::begin_session_end(&app);
            }
        })
    });
}

fn spawn(name: &'static str, run: impl FnOnce() -> zbus::Result<()> + Send + 'static) {
    let spawned = std::thread::Builder::new()
        .name(format!("logind-{name}"))
        .spawn(move || {
            if let Err(error) = run() {
                tracing::warn!(scope = "Power", "no {name} events: {error}");
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(
            scope = "Power",
            "could not start the {name} listener: {error}"
        );
    }
}

/// Calls `on_signal` with the boolean of each `signal`. The shutdown listener holds a delay
/// inhibitor for as long as it runs.
fn listen(signal: &str, on_signal: impl Fn(bool)) -> zbus::Result<()> {
    let connection = Connection::system()?;
    let proxy = Proxy::new(&connection, SERVICE, PATH, INTERFACE)?;
    let _inhibitor = (signal == "PrepareForShutdown").then(|| inhibit_shutdown(&proxy));
    for message in proxy.receive_signal(signal)? {
        on_signal(message.body().deserialize()?);
    }
    Ok(())
}

/// Without the lock the sequence still starts, but logind does not wait for it.
fn inhibit_shutdown(proxy: &Proxy<'_>) -> Option<OwnedFd> {
    let lock = proxy.call::<_, _, OwnedFd>(
        "Inhibit",
        &("shutdown", "MemryNote", "Saving your notes", "delay"),
    );
    match lock {
        Ok(lock) => Some(lock),
        Err(error) => {
            tracing::warn!(
                scope = "Power",
                "no shutdown delay inhibitor, the machine will not wait for a save: {error}"
            );
            None
        }
    }
}
