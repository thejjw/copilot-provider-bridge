//! Credential helper for sealed Custom Endpoint keys (Windows x64).
//!
//! Reads one JSON line from stdin, acknowledges it, waits for VS Code to exit,
//! writes `secret://chat.lm.secret.cpb-*` rows, then swaps
//! `chatLanguageModels.json`. Secrets never appear in argv, logs, or temp files.

mod configfile;
mod crypto;
mod editor;
mod error;
mod oscrypt;
mod protocol;
mod vault;

use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use error::{HelperError, Result};
use protocol::{Outcome, Request};

const EDITOR_WAIT: Duration = Duration::from_secs(600);
const LOCK_WAIT: Duration = Duration::from_secs(30);
const RESULT_FILE: &str = "copilot-provider-bridge-sealed-result.json";

fn main() {
    match run() {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(err) => {
            let outcome = Outcome::failure("unknown", err.0);
            println!("{}", serde_json::to_string(&outcome).unwrap_or_default());
            std::process::exit(1);
        }
    }
}

fn run() -> Result<bool> {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return Err(HelperError::new(
            "this helper supports Windows x64 only",
        ));
    }

    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    let request = Request::parse(&line)?;
    let user_dir = PathBuf::from(request.user_dir());

    // Preflight before the acknowledgement: any failure here means the
    // extension leaves the JSON untouched and can report the error.
    let key = match &request {
        Request::Apply { .. } => Some(oscrypt::derive_key(&user_dir)?),
        Request::Delete { .. } => None,
    };

    print_acknowledgement()?;

    let outcome = match &request {
        Request::Apply {
            config,
            config_sha256,
            secrets,
            relaunch,
            ..
        } => execute_apply(&user_dir, key.expect("apply key"), config, config_sha256, secrets, *relaunch),
        Request::Delete { ids, .. } => execute_delete(&user_dir, ids),
    };

    if let Err(err) = write_result(&user_dir, &outcome) {
        eprintln!("warning: could not write result file: {}", err.0);
    }
    println!("{}", serde_json::to_string(&outcome)?);
    Ok(outcome.ok)
}

fn execute_apply(
    user_dir: &Path,
    key: [u8; 32],
    config: &str,
    config_sha256: &str,
    secrets: &BTreeMap<String, String>,
    relaunch: bool,
) -> Outcome {
    let result = (|| -> Result<Outcome> {
        editor::wait_for_editor_exit(EDITOR_WAIT)?;
        let db = vault::db_path(user_dir);
        let mut conn = vault::open(&db)?;
        vault::acquire_write_lock(&mut conn, LOCK_WAIT)?;
        let updated = vault::apply_secrets(&mut conn, &key, secrets)?;
        drop(conn);

        let config_path = user_dir.join("chatLanguageModels.json");
        configfile::verify_and_replace(&config_path, config_sha256, config)?;

        let relaunched = if relaunch { relaunch_code() } else { false };
        Ok(Outcome::success("apply", updated, Vec::new(), relaunched))
    })();
    result.unwrap_or_else(|err| Outcome::failure("apply", err.0))
}

fn execute_delete(user_dir: &Path, ids: &[String]) -> Outcome {
    let result = (|| -> Result<Outcome> {
        editor::wait_for_editor_exit(EDITOR_WAIT)?;
        let db = vault::db_path(user_dir);
        let mut conn = vault::open(&db)?;
        vault::acquire_write_lock(&mut conn, LOCK_WAIT)?;
        let removed = vault::delete_secrets(&mut conn, ids)?;
        Ok(Outcome::success("delete", Vec::new(), removed, false))
    })();
    result.unwrap_or_else(|err| Outcome::failure("delete", err.0))
}

fn print_acknowledgement() -> Result<()> {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, r#"{{"ok":true,"stage":"accepted"}}"#)?;
    stdout.flush()?;
    Ok(())
}

fn write_result(user_dir: &Path, outcome: &Outcome) -> Result<()> {
    let path = user_dir.join("globalStorage").join(RESULT_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(outcome)?;
    std::fs::write(&path, json)?;
    Ok(())
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
