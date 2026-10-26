//! STUB
use super::base::{Cx, Extracted, Extractor};
use crate::web::extract::error::ExtractError;
pub struct C2WikiExtractor;
impl C2WikiExtractor {
    pub fn new(_cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self)
    }
}
impl Extractor for C2WikiExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(false)
    }
    fn extract(&mut self, _cx: &mut Cx) -> Result<Extracted, ExtractError> {
        Ok(Extracted::default())
    }
}
