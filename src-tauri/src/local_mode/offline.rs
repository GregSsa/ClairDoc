use super::{
    data_dir, index, new_id, read_json, state_lock, state_path, write_json, LocalProject,
    LocalState,
};
use crate::{api_client, read_server_config};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::Duration};
use tauri::{AppHandle, Emitter};

const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Deserialize)]
struct Header {
    #[serde(rename = "type")]
    kind: String,
    format: String,
    project_id: String,
    project_name: String,
    embedding_provider: String,
    embedding_model: String,
    embedding_dimensions: usize,
    document_count: usize,
}

#[derive(Deserialize)]
struct Record {
    #[serde(rename = "type")]
    kind: String,
    document: ServerDocument,
}

#[derive(Deserialize)]
struct ServerDocument {
    job_id: String,
    document_name: String,
    source_relative_path: String,
    document_hash: String,
    indexing_mode: String,
    metadata: serde_json::Value,
    chunks: Vec<ServerChunk>,
}

#[derive(Deserialize)]
struct ServerChunk {
    text: String,
    embedding: Vec<f32>,
    page_number: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineSyncResult {
    project: LocalProject,
    documents: usize,
    embedding_provider: String,
    embedding_model: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineSyncProgress {
    project_id: String,
    imported: usize,
    total: usize,
    stage: &'static str,
}

fn valid_project_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn validate_header(header: &Header, project_id: &str) -> Result<(), String> {
    if header.kind != "header"
        || header.format != "clairdoc-index-1"
        || header.project_id != project_id
    {
        return Err("Le format de l'index exporté ne correspond pas au projet.".into());
    }
    if header.document_count > 100_000 || header.project_name.trim().is_empty() {
        return Err("L'index exporté est invalide ou trop volumineux.".into());
    }
    match header.embedding_provider.as_str() {
        "local"
            if header.embedding_model == index::LOCAL_MODEL
                && header.embedding_dimensions == 384 =>
        {
            Ok(())
        }
        "openai"
            if (256..=3072).contains(&header.embedding_dimensions)
                && matches!(
                    header.embedding_model.as_str(),
                    "text-embedding-3-small" | "text-embedding-3-large"
                ) =>
        {
            Ok(())
        }
        _ => Err(
            "Le modèle d'embeddings de cet index n'est pas compatible avec le mode autonome."
                .into(),
        ),
    }
}

fn import_line(
    line: &[u8],
    project_id: &str,
    stage: &Path,
    header: &mut Option<Header>,
    imported: &mut usize,
) -> Result<(), String> {
    if header.is_none() {
        let received: Header = serde_json::from_slice(line)
            .map_err(|error| format!("En-tête d'index illisible : {error}"))?;
        validate_header(&received, project_id)?;
        write_json(
            &stage.join("_config.json"),
            &index::IndexConfiguration {
                provider: received.embedding_provider.clone(),
                model: received.embedding_model.clone(),
                dimensions: received.embedding_dimensions,
            },
        )?;
        *header = Some(received);
        return Ok(());
    }
    let header = header.as_ref().unwrap();
    if *imported >= header.document_count {
        return Err("L'export contient plus de documents que prévu.".into());
    }
    let record: Record = serde_json::from_slice(line)
        .map_err(|error| format!("Document d'index illisible : {error}"))?;
    if record.kind != "document"
        || record.document.job_id.is_empty()
        || record.document.source_relative_path.is_empty()
    {
        return Err("Document d'index invalide.".into());
    }
    if record
        .document
        .chunks
        .iter()
        .any(|chunk| chunk.embedding.len() != header.embedding_dimensions)
    {
        return Err(format!(
            "Dimensions incohérentes pour {}.",
            record.document.document_name
        ));
    }
    let source = record.document;
    let id = index::doc_id(&source.source_relative_path);
    let content = source.indexing_mode == "content";
    let text = if content {
        source
            .chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .take(16_000)
            .collect()
    } else {
        String::new()
    };
    let metadata = &source.metadata;
    let strings = |key: &str| {
        metadata
            .get(key)
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let document = index::IndexedDocument {
        id: id.clone(),
        project_id: project_id.into(),
        relative_path: source.source_relative_path,
        name: source.document_name,
        fingerprint: format!("server:{}", source.document_hash),
        status: if content {
            "indexed".into()
        } else {
            "indexed_name".into()
        },
        analyzed: true,
        error: None,
        text,
        summary: String::new(),
        category: metadata
            .get("category")
            .and_then(|value| value.as_str())
            .unwrap_or("Autres")
            .into(),
        document_date: metadata
            .get("date")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        organization: metadata
            .get("organization")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        people: strings("people"),
        amounts: strings("amounts"),
        chunks: source
            .chunks
            .into_iter()
            .map(|chunk| index::IndexedChunk {
                text: chunk.text,
                vector: chunk.embedding,
                page_number: chunk.page_number,
            })
            .collect(),
    };
    write_json(&index::doc_path(stage, &id)?, &document)?;
    *imported += 1;
    Ok(())
}

#[tauri::command]
pub async fn sync_project_offline(
    app: AppHandle,
    project_id: String,
) -> Result<OfflineSyncResult, String> {
    if !valid_project_id(&project_id) {
        return Err("Identifiant de projet invalide.".into());
    }
    let config = read_server_config(&app)?;
    let response = api_client(Duration::from_secs(1800))?
        .get(format!(
            "{}/api/v1/projects/{project_id}/index/export",
            config.server_url
        ))
        .header("X-ClairDoc-Key", &config.api_key)
        .send()
        .await
        .map_err(|error| format!("Export de l'index impossible : {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "Export de l'index refusé ({status}). Vérifiez qu'il est déjà créé sur le serveur."
        ));
    }
    let parent = data_dir(&app)?.join("local-index");
    fs::create_dir_all(&parent).map_err(|error| format!("Cache local indisponible : {error}"))?;
    let stage = parent.join(format!("{project_id}.sync-{}", new_id()));
    fs::create_dir(&stage).map_err(|error| format!("Cache provisoire impossible : {error}"))?;
    let mut response = response;
    let mut pending = Vec::new();
    let mut header = None;
    let mut imported = 0;
    let transfer = async {
        while let Some(bytes) = response
            .chunk()
            .await
            .map_err(|error| format!("Transfert interrompu : {error}"))?
        {
            pending.extend_from_slice(&bytes);
            if pending.len() > MAX_LINE_BYTES && !pending.contains(&b'\n') {
                return Err("Une ligne de l'index dépasse la taille autorisée.".to_string());
            }
            while let Some(position) = pending.iter().position(|byte| *byte == b'\n') {
                if position > MAX_LINE_BYTES {
                    return Err("Un document d'index est trop volumineux.".into());
                }
                let line: Vec<u8> = pending.drain(..=position).collect();
                import_line(
                    &line[..position],
                    &project_id,
                    &stage,
                    &mut header,
                    &mut imported,
                )?;
                if let Some(meta) = &header {
                    if imported == 0 || imported % 50 == 0 || imported == meta.document_count {
                        let _ = app.emit(
                            "offline-sync-progress",
                            OfflineSyncProgress {
                                project_id: project_id.clone(),
                                imported,
                                total: meta.document_count,
                                stage: "transfer",
                            },
                        );
                    }
                }
            }
        }
        if !pending.is_empty() {
            return Err("Transfert de l'index incomplet.".into());
        }
        let meta = header.as_ref().ok_or("Export de l'index vide.")?;
        if imported != meta.document_count {
            return Err(format!(
                "Export incomplet : {imported}/{} documents.",
                meta.document_count
            ));
        }
        if meta.embedding_provider == "local" {
            let _ = app.emit(
                "offline-sync-progress",
                OfflineSyncProgress {
                    project_id: project_id.clone(),
                    imported,
                    total: meta.document_count,
                    stage: "model",
                },
            );
            index::warm_local_model(&app).await?;
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = transfer {
        let _ = fs::remove_dir_all(&stage);
        return Err(error);
    }
    let header = header.unwrap();
    let target = parent.join(&project_id);
    let backup = parent.join(format!("{project_id}.backup-{}", new_id()));
    let state_file = match state_path(&app) {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
    };
    let _guard = match state_lock() {
        Ok(guard) => guard,
        Err(error) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
    };
    let mut state: LocalState = match read_json(&state_file) {
        Ok(state) => state,
        Err(error) => {
            let _ = fs::remove_dir_all(&stage);
            return Err(error);
        }
    };
    if let Some(existing) = state.projects.iter().find(|item| item.id == project_id) {
        if existing.server_project_id.as_deref() != Some(&project_id) {
            let _ = fs::remove_dir_all(&stage);
            return Err("Un projet local différent possède déjà cet identifiant.".into());
        }
    }
    let had_target = target.exists();
    if had_target {
        if let Err(error) = fs::rename(&target, &backup) {
            let _ = fs::remove_dir_all(&stage);
            return Err(format!("Sauvegarde de l'ancien cache impossible : {error}"));
        }
    }
    if let Err(error) = fs::rename(&stage, &target) {
        if had_target {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("Installation du cache impossible : {error}"));
    }
    let name = header.project_name.chars().take(120).collect::<String>();
    let item = if let Some(existing) = state.projects.iter_mut().find(|item| item.id == project_id)
    {
        existing.name = name;
        existing.embedding_provider = Some(header.embedding_provider.clone());
        existing.clone()
    } else {
        let created = LocalProject {
            id: project_id.clone(),
            name,
            source_root: None,
            server_project_id: Some(project_id.clone()),
            embedding_provider: Some(header.embedding_provider.clone()),
        };
        state.projects.push(created.clone());
        created
    };
    if let Err(error) = write_json(&state_file, &state) {
        let _ = fs::remove_dir_all(&target);
        if had_target {
            let _ = fs::rename(&backup, &target);
        }
        return Err(error);
    }
    if had_target {
        let _ = fs::remove_dir_all(&backup);
    }
    index::invalidate_search_cache(&project_id);
    Ok(OfflineSyncResult {
        project: item,
        documents: imported,
        embedding_provider: header.embedding_provider,
        embedding_model: header.embedding_model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_server_passages_metadata_and_dimensions() {
        let id = "123e4567-e89b-12d3-a456-426614174000";
        let root = std::env::temp_dir().join(format!("clairdoc-export-test-{}", new_id()));
        fs::create_dir(&root).unwrap();
        let mut header = None;
        let mut count = 0;
        let heading = serde_json::json!({"type":"header","format":"clairdoc-index-1","project_id":id,"project_name":"Maison","embedding_provider":"openai","embedding_model":"text-embedding-3-small","embedding_dimensions":512,"document_count":1});
        import_line(
            heading.to_string().as_bytes(),
            id,
            &root,
            &mut header,
            &mut count,
        )
        .unwrap();
        let record = serde_json::json!({"type":"document","document":{"job_id":"a","document_name":"Facture.pdf","source_relative_path":"2025/Facture.pdf","document_hash":"abc","indexing_mode":"content","metadata":{"category":"Maison","date":"2025-05-09","organization":"EDF","people":["Alice"]},"chunks":[{"text":"Facture d'électricité","embedding":vec![0.1; 512],"page_number":2}]}});
        import_line(
            record.to_string().as_bytes(),
            id,
            &root,
            &mut header,
            &mut count,
        )
        .unwrap();
        assert_eq!(count, 1);
        let config: index::IndexConfiguration = read_json(&root.join("_config.json")).unwrap();
        assert_eq!(config.dimensions, 512);
        let stored: index::IndexedDocument =
            read_json(&index::doc_path(&root, &index::doc_id("2025/Facture.pdf")).unwrap())
                .unwrap();
        assert_eq!(stored.category, "Maison");
        assert_eq!(stored.chunks[0].page_number, Some(2));
        assert_eq!(stored.chunks[0].vector.len(), 512);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_incompatible_models_and_inconsistent_vectors() {
        let id = "123e4567-e89b-12d3-a456-426614174000";
        let root = std::env::temp_dir().join(format!("clairdoc-export-test-{}", new_id()));
        fs::create_dir(&root).unwrap();
        let mut header = None;
        let mut count = 0;
        let wrong = serde_json::json!({"type":"header","format":"clairdoc-index-1","project_id":id,"project_name":"Test","embedding_provider":"local","embedding_model":"wrong","embedding_dimensions":384,"document_count":1});
        assert!(import_line(
            wrong.to_string().as_bytes(),
            id,
            &root,
            &mut header,
            &mut count
        )
        .is_err());
        let right = serde_json::json!({"type":"header","format":"clairdoc-index-1","project_id":id,"project_name":"Test","embedding_provider":"local","embedding_model":index::LOCAL_MODEL,"embedding_dimensions":384,"document_count":1});
        import_line(
            right.to_string().as_bytes(),
            id,
            &root,
            &mut header,
            &mut count,
        )
        .unwrap();
        let bad_doc = serde_json::json!({"type":"document","document":{"job_id":"a","document_name":"a.pdf","source_relative_path":"a.pdf","document_hash":"x","indexing_mode":"content","metadata":{},"chunks":[{"text":"bonjour","embedding":[1.0],"page_number":1}]}});
        assert!(import_line(
            bad_doc.to_string().as_bytes(),
            id,
            &root,
            &mut header,
            &mut count
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
