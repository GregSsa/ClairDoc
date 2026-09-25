use reqwest::{multipart, Client, Response, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

const CONFIG_FILE_NAME: &str = "server-config.json";

#[derive(Deserialize, Serialize)]
struct ServerConfig {
    server_url: String,
    api_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerConfigStatus {
    server_url: String,
    configured: bool,
}

#[derive(Deserialize, Serialize)]
struct ConnectionResponse {
    status: String,
    version: String,
}

#[derive(Deserialize, Serialize)]
struct ProjectResponse {
    id: String,
    name: String,
}

#[derive(Deserialize, Serialize)]
struct ProjectOcrState {
    project_id: String,
    paused: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfFile {
    path: String,
    name: String,
    bytes: u64,
}

#[derive(Deserialize, Serialize)]
struct OcrJobResponse {
    id: String,
    project_id: Option<String>,
    original_filename: String,
    status: String,
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct IndexResponse {
    project_id: String,
    documents_indexed: u64,
    documents_reused: u64,
    chunks_indexed: u64,
    embedding_model: String,
}

#[derive(Deserialize, Serialize)]
struct CitationResponse {
    document_name: String,
    job_id: String,
    chunk_index: u64,
    score: f64,
    excerpt: String,
}

#[derive(Deserialize, Serialize)]
struct AskResponse {
    answer: String,
    citations: Vec<CitationResponse>,
    model: String,
}

#[derive(Deserialize)]
struct ApiError {
    detail: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(CONFIG_FILE_NAME))
        .map_err(|error| format!("Impossible de trouver le dossier de configuration : {error}"))
}

fn normalize_server_url(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('/');
    let url = Url::parse(value).map_err(|_| "L’adresse du serveur est invalide.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("L’adresse doit commencer par http:// ou https://.".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("L’adresse du serveur ne doit contenir ni paramètres ni fragment.".to_string());
    }
    Ok(value.to_string())
}

fn read_server_config(app: &AppHandle) -> Result<ServerConfig, String> {
    let path = config_path(app)?;
    if let Ok(content) = fs::read_to_string(path) {
        return serde_json::from_str(&content)
            .map_err(|_| "La configuration du serveur est illisible.".to_string());
    }
    environment_server_config()
        .ok_or_else(|| "Le serveur ClairDoc n’est pas encore configuré.".to_string())
}

fn environment_server_config() -> Option<ServerConfig> {
    let _ = dotenvy::dotenv();
    let api_key = std::env::var("CLAIRDOC_API_KEY").ok()?;
    if api_key.trim().is_empty() {
        return None;
    }
    let server_url = std::env::var("CLAIRDOC_SERVER_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8787".to_string());
    Some(ServerConfig {
        server_url: normalize_server_url(&server_url).ok()?,
        api_key: api_key.trim().to_string(),
    })
}

fn write_server_config(app: &AppHandle, config: &ServerConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Dossier de configuration invalide.".to_string())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Impossible de créer le dossier de configuration : {error}"))?;

    let temporary_path = path.with_extension("json.tmp");
    let content = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Impossible de préparer la configuration : {error}"))?;
    fs::write(&temporary_path, content)
        .map_err(|error| format!("Impossible d’enregistrer la configuration : {error}"))?;
    fs::rename(&temporary_path, &path)
        .map_err(|error| format!("Impossible de finaliser la configuration : {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Impossible de protéger la configuration : {error}"))?;
    }

    Ok(())
}

fn api_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Impossible de préparer la connexion : {error}"))
}

async fn parse_api_response<T: DeserializeOwned>(response: Response) -> Result<T, String> {
    if response.status().is_success() {
        return response
            .json::<T>()
            .await
            .map_err(|error| format!("Réponse du serveur illisible : {error}"));
    }

    let status = response.status();
    let detail = response
        .json::<ApiError>()
        .await
        .ok()
        .and_then(|error| error.detail)
        .unwrap_or_else(|| format!("Le serveur a répondu avec le statut {status}."));
    Err(detail)
}

async fn verify_server(config: &ServerConfig) -> Result<ConnectionResponse, String> {
    let response = api_client(Duration::from_secs(15))?
        .get(format!("{}/api/v1/connection", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Serveur ClairDoc inaccessible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
fn get_server_config(app: AppHandle) -> Result<ServerConfigStatus, String> {
    match read_server_config(&app) {
        Ok(config) => Ok(ServerConfigStatus {
            server_url: config.server_url,
            configured: true,
        }),
        Err(_) => Ok(ServerConfigStatus {
            server_url: "http://127.0.0.1:8787".to_string(),
            configured: false,
        }),
    }
}

#[tauri::command]
async fn configure_server(
    app: AppHandle,
    server_url: String,
    api_key: String,
) -> Result<ConnectionResponse, String> {
    if api_key.trim().len() < 16 {
        return Err("La clé ClairDoc doit contenir au moins 16 caractères.".to_string());
    }
    let config = ServerConfig {
        server_url: normalize_server_url(&server_url)?,
        api_key: api_key.trim().to_string(),
    };
    let connection = verify_server(&config).await?;
    write_server_config(&app, &config)?;
    Ok(connection)
}

#[tauri::command]
async fn test_server_connection(app: AppHandle) -> Result<ConnectionResponse, String> {
    verify_server(&read_server_config(&app)?).await
}

#[tauri::command]
async fn create_remote_project(app: AppHandle, name: String) -> Result<ProjectResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(20))?
        .post(format!("{}/api/v1/projects", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .json(&serde_json::json!({ "name": name }))
        .send()
        .await
        .map_err(|error| format!("Création du projet impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn list_remote_projects(app: AppHandle) -> Result<Vec<ProjectResponse>, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(20))?
        .get(format!("{}/api/v1/projects", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Chargement des projets impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn submit_ocr_job(
    app: AppHandle,
    path: String,
    project_id: Option<String>,
) -> Result<OcrJobResponse, String> {
    let pdf_path = PathBuf::from(&path);
    if !pdf_path.is_file()
        || pdf_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("Sélectionnez un fichier PDF accessible.".to_string());
    }

    let config = read_server_config(&app)?;
    let form = multipart::Form::new()
        .file("file", &pdf_path)
        .await
        .map_err(|error| format!("Impossible de lire le PDF : {error}"))?;
    let client = api_client(Duration::from_secs(7200))?;
    let mut request = client
        .post(format!("{}/api/v1/ocr/jobs", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .multipart(form);
    if let Some(project_id) = project_id {
        request = request.query(&[("project_id", project_id)]);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Envoi du PDF impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn get_ocr_job(app: AppHandle, job_id: String) -> Result<OcrJobResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(20))?
        .get(format!("{}/api/v1/ocr/jobs/{job_id}", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Suivi OCR impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn list_project_jobs(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<OcrJobResponse>, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .get(format!(
            "{}/api/v1/projects/{project_id}/ocr/jobs",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Chargement des travaux impossible : {error}"))?;
    parse_api_response(response).await
}

async fn change_project_ocr_state(
    app: &AppHandle,
    project_id: &str,
    action: &str,
) -> Result<ProjectOcrState, String> {
    let config = read_server_config(app)?;
    let response = api_client(Duration::from_secs(20))?
        .post(format!(
            "{}/api/v1/projects/{project_id}/ocr/{action}",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Modification de la file OCR impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn pause_project_ocr(app: AppHandle, project_id: String) -> Result<ProjectOcrState, String> {
    change_project_ocr_state(&app, &project_id, "pause").await
}

#[tauri::command]
async fn resume_project_ocr(app: AppHandle, project_id: String) -> Result<ProjectOcrState, String> {
    change_project_ocr_state(&app, &project_id, "resume").await
}

#[tauri::command]
async fn retry_ocr_job(app: AppHandle, job_id: String) -> Result<OcrJobResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(20))?
        .post(format!(
            "{}/api/v1/ocr/jobs/{job_id}/retry",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Relance OCR impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn get_ocr_text(app: AppHandle, job_id: String) -> Result<String, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .get(format!(
            "{}/api/v1/ocr/jobs/{job_id}/text",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Récupération du texte impossible : {error}"))?;
    if response.status().is_success() {
        return response
            .text()
            .await
            .map_err(|error| format!("Texte OCR illisible : {error}"));
    }
    let status = response.status();
    Err(format!("Le texte OCR n’est pas disponible ({status})."))
}

#[tauri::command]
async fn index_project(app: AppHandle, project_id: String) -> Result<IndexResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(7200))?
        .post(format!(
            "{}/api/v1/projects/{project_id}/index",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Indexation impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn ask_project(
    app: AppHandle,
    project_id: String,
    question: String,
) -> Result<AskResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(180))?
        .post(format!(
            "{}/api/v1/projects/{project_id}/ask",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .json(&serde_json::json!({ "question": question }))
        .send()
        .await
        .map_err(|error| format!("Question impossible : {error}"))?;
    parse_api_response(response).await
}

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

#[tauri::command]
fn list_pdf_files(path: String) -> Result<Vec<PdfFile>, String> {
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "Le dossier sélectionné est introuvable ou inaccessible.".to_string())?;
    if !root.is_dir() {
        return Err("L’emplacement sélectionné n’est pas un dossier.".to_string());
    }

    let mut files = Vec::new();
    let mut pending = vec![root];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
                continue;
            }
            let file_path = entry.path();
            let is_pdf = file_path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
            if file_type.is_file() && is_pdf {
                files.push(PdfFile {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    bytes: entry.metadata().map(|metadata| metadata.len()).unwrap_or(0),
                    path: file_path.display().to_string(),
                });
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            get_server_config,
            configure_server,
            test_server_connection,
            create_remote_project,
            list_remote_projects,
            submit_ocr_job,
            get_ocr_job,
            list_project_jobs,
            pause_project_ocr,
            resume_project_ocr,
            retry_ocr_job,
            get_ocr_text,
            index_project,
            ask_project,
            list_pdf_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
