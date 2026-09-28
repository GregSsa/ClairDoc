use reqwest::{multipart, Client, Response, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
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
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct ProjectResponse {
    id: String,
    name: String,
    source_root: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct RuntimeInfoResponse {
    version: String,
    llm_model: String,
    embedding_model: String,
    embedding_provider: String,
    embedding_dimensions: u64,
    ocr_languages: String,
    data_dir: String,
    max_upload_mb: u64,
    max_index_tokens: u64,
    openai_configured: bool,
    tls_enabled: bool,
    model_options: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct ProjectOcrState {
    project_id: String,
    paused: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentFile {
    path: String,
    relative_path: String,
    name: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDirectoryEntry {
    name: String,
    relative_path: String,
    kind: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectDirectoryPage {
    entries: Vec<ProjectDirectoryEntry>,
    total: usize,
    offset: usize,
    limit: usize,
}

#[derive(Deserialize, Serialize, Clone)]
struct OrganizationEntry {
    job_id: String,
    original_filename: String,
    source_relative_path: String,
    suggested_path: String,
    category: String,
    document_date: Option<String>,
    organization: Option<String>,
    reason: String,
}

#[derive(Deserialize, Serialize)]
struct OrganizationPlan {
    project_id: String,
    created_at: String,
    entries: Vec<OrganizationEntry>,
}

#[derive(Deserialize, Serialize)]
struct ManifestEntry {
    source: String,
    destination: String,
    sha256: String,
    #[serde(default)]
    source_backup: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct OperationManifest {
    created_at: u64,
    #[serde(default = "default_copy_mode")]
    mode: String,
    entries: Vec<ManifestEntry>,
}

fn default_copy_mode() -> String {
    "copy".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyResult {
    manifest_path: String,
    copied: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UndoResult {
    removed: usize,
    skipped: usize,
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
    #[serde(default)]
    documents_name_only: u64,
    documents_reused: u64,
    chunks_indexed: u64,
    embedding_model: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct IndexEstimate {
    project_id: String,
    documents_total: u64,
    documents_to_embed: u64,
    documents_reused: u64,
    estimated_tokens: u64,
    estimated_cost_usd: f64,
    price_per_million_tokens_usd: f64,
    embedding_model: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct IndexTaskResponse {
    id: String,
    project_id: String,
    status: String,
    estimate: Option<IndexEstimate>,
    result: Option<IndexResponse>,
    error: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct BackupResponse {
    path: String,
    size_bytes: u64,
    created_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct DocumentSummaryResponse {
    job_id: String,
    name: String,
    source_relative_path: String,
    status: String,
    category: String,
    document_date: Option<String>,
    organization: Option<String>,
    people: Vec<String>,
    amounts: Vec<String>,
    chunks: u64,
    #[serde(default)]
    text_warning: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct DocumentRelationshipResponse {
    source_job_id: String,
    target_job_id: String,
    kind: String,
    label: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct DocumentLibraryResponse {
    project_id: String,
    documents: Vec<DocumentSummaryResponse>,
    categories: Vec<String>,
    relationships: Vec<DocumentRelationshipResponse>,
}

#[derive(Deserialize, Serialize)]
struct CitationResponse {
    document_name: String,
    job_id: String,
    chunk_index: u64,
    page_number: Option<u64>,
    score: f64,
    excerpt: String,
}

#[derive(Deserialize, Serialize)]
struct AskResponse {
    answer: String,
    citations: Vec<CitationResponse>,
    model: String,
    actions: Vec<AssistantActionResponse>,
}

#[derive(Clone, Deserialize, Serialize)]
struct AssistantActionResponse {
    id: Option<String>,
    tool: String,
    status: String,
    summary: String,
    #[serde(default)]
    arguments: serde_json::Value,
    source_relative_path: Option<String>,
    expected_sha256: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct ConversationSummaryResponse {
    id: String,
    project_id: String,
    title: String,
    created_at: String,
    updated_at: String,
    message_count: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct ConversationMessageResponse {
    id: String,
    role: String,
    content: String,
    created_at: String,
    citations: Vec<CitationResponse>,
    actions: Vec<AssistantActionResponse>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
struct ConversationResponse {
    id: String,
    project_id: String,
    title: String,
    created_at: String,
    updated_at: String,
    messages: Vec<ConversationMessageResponse>,
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
async fn create_remote_project(
    app: AppHandle,
    name: String,
    source_root: Option<String>,
) -> Result<ProjectResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(20))?
        .post(format!("{}/api/v1/projects", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .json(&serde_json::json!({ "name": name, "source_root": source_root }))
        .send()
        .await
        .map_err(|error| format!("Création du projet impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn update_remote_project(
    app: AppHandle,
    project_id: String,
    name: Option<String>,
    source_root: Option<String>,
) -> Result<ProjectResponse, String> {
    let config = read_server_config(&app)?;
    let mut payload = serde_json::Map::new();
    if let Some(name) = name {
        payload.insert("name".to_string(), serde_json::Value::String(name));
    }
    if let Some(source_root) = source_root {
        payload.insert(
            "source_root".to_string(),
            serde_json::Value::String(source_root),
        );
    }
    let response = api_client(Duration::from_secs(20))?
        .patch(format!(
            "{}/api/v1/projects/{project_id}",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Modification du projet impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn delete_remote_project(app: AppHandle, project_id: String) -> Result<(), String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .delete(format!(
            "{}/api/v1/projects/{project_id}",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Suppression du projet impossible : {error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        let status = response.status();
        let detail = response
            .json::<ApiError>()
            .await
            .ok()
            .and_then(|error| error.detail)
            .unwrap_or_else(|| format!("Le serveur a répondu avec le statut {status}."));
        Err(detail)
    }
}

#[tauri::command]
fn open_project_folder(path: String) -> Result<(), String> {
    let directory = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "Le dossier associé au projet est inaccessible.".to_string())?;
    if !directory.is_dir() {
        return Err("Le chemin associé n’est pas un dossier.".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        return open_linux_path(&directory);
    }
    #[allow(unreachable_code)]
    Err("L’ouverture du dossier est disponible sous Linux.".to_string())
}

#[cfg(target_os = "linux")]
fn open_linux_path(path: &Path) -> Result<(), String> {
    for program in ["gio", "xdg-open"] {
        let status = if program == "gio" {
            Command::new(program)
                .arg("open")
                .arg(path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
        } else {
            Command::new(program)
                .arg(path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
        };
        if status.is_ok_and(|value| value.success()) {
            return Ok(());
        }
    }

    let converted = Command::new("wslpath")
        .arg("-w")
        .arg(path)
        .output()
        .map_err(|error| format!("Conversion du chemin WSL impossible : {error}"))?;
    if !converted.status.success() {
        return Err("Conversion du chemin WSL impossible.".to_string());
    }
    let windows_path = String::from_utf8_lossy(&converted.stdout)
        .trim()
        .to_string();
    let argument = if path.is_file() {
        format!("/select,{windows_path}")
    } else {
        windows_path
    };
    for explorer in ["/mnt/c/Windows/explorer.exe", "explorer.exe"] {
        if Command::new(explorer)
            .arg(&argument)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    Err("Impossible de lancer l’Explorateur Windows depuis WSL.".to_string())
}

#[tauri::command]
fn open_project_file(root_path: String, relative_path: String) -> Result<(), String> {
    let root = PathBuf::from(root_path)
        .canonicalize()
        .map_err(|_| "Le dossier source est inaccessible.".to_string())?;
    let relative = safe_relative_path(&relative_path)?;
    let file = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "Le document est inaccessible.".to_string())?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("Le document demandé est invalide.".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        return open_linux_path(&file);
    }
    #[allow(unreachable_code)]
    Err("L’ouverture du document est disponible sous Linux.".to_string())
}

fn project_directory(root_path: &str, relative_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = PathBuf::from(root_path)
        .canonicalize()
        .map_err(|_| "Le dossier source est inaccessible sur ce PC.".to_string())?;
    if !root.is_dir() {
        return Err("Le dossier source du projet est invalide.".to_string());
    }
    let relative = safe_relative_path(relative_path)?;
    if relative.starts_with(".clairdoc") {
        return Err("Le dossier interne de ClairDoc est protégé.".to_string());
    }
    let mut checked = root.clone();
    for component in relative.components() {
        checked.push(component);
        if fs::symlink_metadata(&checked)
            .map_err(|_| "Le dossier demandé est inaccessible.".to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Les liens symboliques ne sont pas explorés par ClairDoc.".to_string());
        }
    }
    let directory = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "Le dossier demandé est inaccessible.".to_string())?;
    if !directory.starts_with(&root) || !directory.is_dir() {
        return Err("Le dossier demandé sort du projet.".to_string());
    }
    Ok((root, directory))
}

#[tauri::command]
fn list_project_directory(
    root_path: String,
    relative_path: String,
    offset: usize,
    limit: usize,
) -> Result<ProjectDirectoryPage, String> {
    let (root, directory) = project_directory(&root_path, &relative_path)?;
    let mut entries = Vec::new();
    for item in fs::read_dir(&directory)
        .map_err(|error| format!("Lecture du dossier impossible : {error}"))?
    {
        let item = item.map_err(|error| format!("Lecture du dossier impossible : {error}"))?;
        let file_type = item.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink()
            || (!file_type.is_dir() && !file_type.is_file())
            || item.file_name() == ".clairdoc"
        {
            continue;
        }
        let path = item.path();
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| "Chemin invalide dans le projet.")?;
        entries.push(ProjectDirectoryEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            relative_path: relative.to_string_lossy().replace('\\', "/"),
            kind: if file_type.is_dir() {
                "directory"
            } else {
                "file"
            }
            .to_string(),
            bytes: if file_type.is_file() {
                item.metadata().map(|value| value.len()).unwrap_or(0)
            } else {
                0
            },
        });
    }
    entries.sort_by(|left, right| {
        (left.kind != "directory")
            .cmp(&(right.kind != "directory"))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    let total = entries.len();
    let limit = limit.clamp(1, 200);
    let entries = entries.into_iter().skip(offset).take(limit).collect();
    Ok(ProjectDirectoryPage {
        entries,
        total,
        offset,
        limit,
    })
}

#[tauri::command]
fn create_project_directory(
    root_path: String,
    relative_path: String,
    name: String,
) -> Result<(), String> {
    let (_, parent) = project_directory(&root_path, &relative_path)?;
    let part = safe_relative_path(name.trim())?;
    if part.components().count() != 1 || part == Path::new(".clairdoc") {
        return Err("Indiquez un nom de dossier simple et valide.".to_string());
    }
    fs::create_dir(parent.join(part))
        .map_err(|error| format!("Création du dossier impossible : {error}"))
}

#[tauri::command]
fn remove_empty_project_directory(root_path: String, relative_path: String) -> Result<(), String> {
    if relative_path.is_empty() {
        return Err("Le dossier racine du projet ne peut pas être supprimé.".to_string());
    }
    let (root, directory) = project_directory(&root_path, &relative_path)?;
    if directory == root {
        return Err("Le dossier racine du projet ne peut pas être supprimé.".to_string());
    }
    fs::remove_dir(directory)
        .map_err(|_| "Ce dossier n'est pas vide ou ne peut pas être supprimé.".to_string())
}

#[tauri::command]
fn open_project_directory(root_path: String, relative_path: String) -> Result<(), String> {
    let (_, directory) = project_directory(&root_path, &relative_path)?;
    #[cfg(target_os = "linux")]
    {
        return open_linux_path(&directory);
    }
    #[allow(unreachable_code)]
    Err("L'ouverture du dossier est disponible sous Linux.".to_string())
}

#[tauri::command]
async fn get_runtime_info(app: AppHandle) -> Result<RuntimeInfoResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(20))?
        .get(format!("{}/api/v1/runtime", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Informations serveur indisponibles : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn get_project_source_access(
    app: AppHandle,
    project_id: String,
) -> Result<serde_json::Value, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .get(format!(
            "{}/api/v1/projects/{project_id}/source-access",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Vérification du dossier impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn update_runtime_model(
    app: AppHandle,
    llm_model: String,
) -> Result<RuntimeInfoResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(20))?
        .patch(format!("{}/api/v1/runtime", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .json(&serde_json::json!({ "llm_model": llm_model }))
        .send()
        .await
        .map_err(|error| format!("Changement de modèle impossible : {error}"))?;
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
async fn update_runtime_embeddings(
    app: AppHandle,
    provider: String,
) -> Result<RuntimeInfoResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(20))?
        .patch(format!("{}/api/v1/runtime", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .json(&serde_json::json!({ "embedding_provider": provider }))
        .send()
        .await
        .map_err(|error| format!("Changement d'embeddings impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn submit_ocr_job(
    app: AppHandle,
    path: String,
    project_id: Option<String>,
    source_relative_path: Option<String>,
) -> Result<OcrJobResponse, String> {
    let pdf_path = PathBuf::from(&path);
    if !pdf_path.is_file()
        || pdf_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !supported_document_extension(extension))
    {
        return Err("Sélectionnez un document pris en charge et accessible.".to_string());
    }

    let config = read_server_config(&app)?;
    let form = multipart::Form::new()
        .file("file", &pdf_path)
        .await
        .map_err(|error| format!("Impossible de lire le PDF : {error}"))?;
    let client = api_client(Duration::from_secs(7200))?;
    let mut request = client
        .post(format!("{}/api/v1/document/jobs", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .multipart(form);
    if let Some(project_id) = project_id {
        request = request.query(&[("project_id", project_id)]);
    }
    if let Some(source_relative_path) = source_relative_path {
        request = request.query(&[("source_relative_path", source_relative_path)]);
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
async fn estimate_project_index(
    app: AppHandle,
    project_id: String,
) -> Result<IndexEstimate, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(120))?
        .get(format!(
            "{}/api/v1/projects/{project_id}/index/estimate",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Estimation de l’index impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn start_index_project(
    app: AppHandle,
    project_id: String,
) -> Result<IndexTaskResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .post(format!(
            "{}/api/v1/projects/{project_id}/index/jobs",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Démarrage de l’indexation impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn get_index_task(app: AppHandle, task_id: String) -> Result<IndexTaskResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .get(format!("{}/api/v1/index/jobs/{task_id}", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Suivi de l’indexation impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn retry_index_task(app: AppHandle, task_id: String) -> Result<IndexTaskResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .post(format!(
            "{}/api/v1/index/jobs/{task_id}/retry",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Relance de l’indexation impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn create_server_backup(app: AppHandle) -> Result<BackupResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(120))?
        .post(format!("{}/api/v1/maintenance/backups", config.server_url))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Sauvegarde des métadonnées impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn list_project_documents(
    app: AppHandle,
    project_id: String,
) -> Result<DocumentLibraryResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .get(format!(
            "{}/api/v1/projects/{project_id}/documents",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Chargement de la bibliothèque impossible : {error}"))?;
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

#[tauri::command]
async fn list_conversations(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<ConversationSummaryResponse>, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .get(format!(
            "{}/api/v1/projects/{project_id}/conversations",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Chargement des conversations impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn create_conversation(
    app: AppHandle,
    project_id: String,
    title: Option<String>,
) -> Result<ConversationResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .post(format!(
            "{}/api/v1/projects/{project_id}/conversations",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .json(&serde_json::json!({ "title": title }))
        .send()
        .await
        .map_err(|error| format!("Création de la conversation impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn get_conversation(
    app: AppHandle,
    project_id: String,
    conversation_id: String,
) -> Result<ConversationResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .get(format!(
            "{}/api/v1/projects/{project_id}/conversations/{conversation_id}",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Chargement de la conversation impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn delete_conversation(
    app: AppHandle,
    project_id: String,
    conversation_id: String,
) -> Result<(), String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .delete(format!(
            "{}/api/v1/projects/{project_id}/conversations/{conversation_id}",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Suppression de la conversation impossible : {error}"))?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Le serveur a répondu avec le statut {}.",
            response.status()
        ))
    }
}

#[tauri::command]
async fn send_conversation_message(
    app: AppHandle,
    project_id: String,
    conversation_id: String,
    question: String,
    allow_write_actions: bool,
) -> Result<AskResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(300))?
        .post(format!(
            "{}/api/v1/projects/{project_id}/conversations/{conversation_id}/messages",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .json(&serde_json::json!({
            "question": question,
            "allow_write_actions": allow_write_actions
        }))
        .send()
        .await
        .map_err(|error| format!("Message impossible : {error}"))?;
    parse_api_response(response).await
}

fn safe_local_parent(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let parent = root
        .join(relative)
        .parent()
        .ok_or("Dossier de destination invalide.")?
        .to_path_buf();
    let mut existing = parent.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or("Dossier de destination invalide.")?;
    }
    let canonical = existing.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.starts_with(root) {
        return Err("La destination sort du dossier du projet.".to_string());
    }
    fs::create_dir_all(&parent)
        .map_err(|error| format!("Création du dossier impossible : {error}"))?;
    let canonical = parent.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.starts_with(root) {
        return Err("La destination sort du dossier du projet.".to_string());
    }
    Ok(canonical)
}

fn copy_without_replacing(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = fs::File::open(source).map_err(|error| error.to_string())?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| format!("La destination existe déjà ou n'est pas accessible : {error}"))?;
    if let Err(error) = std::io::copy(&mut input, &mut output) {
        drop(output);
        let _ = fs::remove_file(destination);
        return Err(format!("Copie impossible : {error}"));
    }
    Ok(())
}

fn perform_local_file_action(
    root_path: &str,
    action: &AssistantActionResponse,
) -> Result<(), String> {
    if action.status != "pending_local" {
        return Err("Cette action n'est plus en attente.".to_string());
    }
    let root = PathBuf::from(root_path)
        .canonicalize()
        .map_err(|_| "Le dossier source est inaccessible sur ce PC.".to_string())?;
    let source_relative = safe_relative_path(
        action
            .source_relative_path
            .as_deref()
            .ok_or("Chemin source absent.")?,
    )?;
    if source_relative.starts_with(".clairdoc") {
        return Err("Le dossier interne de ClairDoc est protégé.".to_string());
    }
    let expected = action
        .expected_sha256
        .as_deref()
        .ok_or("Empreinte source absente.")?;
    let source = root.join(&source_relative);
    let destination_relative = match action.tool.as_str() {
        "copy_document" | "move_document" => safe_relative_path(
            action
                .arguments
                .get("destination")
                .and_then(|value| value.as_str())
                .ok_or("Destination absente.")?,
        )?,
        "rename_document" => {
            let name = action
                .arguments
                .get("new_name")
                .and_then(|value| value.as_str())
                .ok_or("Nouveau nom absent.")?;
            let part = safe_relative_path(name)?;
            if part.components().count() != 1 || Path::new(name).extension() != source.extension() {
                return Err("Le nom doit conserver le dossier et l'extension.".to_string());
            }
            source_relative.parent().unwrap_or(Path::new("")).join(part)
        }
        "delete_document" => {
            let id = action.id.as_deref().ok_or("Identifiant d'action absent.")?;
            if safe_relative_path(id)?.components().count() != 1 {
                return Err("Identifiant d'action invalide.".to_string());
            }
            PathBuf::from(".clairdoc/trash").join(format!(
                "{id}-{}",
                source
                    .file_name()
                    .ok_or("Nom source invalide.")?
                    .to_string_lossy()
            ))
        }
        _ => return Err("Action locale non prise en charge.".to_string()),
    };
    if destination_relative == source_relative
        || (action.tool != "delete_document" && destination_relative.starts_with(".clairdoc"))
    {
        return Err("Destination invalide ou réservée à ClairDoc.".to_string());
    }
    let destination = root.join(&destination_relative);
    if source.exists() {
        let canonical = source.canonicalize().map_err(|error| error.to_string())?;
        if !canonical.starts_with(&root)
            || !canonical.is_file()
            || sha256_file(&canonical)? != expected
        {
            return Err("Le fichier source a changé depuis l'import. Action annulée.".to_string());
        }
        safe_local_parent(&root, &destination_relative)?;
        if destination.exists() {
            if action.tool == "copy_document"
                && destination.is_file()
                && sha256_file(&destination)? == expected
            {
                return Ok(());
            }
            return Err("La destination existe déjà. Aucun fichier n'a été remplacé.".to_string());
        }
        if action.tool == "copy_document" {
            copy_without_replacing(&canonical, &destination)?;
            if sha256_file(&destination)? != expected {
                let _ = fs::remove_file(&destination);
                return Err("Le fichier a changé pendant la copie ; action annulée.".to_string());
            }
        } else {
            // Créer la destination sans remplacement atomique, puis retirer la source.
            if fs::hard_link(&canonical, &destination).is_err() {
                copy_without_replacing(&canonical, &destination)?;
            }
            if sha256_file(&destination)? != expected {
                let _ = fs::remove_file(&destination);
                return Err(
                    "Le fichier a changé pendant le déplacement ; action annulée.".to_string(),
                );
            }
            fs::remove_file(&canonical).map_err(|error| {
                format!("Destination créée mais suppression de la source impossible : {error}")
            })?;
        }
        return Ok(());
    }
    // Reprise après une coupure entre l'opération locale et sa confirmation par le serveur.
    if destination.is_file()
        && destination
            .canonicalize()
            .map_err(|error| error.to_string())?
            .starts_with(&root)
        && sha256_file(&destination)? == expected
    {
        return Ok(());
    }
    Err("Le fichier source est introuvable ; l'action n'a pas été confirmée.".to_string())
}

#[tauri::command]
async fn apply_local_assistant_action(
    app: AppHandle,
    project_id: String,
    conversation_id: String,
    action_id: String,
) -> Result<AssistantActionResponse, String> {
    let config = read_server_config(&app)?;
    let client = api_client(Duration::from_secs(60))?;
    let response = client
        .get(format!(
            "{}/api/v1/projects/{project_id}",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Projet inaccessible : {error}"))?;
    let project: ProjectResponse = parse_api_response(response).await?;
    let root = project
        .source_root
        .ok_or("Ce projet n'a pas de dossier local.")?;
    let conversation =
        get_conversation(app.clone(), project_id.clone(), conversation_id.clone()).await?;
    let action = conversation
        .messages
        .iter()
        .flat_map(|message| &message.actions)
        .find(|action| action.id.as_deref() == Some(action_id.as_str()))
        .cloned()
        .ok_or("Action introuvable dans cette conversation.")?;
    tauri::async_runtime::spawn_blocking(move || perform_local_file_action(&root, &action))
        .await
        .map_err(|error| format!("Action locale interrompue : {error}"))??;
    let response = client.post(format!(
        "{}/api/v1/projects/{project_id}/conversations/{conversation_id}/local-actions/{action_id}/complete",
        config.server_url
    )).header("X-ClairDoc-Key", &config.api_key).send().await
        .map_err(|error| format!("Fichier modifié, mais confirmation serveur impossible : {error}. Réessayez cette action."))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn get_project_draft(
    app: AppHandle,
    project_id: String,
) -> Result<serde_json::Value, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .get(format!(
            "{}/api/v1/projects/{project_id}/draft",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Brouillon inaccessible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn cancel_local_assistant_action(
    app: AppHandle,
    project_id: String,
    conversation_id: String,
    action_id: String,
) -> Result<AssistantActionResponse, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(30))?
        .delete(format!(
            "{}/api/v1/projects/{project_id}/conversations/{conversation_id}/local-actions/{action_id}",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send().await.map_err(|error| format!("Retrait du brouillon impossible : {error}"))?;
    parse_api_response(response).await
}

#[tauri::command]
async fn create_organization_plan(
    app: AppHandle,
    project_id: String,
    rename_files: bool,
) -> Result<OrganizationPlan, String> {
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(7200))?
        .post(format!(
            "{}/api/v1/projects/{project_id}/organization/plan",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .json(&serde_json::json!({ "rename_files": rename_files }))
        .send()
        .await
        .map_err(|error| format!("Préparation du classement impossible : {error}"))?;
    parse_api_response(response).await
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Un chemin proposé est invalide.".to_string());
    }
    Ok(path)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Impossible de vérifier {} : {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Lecture impossible : {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn available_destination(path: PathBuf) -> Result<PathBuf, String> {
    if !path.exists() {
        return Ok(path);
    }
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let extension = path.extension().and_then(|value| value.to_str());
    for suffix in 2..10000 {
        let name = match extension {
            Some(extension) => format!("{stem}_{suffix}.{extension}"),
            None => format!("{stem}_{suffix}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Trop de fichiers portent déjà le même nom dans la destination.".to_string())
}

async fn apply_organization_plan_inner(
    app: Option<&AppHandle>,
    root_path: String,
    output_path: String,
    entries: Vec<OrganizationEntry>,
    mode: String,
) -> Result<ApplyResult, String> {
    if !matches!(mode.as_str(), "copy" | "move") {
        return Err("Mode de classement invalide.".to_string());
    }
    let root = PathBuf::from(root_path)
        .canonicalize()
        .map_err(|_| "Le dossier source est inaccessible.".to_string())?;
    let output = PathBuf::from(output_path)
        .canonicalize()
        .map_err(|_| "Le dossier de destination est inaccessible.".to_string())?;
    if output == root || output.starts_with(&root) {
        return Err("Choisissez un dossier de destination séparé du dossier source.".to_string());
    }

    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Horloge système invalide.".to_string())?
        .as_secs();
    let backup_root = output
        .join(".clairdoc")
        .join("originals")
        .join(created_at.to_string());
    let mut prepared = Vec::new();
    for entry in entries {
        let source_relative = safe_relative_path(&entry.source_relative_path)?;
        let source = root.join(source_relative).canonicalize().map_err(|_| {
            format!(
                "Document source introuvable : {}",
                entry.source_relative_path
            )
        })?;
        if !source.starts_with(&root) || !source.is_file() {
            return Err("Un document source sort du dossier sélectionné.".to_string());
        }
        let destination_relative = safe_relative_path(&entry.suggested_path)?;
        let destination = available_destination(output.join(destination_relative))?;
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Création du dossier impossible : {error}"))?;
        }
        prepared.push((entry, source, destination));
    }

    let mut manifest_entries = Vec::new();
    let mut created_paths = Vec::new();
    let has_pdf = prepared.iter().any(|(_, source, _)| {
        source
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
    });
    let remote = if has_pdf {
        let app = app.ok_or_else(|| "Application ClairDoc indisponible.".to_string())?;
        Some((
            read_server_config(app)?,
            api_client(Duration::from_secs(7200))?,
        ))
    } else {
        None
    };
    for (entry, source, destination) in &prepared {
        let is_pdf = source
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pdf"));
        let write_result = if is_pdf {
            let (config, client) = remote.as_ref().expect("PDF client configured");
            let response = client
                .get(format!(
                    "{}/api/v1/ocr/jobs/{}/document",
                    config.server_url, entry.job_id
                ))
                .header("X-ClairDoc-Key", &config.api_key)
                .send()
                .await
                .map_err(|error| format!("Téléchargement du PDF OCRisé impossible : {error}"))?;
            if !response.status().is_success() {
                return Err(format!(
                    "La version OCRisée de {} n’est pas disponible.",
                    entry.original_filename
                ));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|error| format!("Lecture du PDF OCRisé impossible : {error}"))?;
            fs::write(destination, bytes)
        } else {
            fs::copy(source, destination).map(|_| ())
        };
        if let Err(error) = write_result {
            for created in &created_paths {
                let _ = fs::remove_file(created);
            }
            return Err(format!(
                "Copie de {} impossible : {error}",
                source.display()
            ));
        }
        created_paths.push(destination.clone());
        let sha256 = match sha256_file(destination) {
            Ok(value) => value,
            Err(error) => {
                for created in &created_paths {
                    let _ = fs::remove_file(created);
                }
                return Err(error);
            }
        };
        manifest_entries.push(ManifestEntry {
            source: source.display().to_string(),
            destination: destination.display().to_string(),
            sha256,
            source_backup: None,
        });
    }

    if mode == "move" {
        fs::create_dir_all(&backup_root).map_err(|error| {
            format!("Création de la sauvegarde de sécurité impossible : {error}")
        })?;
        for (index, (_, source, _)) in prepared.iter().enumerate() {
            let backup = backup_root.join(format!(
                "{index:06}-{}",
                source.file_name().unwrap_or_default().to_string_lossy()
            ));
            fs::copy(source, &backup).map_err(|error| {
                format!("Sauvegarde de {} impossible : {error}", source.display())
            })?;
            manifest_entries[index].source_backup = Some(backup.display().to_string());
        }
        let mut removed_sources: Vec<(PathBuf, PathBuf)> = Vec::new();
        for (index, (_, source, _)) in prepared.iter().enumerate() {
            if let Err(error) = fs::remove_file(source) {
                for (removed, backup) in removed_sources {
                    let _ = fs::copy(backup, removed);
                }
                return Err(format!(
                    "Nettoyage de {} impossible : {error}",
                    source.display()
                ));
            }
            let backup = PathBuf::from(manifest_entries[index].source_backup.as_ref().unwrap());
            removed_sources.push((source.clone(), backup));
        }
    }

    let manifest = OperationManifest {
        created_at,
        mode,
        entries: manifest_entries,
    };
    let manifest_directory = output.join(".clairdoc").join("operations");
    fs::create_dir_all(&manifest_directory)
        .map_err(|error| format!("Création du journal impossible : {error}"))?;
    let manifest_path = manifest_directory.join(format!("classement-{created_at}.json"));
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("Journal invalide : {error}"))?,
    )
    .map_err(|error| format!("Écriture du journal impossible : {error}"))?;
    Ok(ApplyResult {
        manifest_path: manifest_path.display().to_string(),
        copied: manifest.entries.len(),
    })
}

#[tauri::command]
async fn apply_organization_plan(
    app: AppHandle,
    root_path: String,
    output_path: String,
    entries: Vec<OrganizationEntry>,
    mode: String,
) -> Result<ApplyResult, String> {
    apply_organization_plan_inner(Some(&app), root_path, output_path, entries, mode).await
}

#[tauri::command]
fn undo_organization(manifest_path: String) -> Result<UndoResult, String> {
    let manifest_path = PathBuf::from(manifest_path)
        .canonicalize()
        .map_err(|_| "Le journal de classement est introuvable.".to_string())?;
    let output_root = manifest_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "Emplacement du journal invalide.".to_string())?
        .to_path_buf();
    let manifest: OperationManifest = serde_json::from_slice(
        &fs::read(&manifest_path)
            .map_err(|error| format!("Lecture du journal impossible : {error}"))?,
    )
    .map_err(|error| format!("Journal illisible : {error}"))?;

    let mut removed = 0;
    let mut skipped = 0;
    for entry in manifest.entries {
        let destination = PathBuf::from(&entry.destination);
        let Ok(canonical) = destination.canonicalize() else {
            skipped += 1;
            continue;
        };
        if !canonical.starts_with(&output_root) || sha256_file(&canonical)? != entry.sha256 {
            skipped += 1;
            continue;
        }
        let restoration = if manifest.mode == "move" {
            let source = PathBuf::from(&entry.source);
            let backup = entry.source_backup.as_deref().map(PathBuf::from);
            if source.exists() || backup.as_ref().is_none_or(|path| !path.is_file()) {
                skipped += 1;
                continue;
            }
            Some((source, backup.expect("checked backup")))
        } else {
            None
        };
        fs::remove_file(&canonical)
            .map_err(|error| format!("Suppression de la copie impossible : {error}"))?;
        if let Some((source, backup)) = restoration {
            if let Some(parent) = source.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Restauration du dossier impossible : {error}"))?;
            }
            fs::copy(&backup, &source)
                .map_err(|error| format!("Restauration de l’original impossible : {error}"))?;
            let _ = fs::remove_file(backup);
        }
        removed += 1;
    }
    Ok(UndoResult { removed, skipped })
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
    let mut pending = vec![root.clone()];

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

fn supported_document_extension(extension: &str) -> bool {
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "pdf"
            | "txt"
            | "md"
            | "csv"
            | "tsv"
            | "log"
            | "docx"
            | "xlsx"
            | "pptx"
            | "eml"
            | "png"
            | "jpg"
            | "jpeg"
            | "tif"
            | "tiff"
            | "bmp"
            | "webp"
    )
}

#[tauri::command]
fn list_document_files(path: String) -> Result<Vec<DocumentFile>, String> {
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "Le dossier sélectionné est introuvable ou inaccessible.".to_string())?;
    if !root.is_dir() {
        return Err("L’emplacement sélectionné n’est pas un dossier.".to_string());
    }

    let mut files = Vec::new();
    let mut pending = vec![root.clone()];
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
                if entry.file_name() == ".clairdoc" {
                    continue;
                }
                pending.push(entry.path());
                continue;
            }
            let file_path = entry.path();
            let is_supported = file_path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(supported_document_extension);
            if file_type.is_file() && is_supported {
                let relative_path = file_path
                    .strip_prefix(&root)
                    .map_err(|_| "Chemin de document invalide.".to_string())?;
                files.push(DocumentFile {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    bytes: entry.metadata().map(|metadata| metadata.len()).unwrap_or(0),
                    path: file_path.display().to_string(),
                    relative_path: relative_path.to_string_lossy().replace('\\', "/"),
                });
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    if Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists()
        || std::env::var_os("WSL_DISTRO_NAME").is_some()
    {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        std::env::set_var("GALLIUM_DRIVER", "llvmpipe");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            get_server_config,
            configure_server,
            test_server_connection,
            create_remote_project,
            update_remote_project,
            delete_remote_project,
            open_project_folder,
            open_project_file,
            list_project_directory,
            create_project_directory,
            remove_empty_project_directory,
            open_project_directory,
            get_runtime_info,
            get_project_source_access,
            update_runtime_model,
            update_runtime_embeddings,
            list_remote_projects,
            submit_ocr_job,
            get_ocr_job,
            list_project_jobs,
            pause_project_ocr,
            resume_project_ocr,
            retry_ocr_job,
            get_ocr_text,
            index_project,
            estimate_project_index,
            start_index_project,
            get_index_task,
            retry_index_task,
            create_server_backup,
            list_project_documents,
            ask_project,
            list_conversations,
            create_conversation,
            get_conversation,
            delete_conversation,
            send_conversation_message,
            apply_local_assistant_action,
            get_project_draft,
            cancel_local_assistant_action,
            list_document_files,
            create_organization_plan,
            apply_organization_plan,
            undo_organization
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_explorer_pages_entries_and_protects_folders() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("clairdoc-explorer-{unique}"));
        fs::create_dir_all(root.join("a/b/c/d")).expect("nested directory");
        fs::create_dir_all(root.join(".clairdoc/trash")).expect("internal directory");
        fs::write(root.join("note.txt"), b"note").expect("document");
        let first = list_project_directory(root.display().to_string(), "".to_string(), 0, 1)
            .expect("first page");
        assert_eq!(first.total, 2);
        assert_eq!(first.entries[0].name, "a");
        let second = list_project_directory(root.display().to_string(), "".to_string(), 1, 1)
            .expect("second page");
        assert_eq!(second.entries[0].name, "note.txt");
        create_project_directory(
            root.display().to_string(),
            "a/b/c/d".to_string(),
            "new".to_string(),
        )
        .expect("create nested");
        assert!(root.join("a/b/c/d/new").is_dir());
        assert!(
            remove_empty_project_directory(root.display().to_string(), "a".to_string()).is_err()
        );
        remove_empty_project_directory(root.display().to_string(), "a/b/c/d/new".to_string())
            .expect("remove empty");
        assert!(project_directory(root.to_str().expect("path"), "../outside").is_err());
        assert!(project_directory(root.to_str().expect("path"), ".clairdoc/trash").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&root, root.join("shortcut")).expect("symlink");
            assert!(project_directory(root.to_str().expect("path"), "shortcut").is_err());
            assert!(remove_empty_project_directory(
                root.display().to_string(),
                "shortcut".to_string()
            )
            .is_err());
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_explorer_handles_many_entries_without_returning_all_at_once() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("clairdoc-explorer-many-{unique}"));
        fs::create_dir_all(&root).expect("root");
        for number in 0..205 {
            fs::write(root.join(format!("file-{number:03}.txt")), b"x").expect("file");
        }
        let first = list_project_directory(root.display().to_string(), "".to_string(), 0, 100)
            .expect("first page");
        let last = list_project_directory(root.display().to_string(), "".to_string(), 200, 100)
            .expect("last page");
        assert_eq!(first.total, 205);
        assert_eq!(first.entries.len(), 100);
        assert_eq!(last.entries.len(), 5);
        let _ = fs::remove_dir_all(root);
    }

    fn local_action(
        tool: &str,
        source: &str,
        arguments: serde_json::Value,
        hash: String,
    ) -> AssistantActionResponse {
        AssistantActionResponse {
            id: Some("action-1".to_string()),
            tool: tool.to_string(),
            status: "pending_local".to_string(),
            summary: "test".to_string(),
            arguments,
            source_relative_path: Some(source.to_string()),
            expected_sha256: Some(hash),
        }
    }

    #[test]
    fn local_assistant_rename_requires_hash_and_never_overwrites() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("clairdoc-local-action-{unique}"));
        fs::create_dir_all(&root).expect("root");
        let source = root.join("scan.txt");
        fs::write(&source, b"original").expect("source");
        let action = local_action(
            "rename_document",
            "scan.txt",
            serde_json::json!({"new_name":"memo.txt"}),
            sha256_file(&source).expect("hash"),
        );
        fs::write(root.join("memo.txt"), b"existing").expect("destination");
        assert!(perform_local_file_action(root.to_str().expect("path"), &action).is_err());
        assert_eq!(
            fs::read(root.join("memo.txt")).expect("unchanged"),
            b"existing"
        );
        fs::remove_file(root.join("memo.txt")).expect("clear destination");
        fs::write(&source, b"changed").expect("changed source");
        assert!(perform_local_file_action(root.to_str().expect("path"), &action).is_err());
        fs::write(&source, b"original").expect("restore source");
        perform_local_file_action(root.to_str().expect("path"), &action).expect("rename");
        assert!(!source.exists());
        assert_eq!(
            fs::read(root.join("memo.txt")).expect("renamed"),
            b"original"
        );
        perform_local_file_action(root.to_str().expect("path"), &action)
            .expect("retry after interruption");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_assistant_rejects_parent_traversal() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("clairdoc-local-path-{unique}"));
        fs::create_dir_all(&root).expect("root");
        let source = root.join("scan.txt");
        fs::write(&source, b"original").expect("source");
        let action = local_action(
            "move_document",
            "scan.txt",
            serde_json::json!({"destination":"../outside.txt"}),
            sha256_file(&source).expect("hash"),
        );
        assert!(perform_local_file_action(root.to_str().expect("path"), &action).is_err());
        assert!(source.is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_assistant_copy_keeps_original_and_skips_internal_trash_on_import() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("clairdoc-local-copy-{unique}"));
        fs::create_dir_all(root.join(".clairdoc/trash")).expect("trash");
        fs::write(root.join(".clairdoc/trash/old.txt"), b"deleted").expect("trash file");
        fs::write(root.join("scan.txt"), b"original").expect("source");
        let hash = sha256_file(&root.join("scan.txt")).expect("hash");
        let action = local_action(
            "copy_document",
            "scan.txt",
            serde_json::json!({"destination":"copies/scan.txt"}),
            hash,
        );
        perform_local_file_action(root.to_str().expect("path"), &action).expect("copy");
        assert_eq!(
            fs::read(root.join("scan.txt")).expect("original"),
            b"original"
        );
        assert_eq!(
            fs::read(root.join("copies/scan.txt")).expect("copy"),
            b"original"
        );
        let listed = list_document_files(root.display().to_string()).expect("list");
        assert_eq!(listed.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn organization_copy_keeps_source_and_can_be_undone() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let base = std::env::temp_dir().join(format!("clairdoc-organization-{unique}"));
        let source_root = base.join("source");
        let output_root = base.join("output");
        fs::create_dir_all(source_root.join("incoming")).expect("source directory");
        fs::create_dir_all(&output_root).expect("output directory");
        let source = source_root.join("incoming").join("scan.txt");
        fs::write(&source, b"document original").expect("source file");

        let result = tauri::async_runtime::block_on(apply_organization_plan_inner(
            None,
            source_root.display().to_string(),
            output_root.display().to_string(),
            vec![OrganizationEntry {
                job_id: "job-1".to_string(),
                original_filename: "scan.txt".to_string(),
                source_relative_path: "incoming/scan.txt".to_string(),
                suggested_path: "Factures/2026/2026-01-01_facture.txt".to_string(),
                category: "Factures".to_string(),
                document_date: Some("2026-01-01".to_string()),
                organization: None,
                reason: "test".to_string(),
            }],
            "copy".to_string(),
        ))
        .expect("apply plan");

        assert!(source.is_file());
        assert!(output_root
            .join("Factures/2026/2026-01-01_facture.txt")
            .is_file());
        let undone = undo_organization(result.manifest_path).expect("undo");
        assert_eq!(undone.removed, 1);
        assert!(source.is_file());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn organization_rejects_parent_traversal() {
        assert!(safe_relative_path("../outside.txt").is_err());
    }

    #[test]
    fn organization_move_removes_then_restores_source() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let base = std::env::temp_dir().join(format!("clairdoc-move-{unique}"));
        let source_root = base.join("source");
        let output_root = base.join("output");
        fs::create_dir_all(&source_root).expect("source directory");
        fs::create_dir_all(&output_root).expect("output directory");
        let source = source_root.join("scan.txt");
        fs::write(&source, b"document original").expect("source file");
        let result = tauri::async_runtime::block_on(apply_organization_plan_inner(
            None,
            source_root.display().to_string(),
            output_root.display().to_string(),
            vec![OrganizationEntry {
                job_id: "job-2".to_string(),
                original_filename: "scan.txt".to_string(),
                source_relative_path: "scan.txt".to_string(),
                suggested_path: "Autres/scan.txt".to_string(),
                category: "Autres".to_string(),
                document_date: None,
                organization: None,
                reason: "test".to_string(),
            }],
            "move".to_string(),
        ))
        .expect("move plan");

        assert!(!source.exists());
        assert!(output_root.join("Autres/scan.txt").is_file());
        let undone = undo_organization(result.manifest_path).expect("undo move");
        assert_eq!(undone.removed, 1);
        assert_eq!(
            fs::read(&source).expect("restored source"),
            b"document original"
        );
        let _ = fs::remove_dir_all(base);
    }
}
