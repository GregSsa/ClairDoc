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

export function createRemoteProject(name: string) {
  return invoke<RemoteProject>("create_remote_project", { name });
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

export function askProject(projectId: string, question: string) {
  return invoke<AskResult>("ask_project", { projectId, question });
}

export function createOrganizationPlan(projectId: string) {
  return invoke<OrganizationPlan>("create_organization_plan", { projectId });
}

export function applyOrganizationPlan(
  rootPath: string,
  outputPath: string,
  entries: OrganizationEntry[],
) {
  return invoke<ApplyResult>("apply_organization_plan", { rootPath, outputPath, entries });
}

export function undoOrganization(manifestPath: string) {
  return invoke<UndoResult>("undo_organization", { manifestPath });
}
