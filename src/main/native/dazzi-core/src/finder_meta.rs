//! Native Finder metadata, Finder tags (xattr + binary plist), and Windows file-kind
//! registry lookups for `dazzi-native-core`.
//!
//! Eliminates the N+1 child-process spawn storms in:
//! - `src/main/finder-metadata.ts` (previously spawned `/usr/bin/xattr` x2 + `/usr/bin/plutil` x2 per file)
//! - `src/main/finder-tags.ts` (previously spawned `/usr/bin/xattr` + `/usr/bin/plutil` x2 on every tag read/write)
//! - `src/main/file-kind.ts` (previously spawned `powershell.exe` on Windows to read `HKCR` ProgIDs)

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::io::Cursor;

#[cfg(target_os = "macos")]
const TAGS_XATTR: &str = "com.apple.metadata:_kMDItemUserTags";
#[cfg(target_os = "macos")]
const COMMENT_XATTR: &str = "com.apple.metadata:kMDItemFinderComment";

// ─────────────────────────────────────────────────────────────────────────────
// 1. macOS Finder Xattrs + Binary Plist Decoding (Tags & Comments)
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct NativeFinderXattrs {
    /// Decoded `com.apple.metadata:_kMDItemUserTags` array (raw stored strings, e.g. `"Urgent\n6"`),
    /// or `null` if the xattr is absent or unreadable.
    pub tags: Option<Vec<String>>,
    /// Decoded `com.apple.metadata:kMDItemFinderComment` scalar string (or first array string),
    /// or `null` if absent or unreadable.
    pub comment: Option<String>,
    /// Non-null when `com.apple.metadata:_kMDItemUserTags` existed on disk but failed to decode as a plist.
    pub tags_error: Option<String>,
    /// Non-null when `com.apple.metadata:kMDItemFinderComment` existed on disk but failed to decode as a plist.
    pub comment_error: Option<String>,
}

/// Extract strings from a binary or XML property list matching `finder-metadata.ts` `xmlStringValues`:
/// - A top-level `<array>` of `<string>` returns `Ok(Vec<String>)` (empty array -> `Ok(vec![])`)
/// - A top-level `<string>` scalar returns `Ok(vec![s])`
/// - Any other plist value returns `Ok(None)` (unrecognized shape).
fn decode_plist_string_values(bytes: &[u8]) -> std::result::Result<Option<Vec<String>>, String> {
    if bytes.is_empty() {
        return Ok(None);
    }
    let val = plist::Value::from_reader(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    match val {
        plist::Value::String(s) => Ok(Some(vec![s])),
        plist::Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                if let plist::Value::String(s) = item {
                    out.push(s);
                }
            }
            Ok(Some(out))
        }
        _ => Ok(None),
    }
}

/// Decode a stored Finder tags xattr strictly: requires a plist array where EVERY element is a string.
/// Matches `finder-tags.ts` `readStored` contract (refuses to overwrite non-string-array values).
#[cfg(target_os = "macos")]
fn decode_strict_tag_array(bytes: &[u8]) -> std::result::Result<Vec<String>, String> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let val = plist::Value::from_reader(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    match val {
        plist::Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    plist::Value::String(s) => out.push(s),
                    _ => return Err("unreadable tag plist: non-string entry".to_string()),
                }
            }
            Ok(out)
        }
        _ => Err("unreadable tag plist: expected array".to_string()),
    }
}

/// Encode a slice of stored Finder tag strings into Apple binary plist (`bplist00`) bytes,
/// identical to `plutil -convert binary1`.
fn encode_binary_plist_strings(tags: &[String]) -> std::result::Result<Vec<u8>, String> {
    let array = plist::Value::Array(tags.iter().cloned().map(plist::Value::String).collect());
    let mut out = Vec::new();
    array.to_writer_binary(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(target_os = "macos")]
fn read_xattr_bytes(path: &str, name: &str) -> std::result::Result<Option<Vec<u8>>, String> {
    match xattr::get(path, name) {
        Ok(opt) => Ok(opt),
        Err(e) => {
            // ENOATTR (93 on macOS) or ENODATA means the attribute simply isn't present.
            if matches!(e.raw_os_error(), Some(93) | Some(61)) {
                Ok(None)
            } else {
                Err(e.to_string())
            }
        }
    }
}

/// Read and decode both `com.apple.metadata:_kMDItemUserTags` and
/// `com.apple.metadata:kMDItemFinderComment` in-process via `getxattr(2)` + `plist`.
/// Replaces 4 child-process spawns (`xattr` x2 + `plutil` x2) per file on macOS.
#[napi(js_name = "readFinderXattrsNative", catch_unwind)]
pub fn read_finder_xattrs_native(path: String) -> NativeFinderXattrs {
    #[cfg(target_os = "macos")]
    {
        let mut out = NativeFinderXattrs {
            tags: None,
            comment: None,
            tags_error: None,
            comment_error: None,
        };
        match read_xattr_bytes(&path, TAGS_XATTR) {
            Ok(Some(bytes)) => match decode_plist_string_values(&bytes) {
                Ok(Some(vals)) => out.tags = Some(vals),
                Ok(None) => {}
                Err(e) => out.tags_error = Some(e),
            },
            Ok(None) => {}
            Err(e) => out.tags_error = Some(e),
        }
        match read_xattr_bytes(&path, COMMENT_XATTR) {
            Ok(Some(bytes)) => match decode_plist_string_values(&bytes) {
                Ok(Some(vals)) => {
                    // Match `finder-metadata.ts`: empty string becomes null, else first string.
                    if let Some(first) = vals.into_iter().next() {
                        if !first.is_empty() {
                            out.comment = Some(first);
                        }
                    }
                }
                Ok(None) => {}
                Err(e) => out.comment_error = Some(e),
            },
            Ok(None) => {}
            Err(e) => out.comment_error = Some(e),
        }
        out
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        NativeFinderXattrs {
            tags: None,
            comment: None,
            tags_error: None,
            comment_error: None,
        }
    }
}

/// Read stored Finder tags array (`com.apple.metadata:_kMDItemUserTags`) directly via `getxattr(2)`.
/// Returns `[]` when the attribute is absent; throws on missing file, permission error, or non-string-array plist.
#[napi(js_name = "readFinderTagsNative", catch_unwind)]
pub fn read_finder_tags_native(path: String) -> Result<Vec<String>> {
    #[cfg(target_os = "macos")]
    {
        match read_xattr_bytes(&path, TAGS_XATTR) {
            Ok(Some(bytes)) => decode_strict_tag_array(&bytes).map_err(Error::from_reason),
            Ok(None) => Ok(Vec::new()),
            Err(e) => Err(Error::from_reason(e)),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err(Error::from_reason("Finder tags are only available on macOS"))
    }
}

/// Write (or remove when empty) `com.apple.metadata:_kMDItemUserTags` as an Apple binary plist (`bplist00`)
/// directly via `setxattr(2)` / `removexattr(2)` — zero `plutil` or `xattr` spawns.
#[napi(js_name = "writeFinderTagsNative", catch_unwind)]
pub fn write_finder_tags_native(path: String, stored: Vec<String>) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        if stored.is_empty() {
            match xattr::remove(&path, TAGS_XATTR) {
                Ok(()) => Ok(()),
                Err(e) if matches!(e.raw_os_error(), Some(93) | Some(61)) => Ok(()),
                Err(e) => Err(Error::from_reason(e.to_string())),
            }
        } else {
            let bplist = encode_binary_plist_strings(&stored).map_err(Error::from_reason)?;
            xattr::set(&path, TAGS_XATTR, &bplist).map_err(|e| Error::from_reason(e.to_string()))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, stored);
        Err(Error::from_reason("Finder tags are only available on macOS"))
    }
}

/// Decode arbitrary binary or XML plist bytes (e.g. Finder's iCloud KVS `FinderTagDict` blob) into JSON.
/// Replaces `plutil -convert json` subprocess spawns.
#[napi(js_name = "decodePlistToJsonNative", catch_unwind)]
pub fn decode_plist_to_json_native(bytes: Uint8Array) -> Result<String> {
    let val = plist::Value::from_reader(Cursor::new(bytes.as_ref()))
        .map_err(|e| Error::from_reason(e.to_string()))?;
    let json = plist_value_to_json(val);
    serde_json::to_string(&json).map_err(|e| Error::from_reason(e.to_string()))
}

fn plist_value_to_json(val: plist::Value) -> serde_json::Value {
    match val {
        plist::Value::Array(items) => {
            serde_json::Value::Array(items.into_iter().map(plist_value_to_json).collect())
        }
        plist::Value::Dictionary(dict) => {
            let mut map = serde_json::Map::with_capacity(dict.len());
            for (k, v) in dict {
                map.insert(k, plist_value_to_json(v));
            }
            serde_json::Value::Object(map)
        }
        plist::Value::Boolean(b) => serde_json::Value::Bool(b),
        plist::Value::Data(bytes) => {
            serde_json::Value::Array(bytes.into_iter().map(|b| serde_json::Value::from(b)).collect())
        }
        plist::Value::Date(d) => serde_json::Value::String(d.to_xml_format()),
        plist::Value::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        plist::Value::Integer(i) => {
            if let Some(n) = i.as_signed() {
                serde_json::Value::from(n)
            } else if let Some(n) = i.as_unsigned() {
                serde_json::Value::from(n)
            } else {
                serde_json::Value::Null
            }
        }
        plist::Value::String(s) => serde_json::Value::String(s),
        plist::Value::Uid(u) => serde_json::Value::from(u.get()),
        _ => serde_json::Value::Null,
    }
}

/// Encode a string array as binary plist (`bplist00`) bytes — exposed for cross-platform parity testing.
#[napi(js_name = "encodeBinaryPlistStringsNative", catch_unwind)]
pub fn encode_binary_plist_strings_native(values: Vec<String>) -> Result<Buffer> {
    let bytes = encode_binary_plist_strings(&values).map_err(Error::from_reason)?;
    Ok(Buffer::from(bytes))
}

/// Decode binary/XML plist string(s) — exposed for cross-platform parity testing.
#[napi(js_name = "decodePlistStringsNative", catch_unwind)]
pub fn decode_plist_strings_native(bytes: Uint8Array) -> Result<Option<Vec<String>>> {
    decode_plist_string_values(bytes.as_ref()).map_err(Error::from_reason)
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Windows File Kind Direct Registry Lookup (`HKEY_CLASSES_ROOT`)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn read_hkcr_default_string(subkey: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CLASSES_ROOT, KEY_READ,
        REG_EXPAND_SZ, REG_SZ,
    };

    let wide_subkey: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let mut hkey: HKEY = std::ptr::null_mut();
    let open_rc = unsafe {
        RegOpenKeyExW(
            HKEY_CLASSES_ROOT,
            wide_subkey.as_ptr(),
            0,
            KEY_READ,
            &mut hkey,
        )
    };
    if open_rc != ERROR_SUCCESS {
        return None;
    }

    let mut value_type: u32 = 0;
    let mut byte_len: u32 = 0;
    let size_rc = unsafe {
        RegQueryValueExW(
            hkey,
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut byte_len,
        )
    };
    if size_rc != ERROR_SUCCESS || byte_len == 0 || (value_type != REG_SZ && value_type != REG_EXPAND_SZ) {
        unsafe { RegCloseKey(hkey) };
        return None;
    }

    // Cap single registry string at 64 KiB so corrupt keys never allocate excessively.
    if byte_len > 65536 {
        unsafe { RegCloseKey(hkey) };
        return None;
    }

    let mut buf = vec![0u16; (byte_len as usize + 1) / 2];
    let mut actual_len = (buf.len() * 2) as u32;
    let read_rc = unsafe {
        RegQueryValueExW(
            hkey,
            std::ptr::null(),
            std::ptr::null_mut(),
            &mut value_type,
            buf.as_mut_ptr() as *mut u8,
            &mut actual_len,
        )
    };
    unsafe { RegCloseKey(hkey) };
    if read_rc != ERROR_SUCCESS {
        return None;
    }

    let u16_len = (actual_len as usize / 2).min(buf.len());
    let slice = &buf[..u16_len];
    let trimmed_end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
    let text = String::from_utf16_lossy(&slice[..trimmed_end]);
    let normalized = text
        .replace("\r\n", " ")
        .replace('\r', " ")
        .replace('\n', " ");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Resolve Windows Explorer Type names for a batch of dotted extensions (e.g. `[".pdf", ".docx"]`)
/// directly via `RegOpenKeyExW` / `RegQueryValueExW` on `HKEY_CLASSES_ROOT`.
/// Replaces spawning `powershell.exe` (300–400 ms per batch) with ~0.1 ms in-process Win32 calls.
/// Returns `null` on non-Windows platforms.
#[napi(js_name = "lookupWindowsFileKindsNative", catch_unwind)]
pub fn lookup_windows_file_kinds_native(extensions: Vec<String>) -> Option<Vec<Option<String>>> {
    #[cfg(target_os = "windows")]
    {
        let mut results = Vec::with_capacity(extensions.len());
        for ext in extensions {
            if ext.is_empty() {
                results.push(None);
                continue;
            }
            let kind = read_hkcr_default_string(&ext)
                .and_then(|prog_id| read_hkcr_default_string(&prog_id));
            results.push(kind);
        }
        Some(results)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = extensions;
        None
    }
}
