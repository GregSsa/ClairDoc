import { invoke } from "@tauri-apps/api/core";

export type ServerConfigStatus = {
  serverUrl: string;
  configured: boolean;
};

export type ConnectionResponse = {
  status: string;
  version: string;
};

export type RemoteProject = {
  id: string;
  name: string;
  sourceRoot: string | null;
};

export type RuntimeInfo = {
  version: string;
  llmModel: string;
  embeddingModel: string;
  embeddingProvider: "openai" | "local";
  embeddingDimensions: number;
  ocrLanguages: string;
  dataDir: string;
  maxUploadMb: number;
  maxIndexTokens: number;
  openaiConfigured: boolean;
  tlsEnabled: boolean;
  modelOptions: string[];
};

export type OcrJob = {
  id: string;
  project_id: string | null;
  original_filename: string;
  status: "queued" | "running" | "completed" | "failed";
  error: string | null;
};

export type DocumentFile = {
  path: string;
  relativePath: string;
  name: string;
  bytes: number;
};

export type IndexResult = {
  projectId: string;
  documentsIndexed: number;
  documentsReused: number;
  chunksIndexed: number;
  embeddingModel: string;
};

export type IndexEstimate = {
  projectId: string;
  documentsTotal: number;
  documentsToEmbed: number;
  documentsReused: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  pricePerMillionTokensUsd: number;
  embeddingModel: string;
};

export type IndexTask = {
  id: string;
  projectId: string;
  status: "queued" | "running" | "completed" | "failed";
  estimate: IndexEstimate | null;
  result: IndexResult | null;
  error: string | null;
};

export type BackupResult = {
  path: string;
  sizeBytes: number;
  createdAt: string;
};

export type LibraryDocument = {
  jobId: string;
  name: string;
  sourceRelativePath: string;
  status: "ready" | "indexed";
  category: string;
  documentDate: string | null;
  organization: string | null;
  people: string[];
  amounts: string[];
  chunks: number;
};

export type DocumentRelationship = {
  sourceJobId: string;
  targetJobId: string;
  kind: "organization" | "person" | "category" | "year";
  label: string;
};

export type DocumentLibrary = {
  projectId: string;
  documents: LibraryDocument[];
  categories: string[];
  relationships: DocumentRelationship[];
};

export type Citation = {
  document_name: string;
  job_id: string;
  chunk_index: number;
  page_number: number | null;
  score: number;
  excerpt: string;
};

export type OrganizationEntry = {
  job_id: string;
  original_filename: string;
  source_relative_path: string;
  suggested_path: string;
  category: string;
  document_date: string | null;
  organization: string | null;
  reason: string;
};

export type OrganizationPlan = {
  project_id: string;
  created_at: string;
  entries: OrganizationEntry[];
};

export type ApplyResult = {
  manifestPath: string;
  copied: number;
};

export type UndoResult = {
  removed: number;
  skipped: number;
};

export type AskResult = {
  answer: string;
  citations: Citation[];
  model: string;
  actions: AssistantAction[];
};

export type AssistantAction = {
  tool: string;
  status: "completed" | "failed" | "confirmation_required";
  summary: string;
};

export type ConversationSummary = {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations: Citation[];
  actions: AssistantAction[];
};

export type Conversation = {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
};

export function getServerConfig() {
  return invoke<ServerConfigStatus>("get_server_config");
}

export function configureServer(serverUrl: string, apiKey: string) {
  return invoke<ConnectionResponse>("configure_server", { serverUrl, apiKey });
}

export function testServerConnection() {
  return invoke<ConnectionResponse>("test_server_connection");
}

export function createRemoteProject(name: string, sourceRoot?: string) {
  return invoke<RemoteProject>("create_remote_project", { name, sourceRoot });
}

export function updateRemoteProject(projectId: string, name?: string, sourceRoot?: string) {
  return invoke<RemoteProject>("update_remote_project", { projectId, name, sourceRoot });
}

export function deleteRemoteProject(projectId: string) {
  return invoke<void>("delete_remote_project", { projectId });
}

export function openProjectFolder(path: string) {
  return invoke<void>("open_project_folder", { path });
}

export function openProjectFile(rootPath: string, relativePath: string) {
  return invoke<void>("open_project_file", { rootPath, relativePath });
}

export function getRuntimeInfo() {
  return invoke<RuntimeInfo>("get_runtime_info");
}

export function updateRuntimeModel(llmModel: string) {
  return invoke<RuntimeInfo>("update_runtime_model", { llmModel });
}

export function updateRuntimeEmbeddings(provider: string) {
  return invoke<RuntimeInfo>("update_runtime_embeddings", { provider });
}

export function listRemoteProjects() {
  return invoke<RemoteProject[]>("list_remote_projects");
}

export function submitOcrJob(path: string, projectId: string, sourceRelativePath?: string) {
  return invoke<OcrJob>("submit_ocr_job", { path, projectId, sourceRelativePath });
}

export function getOcrJob(jobId: string) {
  return invoke<OcrJob>("get_ocr_job", { jobId });
}

export function getOcrText(jobId: string) {
  return invoke<string>("get_ocr_text", { jobId });
}

export function listProjectJobs(projectId: string) {
  return invoke<OcrJob[]>("list_project_jobs", { projectId });
}

export function listDocumentFiles(path: string) {
  return invoke<DocumentFile[]>("list_document_files", { path });
}

export function pauseProjectOcr(projectId: string) {
  return invoke("pause_project_ocr", { projectId });
}

export function resumeProjectOcr(projectId: string) {
  return invoke("resume_project_ocr", { projectId });
}

export function retryOcrJob(jobId: string) {
  return invoke<OcrJob>("retry_ocr_job", { jobId });
}

export function indexProject(projectId: string) {
  return invoke<IndexResult>("index_project", { projectId });
}

export function estimateProjectIndex(projectId: string) {
  return invoke<IndexEstimate>("estimate_project_index", { projectId });
}

export function startIndexProject(projectId: string) {
  return invoke<IndexTask>("start_index_project", { projectId });
}

export function getIndexTask(taskId: string) {
  return invoke<IndexTask>("get_index_task", { taskId });
}

export function retryIndexTask(taskId: string) {
  return invoke<IndexTask>("retry_index_task", { taskId });
}

export function createServerBackup() {
  return invoke<BackupResult>("create_server_backup");
}

export function listProjectDocuments(projectId: string) {
  return invoke<DocumentLibrary>("list_project_documents", { projectId });
}

export function askProject(projectId: string, question: string) {
  return invoke<AskResult>("ask_project", { projectId, question });
}

export function listConversations(projectId: string) {
  return invoke<ConversationSummary[]>("list_conversations", { projectId });
}

export function createConversation(projectId: string, title?: string) {
  return invoke<Conversation>("create_conversation", { projectId, title });
}

export function getConversation(projectId: string, conversationId: string) {
  return invoke<Conversation>("get_conversation", { projectId, conversationId });
}

export function deleteConversation(projectId: string, conversationId: string) {
  return invoke<void>("delete_conversation", { projectId, conversationId });
}

export function sendConversationMessage(
  projectId: string,
  conversationId: string,
  question: string,
  allowWriteActions: boolean,
) {
  return invoke<AskResult>("send_conversation_message", {
    projectId,
    conversationId,
    question,
    allowWriteActions,
  });
}

export function createOrganizationPlan(projectId: string, renameFiles = false) {
  return invoke<OrganizationPlan>("create_organization_plan", { projectId, renameFiles });
}

export function applyOrganizationPlan(
  rootPath: string,
  outputPath: string,
  entries: OrganizationEntry[],
  mode: "copy" | "move",
) {
  return invoke<ApplyResult>("apply_organization_plan", { rootPath, outputPath, entries, mode });
}

export function undoOrganization(manifestPath: string) {
  return invoke<UndoResult>("undo_organization", { manifestPath });
}
