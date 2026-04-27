use memry_desktop_tauri_lib::crdt::{seed::seed_from_markdown, DocStore};
use yrs::{GetString, ReadTxn, Xml, XmlFragment, XmlOut};

#[tokio::test]
async fn seeds_markdown_into_prosemirror_xml_fragment() {
    let store = DocStore::new();
    let handle = store.get_or_init("note").await;

    seed_from_markdown(&handle, "# Title\n\nhello world\n\n- one").expect("seed");

    let (snapshot, children) = handle.with_read(|txn| {
        let fragment = txn.get_xml_fragment("prosemirror").expect("fragment");
        (fragment.get_string(txn), child_tags(&fragment, txn))
    });

    assert_eq!(children, vec!["h1", "p", "li"]);
    assert!(snapshot.contains("Title"));
    assert!(snapshot.contains("hello world"));
    assert!(snapshot.contains("one"));
}

#[tokio::test]
async fn seed_is_idempotent_when_fragment_already_has_content() {
    let store = DocStore::new();
    let handle = store.get_or_init("note").await;

    seed_from_markdown(&handle, "first").expect("first seed");
    seed_from_markdown(&handle, "second").expect("second seed");

    let snapshot = handle.with_read(|txn| {
        txn.get_xml_fragment("prosemirror")
            .expect("fragment")
            .get_string(txn)
    });

    assert!(snapshot.contains("first"));
    assert!(!snapshot.contains("second"));
}

#[tokio::test]
async fn seed_preserves_code_block_language_attribute() {
    let store = DocStore::new();
    let handle = store.get_or_init("note").await;

    seed_from_markdown(&handle, "```rust\nlet value = 1;\n```").expect("seed");

    let (tag, language, text) = handle.with_read(|txn| {
        let fragment = txn.get_xml_fragment("prosemirror").expect("fragment");
        let element = match fragment.get(txn, 0).expect("first child") {
            XmlOut::Element(element) => element,
            _ => panic!("expected element"),
        };
        (
            element.tag().to_string(),
            element.get_attribute(txn, "data-language"),
            element.get_string(txn),
        )
    });

    assert_eq!(tag, "pre");
    assert_eq!(language.as_deref(), Some("rust"));
    assert!(text.contains("let value = 1;"));
}

fn child_tags<T>(fragment: &impl XmlFragment, txn: &T) -> Vec<String>
where
    T: yrs::ReadTxn,
{
    fragment
        .children(txn)
        .map(|child| match child {
            XmlOut::Element(element) => element.tag().to_string(),
            _ => panic!("expected element"),
        })
        .collect()
}
