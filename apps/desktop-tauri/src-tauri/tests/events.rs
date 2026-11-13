use std::sync::{Arc, Mutex};

use memry_desktop::notes::index::LinkChanges;
use memry_tauri::events::{
    NoteLinksChangedEvent, PortalsUsageChangedEvent, announce_links, broadcast, send_to,
};
use serde::{Deserialize, Serialize};
use tauri::test::mock_app;
use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Event)]
struct TestPingEvent {
    n: u32,
}

#[test]
fn events_broadcast_survives_a_closed_window_and_reaches_the_other() {
    let app = mock_app();
    let first = WebviewWindowBuilder::new(&app, "first", WebviewUrl::App("index.html".into()))
        .build()
        .expect("first window");
    let second = WebviewWindowBuilder::new(&app, "second", WebviewUrl::App("index.html".into()))
        .build()
        .expect("second window");
    let received = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    second.listen(TestPingEvent::NAME, move |event| {
        sink.lock().expect("lock").push(event.payload().to_owned());
    });

    first.destroy().expect("destroy first window");
    broadcast(app.handle(), TestPingEvent { n: 7 });

    assert_eq!(received.lock().expect("lock").as_slice(), ["{\"n\":7}"]);
}

#[test]
fn events_send_to_targets_one_label_and_never_errors() {
    let app = mock_app();
    let target = WebviewWindowBuilder::new(&app, "target", WebviewUrl::App("index.html".into()))
        .build()
        .expect("target window");
    let other = WebviewWindowBuilder::new(&app, "other", WebviewUrl::App("index.html".into()))
        .build()
        .expect("other window");
    let hits = Arc::new(Mutex::new((0, 0)));
    let target_hits = Arc::clone(&hits);
    target.listen(TestPingEvent::NAME, move |_| {
        target_hits.lock().expect("lock").0 += 1
    });
    let other_hits = Arc::clone(&hits);
    other.listen(TestPingEvent::NAME, move |_| {
        other_hits.lock().expect("lock").1 += 1
    });

    send_to(app.handle(), "target", TestPingEvent { n: 1 });
    send_to(app.handle(), "missing", TestPingEvent { n: 2 });

    assert_eq!(*hits.lock().expect("lock"), (1, 0));
}

#[test]
fn a_reindex_that_moved_only_portal_usage_sends_no_links_event() {
    let app = mock_app();
    let heard = Arc::new(Mutex::new(Vec::new()));
    for name in [NoteLinksChangedEvent::NAME, PortalsUsageChangedEvent::NAME] {
        let sink = Arc::clone(&heard);
        app.listen_any(name, move |_| sink.lock().expect("lock").push(name));
    }
    let ids = |list: &[&str]| list.iter().map(|id| (*id).to_owned()).collect();
    let sent = |links: LinkChanges| {
        announce_links(app.handle(), links);
        std::mem::take(&mut *heard.lock().expect("lock"))
    };

    let usage = LinkChanges {
        usage: ids(&["src"]),
        ..LinkChanges::default()
    };
    assert_eq!(sent(usage), [PortalsUsageChangedEvent::NAME]);
    let links = LinkChanges {
        targets: ids(&["b"]),
        ..LinkChanges::default()
    };
    assert_eq!(sent(links), [NoteLinksChangedEvent::NAME]);
    let both = LinkChanges {
        sources: ids(&["a"]),
        targets: ids(&["b"]),
        usage: ids(&["b"]),
    };
    assert_eq!(
        sent(both),
        [PortalsUsageChangedEvent::NAME, NoteLinksChangedEvent::NAME]
    );
}
