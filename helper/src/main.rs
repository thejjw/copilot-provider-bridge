//! Credential helper for sealed Custom Endpoint keys (Windows x64).
//!
//! Reads one JSON line from stdin, acknowledges it, waits for VS Code to exit,
//! writes `secret://chat.lm.secret.cpb-*` rows, then swaps
//! `chatLanguageModels.json`. Secrets never appear in argv, logs, or temp files.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use cpb_credential_helper::error::{HelperError, Result};
use cpb_credential_helper::protocol::{Outcome, Request};
use cpb_credential_helper::{apply_core, delete_core, editor, oscrypt};

const EDITOR_WAIT: Duration = Duration::from_secs(600);
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
        return Err(HelperError::new("this helper supports Windows x64 only"));
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
        } => match editor::wait_for_editor_exit(EDITOR_WAIT) {
            Ok(()) => apply_core(
                &user_dir,
                key.expect("apply key"),
                config,
                config_sha256,
                secrets,
                *relaunch,
            ),
            Err(err) => Outcome::failure("apply", err.0),
        },
        Request::Delete { ids, .. } => match editor::wait_for_editor_exit(EDITOR_WAIT) {
            Ok(()) => delete_core(&user_dir, ids),
            Err(err) => Outcome::failure("delete", err.0),
        },
    };

    if let Err(err) = write_result(&user_dir, &outcome) {
        eprintln!("warning: could not write result file: {}", err.0);
    }
    println!("{}", serde_json::to_string(&outcome)?);
    Ok(outcome.ok)
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
