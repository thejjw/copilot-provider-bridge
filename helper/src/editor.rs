//! Wait until the stable VS Code process for the default profile exits.
//!
//! The helper targets `win32-x64` stable `Code` only, so any live `Code.exe`
//! is treated as the editor that must close before the database is written.

use std::time::{Duration, Instant};

use sysinfo::{ProcessesToUpdate, System};

use crate::error::{HelperError, Result};

const POLL_INTERVAL: Duration = Duration::from_millis(500);
const EDITOR_IMAGE: &str = "Code.exe";

/// Block until no `Code.exe` process is running, or fail after `timeout`.
pub fn wait_for_editor_exit(timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    let mut system = System::new()
        .map_err(|err| HelperError::new(format!("cannot enumerate processes: {err}")))?;
    loop {
        system.refresh_processes(ProcessesToUpdate::All, true);
        let running = system
            .processes()
            .values()
            .any(|process| process.name().to_string_lossy().eq_ignore_ascii_case(EDITOR_IMAGE));
        if !running {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(HelperError::new(format!(
                "{EDITOR_IMAGE} is still running after {} seconds; nothing was written",
                timeout.as_secs()
            )));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}
