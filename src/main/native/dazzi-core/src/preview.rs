//! Preview acceleration module for `dazzi-native-core` (Tier 1 hot paths).
//!
//! 1. `previewSheetNative`: Streaming XLSX/XLSM + CSV/TSV reader (stops after `maxScanRows`,
//!    never decodes 30MB CSVs or 80k unused sharedStrings, runs on libuv thread pool).
//! 2. `downscaleAndEncodePngNative`: Box-average downscale + fast PNG encoding for PSD/TIFF
//!    RGBA buffers (identical integer bounds to `psd-preview.ts` / `png-encode.ts`).
//! 3. `decodeTiffPreviewNative`: Native TIFF decode + box downscale + PNG encode on libuv
//!    thread pool (eliminates macOS `sips` spawn latency & unlocks >8MB TIFF previews on Windows).
//! 4. `findPdfAnchorPagesNative`: Fast Rust PDF page-candidate locator (`lopdf`) that narrows
//!    hundreds of pages down to a handful of candidate 1-based page numbers for `pdf.js`
//!    so AI Search anchor highlighting avoids calling `getTextContent()` on all 900+ pages.
//! 5. `listArchiveNative`: Streaming TAR / TAR.GZ / ZIP top-level listing on libuv thread pool
//!    with NFC/CP949 filename decoding and entry/output caps (prevents libarchive-wasm OOM traps).

use encoding_rs::{EUC_KR, UTF_16BE, UTF_16LE};
use flate2::read::GzDecoder;
use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Cursor, Read};
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Streaming Spreadsheet Preview (XLSX/XLSM + CSV/TSV)
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct NativeSheetPreview {
    pub names: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub sheets_read: Vec<String>,
    pub scanned_rows: f64,
    pub names_pass: bool,
    /// True when the native streaming reader handled this file cleanly; false signals
    /// the caller to fall back to SheetJS (e.g. XLS BIFF, XLSB, ODS, encrypted, formula-heavy).
    pub handled: bool,
}

fn col_index_from_ref(cell_ref: &str) -> Option<usize> {
    let mut col: usize = 0;
    let mut seen = false;
    for b in cell_ref.bytes() {
        if b.is_ascii_alphabetic() {
            seen = true;
            col = col * 26 + ((b.to_ascii_uppercase() - b'A') as usize + 1);
        } else {
            break;
        }
    }
    if seen && col > 0 {
        Some(col - 1)
    } else {
        None
    }
}

fn resolve_zip_target(target: &str) -> String {
    let clean = target.trim_start_matches('/');
    if clean.starts_with("xl/") {
        clean.to_string()
    } else if let Some(rest) = clean.strip_prefix("../") {
        rest.to_string()
    } else {
        format!("xl/{clean}")
    }
}

fn parse_xlsx_streaming(
    path: &str,
    sheet_index: usize,
    max_scan_rows: usize,
    max_rows: usize,
    max_cols: usize,
) -> std::result::Result<Option<NativeSheetPreview>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut archive = match zip::ZipArchive::new(BufReader::new(file)) {
        Ok(a) => a,
        Err(_) => return Ok(None),
    };

    // 1. Parse xl/workbook.xml to collect sheet names & r:id mappings in order.
    let mut sheets: Vec<(String, String)> = Vec::new();
    {
        let wb_file = match archive.by_name("xl/workbook.xml") {
            Ok(f) => f,
            Err(_) => return Ok(None), // e.g. ODS or non-OOXML zip -> let SheetJS handle
        };
        let mut reader = Reader::from_reader(BufReader::new(wb_file));
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) if e.local_name().as_ref() == b"sheet" => {
                    let mut name = String::new();
                    let mut rid = String::new();
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"name" => {
                                name = attr.unescape_value().unwrap_or_default().into_owned();
                            }
                            k if k == b"r:id" || k.ends_with(b":id") => {
                                rid = attr.unescape_value().unwrap_or_default().into_owned();
                            }
                            _ => {}
                        }
                    }
                    if !name.is_empty() {
                        sheets.push((name, rid));
                    }
                }
                Ok(Event::Eof) => break,
                Err(_) => return Ok(None),
                _ => {}
            }
            buf.clear();
        }
    }

    if sheets.is_empty() {
        return Ok(Some(NativeSheetPreview {
            names: Vec::new(),
            rows: Vec::new(),
            sheets_read: Vec::new(),
            scanned_rows: 0.0,
            names_pass: true,
            handled: true,
        }));
    }

    // 2. Parse xl/_rels/workbook.xml.rels to map r:id -> worksheet path and locate sharedStrings.xml.
    let mut rels: HashMap<String, String> = HashMap::new();
    let mut sst_path: Option<String> = None;
    if let Ok(rels_file) = archive.by_name("xl/_rels/workbook.xml.rels") {
        let mut reader = Reader::from_reader(BufReader::new(rels_file));
        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(ref e)) | Ok(Event::Empty(ref e)) if e.local_name().as_ref() == b"Relationship" => {
                    let mut id = String::new();
                    let mut target = String::new();
                    let mut rel_type = String::new();
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"Id" => id = attr.unescape_value().unwrap_or_default().into_owned(),
                            b"Target" => target = attr.unescape_value().unwrap_or_default().into_owned(),
                            b"Type" => rel_type = attr.unescape_value().unwrap_or_default().into_owned(),
                            _ => {}
                        }
                    }
                    if !id.is_empty() && !target.is_empty() {
                        let resolved = resolve_zip_target(&target);
                        if rel_type.ends_with("/sharedStrings") {
                            sst_path = Some(resolved.clone());
                        }
                        rels.insert(id, resolved);
                    }
                }
                Ok(Event::Eof) => break,
                Err(_) => break,
                _ => {}
            }
            buf.clear();
        }
    }

    let names: Vec<String> = sheets.iter().map(|(n, _)| n.clone()).collect();
    let chosen_idx = if sheet_index < sheets.len() { sheet_index } else { 0 };
    let (chosen_name, chosen_rid) = &sheets[chosen_idx];
    let sheet_zip_path = rels
        .get(chosen_rid)
        .cloned()
        .unwrap_or_else(|| format!("xl/worksheets/sheet{}.xml", chosen_idx + 1));

    // Check if the chosen sheet exists; if not, fall back to SheetJS.
    if archive.by_name(&sheet_zip_path).is_err() {
        return Ok(None);
    }

    // 3. Stream the chosen worksheet XML — stop immediately after `max_scan_rows` rows
    // or once we already collected `max_rows` non-blank rows.
    enum CellVal {
        Plain(String),
        Shared(usize),
    }

    let mut raw_rows: Vec<Vec<(usize, CellVal)>> = Vec::with_capacity(max_rows);
    let mut needed_sst: HashSet<usize> = HashSet::new();
    let mut scanned_rows: usize = 0;

    {
        let sheet_file = archive.by_name(&sheet_zip_path).map_err(|e| e.to_string())?;
        let mut reader = Reader::from_reader(BufReader::new(sheet_file));
        let mut buf = Vec::new();
        let mut in_row = false;
        let mut current_row: Vec<(usize, CellVal)> = Vec::new();
        let mut cell_type = 0u8; // 0=num/str, 1=shared('s'), 2=bool('b'), 3=inlineStr
        let mut cell_col: usize = 0;
        let mut next_auto_col: usize = 0;
        let mut in_v = false;
        let mut in_is = false;
        let mut in_t = false;
        let mut acc = String::new();
        let mut has_value = false;
        let mut has_styled_dates = false;

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(ref e)) => match e.local_name().as_ref() {
                    b"row" => {
                        let mut explicit_row: Option<usize> = None;
                        for attr in e.attributes().flatten() {
                            if attr.key.as_ref() == b"r" {
                                if let Ok(v) = attr.unescape_value() {
                                    explicit_row = v.parse::<usize>().ok();
                                }
                            }
                        }
                        let row_num = explicit_row.unwrap_or(scanned_rows + 1);
                        if row_num > max_scan_rows || raw_rows.len() >= max_rows {
                            break;
                        }
                        scanned_rows = row_num;
                        in_row = true;
                        current_row.clear();
                        next_auto_col = 0;
                    }
                    b"c" if in_row => {
                        cell_type = 0;
                        cell_col = next_auto_col;
                        acc.clear();
                        has_value = false;
                        for attr in e.attributes().flatten() {
                            match attr.key.as_ref() {
                                b"r" => {
                                    if let Ok(v) = attr.unescape_value() {
                                        if let Some(c) = col_index_from_ref(&v) {
                                            cell_col = c;
                                        }
                                    }
                                }
                                b"t" => match attr.value.as_ref() {
                                    b"s" => cell_type = 1,
                                    b"b" => cell_type = 2,
                                    b"inlineStr" => cell_type = 3,
                                    b"str" | b"e" => cell_type = 0,
                                    _ => {}
                                },
                                b"s" => {
                                    // If a cell has a non-zero style index AND is numeric, we don't know if
                                    // it's a date/currency format without reading styles.xml. Only flag if
                                    // the style table might format dates (styles.xml present).
                                    if attr.value.as_ref() != b"0" {
                                        has_styled_dates = true;
                                    }
                                }
                                _ => {}
                            }
                        }
                        next_auto_col = cell_col + 1;
                    }
                    b"v" if in_row && cell_col < max_cols => {
                        in_v = true;
                    }
                    b"is" if in_row && cell_col < max_cols => {
                        in_is = true;
                    }
                    b"t" if in_row && in_is && cell_col < max_cols => {
                        in_t = true;
                    }
                    _ => {}
                },
                Ok(Event::Text(ref e)) if in_v || in_t => {
                    if let Ok(text) = e.unescape() {
                        acc.push_str(&text);
                        has_value = true;
                    }
                }
                Ok(Event::CData(ref e)) if in_v || in_t => {
                    if let Ok(text) = std::str::from_utf8(e.as_ref()) {
                        acc.push_str(text);
                        has_value = true;
                    }
                }
                Ok(Event::End(ref e)) => match e.local_name().as_ref() {
                    b"v" => in_v = false,
                    b"t" => in_t = false,
                    b"is" => in_is = false,
                    b"c" if in_row => {
                        if has_value && cell_col < max_cols {
                            match cell_type {
                                1 => {
                                    if let Ok(idx) = acc.trim().parse::<usize>() {
                                        needed_sst.insert(idx);
                                        current_row.push((cell_col, CellVal::Shared(idx)));
                                    }
                                }
                                2 => {
                                    let val = if acc.trim() == "1" { "TRUE" } else { "FALSE" };
                                    current_row.push((cell_col, CellVal::Plain(val.to_string())));
                                }
                                _ => {
                                    current_row.push((cell_col, CellVal::Plain(acc.clone())));
                                }
                            }
                        }
                        acc.clear();
                        has_value = false;
                    }
                    b"row" if in_row => {
                        in_row = false;
                        if !current_row.is_empty() {
                            raw_rows.push(std::mem::take(&mut current_row));
                        }
                    }
                    _ => {}
                },
                Ok(Event::Eof) => break,
                Err(_) => return Ok(None),
                _ => {}
            }
            buf.clear();
        }
        let _ = has_styled_dates;
    }

    // 4. Stream sharedStrings.xml ONLY for referenced indices (stop once `max_needed` is passed).
    let mut sst_map: HashMap<usize, String> = HashMap::with_capacity(needed_sst.len());
    if !needed_sst.is_empty() {
        let max_needed = *needed_sst.iter().max().unwrap_or(&0);
        let sst_name = sst_path.unwrap_or_else(|| "xl/sharedStrings.xml".to_string());
        if let Ok(sst_file) = archive.by_name(&sst_name) {
            let mut reader = Reader::from_reader(BufReader::new(sst_file));
            let mut buf = Vec::new();
            let mut idx: usize = 0;
            let mut in_si = false;
            let mut capture = false;
            let mut in_t = false;
            let mut in_rph = false;
            let mut acc = String::new();
            loop {
                match reader.read_event_into(&mut buf) {
                    Ok(Event::Start(ref e)) => match e.local_name().as_ref() {
                        b"si" => {
                            if idx > max_needed {
                                break;
                            }
                            in_si = true;
                            capture = needed_sst.contains(&idx);
                            if capture {
                                acc.clear();
                            }
                        }
                        b"rPh" if in_si => in_rph = true,
                        b"t" if in_si && capture && !in_rph => in_t = true,
                        _ => {}
                    },
                    Ok(Event::Text(ref e)) if in_t => {
                        if let Ok(text) = e.unescape() {
                            acc.push_str(&text);
                        }
                    }
                    Ok(Event::CData(ref e)) if in_t => {
                        if let Ok(text) = std::str::from_utf8(e.as_ref()) {
                            acc.push_str(text);
                        }
                    }
                    Ok(Event::End(ref e)) => match e.local_name().as_ref() {
                        b"t" => in_t = false,
                        b"rPh" => in_rph = false,
                        b"si" => {
                            if capture {
                                sst_map.insert(idx, std::mem::take(&mut acc));
                            }
                            idx += 1;
                            in_si = false;
                            capture = false;
                        }
                        _ => {}
                    },
                    Ok(Event::Eof) => break,
                    Err(_) => return Ok(None),
                    _ => {}
                }
                buf.clear();
            }
        }
    }

    // 5. Materialize dense grid rows (padded with "" up to row's max col, capped at max_cols).
    let mut rows: Vec<Vec<String>> = Vec::with_capacity(raw_rows.len());
    for row_cells in raw_rows {
        let width = row_cells
            .iter()
            .map(|(c, _)| *c + 1)
            .max()
            .unwrap_or(0)
            .min(max_cols);
        if width == 0 {
            continue;
        }
        let mut dense = vec![String::new(); width];
        let mut any_non_empty = false;
        for (col, val) in row_cells {
            if col >= width {
                continue;
            }
            let text = match val {
                CellVal::Plain(s) => s,
                CellVal::Shared(i) => sst_map.get(&i).cloned().unwrap_or_default(),
            };
            if !text.is_empty() {
                any_non_empty = true;
            }
            dense[col] = text;
        }
        if any_non_empty {
            rows.push(dense);
        }
    }

    Ok(Some(NativeSheetPreview {
        names,
        rows,
        sheets_read: vec![chosen_name.clone()],
        scanned_rows: scanned_rows as f64,
        names_pass: true,
        handled: true,
    }))
}

fn decode_text_prefix(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = UTF_16LE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = UTF_16BE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (cow, _, _) = EUC_KR.decode(bytes);
            cow.into_owned()
        }
    }
}

/// RFC 4180 streaming CSV/TSV parser that reads at most `max_scan_rows` rows and returns
/// up to `max_rows` non-blank rows × `max_cols` columns.
fn parse_delimited_streaming(
    path: &str,
    force_tab: bool,
    max_scan_rows: usize,
    max_rows: usize,
    max_cols: usize,
) -> std::result::Result<NativeSheetPreview, String> {
    // Read at most 4 MiB from the head of the file — more than enough for 1,000 rows while
    // never touching the remaining 30+ MiB of a huge CSV.
    const CSV_HEAD_CAP: usize = 4 * 1024 * 1024;
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CSV_HEAD_CAP];
    let mut n = 0usize;
    while n < CSV_HEAD_CAP {
        let k = file.read(&mut buf[n..]).map_err(|e| e.to_string())?;
        if k == 0 {
            break;
        }
        n += k;
    }
    buf.truncate(n);

    // Trim at a safe newline boundary after `max_scan_rows` lines so we decode only what we scan
    // (only safe on single-byte / UTF-8 encodings, not UTF-16).
    let is_utf16 = buf.starts_with(&[0xFF, 0xFE]) || buf.starts_with(&[0xFE, 0xFF]);
    if !is_utf16 {
        let mut lines = 0usize;
        let mut cut = buf.len();
        let mut in_quotes = false;
        for (i, &b) in buf.iter().enumerate() {
            if b == b'"' {
                in_quotes = !in_quotes;
            } else if b == b'\n' && !in_quotes {
                lines += 1;
                if lines >= max_scan_rows {
                    cut = i + 1;
                    break;
                }
            }
        }
        buf.truncate(cut);
    }

    let text = decode_text_prefix(&buf);
    let delimiter: char = if force_tab {
        '\t'
    } else {
        // Auto-detect tab vs comma on the first line (matching SheetJS behavior).
        let first_line = text.lines().next().unwrap_or("");
        let tabs = first_line.chars().filter(|&c| c == '\t').count();
        let commas = first_line.chars().filter(|&c| c == ',').count();
        if tabs > commas { '\t' } else { ',' }
    };

    let mut rows: Vec<Vec<String>> = Vec::with_capacity(max_rows);
    let mut scanned_rows: usize = 0;
    let mut current_row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();

    let finish_row = |row: &mut Vec<String>, out: &mut Vec<Vec<String>>, scanned: &mut usize| {
        *scanned += 1;
        let has_non_empty = row.iter().any(|c| !c.is_empty());
        if has_non_empty && out.len() < max_rows {
            out.push(std::mem::take(row));
        } else {
            row.clear();
        }
    };

    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    if current_row.len() < max_cols {
                        field.push('"');
                    }
                } else {
                    in_quotes = false;
                }
            } else if current_row.len() < max_cols {
                field.push(ch);
            }
        } else if ch == '"' && field.is_empty() {
            in_quotes = true;
        } else if ch == delimiter {
            if current_row.len() < max_cols {
                current_row.push(std::mem::take(&mut field));
            } else {
                field.clear();
            }
        } else if ch == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            if current_row.len() < max_cols {
                current_row.push(std::mem::take(&mut field));
            } else {
                field.clear();
            }
            finish_row(&mut current_row, &mut rows, &mut scanned_rows);
            if scanned_rows >= max_scan_rows || rows.len() >= max_rows {
                break;
            }
        } else if ch == '\n' {
            if current_row.len() < max_cols {
                current_row.push(std::mem::take(&mut field));
            } else {
                field.clear();
            }
            finish_row(&mut current_row, &mut rows, &mut scanned_rows);
            if scanned_rows >= max_scan_rows || rows.len() >= max_rows {
                break;
            }
        } else if current_row.len() < max_cols {
            field.push(ch);
        }
    }

    if (!field.is_empty() || !current_row.is_empty()) && scanned_rows < max_scan_rows && rows.len() < max_rows {
        if current_row.len() < max_cols {
            current_row.push(field);
        }
        finish_row(&mut current_row, &mut rows, &mut scanned_rows);
    }

    Ok(NativeSheetPreview {
        names: vec!["Sheet1".to_string()],
        rows,
        sheets_read: vec!["Sheet1".to_string()],
        scanned_rows: scanned_rows as f64,
        names_pass: false,
        handled: true,
    })
}

pub struct PreviewSheetTask {
    path: String,
    sheet_index: usize,
    max_scan_rows: usize,
    max_rows: usize,
    max_cols: usize,
}

impl Task for PreviewSheetTask {
    type Output = NativeSheetPreview;
    type JsValue = NativeSheetPreview;

    fn compute(&mut self) -> Result<Self::Output> {
        // Sniff first 4 bytes to classify ZIP (xlsx/xlsm/ods) vs OLE2 (xls) vs text (csv/tsv).
        let mut magic = [0u8; 4];
        let mut f = File::open(&self.path).map_err(|e| Error::from_reason(e.to_string()))?;
        let n = f.read(&mut magic).map_err(|e| Error::from_reason(e.to_string()))?;
        drop(f);

        if n == 0 {
            return Ok(NativeSheetPreview {
                names: vec!["Sheet1".to_string()],
                rows: Vec::new(),
                sheets_read: vec!["Sheet1".to_string()],
                scanned_rows: 0.0,
                names_pass: false,
                handled: true,
            });
        }

        // OLE2 Compound Binary (.xls) -> delegate to SheetJS
        if n >= 2 && magic[0] == 0xD0 && magic[1] == 0xCF {
            return Ok(NativeSheetPreview {
                names: Vec::new(),
                rows: Vec::new(),
                sheets_read: Vec::new(),
                scanned_rows: 0.0,
                names_pass: false,
                handled: false,
            });
        }

        // ZIP container (check for OOXML xl/workbook.xml)
        if n >= 2 && magic[0] == 0x50 && magic[1] == 0x4B {
            match parse_xlsx_streaming(&self.path, self.sheet_index, self.max_scan_rows, self.max_rows, self.max_cols) {
                Ok(Some(preview)) => return Ok(preview),
                Ok(None) | Err(_) => {
                    return Ok(NativeSheetPreview {
                        names: Vec::new(),
                        rows: Vec::new(),
                        sheets_read: Vec::new(),
                        scanned_rows: 0.0,
                        names_pass: false,
                        handled: false,
                    });
                }
            }
        }

        // Delimited text (CSV / TSV)
        let ext_lower = Path::new(&self.path)
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        let force_tab = ext_lower == "tsv";
        parse_delimited_streaming(&self.path, force_tab, self.max_scan_rows, self.max_rows, self.max_cols)
            .map_err(Error::from_reason)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Async streaming spreadsheet preview on the libuv thread pool.
#[napi(js_name = "previewSheetNative", catch_unwind)]
pub fn preview_sheet_native(
    path: String,
    sheet_index: u32,
    max_scan_rows: u32,
    max_rows: u32,
    max_cols: u32,
) -> AsyncTask<PreviewSheetTask> {
    AsyncTask::new(PreviewSheetTask {
        path,
        sheet_index: sheet_index as usize,
        max_scan_rows: (max_scan_rows as usize).max(1),
        max_rows: (max_rows as usize).max(1),
        max_cols: (max_cols as usize).max(1),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Native Box Downscale + PNG Encode (PSD & TIFF)
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn downscale_rgba_and_encode_png(
    rgba: &[u8],
    sw: usize,
    sh: usize,
    max_side: usize,
) -> std::result::Result<Vec<u8>, String> {
    if sw == 0 || sh == 0 || rgba.len() != sw * sh * 4 {
        return Err(format!("invalid RGBA buffer for {}x{} (got {} bytes)", sw, sh, rgba.len()));
    }
    let longest = sw.max(sh);
    let (dw, dh, pixels_owned): (usize, usize, Option<Vec<u8>>) = if max_side > 0 && longest > max_side {
        let dw = ((sw * max_side) / longest).max(1);
        let dh = ((sh * max_side) / longest).max(1);
        let mut out = vec![0u8; dw * dh * 4];
        for y in 0..dh {
            let top = (y * sh) / dh;
            let bot = (((y + 1) * sh) / dh).max(top + 1);
            for x in 0..dw {
                let left = (x * sw) / dw;
                let right = (((x + 1) * sw) / dw).max(left + 1);
                let mut r: u32 = 0;
                let mut g: u32 = 0;
                let mut b: u32 = 0;
                let mut a: u32 = 0;
                for sy in top..bot {
                    let row_off = sy * sw;
                    for sx in left..right {
                        let s = (row_off + sx) * 4;
                        r += rgba[s] as u32;
                        g += rgba[s + 1] as u32;
                        b += rgba[s + 2] as u32;
                        a += rgba[s + 3] as u32;
                    }
                }
                let cnt = ((bot - top) * (right - left)) as u32;
                let half = cnt / 2;
                let t = (y * dw + x) * 4;
                out[t] = ((r + half) / cnt) as u8;
                out[t + 1] = ((g + half) / cnt) as u8;
                out[t + 2] = ((b + half) / cnt) as u8;
                out[t + 3] = ((a + half) / cnt) as u8;
            }
        }
        (dw, dh, Some(out))
    } else {
        (sw, sh, None)
    };

    let src = pixels_owned.as_deref().unwrap_or(rgba);
    let mut png_buf = Vec::with_capacity((dw * dh).min(4 * 1024 * 1024));
    {
        let mut encoder = png::Encoder::new(&mut png_buf, dw as u32, dh as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        encoder.set_filter(png::FilterType::NoFilter);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(src).map_err(|e| e.to_string())?;
    }
    Ok(png_buf)
}

#[napi(js_name = "downscaleAndEncodePngNative", catch_unwind)]
pub fn downscale_and_encode_png_native(
    rgba: Uint8Array,
    width: u32,
    height: u32,
    max_side: u32,
) -> Result<Buffer> {
    let png = downscale_rgba_and_encode_png(rgba.as_ref(), width as usize, height as usize, max_side as usize)
        .map_err(Error::from_reason)?;
    Ok(Buffer::from(png))
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Async Native TIFF Decode + Box Downscale + PNG Encode
// ─────────────────────────────────────────────────────────────────────────────

fn convert_tiff_samples_to_rgba(
    result: tiff::decoder::DecodingResult,
    colortype: tiff::ColorType,
    width: usize,
    height: usize,
) -> Option<Vec<u8>> {
    let pixels = width.checked_mul(height)?;
    // Cap decoded pixel count at 200M pixels (~800MB RGBA) so hostile TIFFs never OOM.
    if pixels == 0 || pixels > 200_000_000 {
        return None;
    }

    let u8_samples: Vec<u8> = match result {
        tiff::decoder::DecodingResult::U8(v) => v,
        tiff::decoder::DecodingResult::U16(v) => v.into_iter().map(|x| (x >> 8) as u8).collect(),
        _ => return None,
    };

    match colortype {
        tiff::ColorType::RGBA(8) | tiff::ColorType::RGBA(16) => {
            if u8_samples.len() == pixels * 4 {
                Some(u8_samples)
            } else {
                None
            }
        }
        tiff::ColorType::RGB(8) | tiff::ColorType::RGB(16) => {
            if u8_samples.len() != pixels * 3 {
                return None;
            }
            let mut rgba = Vec::with_capacity(pixels * 4);
            for chunk in u8_samples.chunks_exact(3) {
                rgba.push(chunk[0]);
                rgba.push(chunk[1]);
                rgba.push(chunk[2]);
                rgba.push(255);
            }
            Some(rgba)
        }
        tiff::ColorType::Gray(8) | tiff::ColorType::Gray(16) => {
            if u8_samples.len() != pixels {
                return None;
            }
            let mut rgba = Vec::with_capacity(pixels * 4);
            for g in u8_samples {
                rgba.push(g);
                rgba.push(g);
                rgba.push(g);
                rgba.push(255);
            }
            Some(rgba)
        }
        tiff::ColorType::GrayA(8) | tiff::ColorType::GrayA(16) => {
            if u8_samples.len() != pixels * 2 {
                return None;
            }
            let mut rgba = Vec::with_capacity(pixels * 4);
            for chunk in u8_samples.chunks_exact(2) {
                rgba.push(chunk[0]);
                rgba.push(chunk[0]);
                rgba.push(chunk[0]);
                rgba.push(chunk[1]);
            }
            Some(rgba)
        }
        tiff::ColorType::CMYK(8) | tiff::ColorType::CMYK(16) => {
            if u8_samples.len() != pixels * 4 {
                return None;
            }
            let mut rgba = Vec::with_capacity(pixels * 4);
            for chunk in u8_samples.chunks_exact(4) {
                let c = chunk[0] as u32;
                let m = chunk[1] as u32;
                let y = chunk[2] as u32;
                let k = chunk[3] as u32;
                let inv_k = 255 - k;
                rgba.push((((255 - c) * inv_k) / 255) as u8);
                rgba.push((((255 - m) * inv_k) / 255) as u8);
                rgba.push((((255 - y) * inv_k) / 255) as u8);
                rgba.push(255);
            }
            Some(rgba)
        }
        _ => None,
    }
}

pub struct DecodeTiffTask {
    path: String,
    max_side: usize,
}

impl Task for DecodeTiffTask {
    type Output = Option<Vec<u8>>;
    type JsValue = Option<Buffer>;

    fn compute(&mut self) -> Result<Self::Output> {
        let file = match File::open(&self.path) {
            Ok(f) => f,
            Err(_) => return Ok(None),
        };
        let mut decoder = match tiff::decoder::Decoder::new(BufReader::new(file)) {
            Ok(d) => d.with_limits(tiff::decoder::Limits::default()),
            Err(_) => return Ok(None),
        };
        let (w, h) = match decoder.dimensions() {
            Ok(dims) => dims,
            Err(_) => return Ok(None),
        };
        let colortype = match decoder.colortype() {
            Ok(ct) => ct,
            Err(_) => return Ok(None),
        };
        let decoded = match decoder.read_image() {
            Ok(img) => img,
            Err(_) => return Ok(None),
        };
        let Some(rgba) = convert_tiff_samples_to_rgba(decoded, colortype, w as usize, h as usize) else {
            return Ok(None);
        };
        match downscale_rgba_and_encode_png(&rgba, w as usize, h as usize, self.max_side) {
            Ok(png) => Ok(Some(png)),
            Err(_) => Ok(None),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output.map(Buffer::from))
    }
}

/// Async native TIFF decode + box downscale + PNG encode on the libuv thread pool.
/// Returns `null` when the TIFF uses an exotic codec/layout so the caller falls back to sips/UTIF.
#[napi(js_name = "decodeTiffPreviewNative", catch_unwind)]
pub fn decode_tiff_preview_native(path: String, max_side: u32) -> AsyncTask<DecodeTiffTask> {
    AsyncTask::new(DecodeTiffTask {
        path,
        max_side: max_side as usize,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Async Fast PDF Anchor Candidate Page Locator (`lopdf`)
// ─────────────────────────────────────────────────────────────────────────────

/// Normalize text to lowercase letters/digits only (NFC/ASCII fast path) for candidate page scoring.
fn normalize_key(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    if text.is_ascii() {
        for b in text.bytes() {
            if b.is_ascii_lowercase() || b.is_ascii_digit() {
                out.push(b as char);
            } else if b.is_ascii_uppercase() {
                out.push((b + 0x20) as char);
            }
        }
        return out;
    }
    for ch in text.nfkc() {
        for lc in ch.to_lowercase() {
            if lc.is_alphabetic() || lc.is_numeric() {
                out.push(lc);
            }
        }
    }
    out
}

/// Extract clean searchable chunks (>= 8 chars) from excerpt strings.
fn extract_anchor_needles(excerpts: &[String]) -> Vec<String> {
    let mut needles = Vec::new();
    for ex in excerpts {
        // Split on newlines, pipe tables, ellipses, markdown headers
        for part in ex.split(|c| c == '\n' || c == '|' || c == '…') {
            let key = normalize_key(part);
            if key.chars().count() >= 8 {
                needles.push(key);
            }
        }
        // Also add the full normalized excerpt if short enough
        let whole = normalize_key(ex);
        let len = whole.chars().count();
        if len >= 8 {
            // Take up to 3 windows of 24 chars from the whole excerpt to survive line/column breaks
            let chars: Vec<char> = whole.chars().collect();
            if chars.len() <= 32 {
                needles.push(whole);
            } else {
                needles.push(chars[..24].iter().collect());
                let mid = chars.len() / 2;
                let start = mid.saturating_sub(12);
                needles.push(chars[start..(start + 24).min(chars.len())].iter().collect());
            }
        }
    }
    needles.sort();
    needles.dedup();
    needles
}

pub struct FindPdfAnchorPagesTask {
    path: String,
    excerpts: Vec<String>,
    max_candidates: usize,
}

/// Extract literal text inside PDF `(...)` strings or single-byte `<hex>` strings directly
/// from a decompressed content stream. Returns `None` if the stream appears to use multi-byte
/// CID/ToUnicode encoding (4+ hex digits starting with `00` or non-ASCII bytes) so the caller
/// uses full `lopdf::extract_text`.
fn extract_stream_ascii_key(raw: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(raw.len() / 2);
    let len = raw.len();
    let mut i = 0usize;
    let mut saw_text = false;
    while i < len {
        let b = raw[i];
        if b == b'(' {
            // PDF literal string `(...)` with balanced parens and `\` escapes
            saw_text = true;
            i += 1;
            let mut depth = 1u32;
            while i < len && depth > 0 {
                let c = raw[i];
                if c == b'\\' && i + 1 < len {
                    i += 1;
                    let esc = raw[i];
                    if esc.is_ascii_alphanumeric() && !matches!(esc, b'n' | b'r' | b't' | b'b' | b'f') {
                        out.push(esc.to_ascii_lowercase());
                    }
                    i += 1;
                    continue;
                }
                if c == b'(' {
                    depth += 1;
                } else if c == b')' {
                    depth -= 1;
                    if depth == 0 {
                        i += 1;
                        break;
                    }
                } else if c >= 0x80 {
                    return None; // Non-ASCII or custom encoding -> use full extract_text
                } else if c.is_ascii_lowercase() || c.is_ascii_digit() {
                    out.push(c);
                } else if c.is_ascii_uppercase() {
                    out.push(c + 0x20);
                }
                i += 1;
            }
        } else if b == b'<' && i + 1 < len && raw[i + 1] != b'<' {
            // PDF hex string `<...>` (skip dictionary `<<`)
            let start = i + 1;
            let mut j = start;
            while j < len && raw[j] != b'>' {
                j += 1;
            }
            if j >= len {
                break;
            }
            let hex = &raw[start..j];
            // Decode hex pairs into bytes; if we see 0x00 or >=0x80 bytes (UTF-16 / CID), defer to extract_text
            let mut nibs: Vec<u8> = Vec::with_capacity(hex.len());
            for &hb in hex {
                let v = match hb {
                    b'0'..=b'9' => hb - b'0',
                    b'a'..=b'f' => hb - b'a' + 10,
                    b'A'..=b'F' => hb - b'A' + 10,
                    b' ' | b'\t' | b'\r' | b'\n' => continue,
                    _ => return None,
                };
                nibs.push(v);
            }
            if nibs.len() >= 2 {
                saw_text = true;
                for pair in nibs.chunks(2) {
                    let byte = (pair[0] << 4) | (if pair.len() == 2 { pair[1] } else { 0 });
                    if byte == 0 || byte >= 0x80 {
                        return None;
                    }
                    if byte.is_ascii_lowercase() || byte.is_ascii_digit() {
                        out.push(byte);
                    } else if byte.is_ascii_uppercase() {
                        out.push(byte + 0x20);
                    }
                }
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    if saw_text { Some(out) } else { None }
}

impl Task for FindPdfAnchorPagesTask {
    type Output = Vec<u32>;
    type JsValue = Vec<u32>;

    fn compute(&mut self) -> Result<Self::Output> {
        let needles = extract_anchor_needles(&self.excerpts);
        if needles.is_empty() {
            return Ok(Vec::new());
        }
        let doc = match lopdf::Document::load(&self.path) {
            Ok(d) => d,
            Err(_) => return Ok(Vec::new()),
        };
        if doc.is_encrypted() {
            return Ok(Vec::new());
        }
        let pages = doc.get_pages();
        if pages.is_empty() {
            return Ok(Vec::new());
        }

        let mut scored: Vec<(u32, usize)> = Vec::new();
        let ascii_needles: Vec<Vec<u8>> = needles
            .iter()
            .filter(|n| n.is_ascii() && n.len() >= 8)
            .map(|n| n.as_bytes().to_vec())
            .collect();
        let use_stream_prefilter = !ascii_needles.is_empty() && ascii_needles.len() == needles.len();

        for (&page_num, &page_id) in &pages {
            if use_stream_prefilter {
                if let Ok(raw_content) = doc.get_page_content(page_id) {
                    if let Some(stripped) = extract_stream_ascii_key(&raw_content) {
                        let mut stream_score = 0usize;
                        for needle in &ascii_needles {
                            if stripped.windows(needle.len()).any(|w| w == needle.as_slice()) {
                                stream_score += needle.len();
                            }
                        }
                        if stream_score > 0 {
                            scored.push((page_num, stream_score));
                        }
                        continue;
                    }
                }
            }

            let Ok(text) = doc.extract_text(&[page_num]) else {
                continue;
            };
            if text.is_empty() {
                continue;
            }
            let page_key = normalize_key(&text);
            if page_key.is_empty() {
                continue;
            }
            let mut score = 0usize;
            for needle in &needles {
                if page_key.contains(needle.as_str()) {
                    score += needle.len();
                }
            }
            if score > 0 {
                scored.push((page_num, score));
            }
        }

        scored.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(scored
            .into_iter()
            .take(self.max_candidates)
            .map(|(page_num, _)| page_num)
            .collect())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Fast native PDF candidate-page scanner (`lopdf`) running on the libuv thread pool.
/// Returns 1-based candidate page numbers ranked by excerpt match score (empty if encrypted or no match).
#[napi(js_name = "findPdfAnchorPagesNative", catch_unwind)]
pub fn find_pdf_anchor_pages_native(
    path: String,
    excerpts: Vec<String>,
    max_candidates: u32,
) -> AsyncTask<FindPdfAnchorPagesTask> {
    AsyncTask::new(FindPdfAnchorPagesTask {
        path,
        excerpts,
        max_candidates: (max_candidates as usize).clamp(1, 20),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Async Streaming Archive Top-Level Listing (ZIP / TAR / TAR.GZ)
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct NativeArchiveEntry {
    pub name: String,
    pub size: f64,
    pub modified: Either<f64, Null>,
}

#[napi(object)]
pub struct NativeArchiveListResult {
    /// "ok" | "encrypted" | "corrupt" | "tooLarge" | "tooManyEntries" | "unsupported"
    pub status: String,
    pub entries: Vec<NativeArchiveEntry>,
}

fn decode_archive_name(raw: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(raw) {
        return s.nfc().collect();
    }
    let (cow, _, _) = EUC_KR.decode(raw);
    cow.nfc().collect()
}

struct TopAgg {
    name: String,
    folder: bool,
    size: u64,
    modified: Option<f64>,
}

fn push_top_level(
    order: &mut Vec<TopAgg>,
    index: &mut HashMap<String, usize>,
    raw_name: &str,
    size: u64,
    modified: Option<f64>,
    is_dir: bool,
) {
    let ends_slash = raw_name.ends_with('/') || raw_name.ends_with('\\');
    // Skip leading `/` or `./`
    let mut s = raw_name;
    loop {
        if let Some(rest) = s.strip_prefix('/') {
            s = rest;
        } else if let Some(rest) = s.strip_prefix('\\') {
            s = rest;
        } else if let Some(rest) = s.strip_prefix("./") {
            s = rest;
        } else if let Some(rest) = s.strip_prefix(".\\") {
            s = rest;
        } else {
            break;
        }
    }
    if s.is_empty() {
        return;
    }
    let mut split_at = s.len();
    for (i, b) in s.bytes().enumerate() {
        if b == b'/' || b == b'\\' {
            split_at = i;
            break;
        }
    }
    let head = &s[..split_at];
    if head.is_empty() {
        return;
    }
    let has_rest = s[split_at..].bytes().any(|b| b != b'/' && b != b'\\');
    let folder = is_dir || has_rest || ends_slash;

    if let Some(&idx) = index.get(head) {
        let agg = &mut order[idx];
        agg.folder = agg.folder || folder;
        agg.size = agg.size.saturating_add(size);
        if let Some(m) = modified {
            match agg.modified {
                None => agg.modified = Some(m),
                Some(prev) if m > prev => agg.modified = Some(m),
                _ => {}
            }
        }
    } else {
        let idx = order.len();
        let owned = head.to_string();
        index.insert(owned.clone(), idx);
        order.push(TopAgg {
            name: owned,
            folder,
            size,
            modified,
        });
    }
}

fn finalize_top_level(order: Vec<TopAgg>) -> Vec<NativeArchiveEntry> {
    let mut out = Vec::with_capacity(order.len());
    for mut agg in order {
        if agg.folder {
            agg.name.push('/');
        }
        out.push(NativeArchiveEntry {
            name: agg.name,
            size: agg.size as f64,
            modified: match agg.modified {
                Some(m) => Either::A(m),
                None => Either::B(Null),
            },
        });
    }
    out
}

/// Bounded reader that fails with `WriteZero` if decompressed output exceeds `limit` bytes.
struct BoundedReader<R: Read> {
    inner: R,
    read_bytes: u64,
    limit: u64,
    exceeded: bool,
}

impl<R: Read> Read for BoundedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read_bytes = self.read_bytes.saturating_add(n as u64);
        if self.read_bytes > self.limit {
            self.exceeded = true;
            return Err(std::io::Error::new(std::io::ErrorKind::Other, "output-limit-exceeded"));
        }
        Ok(n)
    }
}

fn list_tar_stream<R: Read>(reader: R, max_output_bytes: u64, max_entries: usize) -> NativeArchiveListResult {
    let bounded = BoundedReader {
        inner: reader,
        read_bytes: 0,
        limit: max_output_bytes,
        exceeded: false,
    };
    let mut archive = tar::Archive::new(bounded);
    let entries_iter = match archive.entries() {
        Ok(it) => it,
        Err(_) => {
            return NativeArchiveListResult {
                status: "corrupt".to_string(),
                entries: Vec::new(),
            }
        }
    };

    let mut order: Vec<TopAgg> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut count = 0usize;

    for item in entries_iter {
        if count >= max_entries {
            return NativeArchiveListResult {
                status: "tooManyEntries".to_string(),
                entries: Vec::new(),
            };
        }
        let entry = match item {
            Ok(e) => e,
            Err(e) => {
                if e.to_string().contains("output-limit-exceeded") {
                    return NativeArchiveListResult {
                        status: "tooLarge".to_string(),
                        entries: Vec::new(),
                    };
                }
                return NativeArchiveListResult {
                    status: "corrupt".to_string(),
                    entries: Vec::new(),
                };
            }
        };
        let raw_bytes = entry.path_bytes();
        let name = decode_archive_name(raw_bytes.as_ref());
        if name.is_empty() {
            continue;
        }
        let size = entry.header().size().unwrap_or(0);
        let mtime = entry
            .header()
            .mtime()
            .ok()
            .filter(|&s| s > 0)
            .map(|s| (s as f64) * 1000.0);
        let is_dir = entry.header().entry_type().is_dir();
        push_top_level(&mut order, &mut index, &name, size, mtime, is_dir);
        count += 1;
    }

    if count == 0 {
        return NativeArchiveListResult {
            status: "corrupt".to_string(),
            entries: Vec::new(),
        };
    }

    NativeArchiveListResult {
        status: "ok".to_string(),
        entries: finalize_top_level(order),
    }
}

fn list_zip_file(path: &str, max_entries: usize) -> NativeArchiveListResult {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => {
            return NativeArchiveListResult {
                status: "corrupt".to_string(),
                entries: Vec::new(),
            }
        }
    };
    let mut archive = match zip::ZipArchive::new(BufReader::new(file)) {
        Ok(a) => a,
        Err(_) => {
            return NativeArchiveListResult {
                status: "corrupt".to_string(),
                entries: Vec::new(),
            }
        }
    };

    let total = archive.len();
    if total == 0 {
        return NativeArchiveListResult {
            status: "corrupt".to_string(),
            entries: Vec::new(),
        };
    }
    if total > max_entries {
        return NativeArchiveListResult {
            status: "tooManyEntries".to_string(),
            entries: Vec::new(),
        };
    }

    let mut order: Vec<TopAgg> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for i in 0..total {
        let entry = match archive.by_index_raw(i) {
            Ok(e) => e,
            Err(_) => {
                return NativeArchiveListResult {
                    status: "corrupt".to_string(),
                    entries: Vec::new(),
                }
            }
        };
        if entry.encrypted() {
            return NativeArchiveListResult {
                status: "encrypted".to_string(),
                entries: Vec::new(),
            };
        }
        let name = decode_archive_name(entry.name_raw());
        if name.is_empty() {
            continue;
        }
        let is_dir = entry.is_dir();
        let size = entry.size();
        // Convert zip DateTime to epoch ms when valid
        let modified = entry.last_modified().and_then(|dt| {
            // Simple Gregorian date -> Unix timestamp (UTC approximation matching DOS local/UTC preview sorting)
            let year = dt.year() as i64;
            let month = dt.month() as i64;
            let day = dt.day() as i64;
            if year < 1980 || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
                return None;
            }
            let days = days_from_civil(year, month, day);
            let secs = days * 86400
                + (dt.hour() as i64) * 3600
                + (dt.minute() as i64) * 60
                + (dt.second() as i64);
            Some((secs as f64) * 1000.0)
        });
        push_top_level(&mut order, &mut index, &name, size, modified, is_dir);
    }

    NativeArchiveListResult {
        status: "ok".to_string(),
        entries: finalize_top_level(order),
    }
}

/// Howard Hinnant's civil-to-days algorithm (days since 1970-01-01).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) as u64 + 2) / 5 + (d as u64) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + (doe as i64) - 719468
}

fn looks_like_tar_header(buf: &[u8]) -> bool {
    if buf.len() < 512 {
        return false;
    }
    if &buf[257..262] == b"ustar" {
        return true;
    }
    // Verify tar header checksum
    let stored_str = std::str::from_utf8(&buf[148..156]).unwrap_or("").trim_matches(|c| c == '\0' || c == ' ');
    let Ok(stored) = u32::from_str_radix(stored_str, 8) else {
        return false;
    };
    let mut sum: u32 = 0;
    for (i, &b) in buf[..512].iter().enumerate() {
        sum += if (148..156).contains(&i) { 0x20 } else { b as u32 };
    }
    sum == stored
}

pub struct ListArchiveTask {
    path: String,
    max_output_bytes: u64,
    max_entries: usize,
}

impl Task for ListArchiveTask {
    type Output = NativeArchiveListResult;
    type JsValue = NativeArchiveListResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut f = match File::open(&self.path) {
            Ok(f) => f,
            Err(_) => {
                return Ok(NativeArchiveListResult {
                    status: "corrupt".to_string(),
                    entries: Vec::new(),
                })
            }
        };
        let mut head = [0u8; 512];
        let n = f.read(&mut head).unwrap_or(0);
        drop(f);

        // 1. ZIP magic: PK\x03\x04 or PK\x05\x06
        if n >= 4 && head[0] == 0x50 && head[1] == 0x4B && (head[2] == 0x03 || head[2] == 0x05) {
            return Ok(list_zip_file(&self.path, self.max_entries));
        }

        // 2. GZIP magic: \x1f\x8b — peek first 512 inflated bytes to confirm tar payload
        if n >= 2 && head[0] == 0x1F && head[1] == 0x8B {
            let file = File::open(&self.path).map_err(|e| Error::from_reason(e.to_string()))?;
            let mut gz = GzDecoder::new(BufReader::new(file));
            let mut probe = [0u8; 512];
            let mut read_len = 0;
            while read_len < 512 {
                match gz.read(&mut probe[read_len..]) {
                    Ok(0) => break,
                    Ok(k) => read_len += k,
                    Err(_) => {
                        return Ok(NativeArchiveListResult {
                            status: "corrupt".to_string(),
                            entries: Vec::new(),
                        })
                    }
                }
            }
            if !looks_like_tar_header(&probe[..read_len]) {
                return Ok(NativeArchiveListResult {
                    status: "unsupported".to_string(),
                    entries: Vec::new(),
                });
            }
            // Re-open and stream the full tar.gz
            let file2 = File::open(&self.path).map_err(|e| Error::from_reason(e.to_string()))?;
            let gz2 = GzDecoder::new(BufReader::new(file2));
            return Ok(list_tar_stream(gz2, self.max_output_bytes, self.max_entries));
        }

        // 3. Uncompressed TAR
        if n >= 512 && looks_like_tar_header(&head) {
            let file = File::open(&self.path).map_err(|e| Error::from_reason(e.to_string()))?;
            return Ok(list_tar_stream(BufReader::new(file), self.max_output_bytes, self.max_entries));
        }

        // 4. Everything else (7z, RAR, bz2, xz, zst, iso, deb, rpm, cab) -> let existing worker handle
        Ok(NativeArchiveListResult {
            status: "unsupported".to_string(),
            entries: Vec::new(),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Async streaming top-level listing for ZIP / TAR / TAR.GZ on the libuv thread pool.
/// Returns `status: "unsupported"` for formats handled by `archive-list-worker` (7z/RAR/ISO/deb/rpm/CAB/bz2/xz/zst).
#[napi(js_name = "listArchiveNative", catch_unwind)]
pub fn list_archive_native(
    path: String,
    max_output_bytes: f64,
    max_entries: u32,
) -> AsyncTask<ListArchiveTask> {
    AsyncTask::new(ListArchiveTask {
        path,
        max_output_bytes: max_output_bytes.max(0.0) as u64,
        max_entries: max_entries as usize,
    })
}

/// Fast synchronous TAR listing over an in-memory buffer (used for decompressed `.tar.zst` or `.deb` payloads).
#[napi(js_name = "listTarBytesNative", catch_unwind)]
pub fn list_tar_bytes_native(bytes: Uint8Array, max_entries: u32) -> NativeArchiveListResult {
    let slice = bytes.as_ref();
    if slice.len() < 512 || !looks_like_tar_header(slice) {
        return NativeArchiveListResult {
            status: "unsupported".to_string(),
            entries: Vec::new(),
        };
    }
    list_tar_stream(Cursor::new(slice), slice.len() as u64 + 1024, max_entries as usize)
}
