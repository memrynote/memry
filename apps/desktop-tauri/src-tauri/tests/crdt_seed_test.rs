use memry_desktop_tauri_lib::crdt::{seed::seed_from_markdown, DocStore};
use yrs::{GetString, ReadTxn, Xml, XmlFragment, XmlOut};

#[tokio::test]
async fn seeds_markdown_into_prosemirror_xml_fragment() {
    let store = DocStore::new();
    let handle = store.get_or_init("note").await;

    seed_from_markdown(&handle, "# Title\n\nhello world\n\n- one").expect("seed");

    let (snapshot, children) = handle.with_read(|txn| {
        let fragment = txn.get_xml_fragment("prosemirror").expect("fragment");
        (fragment.get_string(txn), block_content_tags(&fragment, txn))
    });

    assert_eq!(children, vec!["heading", "paragraph", "bulletListItem"]);
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
        let element = first_block_content_from_root(&fragment, txn);
        (
            element.tag().to_string(),
            element.get_attribute(txn, "language"),
            element.get_string(txn),
        )
    });

    assert_eq!(tag, "codeBlock");
    assert_eq!(language.as_deref(), Some("rust"));
    assert!(text.contains("let value = 1;"));
}

fn block_content_tags<T>(fragment: &impl XmlFragment, txn: &T) -> Vec<String>
where
    T: yrs::ReadTxn,
{
    let block_group = match fragment.get(txn, 0).expect("block group") {
        XmlOut::Element(element) => element,
        _ => panic!("expected block group"),
    };
    assert_eq!(block_group.tag().as_ref(), "blockGroup");

    block_group
        .children(txn)
        .map(|child| match child {
            XmlOut::Element(container) => block_content_from_container(&container, txn)
                .tag()
                .to_string(),
            _ => panic!("expected element"),
        })
        .collect()
}

fn first_block_content_from_root<T>(fragment: &impl XmlFragment, txn: &T) -> yrs::XmlElementRef
where
    T: yrs::ReadTxn,
{
    let block_group = match fragment.get(txn, 0).expect("block group") {
        XmlOut::Element(element) => element,
        _ => panic!("expected block group"),
    };
    assert_eq!(block_group.tag().as_ref(), "blockGroup");

    let container = match block_group.get(txn, 0).expect("block container") {
        XmlOut::Element(element) => element,
        _ => panic!("expected block container"),
    };
    block_content_from_container(&container, txn)
}

fn block_content_from_container<T>(container: &yrs::XmlElementRef, txn: &T) -> yrs::XmlElementRef
where
    T: yrs::ReadTxn,
{
    assert_eq!(container.tag().as_ref(), "blockContainer");

    match container.get(txn, 0).expect("block content") {
        XmlOut::Element(element) => element,
        _ => panic!("expected block content"),
    }
}
