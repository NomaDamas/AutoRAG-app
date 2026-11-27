//! Dazzi native Rust core (napi-rs) — hot paths identified and verified with `fast-anything`.
//!
//! Exports:
//! 1. `findExclusionBatch(exclusions, paths)` + `CompiledExclusions` — compiled path-prefix & glob
//!    matcher matching `src/main/path-exclusion.ts` (`path.matchesGlob` semantics, including dot-segment
//!    rules and platform case-sensitivity).
//! 2. `scanFolderNative(...)` — async (libuv thread pool) BFS directory pre-scan (`src/main/onboarding-scan.ts`).
//! 3. `measureFolderNative(...)` — async (libuv thread pool) folder survey (`src/main/folder-stats.ts`).
//! 4. `listDirNative(dirPath, platform)` — fast native directory listing (`src/main/fs-service.ts`).

use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Path & Glob Exclusion Matching (`path-exclusion.ts`)
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct ExclusionMatch {
    pub kind: String,
    pub entry: String,
}

/// Sentinel indicating the glob uses syntax we delegate to Node's `matchesGlob` fallback
/// (e.g. brace expansion `{a,b}`, extglob `!(...)`, character classes `[...]`, escapes `\`,
/// or non-ASCII patterns where case-folding nuances apply).
#[inline]
fn is_glob_exclusion(entry: &str) -> bool {
    entry.as_bytes().iter().any(|&b| b == b'*' || b == b'?' || b == b'[')
}

#[inline]
fn is_under(path: &str, root: &str, sep: u8) -> bool {
    if path == root {
        return true;
    }
    let pb = path.as_bytes();
    let rb = root.as_bytes();
    if pb.len() <= rb.len() || !pb.starts_with(rb) {
        return false;
    }
    if rb.last() == Some(&sep) {
        true
    } else {
        pb[rb.len()] == sep
    }
}

#[inline]
fn has_dot_segment(s: &str) -> bool {
    // Check if any `/`-delimited segment starts with `.` (excluding empty segments)
    for seg in s.split('/') {
        if seg.starts_with('.') {
            return true;
        }
    }
    false
}

#[inline]
fn ascii_eq_icase(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.to_ascii_lowercase() == y.to_ascii_lowercase())
}

#[inline]
fn ascii_ends_with_icase(haystack: &[u8], suffix: &[u8]) -> bool {
    haystack.len() >= suffix.len() && ascii_eq_icase(&haystack[haystack.len() - suffix.len()..], suffix)
}

#[inline]
fn ascii_starts_with_icase(haystack: &[u8], prefix: &[u8]) -> bool {
    haystack.len() >= prefix.len() && ascii_eq_icase(&haystack[..prefix.len()], prefix)
}

#[derive(Clone)]
enum GlobPattern {
    /// `**/segment/**` — exact segment match (no dot segments matched by `**` before/after)
    DoubleStarMiddle(String),
    /// `**/*suffix` — basename ends with `suffix` (basename and ancestor segments must not start with `.`;
    /// case-insensitive on macOS/Windows because the basename segment contains `*`, matching Node's `matchesGlob`)
    DoubleStarBasenameSuffix(String),
    /// `**/prefix*` — basename starts with `prefix` (no dot segments matched by `**` or `*`)
    DoubleStarBasenamePrefix(String),
    /// `**/exact` — exact basename match (ancestor segments matched by `**` must not start with `.`)
    DoubleStarBasenameExact(String),
    /// `**/<dir1>/<dir2>/**` — multi-segment literal path inside `**/.../**`
    DoubleStarPathMiddle(Vec<String>),
    /// Complex pattern (braces `{a,b}`, char classes `[...]`, `?`, escapes, etc.) — caller handles or returns fallback signal
    Unsupported,
}

impl GlobPattern {
    fn is_plain_segment(s: &str) -> bool {
        !s.is_empty() && s.is_ascii() && !s.contains(['*', '?', '[', ']', '{', '}', '(', ')', '!', '\\'])
    }

    fn compile(glob: &str) -> Self {
        if !glob.is_ascii() || glob.contains(['?', '[', ']', '{', '}', '(', ')', '!', '\\']) {
            return GlobPattern::Unsupported;
        }
        // `**/mid/**` (single or multi-segment literal)
        if let Some(mid) = glob.strip_prefix("**/").and_then(|s| s.strip_suffix("/**")) {
            if !mid.is_empty() && !mid.contains('*') {
                if !mid.contains('/') {
                    return GlobPattern::DoubleStarMiddle(mid.to_string());
                }
                let segs: Vec<String> = mid.split('/').map(|s| s.to_string()).collect();
                if segs.iter().all(|s| Self::is_plain_segment(s)) {
                    return GlobPattern::DoubleStarPathMiddle(segs);
                }
            }
            return GlobPattern::Unsupported;
        }
        // `**/<rest>` where `<rest>` has no `/`
        if let Some(rest) = glob.strip_prefix("**/") {
            if !rest.contains('/') {
                if let Some(suf) = rest.strip_prefix('*') {
                    if Self::is_plain_segment(suf) {
                        return GlobPattern::DoubleStarBasenameSuffix(suf.to_string());
                    }
                } else if let Some(pre) = rest.strip_suffix('*') {
                    if Self::is_plain_segment(pre) {
                        return GlobPattern::DoubleStarBasenamePrefix(pre.to_string());
                    }
                } else if Self::is_plain_segment(rest) {
                    return GlobPattern::DoubleStarBasenameExact(rest.to_string());
                }
            }
        }
        GlobPattern::Unsupported
    }

    /// Returns `Some(true/false)` if handled natively with exact `node:path.matchesGlob` parity,
    /// or `None` if the caller should fall back to `node:path.matchesGlob`.
    #[inline]
    fn matches(&self, slashed: &str, nocase_wildcards: bool) -> Option<bool> {
        match self {
            GlobPattern::DoubleStarMiddle(seg) => {
                // `**/seg/**` matches `/a/b/seg/c` and `seg/c` and `/a/seg/` provided:
                // - there is a segment strictly equal to `seg` (literal segment: case-sensitive on POSIX,
                //   and in Node `path.matchesGlob` literal segments are case-sensitive on darwin & win32 too!)
                // - there is at least one `/` after `seg`
                // - no segment matched by the leading `**` starts with `.`
                // - no segment matched by the trailing `**` starts with `.`
                let seg_bytes = seg.as_bytes();
                let mut iter = slashed.split('/');
                let mut matched_seg = false;
                let mut has_trailing = false;
                // Track segments: leading empty segment from leading `/` is fine (not a dot segment)
                while let Some(part) = iter.next() {
                    if !matched_seg {
                        if part.as_bytes() == seg_bytes {
                            matched_seg = true;
                        } else if part.starts_with('.') {
                            // Leading `**` cannot traverse a dot-prefixed segment
                            return Some(false);
                        }
                    } else {
                        has_trailing = true;
                        if part.starts_with('.') {
                            // Trailing `**` cannot match a dot-prefixed segment
                            return Some(false);
                        }
                    }
                }
                Some(matched_seg && has_trailing)
            }
            GlobPattern::DoubleStarPathMiddle(target_segs) => {
                let parts: Vec<&str> = slashed.split('/').collect();
                let tlen = target_segs.len();
                // Need at least one element after the target_segs (trailing `/**` requires `/`)
                if parts.len() <= tlen {
                    return Some(false);
                }
                // Find an index `i` where parts[i..i+tlen] == target_segs,
                // all parts[0..i] don't start with '.', and all parts[i+tlen..] don't start with '.'
                for i in 0..=(parts.len() - tlen - 1) {
                    if i > 0 && parts[i - 1].starts_with('.') {
                        // Once a dot segment appears before `i`, leading `**` cannot pass it
                        return Some(false);
                    }
                    let mut eq = true;
                    for j in 0..tlen {
                        if parts[i + j] != target_segs[j].as_str() {
                            eq = false;
                            break;
                        }
                    }
                    if eq {
                        // Check trailing parts have no dot segment
                        let mut trailing_ok = true;
                        for &tp in &parts[i + tlen..] {
                            if tp.starts_with('.') {
                                trailing_ok = false;
                                break;
                            }
                        }
                        if trailing_ok {
                            return Some(true);
                        }
                    }
                }
                Some(false)
            }
            GlobPattern::DoubleStarBasenameSuffix(suf) => {
                // Split into parent + basename
                let (parent, base) = match slashed.rfind('/') {
                    Some(idx) => (&slashed[..idx], &slashed[idx + 1..]),
                    None => ("", slashed),
                };
                if base.is_empty() || base.starts_with('.') {
                    return Some(false);
                }
                let suf_bytes = suf.as_bytes();
                let base_bytes = base.as_bytes();
                let suffix_matches = if nocase_wildcards {
                    ascii_ends_with_icase(base_bytes, suf_bytes)
                } else {
                    base_bytes.ends_with(suf_bytes)
                };
                if !suffix_matches {
                    return Some(false);
                }
                if !parent.is_empty() && has_dot_segment(parent) {
                    return Some(false);
                }
                Some(true)
            }
            GlobPattern::DoubleStarBasenamePrefix(pre) => {
                let (parent, base) = match slashed.rfind('/') {
                    Some(idx) => (&slashed[..idx], &slashed[idx + 1..]),
                    None => ("", slashed),
                };
                if base.is_empty() {
                    return Some(false);
                }
                if !pre.starts_with('.') && base.starts_with('.') {
                    return Some(false);
                }
                let pre_bytes = pre.as_bytes();
                let base_bytes = base.as_bytes();
                let prefix_matches = if nocase_wildcards {
                    ascii_starts_with_icase(base_bytes, pre_bytes)
                } else {
                    base_bytes.starts_with(pre_bytes)
                };
                if !prefix_matches {
                    return Some(false);
                }
                if !parent.is_empty() && has_dot_segment(parent) {
                    return Some(false);
                }
                Some(true)
            }
            GlobPattern::DoubleStarBasenameExact(exact) => {
                let (parent, base) = match slashed.rfind('/') {
                    Some(idx) => (&slashed[..idx], &slashed[idx + 1..]),
                    None => ("", slashed),
                };
                if base != exact.as_str() {
                    return Some(false);
                }
                if !parent.is_empty() && has_dot_segment(parent) {
                    return Some(false);
                }
                Some(true)
            }
            GlobPattern::Unsupported => None,
        }
    }
}

enum CompiledRule {
    Path(String),
    Glob { entry: String, pattern: GlobPattern },
}

/// Returns true when every glob entry in `exclusions` is handled natively with exact `matchesGlob` parity.
#[napi(js_name = "canHandleExclusionsNatively", catch_unwind)]
pub fn can_handle_exclusions_natively(exclusions: Vec<String>) -> bool {
    for entry in &exclusions {
        if is_glob_exclusion(entry) {
            if matches!(GlobPattern::compile(entry), GlobPattern::Unsupported) {
                return false;
            }
        }
    }
    true
}

/// Evaluate `exclusions` over a batch of `paths` with a single FFI crossing.
/// Callers check `canHandleExclusionsNatively` first (or let unsupported globs fall back to JS).
#[napi(js_name = "findExclusionBatch", catch_unwind)]
pub fn find_exclusion_batch(
    exclusions: Vec<String>,
    paths: Vec<String>,
) -> Result<Vec<Option<ExclusionMatch>>> {
    let sep: u8 = if cfg!(windows) { b'\\' } else { b'/' };
    // Node.js `path.matchesGlob` uses case-insensitive wildcard regex on macOS & Windows.
    let nocase_wildcards = cfg!(any(target_os = "macos", target_os = "windows"));
    let mut rules: Vec<CompiledRule> = Vec::with_capacity(exclusions.len());
    let mut has_glob = false;
    for entry in exclusions {
        if is_glob_exclusion(&entry) {
            has_glob = true;
            let pattern = GlobPattern::compile(&entry);
            rules.push(CompiledRule::Glob { entry, pattern });
        } else {
            rules.push(CompiledRule::Path(entry));
        }
    }

    let mut out: Vec<Option<ExclusionMatch>> = Vec::with_capacity(paths.len());
    let mut slashed_buf = String::new();

    for path in &paths {
        let mut glob_match_entry: Option<&str> = None;
        let mut path_match_entry: Option<&str> = None;

        let slashed: &str = if has_glob && path.as_bytes().contains(&b'\\') {
            slashed_buf.clear();
            slashed_buf.reserve(path.len());
            for ch in path.chars() {
                slashed_buf.push(if ch == '\\' { '/' } else { ch });
            }
            &slashed_buf
        } else {
            path.as_str()
        };

        for rule in &rules {
            match rule {
                CompiledRule::Glob { entry, pattern } => {
                    if glob_match_entry.is_none() && pattern.matches(slashed, nocase_wildcards) == Some(true) {
                        glob_match_entry = Some(entry.as_str());
                    }
                }
                CompiledRule::Path(entry) => {
                    if is_under(path.as_str(), entry.as_str(), sep) {
                        path_match_entry = Some(entry.as_str());
                        break;
                    }
                }
            }
        }

        if let Some(entry) = path_match_entry {
            out.push(Some(ExclusionMatch {
                kind: "path".to_string(),
                entry: entry.to_string(),
            }));
        } else if let Some(entry) = glob_match_entry {
            out.push(Some(ExclusionMatch {
                kind: "glob".to_string(),
                entry: entry.to_string(),
            }));
        } else {
            out.push(None);
        }
    }

    Ok(out)
}

/// Reusable compiled exclusion matcher for streaming callers (e.g. `scanIndexScope`).
#[napi]
pub struct CompiledExclusions {
    rules: Vec<CompiledRule>,
    has_glob: bool,
    has_unsupported_glob: bool,
    sep: u8,
    nocase_wildcards: bool,
}

#[napi]
impl CompiledExclusions {
    #[napi(constructor)]
    pub fn new(exclusions: Vec<String>) -> Self {
        let sep: u8 = if cfg!(windows) { b'\\' } else { b'/' };
        let nocase_wildcards = cfg!(any(target_os = "macos", target_os = "windows"));
        let mut rules = Vec::with_capacity(exclusions.len());
        let mut has_glob = false;
        let mut has_unsupported_glob = false;
        for entry in exclusions {
            if is_glob_exclusion(&entry) {
                has_glob = true;
                let pattern = GlobPattern::compile(&entry);
                if matches!(pattern, GlobPattern::Unsupported) {
                    has_unsupported_glob = true;
                }
                rules.push(CompiledRule::Glob { entry, pattern });
            } else {
                rules.push(CompiledRule::Path(entry));
            }
        }
        Self {
            rules,
            has_glob,
            has_unsupported_glob,
            sep,
            nocase_wildcards,
        }
    }

    #[napi(getter)]
    pub fn all_native(&self) -> bool {
        !self.has_unsupported_glob
    }

    #[napi]
    pub fn find(&self, path: String) -> Option<ExclusionMatch> {
        let mut glob_match_entry: Option<&str> = None;
        let slashed_owned: String;
        let slashed: &str = if self.has_glob && path.as_bytes().contains(&b'\\') {
            slashed_owned = path.replace('\\', "/");
            &slashed_owned
        } else {
            path.as_str()
        };
        for rule in &self.rules {
            match rule {
                CompiledRule::Glob { entry, pattern } => {
                    if glob_match_entry.is_none()
                        && pattern.matches(slashed, self.nocase_wildcards) == Some(true)
                    {
                        glob_match_entry = Some(entry.as_str());
                    }
                }
                CompiledRule::Path(entry) => {
                    if is_under(path.as_str(), entry.as_str(), self.sep) {
                        return Some(ExclusionMatch {
                            kind: "path".to_string(),
                            entry: entry.clone(),
                        });
                    }
                }
            }
        }
        glob_match_entry.map(|entry| ExclusionMatch {
            kind: "glob".to_string(),
            entry: entry.to_string(),
        })
    }

    #[napi]
    pub fn is_excluded(&self, path: String) -> bool {
        let slashed_owned: String;
        let slashed: &str = if self.has_glob && path.as_bytes().contains(&b'\\') {
            slashed_owned = path.replace('\\', "/");
            &slashed_owned
        } else {
            path.as_str()
        };
        for rule in &self.rules {
            match rule {
                CompiledRule::Path(entry) => {
                    if is_under(path.as_str(), entry.as_str(), self.sep) {
                        return true;
                    }
                }
                CompiledRule::Glob { pattern, .. } => {
                    if pattern.matches(slashed, self.nocase_wildcards) == Some(true) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Native Folder Pre-Scan (`onboarding-scan.ts`)
// ─────────────────────────────────────────────────────────────────────────────

#[inline]
fn lower_extname(name: &str) -> String {
    let bytes = name.as_bytes();
    for i in (0..bytes.len()).rev() {
        if bytes[i] == b'.' {
            return if i > 0 {
                name[i..].to_lowercase()
            } else {
                String::new()
            };
        }
    }
    String::new()
}

/// Cancellation + live progress shared between the JS caller and a running native walk.
struct WalkShared {
    cancelled: AtomicBool,
    files: AtomicU64,
    bytes: AtomicU64,
    online_only: AtomicU64,
}

/// Handle JS keeps while a native walk runs on the libuv thread pool: `cancel()` is the AbortSignal,
/// `snapshot()` is polled for the running totals the onboarding screen streams.
#[napi]
pub struct WalkControl {
    inner: Arc<WalkShared>,
}

#[napi(object)]
pub struct WalkSnapshot {
    pub files: f64,
    pub bytes: f64,
    pub online_only: f64,
}

#[napi]
impl WalkControl {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(WalkShared {
                cancelled: AtomicBool::new(false),
                files: AtomicU64::new(0),
                bytes: AtomicU64::new(0),
                online_only: AtomicU64::new(0),
            }),
        }
    }

    #[napi]
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::Relaxed);
    }

    #[napi]
    pub fn snapshot(&self) -> WalkSnapshot {
        WalkSnapshot {
            files: self.inner.files.load(Ordering::Relaxed) as f64,
            bytes: self.inner.bytes.load(Ordering::Relaxed) as f64,
            online_only: self.inner.online_only.load(Ordering::Relaxed) as f64,
        }
    }
}

#[napi(object)]
pub struct NativeFolderScanResult {
    pub files: f64,
    pub bytes: f64,
    pub online_only: f64,
    pub scanned: f64,
}

pub struct ScanFolderTask {
    root: String,
    ext_set: HashSet<String>,
    skip_set: HashSet<String>,
    dataless_set: Option<HashSet<String>>,
    max_bytes: u64,
    max_entries: u64,
    shared: Arc<WalkShared>,
}

impl Task for ScanFolderTask {
    type Output = NativeFolderScanResult;
    type JsValue = NativeFolderScanResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let shared = &self.shared;
        let mut files: u64 = 0;
        let mut bytes: u64 = 0;
        let mut online_only: u64 = 0;
        let mut scanned: u64 = 0;
        let mut queue: VecDeque<std::path::PathBuf> = VecDeque::new();
        queue.push_back(std::path::PathBuf::from(&self.root));

        'walk: while let Some(dir) = queue.pop_front() {
            if shared.cancelled.load(Ordering::Relaxed) {
                break;
            }
            let Ok(rd) = fs::read_dir(&dir) else {
                continue;
            };
            for item in rd {
                if shared.cancelled.load(Ordering::Relaxed) || scanned >= self.max_entries {
                    break 'walk;
                }
                let Ok(entry) = item else {
                    continue;
                };
                scanned += 1;
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                let os_name = entry.file_name();
                let Some(name) = os_name.to_str() else {
                    continue;
                };
                if ft.is_dir() {
                    if name.starts_with('.') || self.skip_set.contains(&name.to_lowercase()) {
                        continue;
                    }
                    queue.push_back(entry.path());
                    continue;
                }
                if !ft.is_file() {
                    continue;
                }
                let ext = lower_extname(name);
                if ext.is_empty() || !self.ext_set.contains(&ext) {
                    continue;
                }
                // `DirEntry::metadata` reuses the directory read on Windows (no extra CreateFileW per file).
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let size = meta.len();
                if size > self.max_bytes {
                    continue;
                }
                if let Some(ref dl) = self.dataless_set {
                    if let Some(full_str) = entry.path().to_str() {
                        if dl.contains(full_str) {
                            online_only += 1;
                            shared.online_only.store(online_only, Ordering::Relaxed);
                            continue;
                        }
                    }
                }
                files += 1;
                bytes += size;
                shared.files.store(files, Ordering::Relaxed);
                shared.bytes.store(bytes, Ordering::Relaxed);
            }
        }

        Ok(NativeFolderScanResult {
            files: files as f64,
            bytes: bytes as f64,
            online_only: online_only as f64,
            scanned: scanned as f64,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Runs the `onboarding-scan.ts` walk on the libuv thread pool; never blocks the calling JS thread.
#[napi(js_name = "scanFolderNative", catch_unwind)]
pub fn scan_folder_native(
    root: String,
    supported_extensions: Vec<String>,
    skip_dir_names: Vec<String>,
    max_source_bytes: f64,
    max_entries: f64,
    dataless_paths: Option<Vec<String>>,
    control: &WalkControl,
) -> AsyncTask<ScanFolderTask> {
    AsyncTask::new(ScanFolderTask {
        root,
        ext_set: supported_extensions.into_iter().collect(),
        skip_set: skip_dir_names.into_iter().collect(),
        dataless_set: dataless_paths.map(|v| v.into_iter().collect()),
        max_bytes: max_source_bytes.max(0.0) as u64,
        max_entries: max_entries.max(0.0) as u64,
        shared: Arc::clone(&control.inner),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Native Folder Survey (`folder-stats.ts`)
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct NativeExtensionCount {
    pub extension: String,
    pub files: f64,
    pub indexed: bool,
}

#[napi(object)]
pub struct NativeModifiedSpread {
    pub oldest_ms: f64,
    pub newest_ms: f64,
    pub span_days: f64,
    pub same_day_share: f64,
}

#[napi(object)]
pub struct NativeSubfolder {
    pub name: String,
    pub total_files: f64,
}

#[napi(object)]
pub struct NativeChildStats {
    pub name: String,
    pub indexed_files: f64,
    pub total_files: f64,
    pub extensions: Vec<NativeExtensionCount>,
    pub modified: Option<NativeModifiedSpread>,
    pub sample: Vec<String>,
    pub subfolders: Vec<NativeSubfolder>,
}

#[napi(object)]
pub struct NativeFolderStats {
    pub indexed_files: f64,
    pub total_files: f64,
    pub indexed_bytes: f64,
    pub extensions: Vec<NativeExtensionCount>,
    pub children: Vec<NativeChildStats>,
    pub own_files: Vec<String>,
    pub sample: Vec<String>,
    pub modified: Option<NativeModifiedSpread>,
    pub truncated: bool,
}

const DAY_MS: f64 = 86_400_000.0;

struct RustBucket {
    indexed_files: u64,
    total_files: u64,
    indexed_bytes: u64,
    extensions: HashMap<String, u64>,
    times: Vec<f64>,
    names: Vec<String>,
    below: HashMap<String, u64>,
}

impl RustBucket {
    fn new() -> Self {
        Self {
            indexed_files: 0,
            total_files: 0,
            indexed_bytes: 0,
            extensions: HashMap::new(),
            times: Vec::new(),
            names: Vec::new(),
            below: HashMap::new(),
        }
    }
}

fn spread_names(names: &[String], count: usize) -> Vec<String> {
    if names.len() <= count {
        return names.to_vec();
    }
    let mut picked = Vec::with_capacity(count);
    for i in 0..count {
        let idx = (i * names.len()) / count;
        picked.push(names[idx].clone());
    }
    picked
}

fn modified_of(times: &[f64]) -> Option<NativeModifiedSpread> {
    if times.is_empty() {
        return None;
    }
    let mut sorted = times.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let median = sorted[sorted.len() / 2];
    let together = sorted.iter().filter(|&&t| (t - median).abs() <= DAY_MS).count();
    let oldest = sorted[0];
    let newest = sorted[sorted.len() - 1];
    Some(NativeModifiedSpread {
        oldest_ms: oldest,
        newest_ms: newest,
        span_days: (newest - oldest) / DAY_MS,
        same_day_share: (together as f64) / (sorted.len() as f64),
    })
}

fn extensions_of(buckets: &[&RustBucket], supported: &HashSet<String>) -> Vec<NativeExtensionCount> {
    let mut totals: HashMap<&str, u64> = HashMap::new();
    for b in buckets {
        for (ext, &cnt) in &b.extensions {
            *totals.entry(ext.as_str()).or_insert(0) += cnt;
        }
    }
    let mut out: Vec<NativeExtensionCount> = totals
        .into_iter()
        .map(|(ext, files)| NativeExtensionCount {
            extension: ext.to_string(),
            files: files as f64,
            indexed: supported.contains(ext),
        })
        .collect();
    out.sort_by(|a, b| {
        b.files
            .total_cmp(&a.files)
            .then_with(|| a.extension.cmp(&b.extension))
    });
    out
}

/// Convert a `SystemTime` to epoch ms using Node's exact formula (`sec * 1e3 + nsec / 1e6`)
/// so `mtimeMs` and `birthtimeMs` are bit-identical to `fs.Stats` (used as identity keys in the sidecar).
#[inline]
fn system_time_ms(t: std::time::SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => (d.as_secs() as f64) * 1000.0 + (d.subsec_nanos() as f64) / 1e6,
        Err(e) => {
            let d = e.duration();
            -((d.as_secs() as f64) * 1000.0 + (d.subsec_nanos() as f64) / 1e6)
        }
    }
}

fn mtime_ms(meta: &fs::Metadata) -> Option<f64> {
    meta.modified().ok().map(system_time_ms)
}

pub struct MeasureFolderTask {
    folder: String,
    supported: HashSet<String>,
    skip: HashSet<String>,
    max_bytes: u64,
    max_entries: u64,
    sample_cap: usize,
    shared: Arc<WalkShared>,
}

impl Task for MeasureFolderTask {
    type Output = NativeFolderStats;
    type JsValue = NativeFolderStats;

    fn compute(&mut self) -> Result<Self::Output> {
        let supported = &self.supported;
        let skip = &self.skip;
        let sample_cap = self.sample_cap;
        let mut own = RustBucket::new();
        let mut child_names: Vec<String> = Vec::new();
        let mut child_buckets: Vec<RustBucket> = Vec::new();
        let mut scanned: u64 = 0;
        let mut truncated = false;

        struct QueueItem {
            dir: std::path::PathBuf,
            child_idx: Option<usize>,
            part: Option<String>,
            depth: usize,
        }

        let mut queue: VecDeque<QueueItem> = VecDeque::new();
        queue.push_back(QueueItem {
            dir: std::path::PathBuf::from(&self.folder),
            child_idx: None,
            part: None,
            depth: 0,
        });

        while let Some(item) = queue.pop_front() {
            if self.shared.cancelled.load(Ordering::Relaxed) {
                truncated = true;
                break;
            }
            let Ok(rd) = fs::read_dir(&item.dir) else {
                continue;
            };
            for entry_res in rd {
                if self.shared.cancelled.load(Ordering::Relaxed) || scanned >= self.max_entries {
                    truncated = true;
                    break;
                }
                let Ok(entry) = entry_res else {
                    continue;
                };
                scanned += 1;
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                let os_name = entry.file_name();
                let Some(name) = os_name.to_str() else {
                    continue;
                };
                if ft.is_dir() {
                    if name.starts_with('.') || skip.contains(&name.to_lowercase()) {
                        continue;
                    }
                    let next_child_idx = if item.child_idx.is_none() {
                        let idx = child_buckets.len();
                        child_names.push(name.to_string());
                        child_buckets.push(RustBucket::new());
                        Some(idx)
                    } else {
                        item.child_idx
                    };
                    let next_part = if item.depth == 1 {
                        Some(name.to_string())
                    } else {
                        item.part.clone()
                    };
                    queue.push_back(QueueItem {
                        dir: entry.path(),
                        child_idx: next_child_idx,
                        part: next_part,
                        depth: item.depth + 1,
                    });
                    continue;
                }
                if !ft.is_file() {
                    continue;
                }
                let ext = lower_extname(name);
                let label = if ext.is_empty() {
                    "(none)".to_string()
                } else {
                    ext.clone()
                };
                let bucket = match item.child_idx {
                    Some(idx) => &mut child_buckets[idx],
                    None => &mut own,
                };
                bucket.total_files += 1;
                *bucket.extensions.entry(label).or_insert(0) += 1;
                bucket.names.push(name.to_string());
                if let Some(ref p) = item.part {
                    *bucket.below.entry(p.clone()).or_insert(0) += 1;
                }
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let size = meta.len();
                if let Some(ms) = mtime_ms(&meta) {
                    bucket.times.push(ms);
                }
                if !supported.contains(&ext) || size > self.max_bytes {
                    continue;
                }
                bucket.indexed_files += 1;
                bucket.indexed_bytes += size;
            }
            if truncated && scanned >= self.max_entries {
                break;
            }
        }

        let mut all_refs: Vec<&RustBucket> = Vec::with_capacity(1 + child_buckets.len());
        all_refs.push(&own);
        for cb in &child_buckets {
            all_refs.push(cb);
        }

        let mut children: Vec<NativeChildStats> = child_names
            .iter()
            .zip(child_buckets.iter())
            .map(|(name, bucket)| {
                let mut subfolders: Vec<NativeSubfolder> = bucket
                    .below
                    .iter()
                    .map(|(fname, &cnt)| NativeSubfolder {
                        name: fname.clone(),
                        total_files: cnt as f64,
                    })
                    .collect();
                subfolders.sort_by(|a, b| {
                    b.total_files
                        .total_cmp(&a.total_files)
                        .then_with(|| a.name.cmp(&b.name))
                });
                NativeChildStats {
                    name: name.clone(),
                    indexed_files: bucket.indexed_files as f64,
                    total_files: bucket.total_files as f64,
                    extensions: extensions_of(&[bucket], supported),
                    modified: modified_of(&bucket.times),
                    sample: spread_names(&bucket.names, sample_cap),
                    subfolders,
                }
            })
            .collect();
        children.sort_by(|a, b| {
            b.total_files
                .total_cmp(&a.total_files)
                .then_with(|| b.indexed_files.total_cmp(&a.indexed_files))
                .then_with(|| a.name.cmp(&b.name))
        });

        let total_indexed_files: u64 = all_refs.iter().map(|b| b.indexed_files).sum();
        let total_files: u64 = all_refs.iter().map(|b| b.total_files).sum();
        let total_indexed_bytes: u64 = all_refs.iter().map(|b| b.indexed_bytes).sum();
        let mut all_names: Vec<String> = Vec::with_capacity(all_refs.iter().map(|b| b.names.len()).sum());
        let mut all_times: Vec<f64> = Vec::with_capacity(all_refs.iter().map(|b| b.times.len()).sum());
        for b in &all_refs {
            all_names.extend(b.names.iter().cloned());
            all_times.extend(b.times.iter().copied());
        }

        Ok(NativeFolderStats {
            indexed_files: total_indexed_files as f64,
            total_files: total_files as f64,
            indexed_bytes: total_indexed_bytes as f64,
            extensions: extensions_of(&all_refs, supported),
            children,
            own_files: spread_names(&own.names, sample_cap),
            sample: spread_names(&all_names, sample_cap),
            modified: modified_of(&all_times),
            truncated,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Runs the `folder-stats.ts` survey on the libuv thread pool; never blocks the calling JS thread.
#[napi(js_name = "measureFolderNative", catch_unwind)]
pub fn measure_folder_native(
    folder: String,
    supported_extensions: Vec<String>,
    skip_dir_names: Vec<String>,
    max_source_bytes: f64,
    max_entries: f64,
    sample_size: u32,
    control: &WalkControl,
) -> AsyncTask<MeasureFolderTask> {
    AsyncTask::new(MeasureFolderTask {
        folder,
        supported: supported_extensions.into_iter().collect(),
        skip: skip_dir_names.into_iter().collect(),
        max_bytes: max_source_bytes.max(0.0) as u64,
        max_entries: max_entries.max(0.0) as u64,
        sample_cap: sample_size as usize,
        shared: Arc::clone(&control.inner),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Native Fast Directory Listing (`fs-service.ts` listDir)
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct NativeDirEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub ext: String,
    pub size: Either<f64, Null>,
    pub mtime_ms: f64,
    pub birthtime_ms: Option<f64>,
    pub flags: u32,
}

#[inline]
fn extension_without_dot(name: &str) -> String {
    let bytes = name.as_bytes();
    for i in (0..bytes.len()).rev() {
        if bytes[i] == b'.' {
            return if i > 0 {
                name[i + 1..].to_lowercase()
            } else {
                String::new()
            };
        }
    }
    String::new()
}

#[inline]
fn is_package_directory(name: &str, is_dir: bool, is_darwin: bool, ext: &str) -> bool {
    if !is_dir {
        return false;
    }
    if is_darwin && name.len() > 4 && ext == "app" {
        return true;
    }
    matches!(ext, "rtfd" | "iconset" | "pvt" | "lpdf" | "prefpane")
}

#[napi(object)]
pub struct NativeDirListing {
    pub entries: Vec<NativeDirEntry>,
    /// True when any entry could not be read or named in UTF-8. The caller then lists the folder
    /// with the JavaScript path instead, so every skipped entry keeps its verbatim `fs:listDir skipping` warning.
    pub had_skips: bool,
}

#[napi(js_name = "listDirNative", catch_unwind)]
pub fn list_dir_native(dir_path: String, platform: String) -> Result<NativeDirListing> {
    let is_darwin = platform == "darwin";
    let dir = Path::new(&dir_path);
    let rd = fs::read_dir(dir).map_err(|e| Error::from_reason(e.to_string()))?;
    let mut entries: Vec<NativeDirEntry> = Vec::with_capacity(128);
    let mut had_skips = false;

    for item in rd {
        let Ok(dirent) = item else {
            had_skips = true;
            continue;
        };
        let os_name = dirent.file_name();
        let Some(name) = os_name.to_str() else {
            had_skips = true;
            continue;
        };
        let full_path = dirent.path();
        let Some(full_str) = full_path.to_str() else {
            had_skips = true;
            continue;
        };
        // On Windows `DirEntry::metadata` reuses the directory read (no CreateFileW per entry); on POSIX it is `lstat`.
        let Ok(link_meta) = dirent.metadata() else {
            had_skips = true;
            continue;
        };
        let is_symlink = link_meta.file_type().is_symlink();
        let effective = if is_symlink {
            match fs::metadata(&full_path) {
                Ok(m) => m,
                // A broken link keeps the link's own metadata, exactly as `buildFsEntry` does for ENOENT.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => link_meta,
                Err(_) => {
                    had_skips = true;
                    continue;
                }
            }
        } else {
            link_meta
        };
        let is_dir = effective.is_dir();
        let ext_raw = extension_without_dot(name);
        let is_pkg = is_package_directory(name, is_dir, is_darwin, &ext_raw);
        let is_folder = is_dir && !is_pkg;

        let mtime = mtime_ms(&effective).unwrap_or(0.0);
        let birthtime = effective
            .created()
            .ok()
            .map(system_time_ms)
            .filter(|&ms| ms > 0.0);

        entries.push(NativeDirEntry {
            name: name.to_string(),
            path: full_str.to_string(),
            kind: if is_folder { "folder".to_string() } else { "file".to_string() },
            ext: if is_folder { String::new() } else { ext_raw },
            size: if is_dir { Either::B(Null) } else { Either::A(effective.len() as f64) },
            mtime_ms: mtime,
            birthtime_ms: birthtime,
            flags: if is_symlink { 1 } else { 0 },
        });
    }

    Ok(NativeDirListing { entries, had_skips })
}
