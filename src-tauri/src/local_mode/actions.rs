use super::index::{doc_path, documents, index_dir, source_root, IndexedDocument};
use super::{data_dir, new_id, read_json, write_json};
use crate::{perform_local_file_action, safe_relative_path, sha256_file, AssistantActionResponse};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::AppHandle;

static DRAFT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Deserialize, Serialize)]
pub struct DraftAction {
    pub id: String,
    pub conversation_id: String,
    pub job_id: String,
    pub tool: String,
    pub summary: String,
    pub source_relative_path: String,
    pub destination_relative_path: Option<String>,
    pub expected_sha256: String,
}

#[derive(Default, Deserialize, Serialize)]
pub struct Draft {
    pub project_id: String,
    pub actions: Vec<DraftAction>,
}

#[derive(Deserialize)]
pub struct ProposedAction {
    pub job_id: String,
    pub tool: String,
    pub destination: String,
    pub new_name: String,
}

fn lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    DRAFT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Brouillon occupé.".to_string())
}

fn draft_path(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    source_root(app, project_id)?;
    Ok(data_dir(app)?
        .join("local-drafts")
        .join(format!("{project_id}.json")))
}

fn read_draft(app: &AppHandle, project_id: &str) -> Result<Draft, String> {
    let mut draft: Draft = read_json(&draft_path(app, project_id)?)?;
    if draft.project_id.is_empty() {
        draft.project_id = project_id.to_string();
    }
    if draft.project_id != project_id {
        return Err("Brouillon incohérent.".to_string());
    }
    Ok(draft)
}

fn write_draft(app: &AppHandle, draft: &Draft) -> Result<(), String> {
    write_json(&draft_path(app, &draft.project_id)?, draft)
}

#[tauri::command]
pub fn local_get_draft(app: AppHandle, project_id: String) -> Result<Draft, String> {
    let _guard = lock()?;
    read_draft(&app, &project_id)
}

fn virtual_paths(
    docs: &[IndexedDocument],
    actions: &[DraftAction],
) -> Result<(HashMap<String, String>, HashSet<String>), String> {
    let mut paths: HashMap<String, String> = docs
        .iter()
        .map(|doc| (doc.id.clone(), doc.relative_path.clone()))
        .collect();
    let mut occupied: HashSet<String> = paths.values().cloned().collect();
    for action in actions {
        let current = paths
            .get(&action.job_id)
            .ok_or("Document du brouillon introuvable.")?;
        if current != &action.source_relative_path {
            return Err("Chaîne de modifications incohérente.".to_string());
        }
        if matches!(
            action.tool.as_str(),
            "move_document" | "rename_document" | "delete_document"
        ) {
            occupied.remove(current);
            if let Some(destination) = &action.destination_relative_path {
                paths.insert(action.job_id.clone(), destination.clone());
            } else {
                paths.remove(&action.job_id);
            }
        }
        if let Some(destination) = &action.destination_relative_path {
            occupied.insert(destination.clone());
        }
    }
    Ok((paths, occupied))
}

fn prepare(
    app: &AppHandle,
    project_id: &str,
    conversation_id: &str,
    proposal: ProposedAction,
    current_actions: &[DraftAction],
) -> Result<DraftAction, String> {
    if !matches!(
        proposal.tool.as_str(),
        "copy_document" | "move_document" | "rename_document" | "delete_document"
    ) {
        return Err("Action non prise en charge.".to_string());
    }
    let docs = documents(app, project_id)?;
    let document = docs
        .iter()
        .find(|doc| doc.id == proposal.job_id)
        .ok_or("Document inconnu.")?;
    let (paths, occupied) = virtual_paths(&docs, current_actions)?;
    let source = paths
        .get(&proposal.job_id)
        .ok_or("Document déjà destiné à la corbeille.")?
        .clone();
    let source_path = safe_relative_path(&document.relative_path)?;
    let root = source_root(app, project_id)?;
    let physical = root
        .join(source_path)
        .canonicalize()
        .map_err(|_| "Fichier source introuvable.")?;
    if !physical.starts_with(&root) || !physical.is_file() {
        return Err("Fichier hors du projet.".to_string());
    }
    let extension = Path::new(&source)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let destination = match proposal.tool.as_str() {
        "rename_document" => {
            let name = safe_relative_path(&proposal.new_name)?;
            if name.components().count() != 1 {
                return Err("Le nouveau nom ne doit pas contenir de dossier.".to_string());
            }
            Some(
                Path::new(&source)
                    .parent()
                    .unwrap_or(Path::new(""))
                    .join(name)
                    .to_string_lossy()
                    .replace('\\', "/"),
            )
        }
        "copy_document" | "move_document" => Some(
            safe_relative_path(&proposal.destination)?
                .to_string_lossy()
                .replace('\\', "/"),
        ),
        _ => None,
    };
    if let Some(target) = &destination {
        if target == &source || target.starts_with(".clairdoc/") || occupied.contains(target) {
            return Err("Destination identique, réservée ou déjà utilisée.".to_string());
        }
        let target_extension = Path::new(target)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_lowercase();
        if target_extension != extension {
            return Err("Conservez l'extension du fichier.".to_string());
        }
        let target_path = root.join(safe_relative_path(target)?);
        if target_path.exists() {
            return Err("La destination existe déjà sur le disque.".to_string());
        }
    }
    let summary = match proposal.tool.as_str() {
        "copy_document" => "Copier",
        "move_document" => "Déplacer",
        "rename_document" => "Renommer",
        _ => "Mettre à la corbeille",
    };
    Ok(DraftAction {
        id: new_id(),
        conversation_id: conversation_id.to_string(),
        job_id: proposal.job_id,
        tool: proposal.tool,
        summary: format!(
            "{summary} {source}{}",
            destination
                .as_ref()
                .map(|path| format!(" → {path}"))
                .unwrap_or_default()
        ),
        source_relative_path: source,
        destination_relative_path: destination,
        expected_sha256: sha256_file(&physical)?,
    })
}

pub(super) fn stage(
    app: &AppHandle,
    project_id: &str,
    conversation_id: &str,
    proposals: Vec<ProposedAction>,
    allowed_ids: &HashSet<String>,
) -> Result<(Vec<DraftAction>, Vec<String>), String> {
    let _guard = lock()?;
    let mut draft = read_draft(app, project_id)?;
    let mut accepted = Vec::new();
    let mut errors = Vec::new();
    for proposal in proposals.into_iter().take(50) {
        if !allowed_ids.contains(&proposal.job_id) {
            errors.push("Document non présenté à l'assistant.".to_string());
            continue;
        }
        match prepare(app, project_id, conversation_id, proposal, &draft.actions) {
            Ok(action) => {
                draft.actions.push(action.clone());
                accepted.push(action);
            }
            Err(error) => errors.push(error),
        }
    }
    if !accepted.is_empty() {
        write_draft(app, &draft)?;
    }
    Ok((accepted, errors))
}

#[tauri::command]
pub fn local_cancel_draft_action(
    app: AppHandle,
    project_id: String,
    action_id: String,
) -> Result<Draft, String> {
    let _guard = lock()?;
    let mut draft = read_draft(&app, &project_id)?;
    let position = draft
        .actions
        .iter()
        .position(|action| action.id == action_id)
        .ok_or("Action introuvable.")?;
    let job = draft.actions[position].job_id.clone();
    if draft.actions[position + 1..]
        .iter()
        .any(|action| action.job_id == job)
    {
        return Err("Retirez d'abord les étapes suivantes de ce fichier.".to_string());
    }
    draft.actions.remove(position);
    write_draft(&app, &draft)?;
    Ok(draft)
}

#[tauri::command]
pub fn local_apply_draft_action(
    app: AppHandle,
    project_id: String,
    action_id: String,
) -> Result<Draft, String> {
    let _guard = lock()?;
    let mut draft = read_draft(&app, &project_id)?;
    let action = draft.actions.first().ok_or("Brouillon vide.")?.clone();
    if action.id != action_id {
        return Err("Appliquez les modifications dans l'ordre proposé.".to_string());
    }
    let root = source_root(&app, &project_id)?;
    let args = match action.tool.as_str() {
        "rename_document" => {
            serde_json::json!({"new_name":Path::new(action.destination_relative_path.as_deref().ok_or("Destination absente.")?).file_name().ok_or("Nom invalide.")?.to_string_lossy()})
        }
        "move_document" | "copy_document" => {
            serde_json::json!({"destination":action.destination_relative_path})
        }
        _ => serde_json::json!({}),
    };
    let executable = AssistantActionResponse {
        id: Some(action.id.clone()),
        tool: action.tool.clone(),
        status: "pending_local".to_string(),
        summary: action.summary.clone(),
        arguments: args,
        source_relative_path: Some(action.source_relative_path.clone()),
        expected_sha256: Some(action.expected_sha256.clone()),
    };
    let directory = index_dir(&app, &project_id)?;
    let document_path = doc_path(&directory, &action.job_id)?;
    let current_document: IndexedDocument = read_json(&document_path)?;
    if current_document.id != action.job_id
        || current_document.relative_path != action.source_relative_path
    {
        return Err(
            "L'index du document a changé ; rechargez le brouillon avant validation.".to_string(),
        );
    }
    perform_local_file_action(&root.display().to_string(), &executable)?;
    if action.tool == "delete_document" {
        fs::remove_file(&document_path).map_err(|error| {
            format!("Fichier déplacé, mais index local non mis à jour : {error}")
        })?;
    } else if matches!(action.tool.as_str(), "rename_document" | "move_document") {
        let mut document = current_document;
        let destination = action
            .destination_relative_path
            .as_deref()
            .ok_or("Destination absente.")?;
        document.relative_path = destination.to_string();
        document.name = Path::new(destination)
            .file_name()
            .ok_or("Nom invalide.")?
            .to_string_lossy()
            .to_string();
        write_json(&document_path, &document)?;
    }
    draft.actions.remove(0);
    write_draft(&app, &draft)?;
    Ok(draft)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn virtual_paths_follow_multiple_steps() {
        let docs = vec![IndexedDocument {
            id: "a".to_string(),
            relative_path: "one.pdf".to_string(),
            ..Default::default()
        }];
        let actions = vec![DraftAction {
            id: "1".to_string(),
            conversation_id: "c".to_string(),
            job_id: "a".to_string(),
            tool: "rename_document".to_string(),
            summary: String::new(),
            source_relative_path: "one.pdf".to_string(),
            destination_relative_path: Some("two.pdf".to_string()),
            expected_sha256: String::new(),
        }];
        let (paths, occupied) = virtual_paths(&docs, &actions).expect("chain");
        assert_eq!(paths["a"], "two.pdf");
        assert!(!occupied.contains("one.pdf"));
    }
}
