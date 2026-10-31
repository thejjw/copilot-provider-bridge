use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{HelperError, Result};

/// Stable core-vault id prefix owned by the extension.
pub const SEALED_SECRET_PREFIX: &str = "chat.lm.secret.cpb-";

/// One JSON-line request from the extension.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Request {
    Apply {
        #[serde(rename = "userDir")]
        user_dir: String,
        config: String,
        #[serde(rename = "configSha256")]
        config_sha256: String,
        secrets: BTreeMap<String, String>,
        #[serde(default)]
        relaunch: bool,
    },
    Delete {
        #[serde(rename = "userDir")]
        user_dir: String,
        ids: Vec<String>,
    },
}

impl Request {
    /// Parse one protocol line. Unknown ops fail here.
    pub fn parse(line: &str) -> Result<Self> {
        let request: Self = serde_json::from_str(line.trim())
            .map_err(|err| HelperError::new(format!("invalid request: {err}")))?;
        request.validate()?;
        Ok(request)
    }

    /// Reject ids outside the bridge namespace and malformed hashes before any write.
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Apply {
                user_dir,
                config_sha256,
                secrets,
                ..
            } => {
                require_user_dir(user_dir)?;
                if !is_sha256_hex(config_sha256) {
                    return Err(HelperError::new(
                        "configSha256 must be 64 lowercase or uppercase hex characters",
                    ));
                }
                if secrets.is_empty() {
                    return Err(HelperError::new("apply requires at least one secret"));
                }
                for (provider, value) in secrets {
                    validate_provider_id(provider)?;
                    if value.is_empty() {
                        return Err(HelperError::new(format!(
                            "secret for provider '{provider}' is empty"
                        )));
                    }
                }
            }
            Self::Delete { user_dir, ids } => {
                require_user_dir(user_dir)?;
                if ids.is_empty() {
                    return Err(HelperError::new("delete requires at least one id"));
                }
                for id in ids {
                    validate_secret_id(id)?;
                }
            }
        }
        Ok(())
    }

    pub fn user_dir(&self) -> &str {
        match self {
            Self::Apply { user_dir, .. } | Self::Delete { user_dir, .. } => user_dir,
        }
    }

    #[cfg(test)]
    pub fn op_name(&self) -> &'static str {
        match self {
            Self::Apply { .. } => "apply",
            Self::Delete { .. } => "delete",
        }
    }
}

/// Result written to stdout and to the result file.
#[derive(Debug, Clone, Serialize)]
pub struct Outcome {
    pub ok: bool,
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub updated: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed: Vec<String>,
    #[serde(default)]
    pub relaunched: bool,
}

impl Outcome {
    pub fn success(op: &str, updated: Vec<String>, removed: Vec<String>, relaunched: bool) -> Self {
        Self {
            ok: true,
            op: op.to_string(),
            error: None,
            updated,
            removed,
            relaunched,
        }
    }

    pub fn failure(op: &str, error: impl Into<String>) -> Self {
        Self {
            ok: false,
            op: op.to_string(),
            error: Some(error.into()),
            updated: Vec::new(),
            removed: Vec::new(),
            relaunched: false,
        }
    }
}

/// Build the stable core-vault id for a provider, rejecting unsafe ids.
pub fn secret_id(provider_id: &str) -> Result<String> {
    validate_provider_id(provider_id)?;
    Ok(format!("{SEALED_SECRET_PREFIX}{provider_id}"))
}

fn require_user_dir(user_dir: &str) -> Result<()> {
    if user_dir.trim().is_empty() {
        return Err(HelperError::new("userDir is required"));
    }
    if user_dir.contains('\0') {
        return Err(HelperError::new("userDir contains a NUL byte"));
    }
    Ok(())
}

fn validate_provider_id(provider_id: &str) -> Result<()> {
    if provider_id.is_empty() {
        return Err(HelperError::new("provider id is empty"));
    }
    if !provider_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(HelperError::new(format!(
            "provider id '{provider_id}' contains unsupported characters"
        )));
    }
    Ok(())
}

fn validate_secret_id(id: &str) -> Result<()> {
    let provider = id.strip_prefix(SEALED_SECRET_PREFIX).ok_or_else(|| {
        HelperError::new(format!(
            "id '{id}' is outside the {SEALED_SECRET_PREFIX} namespace"
        ))
    })?;
    validate_provider_id(provider)
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_apply_and_delete() {
        let apply = Request::parse(
            r#"{"op":"apply","userDir":"C:\\u\\Code\\User","config":"[]","configSha256":"0000000000000000000000000000000000000000000000000000000000000000","secrets":{"zai":"sk-live"}}"#,
        )
        .unwrap();
        assert_eq!(apply.op_name(), "apply");

        let delete = Request::parse(
            r#"{"op":"delete","userDir":"C:\\u\\Code\\User","ids":["chat.lm.secret.cpb-zai"]}"#,
        )
        .unwrap();
        assert_eq!(delete.op_name(), "delete");
    }

    #[test]
    fn rejects_unknown_op() {
        assert!(Request::parse(r#"{"op":"list","userDir":"C:\\u"}"#).is_err());
    }

    #[test]
    fn rejects_foreign_ids_without_echoing_values() {
        let err = Request::parse(
            r#"{"op":"delete","userDir":"C:\\u","ids":["secret://chat.lm.secret.other"]}"#,
        )
        .unwrap_err();
        assert_eq!(err.0, "id 'secret://chat.lm.secret.other' is outside the chat.lm.secret.cpb- namespace");

        let err = Request::parse(
            r#"{"op":"apply","userDir":"C:\\u","config":"[]","configSha256":"0000000000000000000000000000000000000000000000000000000000000000","secrets":{"bad/id":"sk-should-not-appear"}}"#,
        )
        .unwrap_err();
        assert!(!err.0.contains("sk-should-not-appear"));
    }

    #[test]
    fn rejects_bad_hash() {
        assert!(
            Request::parse(
                r#"{"op":"apply","userDir":"C:\\u","config":"[]","configSha256":"abc","secrets":{"zai":"x"}}"#,
            )
            .is_err()
        );
    }
}
