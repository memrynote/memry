// S2 Prototype B: yrs authoritative in Rust. Renderer has shadow Y.Doc for
// y-prosemirror binding, but authority is Rust. Flow:
//   renderer edit → Y.Doc 'update' → invoke('apply_update') → yrs apply
//   yrs applies → Tauri 'crdt-update' event → renderer Y.applyUpdate(origin='rust')
// Loop prevention via origin tag; renderer skips invoke when origin === 'rust'.

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

struct DocsState(Mutex<HashMap<String, Doc>>);

#[derive(serde::Serialize, Clone)]
struct CrdtUpdatePayload {
    note_id: String,
    bytes: Vec<u8>,
}

#[tauri::command]
fn apply_update(
    note_id: String,
    update_bytes: Vec<u8>,
    state: State<DocsState>,
    app: AppHandle,
) -> Result<Vec<u8>, String> {
    let mut docs = state.0.lock().map_err(|e| e.to_string())?;
    let doc = docs.entry(note_id.clone()).or_insert_with(Doc::new);

    let update = Update::decode_v1(&update_bytes).map_err(|e| e.to_string())?;
    let mut txn = doc.transact_mut();
    txn.apply_update(update).map_err(|e| e.to_string())?;
    let post_state = txn.state_vector().encode_v1();
    drop(txn);

    app.emit(
        "crdt-update",
        CrdtUpdatePayload {
            note_id: note_id.clone(),
            bytes: update_bytes,
        },
    )
    .ok();

    Ok(post_state)
}

#[tauri::command]
fn get_state_vector(note_id: String, state: State<DocsState>) -> Result<Vec<u8>, String> {
    let docs = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(doc) = docs.get(&note_id) {
        let txn = doc.transact();
        Ok(txn.state_vector().encode_v1())
    } else {
        Ok(vec![])
    }
}

#[tauri::command]
fn get_snapshot(note_id: String, state: State<DocsState>) -> Result<Vec<u8>, String> {
    let docs = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(doc) = docs.get(&note_id) {
        let txn = doc.transact();
        Ok(txn.encode_state_as_update_v1(&StateVector::default()))
    } else {
        Ok(vec![])
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(DocsState(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            apply_update,
            get_state_vector,
            get_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
