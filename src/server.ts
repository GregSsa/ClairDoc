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

export type PdfFile = {
  path: string;
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
  score: number;
  excerpt: string;
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

export function submitOcrJob(path: string, projectId: string) {
  return invoke<OcrJob>("submit_ocr_job", { path, projectId });
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

export function listPdfFiles(path: string) {
  return invoke<PdfFile[]>("list_pdf_files", { path });
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
