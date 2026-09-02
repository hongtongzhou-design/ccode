//! Excel / ODS 表格预览：白名单读字节后用 calamine 抽指定工作表前若干行。
//! 只读、截断，不当电子表格编辑器。

use crate::pdf::read_whitelisted_sync;
use calamine::{Data, Reader};
use serde::Serialize;
use std::io::{Cursor, Read, Seek};

const XLSX_CAP: u64 = 20 * 1024 * 1024;
const MAX_ROWS: usize = 200;
const MAX_COLS: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPreviewDto {
    pub sheet: String,
    pub sheets: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub truncated: bool,
    pub size: u64,
    pub total_rows: usize,
    pub total_cols: usize,
}

fn cell_text(d: &Data) -> String {
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{f:.0}")
            } else {
                format!("{f}")
            }
        }
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => {
            if *b {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        Data::Error(e) => format!("#{e:?}"),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
    }
}

fn read_sheet_preview_sync(
    path: &str,
    cwd_hint: Option<&str>,
    sheet_name: Option<&str>,
) -> Result<SheetPreviewDto, String> {
    let (bytes, size) = read_whitelisted_sync(path, cwd_hint, XLSX_CAP, |mb| {
        format!("表格超过 20 MB（{mb:.1} MB），暂不支持内嵌预览")
    })?;
    let cursor = Cursor::new(bytes);
    let mut workbook = open_auto(cursor, path)?;
    let sheets = workbook.sheet_names();
    if sheets.is_empty() {
        return Err("这个表格里没有工作表".into());
    }
    let want = sheet_name.map(str::trim).filter(|s| !s.is_empty());
    let sheet = if let Some(name) = want {
        if !sheets.iter().any(|s| s == name) {
            return Err(format!("没有名为「{name}」的工作表"));
        }
        name.to_string()
    } else {
        sheets[0].clone()
    };
    let range = workbook
        .worksheet_range(&sheet)
        .map_err(|e| format!("读取工作表失败: {e}"))?;
    let total_cols = range.width();
    let total_rows = range.height();
    let truncated = total_rows > MAX_ROWS || total_cols > MAX_COLS;
    let width = total_cols.min(MAX_COLS);
    let take_rows = total_rows.min(MAX_ROWS);
    let mut rows = Vec::with_capacity(take_rows);
    for r in 0..take_rows {
        let mut row = Vec::with_capacity(width);
        for c in 0..width {
            row.push(range.get((r, c)).map(cell_text).unwrap_or_default());
        }
        rows.push(row);
    }
    Ok(SheetPreviewDto {
        sheet,
        sheets,
        rows,
        truncated,
        size,
        total_rows,
        total_cols,
    })
}

fn open_auto<RS: Read + Seek + Send>(
    cursor: RS,
    path: &str,
) -> Result<calamine::Sheets<RS>, String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "xlsx" | "xlsm" => calamine::open_workbook_from_rs::<calamine::Xlsx<_>, _>(cursor)
            .map(calamine::Sheets::Xlsx)
            .map_err(|e| format!("无法解析 xlsx: {e}")),
        "xls" => calamine::open_workbook_from_rs::<calamine::Xls<_>, _>(cursor)
            .map(calamine::Sheets::Xls)
            .map_err(|e| format!("无法解析 xls: {e}")),
        "ods" => calamine::open_workbook_from_rs::<calamine::Ods<_>, _>(cursor)
            .map(calamine::Sheets::Ods)
            .map_err(|e| format!("无法解析 ods: {e}")),
        _ => Err("只支持 .xlsx / .xls / .ods 表格预览".into()),
    }
}

#[tauri::command]
pub async fn read_sheet_preview(
    path: String,
    cwd_hint: Option<String>,
    sheet: Option<String>,
) -> Result<SheetPreviewDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_sheet_preview_sync(&path, cwd_hint.as_deref(), sheet.as_deref())
    })
    .await
    .map_err(|e| format!("读取表格失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    /// 最小合法 xlsx：一张表、A1=hello。calamine 对残缺包会失败，这里只测白名单拒读。
    #[test]
    fn sheet_preview_rejects_outside_whitelist() {
        let dir = std::env::temp_dir().join(format!("ccode-xlsx-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.xlsx");
        fs::write(&f, b"PK\x03\x04not-a-real-xlsx").unwrap();
        let err = read_sheet_preview_sync(f.to_str().unwrap(), None, None).unwrap_err();
        assert!(
            err.contains("拒绝") || err.contains("范围") || err.contains("不存在"),
            "{err}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sheet_preview_reads_minimal_xlsx() {
        let dir = std::env::temp_dir().join(format!("ccode-xlsx-ok-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.xlsx");
        write_minimal_xlsx(&f, "hello");
        let dto = read_sheet_preview_sync(f.to_str().unwrap(), Some(dir.to_str().unwrap()), None)
            .expect("parse");
        assert!(!dto.rows.is_empty());
        assert!(dto.total_rows >= 1);
        assert!(dto.total_cols >= 1);
        assert!(
            dto.rows
                .iter()
                .any(|r| r.iter().any(|c| c.contains("hello"))),
            "{dto:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_minimal_xlsx(path: &std::path::Path, cell: &str) {
        // 手写一份 calamine 能读的最小 worksheet；共享字符串走 inlineStr 免 sst。
        let file = fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let opt = SimpleFileOptions::default();
        zip.start_file("[Content_Types].xml", opt).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#,
        )
        .unwrap();
        zip.start_file("_rels/.rels", opt).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
        )
        .unwrap();
        zip.start_file("xl/_rels/workbook.xml.rels", opt).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#,
        )
        .unwrap();
        zip.start_file("xl/workbook.xml", opt).unwrap();
        zip.write_all(
            br#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
        )
        .unwrap();
        zip.start_file("xl/worksheets/sheet1.xml", opt).unwrap();
        let sheet = format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{}</t></is></c></row></sheetData>
</worksheet>"#,
            cell
        );
        zip.write_all(sheet.as_bytes()).unwrap();
        zip.finish().unwrap();
    }
}
