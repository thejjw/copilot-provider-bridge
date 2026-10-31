//! Derive the Chromium OSCrypt key the way VS Code core does on Windows x64.
//!
//! `Local State` holds `os_crypt.encrypted_key`: base64 of the five-byte `DPAPI`
//! marker followed by a DPAPI-protected 32-byte AES key. App-bound encryption
//! (where only the owning executable can unwrap the key) is explicitly refused.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::Value;

use crate::error::{HelperError, Result};

pub const DPAPI_PREFIX: &[u8; 5] = b"DPAPI";
pub const KEY_LEN: usize = 32;

/// Locate `Local State` beside the `User` directory.
pub fn local_state_path(user_dir: &Path) -> Result<PathBuf> {
    let data_dir = user_dir
        .parent()
        .ok_or_else(|| HelperError::new("userDir has no parent data directory"))?;
    Ok(data_dir.join("Local State"))
}

/// Read and unwrap the OSCrypt key for `user_dir`.
pub fn derive_key(user_dir: &Path) -> Result<[u8; KEY_LEN]> {
    let path = local_state_path(user_dir)?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|err| HelperError::new(format!("cannot read {}: {err}", path.display())))?;
    let state: Value = serde_json::from_str(&raw)
        .map_err(|err| HelperError::new(format!("invalid Local State JSON: {err}")))?;
    let os_crypt = state
        .get("os_crypt")
        .and_then(Value::as_object)
        .ok_or_else(|| HelperError::new("Local State has no os_crypt object"))?;

    if os_crypt.contains_key("app_bound_encryption") {
        return Err(HelperError::new(
            "app-bound encryption is enabled; this helper supports DPAPI only",
        ));
    }

    let encoded = os_crypt
        .get("encrypted_key")
        .and_then(Value::as_str)
        .ok_or_else(|| HelperError::new("os_crypt.encrypted_key is missing"))?;
    let wrapped = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| HelperError::new("os_crypt.encrypted_key is not valid base64"))?;
    if !wrapped.starts_with(DPAPI_PREFIX) {
        return Err(HelperError::new(
            "os_crypt.encrypted_key does not use the DPAPI prefix",
        ));
    }

    let key = unprotect(&wrapped[DPAPI_PREFIX.len()..])?;
    let key: [u8; KEY_LEN] = key
        .try_into()
        .map_err(|_| HelperError::new("DPAPI key is not 32 bytes"))?;
    Ok(key)
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Result<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData};

    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    // SAFETY: both blobs point at valid buffers for the duration of the call;
    // `output` is freed below on every path after a successful call.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(HelperError::new("DPAPI unprotect failed"));
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut core::ffi::c_void);
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn unprotect(_data: &[u8]) -> Result<Vec<u8>> {
    Err(HelperError::new("OSCrypt is only supported on Windows"))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptProtectData};

    fn protect(data: &[u8]) -> Vec<u8> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut output,
            )
        };
        assert_ne!(ok, 0);
        let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        unsafe {
            windows_sys::Win32::Foundation::LocalFree(output.pbData as *mut core::ffi::c_void);
        }
        bytes
    }

    #[test]
    fn derives_a_32_byte_key_from_local_state() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("Code");
        let user_dir = data_dir.join("User");
        std::fs::create_dir_all(&user_dir).unwrap();

        let mut wrapped = DPAPI_PREFIX.to_vec();
        wrapped.extend(protect(&[7u8; KEY_LEN]));
        let state = serde_json::json!({
            "os_crypt": {
                "encrypted_key": base64::engine::general_purpose::STANDARD.encode(wrapped),
            }
        });
        std::fs::write(data_dir.join("Local State"), state.to_string()).unwrap();

        assert_eq!(derive_key(&user_dir).unwrap(), [7u8; KEY_LEN]);
    }

    #[test]
    fn refuses_a_non_dpapi_prefix_and_app_bound_state() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().join("Code");
        let user_dir = data_dir.join("User");
        std::fs::create_dir_all(&user_dir).unwrap();

        let plain = serde_json::json!({
            "os_crypt": { "encrypted_key": base64::engine::general_purpose::STANDARD.encode(b"v20nope") }
        });
        std::fs::write(data_dir.join("Local State"), plain.to_string()).unwrap();
        assert!(derive_key(&user_dir).is_err());

        let app_bound = serde_json::json!({
            "os_crypt": { "app_bound_encryption": true, "encrypted_key": "DPAPI" }
        });
        std::fs::write(data_dir.join("Local State"), app_bound.to_string()).unwrap();
        let err = derive_key(&user_dir).unwrap_err();
        assert!(err.0.contains("app-bound"));
    }
}
