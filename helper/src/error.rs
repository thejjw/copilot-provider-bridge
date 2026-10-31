use std::fmt;

/// Helper failure with a user-reportable message.
///
/// Messages must never contain a secret value or the rendered config; callers
/// only add ids, paths, and error classes.
#[derive(Debug)]
pub struct HelperError(pub String);

impl HelperError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for HelperError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for HelperError {}

impl From<std::io::Error> for HelperError {
    fn from(err: std::io::Error) -> Self {
        Self(format!("io error: {err}"))
    }
}

impl From<serde_json::Error> for HelperError {
    fn from(err: serde_json::Error) -> Self {
        Self(format!("json error: {err}"))
    }
}

impl From<rusqlite::Error> for HelperError {
    fn from(err: rusqlite::Error) -> Self {
        Self(format!("sqlite error: {err}"))
    }
}

pub type Result<T, E = HelperError> = std::result::Result<T, E>;
