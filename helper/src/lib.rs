//! Core operations for the sealed credential helper, callable without waiting
//! for the editor. The binary wraps these with the exit wait; tests call them
//! against fixture profiles.

pub mod configfile;
pub mod crypto;
pub mod editor;
pub mod error;
pub mod oscrypt;
pub mod protocol;
pub mod vault;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use error::Result;
use protocol::Outcome;

/// Write the secret rows and then swap the config, without waiting for exit.
pub fn apply_core(
    user_dir: &Path,
    key: [u8; 32],
    config: &str,
    config_sha256: &str,
    secrets: &BTreeMap<String, String>,
    relaunch: bool,
) -> Outcome {
    let result = (|| -> Result<Outcome> {
        let db = vault::db_path(user_dir);
        let mut conn = vault::open(&db)?;
        vault::acquire_write_lock(&mut conn, std::time::Duration::from_secs(30))?;
        let updated = vault::apply_secrets(&mut conn, &key, secrets)?;
        drop(conn);

        let config_path = user_dir.join("chatLanguageModels.json");
        configfile::verify_and_replace(&config_path, config_sha256, config)?;

        let relaunched = if relaunch { relaunch_code() } else { false };
        Ok(Outcome::success("apply", updated, Vec::new(), relaunched))
    })();
    result.unwrap_or_else(|err| Outcome::failure("apply", err.0))
}

/// Delete sealed rows and marker entries, without waiting for exit.
pub fn delete_core(user_dir: &Path, ids: &[String]) -> Outcome {
    let result = (|| -> Result<Outcome> {
        let db = vault::db_path(user_dir);
        let mut conn = vault::open(&db)?;
        vault::acquire_write_lock(&mut conn, std::time::Duration::from_secs(30))?;
        let removed = vault::delete_secrets(&mut conn, ids)?;
        Ok(Outcome::success("delete", Vec::new(), removed, false))
    })();
    result.unwrap_or_else(|err| Outcome::failure("delete", err.0))
}

/// Best-effort relaunch through the VS Code CLI. Failure is not fatal.
fn relaunch_code() -> bool {
    use std::process::Command;

    let cli = std::env::var_os("LOCALAPPDATA").map(|base| {
        PathBuf::from(base)
            .join("Programs")
            .join("Microsoft VS Code")
            .join("bin")
            .join("code.cmd")
    });
    if let Some(cli) = cli.filter(|path| path.exists()) {
        return Command::new("cmd").arg("/C").arg(cli).spawn().is_ok();
    }
    Command::new("cmd").args(["/C", "code"]).spawn().is_ok()
}
