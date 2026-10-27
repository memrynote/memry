//! logind on the system bus: `PrepareForSleep(start)` and `PrepareForShutdown(start)`. A machine
//! with no system bus (a container) logs once and goes without power events.

use memry_desktop::shell::power::{PowerEvent, from_prepare_for_sleep};
use tokio::sync::broadcast::Sender;
use zbus::blocking::{Connection, Proxy};

const SERVICE: &str = "org.freedesktop.login1";
const PATH: &str = "/org/freedesktop/login1";
const INTERFACE: &str = "org.freedesktop.login1.Manager";

pub fn start(sender: &Sender<PowerEvent>) {
    spawn("PrepareForSleep", sender, |start| {
        Some(from_prepare_for_sleep(start))
    });
    spawn("PrepareForShutdown", sender, |start| {
        start.then_some(PowerEvent::SessionEnding)
    });
}

fn spawn(signal: &'static str, sender: &Sender<PowerEvent>, map: fn(bool) -> Option<PowerEvent>) {
    let sender = sender.clone();
    let spawned = std::thread::Builder::new()
        .name(format!("logind-{signal}"))
        .spawn(move || {
            if let Err(error) = listen(signal, &sender, map) {
                tracing::warn!(scope = "Power", "no {signal} events: {error}");
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(
            scope = "Power",
            "could not start the {signal} listener: {error}"
        );
    }
}

fn listen(
    signal: &str,
    sender: &Sender<PowerEvent>,
    map: fn(bool) -> Option<PowerEvent>,
) -> zbus::Result<()> {
    let connection = Connection::system()?;
    let proxy = Proxy::new(&connection, SERVICE, PATH, INTERFACE)?;
    for message in proxy.receive_signal(signal)? {
        let start: bool = message.body().deserialize()?;
        if let Some(event) = map(start) {
            super::publish(sender, event);
        }
    }
    Ok(())
}
