//! Runs a bundled npm CLI with the bundled Node runtime.
//!
//! The release stager copies this binary to `bin/<name>[.exe]` and writes
//! `bin/<name>.shim` beside it, holding the CLI's entry script relative to the
//! tools root (the directory that contains `bin/` and `node/`). Windows can only
//! spawn real executables by bare name, and a shebang script is not one, so every
//! bundled npm CLI (mailcrawl, qmd, kordoc) gets a launcher instead.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{exit, Command};

fn fail(message: String) -> ! {
    eprintln!("autorag-shim: {message}");
    exit(127);
}

fn main() {
    let exe = env::current_exe().unwrap_or_else(|e| fail(format!("cannot locate itself: {e}")));
    let bin_dir = exe.parent().unwrap_or_else(|| fail("executable has no parent directory".into())).to_path_buf();
    let stem = exe
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_else(|| fail("executable name is not valid UTF-8".into()))
        .to_string();
    let sidecar = bin_dir.join(format!("{stem}.shim"));
    let entry_rel = fs::read_to_string(&sidecar).unwrap_or_else(|e| fail(format!("cannot read {}: {e}", sidecar.display())));
    let root: PathBuf = bin_dir.parent().unwrap_or_else(|| fail("bin directory has no parent".into())).to_path_buf();

    let node = if cfg!(windows) { root.join("node").join("node.exe") } else { root.join("node").join("bin").join("node") };
    let entry = root.join(entry_rel.trim());
    if !node.is_file() {
        fail(format!("bundled Node runtime is missing: {}", node.display()));
    }
    if !entry.is_file() {
        fail(format!("bundled CLI entry is missing: {}", entry.display()));
    }

    let mut command = Command::new(&node);
    command.arg(&entry).args(env::args_os().skip(1));

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Replace this process so signals and the pid reach Node directly.
        let error = command.exec();
        fail(format!("cannot start {}: {error}", node.display()));
    }
    #[cfg(not(unix))]
    {
        match command.status() {
            Ok(status) => exit(status.code().unwrap_or(1)),
            Err(error) => fail(format!("cannot start {}: {error}", node.display())),
        }
    }
}
