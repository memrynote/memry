//! lib0 `decoding` primitives and `readAny` (the value encoding of y-leveldb meta entries).
//! Every read is bounds-checked: truncated input is [`ImportError::Parse`], never a panic.

use std::collections::BTreeMap;

use crate::electron_import::ImportError;

const WHAT: &str = "lib0 value";
const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub enum Lib0Any {
    Undefined,
    Null,
    Integer(i64),
    Float(f64),
    BigInt(i64),
    Bool(bool),
    String(String),
    Object(BTreeMap<String, Lib0Any>),
    Array(Vec<Lib0Any>),
    Bytes(Vec<u8>),
}

pub struct Decoder<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Decoder<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    pub fn has_content(&self) -> bool {
        self.pos < self.bytes.len()
    }

    fn err(&self) -> ImportError {
        ImportError::parse(WHAT, self.pos)
    }

    pub fn take(&mut self, n: usize) -> Result<&'a [u8], ImportError> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len());
        let end = end.ok_or_else(|| self.err())?;
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }

    pub fn read_u8(&mut self) -> Result<u8, ImportError> {
        Ok(self.take(1)?[0])
    }

    pub fn read_u32_be(&mut self) -> Result<u32, ImportError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn read_var_uint(&mut self) -> Result<u64, ImportError> {
        let mut num = 0_u64;
        for shift in (0..64).step_by(7) {
            let byte = self.read_u8()?;
            num |= u64::from(byte & 0x7f)
                .checked_shl(shift)
                .filter(|v| v >> shift == u64::from(byte & 0x7f))
                .ok_or_else(|| self.err())?;
            if byte & 0x80 == 0 {
                return Ok(num);
            }
        }
        Err(self.err())
    }

    /// lib0 `readVarInt`: bit 7 of the first byte is the sign, bits 0-5 the low payload.
    pub fn read_var_int(&mut self) -> Result<i64, ImportError> {
        let first = self.read_u8()?;
        let negative = first & 0x40 != 0;
        let mut num = i64::from(first & 0x3f);
        let mut shift = 6_u32;
        let mut byte = first;
        while byte & 0x80 != 0 {
            byte = self.read_u8()?;
            let part = i64::from(byte & 0x7f)
                .checked_shl(shift)
                .filter(|v| v >> shift == i64::from(byte & 0x7f))
                .ok_or_else(|| self.err())?;
            num = num.checked_add(part).ok_or_else(|| self.err())?;
            shift += 7;
        }
        Ok(if negative { -num } else { num })
    }

    pub fn read_var_bytes(&mut self) -> Result<&'a [u8], ImportError> {
        let len = usize::try_from(self.read_var_uint()?).map_err(|_| self.err())?;
        self.take(len)
    }

    pub fn read_var_string(&mut self) -> Result<String, ImportError> {
        let bytes = self.read_var_bytes()?;
        String::from_utf8(bytes.to_vec()).map_err(|_| self.err())
    }

    pub fn read_any(&mut self) -> Result<Lib0Any, ImportError> {
        self.read_any_at(0)
    }

    fn read_any_at(&mut self, depth: usize) -> Result<Lib0Any, ImportError> {
        if depth > MAX_DEPTH {
            return Err(self.err());
        }
        Ok(match self.read_u8()? {
            127 => Lib0Any::Undefined,
            126 => Lib0Any::Null,
            125 => Lib0Any::Integer(self.read_var_int()?),
            124 => {
                let b = self.take(4)?;
                Lib0Any::Float(f64::from(f32::from_be_bytes([b[0], b[1], b[2], b[3]])))
            }
            123 => {
                let b = self.take(8)?;
                Lib0Any::Float(f64::from_be_bytes(b.try_into().map_err(|_| self.err())?))
            }
            122 => {
                let b = self.take(8)?;
                Lib0Any::BigInt(i64::from_be_bytes(b.try_into().map_err(|_| self.err())?))
            }
            121 => Lib0Any::Bool(false),
            120 => Lib0Any::Bool(true),
            119 => Lib0Any::String(self.read_var_string()?),
            118 => {
                let len = self.read_var_uint()?;
                let mut object = BTreeMap::new();
                for _ in 0..len {
                    let key = self.read_var_string()?;
                    object.insert(key, self.read_any_at(depth + 1)?);
                }
                Lib0Any::Object(object)
            }
            117 => {
                let len = self.read_var_uint()?;
                let mut array = Vec::new();
                for _ in 0..len {
                    array.push(self.read_any_at(depth + 1)?);
                }
                Lib0Any::Array(array)
            }
            116 => Lib0Any::Bytes(self.read_var_bytes()?.to_vec()),
            _ => return Err(self.err()),
        })
    }
}

#[cfg(test)]
mod tests;
