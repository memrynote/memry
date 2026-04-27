use serde::Serialize;

pub const CRDT_UPDATE_EVENT: &str = "crdt-update";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CrdtUpdateEvent {
    pub note_id: String,
    pub update: Vec<u8>,
    pub origin: u32,
}
