use memry_desktop_tauri_lib::db::{settings, Db};

#[test]
fn get_missing_key_returns_none() {
    let db = Db::open_memory().unwrap();
    let v = settings::get(&db, "nonexistent").unwrap();
    assert_eq!(v, None);
}

#[test]
fn set_then_get_roundtrip() {
    let db = Db::open_memory().unwrap();
    settings::set(&db, "theme", "dark").unwrap();
    let v = settings::get(&db, "theme").unwrap();
    assert_eq!(v.as_deref(), Some("dark"));
}

#[test]
fn set_upserts_existing_key() {
    let db = Db::open_memory().unwrap();
    settings::set(&db, "theme", "dark").unwrap();
    settings::set(&db, "theme", "light").unwrap();
    let v = settings::get(&db, "theme").unwrap();
    assert_eq!(v.as_deref(), Some("light"));
}

#[test]
fn list_returns_sorted_entries() {
    let db = Db::open_memory().unwrap();
    settings::set(&db, "b-key", "2").unwrap();
    settings::set(&db, "a-key", "1").unwrap();
    settings::set(&db, "c-key", "3").unwrap();
    let items = settings::list(&db).unwrap();
    let keys: Vec<&str> = items.iter().map(|s| s.key.as_str()).collect();
    assert_eq!(keys, vec!["a-key", "b-key", "c-key"]);
}

#[test]
fn set_and_get_preserve_utf8_multibyte_value() {
    let db = Db::open_memory().unwrap();
    settings::set(&db, "general.label", "çalışma modu").unwrap();
    let v = settings::get(&db, "general.label").unwrap();
    assert_eq!(v.as_deref(), Some("çalışma modu"));
}
