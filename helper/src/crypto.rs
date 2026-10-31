//! `v10` OSCrypt blob layout used by Chromium/Electron on Windows:
//! `"v10" | nonce(12) | AES-256-GCM ciphertext | tag(16)`.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use serde::Serialize;

use crate::error::{HelperError, Result};

pub const V10_PREFIX: &[u8; 3] = b"v10";
pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;

/// Serialized form of VS Code storage values: `JSON.stringify(Buffer)`.
#[derive(Debug, Serialize)]
pub struct BufferValue {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub data: Vec<u8>,
}

impl BufferValue {
    pub fn new(data: Vec<u8>) -> Self {
        Self { kind: "Buffer", data }
    }
}

/// Encrypt `plaintext` into a `v10` blob using the derived OSCrypt key.
pub fn seal(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| HelperError::new("invalid OSCrypt key length"))?;
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|_| HelperError::new("nonce generation failed"))?;
    let ciphertext = cipher
        .encrypt(&Nonce::from(nonce), plaintext)
        .map_err(|_| HelperError::new("AES-GCM encryption failed"))?;

    let mut blob = Vec::with_capacity(V10_PREFIX.len() + NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(V10_PREFIX);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// Decrypt a `v10` blob. Used by tests and row verification.
pub fn open(key: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < V10_PREFIX.len() + NONCE_LEN + TAG_LEN || !blob.starts_with(V10_PREFIX) {
        return Err(HelperError::new("blob is not a v10 OSCrypt value"));
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| HelperError::new("invalid OSCrypt key length"))?;
    let nonce: &[u8; NONCE_LEN] = blob[V10_PREFIX.len()..V10_PREFIX.len() + NONCE_LEN]
        .try_into()
        .map_err(|_| HelperError::new("blob nonce is truncated"))?;
    cipher
        .decrypt(&Nonce::from(*nonce), &blob[V10_PREFIX.len() + NONCE_LEN..])
        .map_err(|_| HelperError::new("AES-GCM decryption failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_with_the_documented_layout() {
        let key = [9u8; 32];
        let blob = seal(&key, b"sk-live-secret").unwrap();
        assert_eq!(&blob[..3], b"v10");
        assert_eq!(blob.len(), 3 + NONCE_LEN + "sk-live-secret".len() + TAG_LEN);
        assert_eq!(open(&key, &blob).unwrap(), b"sk-live-secret");
    }

    #[test]
    fn rejects_short_or_foreign_blobs() {
        assert!(open(&[9u8; 32], b"v10short").is_err());
        assert!(open(&[9u8; 32], &[0u8; 40]).is_err());
    }

    #[test]
    fn buffer_value_matches_vscode_shape() {
        let json = serde_json::to_string(&BufferValue::new(vec![118, 49, 48])).unwrap();
        assert_eq!(json, r#"{"type":"Buffer","data":[118,49,48]}"#);
    }
}
