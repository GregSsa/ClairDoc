use serde::Serialize;
use std::{fs, path::PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderSummary {
    root_path: String,
    folder_name: String,
    file_count: u64,
    directory_count: u64,
    pdf_count: u64,
    image_count: u64,
    office_count: u64,
    total_bytes: u64,
    inaccessible_count: u64,
}

impl FolderSummary {
    fn new(root: &std::path::Path) -> Self {
        Self {
            root_path: root.display().to_string(),
            folder_name: root
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Dossier sélectionné")
                .to_string(),
            file_count: 0,
            directory_count: 0,
            pdf_count: 0,
            image_count: 0,
            office_count: 0,
            total_bytes: 0,
            inaccessible_count: 0,
        }
    }
}

#[tauri::command]
fn scan_folder(path: String) -> Result<FolderSummary, String> {
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "Le dossier sélectionné est introuvable ou inaccessible.".to_string())?;

    if !root.is_dir() {
        return Err("L’emplacement sélectionné n’est pas un dossier.".to_string());
    }

    let mut summary = FolderSummary::new(&root);
    let mut pending = vec![root];

    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                summary.inaccessible_count += 1;
                continue;
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    summary.inaccessible_count += 1;
                    continue;
                }
            };

            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    summary.inaccessible_count += 1;
                    continue;
                }
            };

            // Do not follow symbolic links or Windows junctions. This prevents
            // traversal outside the folder and avoids recursive cycles.
            if file_type.is_symlink() {
                continue;
            }

            if file_type.is_dir() {
                summary.directory_count += 1;
                pending.push(entry.path());
                continue;
            }

            if !file_type.is_file() {
                continue;
            }

            summary.file_count += 1;
            match entry.metadata() {
                Ok(metadata) => {
                    summary.total_bytes = summary.total_bytes.saturating_add(metadata.len())
                }
                Err(_) => summary.inaccessible_count += 1,
            }

            let extension = entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();

            match extension.as_str() {
                "pdf" => summary.pdf_count += 1,
                "png" | "jpg" | "jpeg" | "tif" | "tiff" | "bmp" | "webp" | "heic" => {
                    summary.image_count += 1
                }
                "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp"
                | "rtf" | "txt" | "csv" => summary.office_count += 1,
                _ => {}
            }
        }
    }

    Ok(summary)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
