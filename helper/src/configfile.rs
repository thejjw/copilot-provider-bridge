//! Verify the rendered config against the extension's SHA-256, then replace it
//! atomically. A mismatch leaves the previous plaintext file untouched.

use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::{HelperError, Result};

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Replace `path` with `content` only if its current hash matches `expected`.
pub fn verify_and_replace(path: &Path, expected: &str, content: &str) -> Result<()> {
    let current = fs::read(path)
        .map_err(|err| HelperError::new(format!("cannot read {}: {err}", path.display())))?;
    let actual = sha256_hex(&current);
    if !actual.eq_ignore_ascii_case(expected) {
        return Err(HelperError::new(format!(
            "{} changed after rendering; refusing to overwrite (expected {expected}, found {actual})",
            path.display()
        )));
    }

    let tmp = path.with_extension(format!("cpb-{}.tmp", std::process::id()));
    fs::write(&tmp, content.as_bytes())
        .map_err(|err| HelperError::new(format!("cannot write {}: {err}", tmp.display())))?;
    let file = fs::OpenOptions::new().write(true).open(&tmp)?;
    file.sync_all()?;
    drop(file);

    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        HelperError::new(format!("cannot replace {}: {err}", path.display()))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_only_on_matching_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("chatLanguageModels.json");
        fs::write(&path, "[]").unwrap();
        let expected = sha256_hex(b"[]");

        verify_and_replace(&path, &expected, "[{\"a\":1}]").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[{\"a\":1}]");

        let err = verify_and_replace(&path, &expected, "[]").unwrap_err();
        assert!(err.0.contains("refusing to overwrite"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "[{\"a\":1}]");
    }

    #[test]
    fn hash_is_standard_sha256() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
