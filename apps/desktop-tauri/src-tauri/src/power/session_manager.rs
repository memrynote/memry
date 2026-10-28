//! The desktop's session manager on the session bus, for a logout. logind announces only a
//! restart or a power off (`linux.rs`); at a logout the session manager quits, the display server
//! goes with it, and Xlib's IO error handler (GDK's) ends the process with `_exit(1)` about 150 ms
//! later, before any quit sequence. The session manager asks its registered clients first, and
//! keeps the display up until each has answered, so the app registers as a client and runs the
//! quit sequence then.
//!
//! GNOME (`gnome-session`, also used by MATE, Cinnamon and Budgie under the same name) and Xfce
//! (`xfce4-session` 4.16 and later) speak the same client protocol under their own names:
//! `RegisterClient(app_id, startup_id)` returns the client's object path, which then receives
//! `QueryEndSession`, `EndSession`, `CancelEndSession` and `Stop`, and is answered with
//! `EndSessionResponse(is_ok, reason)`. GNOME wants the `QueryEndSession` answer within a second
//! and gives `EndSession` ten; Xfce waits up to 60 s and 7 s. Both count a client whose bus
//! connection closed as answered. KDE Plasma and LXQt speak only XSMP and are not covered.

use std::time::Duration;

use memry_desktop::shell::power::{PowerEvent, wait_for};
use memry_desktop::shell::shutdown::SESSION_END_BUDGET;
use tauri::{AppHandle, Wry};
use tokio::sync::broadcast::Sender;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::OwnedObjectPath;

struct Protocol {
    desktop: &'static str,
    service: &'static str,
    path: &'static str,
    manager: &'static str,
    client: &'static str,
}

const PROTOCOLS: [Protocol; 2] = [
    Protocol {
        desktop: "GNOME",
        service: "org.gnome.SessionManager",
        path: "/org/gnome/SessionManager",
        manager: "org.gnome.SessionManager",
        client: "org.gnome.SessionManager.ClientPrivate",
    },
    Protocol {
        desktop: "Xfce",
        service: "org.xfce.SessionManager",
        path: "/org/xfce/SessionManager",
        manager: "org.xfce.Session.Manager",
        client: "org.xfce.Session.Client",
    },
];

/// How often the `EndSession` handler looks at the quit sequence.
const POLL: Duration = Duration::from_millis(20);

pub fn start(app: &AppHandle<Wry>, sender: &Sender<PowerEvent>) {
    let (app, sender) = (app.clone(), sender.clone());
    let spawned = std::thread::Builder::new()
        .name("session-manager".into())
        .spawn(move || {
            if let Err(error) = listen(&app, &sender) {
                tracing::warn!(scope = "Power", "no logout events: {error}");
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(
            scope = "Power",
            "could not start the session manager listener: {error}"
        );
    }
}

fn listen(app: &AppHandle<Wry>, sender: &Sender<PowerEvent>) -> zbus::Result<()> {
    let connection = Connection::session()?;
    let Some((protocol, path)) = register(&connection, &app.config().identifier) else {
        tracing::info!(
            scope = "Power",
            "no session manager on the session bus; a logout is not heard"
        );
        return Ok(());
    };
    tracing::info!(
        scope = "Power",
        "registered with the {} session manager",
        protocol.desktop
    );
    let client = Proxy::new(&connection, protocol.service, path, protocol.client)?;
    for message in client.receive_all_signals()? {
        let header = message.header();
        let Some(member) = header.member() else {
            continue;
        };
        match member.as_str() {
            "QueryEndSession" => {
                // An update must not start installing as the session goes down. The session may
                // still be called off, so nothing else starts yet.
                if let Some(hook) = crate::shutdown::update_hook(app) {
                    hook.disable_install_on_quit();
                }
                answer(&client, "QueryEndSession");
            }
            "EndSession" => {
                super::publish(sender, PowerEvent::SessionEnding);
                crate::shutdown::begin_session_end(app);
                let done = wait_for(
                    SESSION_END_BUDGET,
                    || crate::shutdown::is_completed(app),
                    std::thread::sleep,
                );
                if !done {
                    tracing::warn!(
                        scope = "Power",
                        "the quit sequence did not end within the logout budget"
                    );
                }
                // The display stays up until this answer or the end of the process.
                answer(&client, "EndSession");
            }
            "CancelEndSession" => {
                tracing::info!(scope = "Power", "the logout was called off");
                if let Some(hook) = crate::shutdown::update_hook(app) {
                    hook.enable_install_on_quit();
                }
            }
            "Stop" => crate::shutdown::begin_session_end(app),
            _ => {}
        }
    }
    Ok(())
}

/// The first session manager that accepts the app as a client, and the client's object path.
/// A session manager starts an autostarted app with its client id in `DESKTOP_AUTOSTART_ID`.
fn register(connection: &Connection, app_id: &str) -> Option<(&'static Protocol, OwnedObjectPath)> {
    let startup_id = std::env::var("DESKTOP_AUTOSTART_ID").unwrap_or_default();
    PROTOCOLS.iter().find_map(|protocol| {
        let manager = Proxy::new(
            connection,
            protocol.service,
            protocol.path,
            protocol.manager,
        )
        .ok()?;
        match manager.call("RegisterClient", &(app_id, startup_id.as_str())) {
            Ok(path) => Some((protocol, path)),
            Err(error) => {
                tracing::debug!(
                    scope = "Power",
                    "no {} session manager: {error}",
                    protocol.desktop
                );
                None
            }
        }
    })
}

fn answer(client: &Proxy<'_>, signal: &str) {
    if let Err(error) = client.call_method("EndSessionResponse", &(true, "")) {
        tracing::warn!(
            scope = "Power",
            "could not answer the session manager's {signal}: {error}"
        );
    }
}
