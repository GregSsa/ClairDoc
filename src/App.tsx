import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  applyOrganizationPlan,
  createConversation,
  createOrganizationPlan,
  createRemoteProject,
  createServerBackup,
  deleteRemoteProject,
  deleteConversation,
  estimateProjectIndex,
  getIndexTask,
  getConversation,
  getOcrJob,
  getOcrText,
  getServerConfig,
  getRuntimeInfo,
  listDocumentFiles,
  listConversations,
  listProjectDocuments,
  listProjectJobs,
  listRemoteProjects,
  pauseProjectOcr,
  openProjectFolder,
  openProjectFile,
  retryIndexTask,
  sendConversationMessage,
  DocumentFile,
  DocumentLibrary,
  LibraryDocument,
  AskResult,
  Conversation,
  ConversationSummary,
  IndexResult,
  IndexEstimate,
  IndexTask,
  OcrJob,
  OrganizationPlan,
  RemoteProject,
  RuntimeInfo,
  submitOcrJob,
  testServerConnection,
  resumeProjectOcr,
  retryOcrJob,
  startIndexProject,
  updateRemoteProject,
  updateRuntimeModel,
  updateRuntimeEmbeddings,
  undoOrganization,
} from "./server";
import "./App.css";

type FolderSummary = {
  rootPath: string;
  folderName: string;
  fileCount: number;
  directoryCount: number;
  pdfCount: number;
  imageCount: number;
  officeCount: number;
  totalBytes: number;
  inaccessibleCount: number;
};

type ScanState =
  | { status: "idle" }
  | { status: "scanning"; path: string }
  | { status: "ready"; summary: FolderSummary }
  | { status: "error"; message: string };

type ConnectionState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "testing" }
  | { status: "connected"; version: string }
  | { status: "error"; message: string };

type ProjectState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "ready"; project: RemoteProject }
  | { status: "error"; message: string };

type OcrState =
  | { status: "idle" }
  | { status: "uploading"; path: string }
  | { status: "processing"; path: string; job: OcrJob }
  | { status: "completed"; path: string; job: OcrJob; text: string }
  | { status: "error"; message: string };

type RagState =
  | { status: "idle" }
  | { status: "estimating" }
  | { status: "estimate"; estimate: IndexEstimate }
  | { status: "indexing"; task: IndexTask }
  | { status: "ready"; result: IndexResult }
  | { status: "asking"; result: IndexResult }
  | { status: "answered"; result: IndexResult; answer: AskResult }
  | { status: "error"; message: string; result?: IndexResult; task?: IndexTask };

type BackupState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; path: string; size: number }
  | { status: "error"; message: string };

type WorkspaceView = "home" | "library" | "relations" | "assistant" | "import" | "settings";

type LibraryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: DocumentLibrary }
  | { status: "error"; message: string };

type BatchState =
  | { status: "idle" }
  | { status: "discovering" }
  | { status: "uploading"; files: DocumentFile[]; next: number; jobIds: string[]; paused: boolean }
  | { status: "processing"; files: DocumentFile[]; jobIds: string[]; paused: boolean }
  | { status: "completed"; files: DocumentFile[]; jobIds: string[] }
  | {
      status: "error";
      message: string;
      files: DocumentFile[];
      next: number;
      jobIds: string[];
      paused: boolean;
    };

type OrganizationState =
  | { status: "idle" }
  | { status: "planning" }
  | { status: "ready"; plan: OrganizationPlan }
  | { status: "applying"; plan: OrganizationPlan }
  | { status: "applied"; plan: OrganizationPlan; manifestPath: string; copied: number }
  | { status: "error"; message: string; plan?: OrganizationPlan };

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "string" ? error : fallback;
}

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 octet";
  const units = ["octets", "Ko", "Mo", "Go", "To"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: index === 0 ? 0 : 1,
  }).format(value)} ${units[index]}`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("fr-FR").format(value);
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.75 5.75c0-1.1.9-2 2-2h3.1c.58 0 1.13.25 1.51.69l1.2 1.37c.19.22.46.34.75.34h5.94c1.1 0 2 .9 2 2v8.1a3 3 0 0 1-3 3H6.75a3 3 0 0 1-3-3V5.75Z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.75 4.75 5.8v5.45c0 4.45 2.95 8.57 7.25 10 4.3-1.43 7.25-5.55 7.25-10V5.8L12 2.75Zm3.45 7.42-4.17 4.17a.75.75 0 0 1-1.06 0l-1.67-1.67 1.06-1.06 1.14 1.14 3.64-3.64 1.06 1.06Z" />
    </svg>
  );
}

function App() {
  const [scan, setScan] = useState<ScanState>({ status: "idle" });
  const [serverUrl, setServerUrl] = useState("http://127.0.0.1:8787");
  const [connection, setConnection] = useState<ConnectionState>({ status: "loading" });
  const [project, setProject] = useState<ProjectState>({ status: "idle" });
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [ocr, setOcr] = useState<OcrState>({ status: "idle" });
  const [batch, setBatch] = useState<BatchState>({ status: "idle" });
  const [projectJobs, setProjectJobs] = useState<OcrJob[]>([]);
  const [rag, setRag] = useState<RagState>({ status: "idle" });
  const [question, setQuestion] = useState("");
  const [organization, setOrganization] = useState<OrganizationState>({ status: "idle" });
  const [selectedPlanEntries, setSelectedPlanEntries] = useState<string[]>([]);
  const [backup, setBackup] = useState<BackupState>({ status: "idle" });
  const [activeView, setActiveView] = useState<WorkspaceView>("home");
  const [newProjectName, setNewProjectName] = useState("");
  const [library, setLibrary] = useState<LibraryState>({ status: "idle" });
  const [documentSearch, setDocumentSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("Toutes");
  const [linkFilter, setLinkFilter] = useState("Tous");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    localStorage.getItem("clairdoc-theme") === "dark" ? "dark" : "light",
  );
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [relationSearch, setRelationSearch] = useState("");
  const [relationKind, setRelationKind] = useState("Tous");
  const [focusDocument, setFocusDocument] = useState("Tous");
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [organizationMode, setOrganizationMode] = useState<"copy" | "move">("copy");
  const [renameFiles, setRenameFiles] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [assistantSending, setAssistantSending] = useState(false);
  const [assistantError, setAssistantError] = useState("");
  const [allowAssistantActions, setAllowAssistantActions] = useState(false);
  const connected = connection.status === "connected";

  useEffect(() => {
    let active = true;
    getServerConfig()
      .then(async (config) => {
        if (!active) return;
        setServerUrl(config.serverUrl);
        if (!config.configured) {
          setConnection({ status: "missing" });
          return;
        }
        setConnection({ status: "testing" });
        try {
          const result = await testServerConnection();
          if (active) setConnection({ status: "connected", version: result.version });
        } catch (error) {
          if (active) {
            setConnection({
              status: "error",
              message: errorMessage(error, "Le serveur ne répond pas."),
            });
          }
        }
      })
      .catch(() => active && setConnection({ status: "missing" }));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("clairdoc-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (connection.status !== "connected") return;
    listRemoteProjects().then(setProjects).catch(() => setProjects([]));
  }, [connection.status]);

  useEffect(() => {
    if (ocr.status !== "processing") return;
    const { job, path } = ocr;
    const timer = window.setTimeout(async () => {
      try {
        const updated = await getOcrJob(job.id);
        if (updated.status === "completed") {
          const text = await getOcrText(updated.id);
          setOcr({ status: "completed", path, job: updated, text });
        } else if (updated.status === "failed") {
          setOcr({ status: "error", message: updated.error ?? "Le traitement OCR a échoué." });
        } else {
          setOcr({ status: "processing", path, job: updated });
        }
      } catch (error) {
        setOcr({ status: "error", message: errorMessage(error, "Suivi OCR impossible.") });
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [ocr]);

  useEffect(() => {
    if (project.status !== "ready" || batch.status !== "uploading" || batch.paused) return;
    if (batch.next >= batch.files.length) {
      setBatch({
        status: "processing",
        files: batch.files,
        jobIds: batch.jobIds,
        paused: false,
      });
      return;
    }

    let active = true;
    const file = batch.files[batch.next];
    submitOcrJob(file.path, project.project.id, file.relativePath)
      .then((job) => {
        if (!active) return;
        setBatch((current) => {
          if (current.status !== "uploading") return current;
          const jobIds = current.jobIds.includes(job.id)
            ? current.jobIds
            : [...current.jobIds, job.id];
          return { ...current, next: current.next + 1, jobIds };
        });
      })
      .catch((error) => {
        if (!active) return;
        setBatch((current) =>
          current.status === "uploading"
            ? {
                status: "error",
                message: errorMessage(error, `Envoi impossible : ${file.name}`),
                files: current.files,
                next: current.next,
                jobIds: current.jobIds,
                paused: current.paused,
              }
            : current,
        );
      });
    return () => {
      active = false;
    };
  }, [batch, project]);

  useEffect(() => {
    if (project.status !== "ready") {
      setProjectJobs([]);
      return;
    }
    let active = true;
    const projectId = project.project.id;
    const refresh = async () => {
      try {
        const jobs = await listProjectJobs(projectId);
        if (!active) return;
        setProjectJobs(jobs);
        setBatch((current) => {
          if (current.status !== "processing" || current.jobIds.length === 0) return current;
          const selected = jobs.filter((job) => current.jobIds.includes(job.id));
          if (
            selected.length === current.jobIds.length &&
            selected.every((job) => job.status === "completed" || job.status === "failed")
          ) {
            return { status: "completed", files: current.files, jobIds: current.jobIds };
          }
          return current;
        });
      } catch {
        // A temporary polling failure is retried automatically.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [project]);

  useEffect(() => {
    if (rag.status !== "indexing") return;
    const taskId = rag.task.id;
    const timer = window.setTimeout(async () => {
      try {
        const task = await getIndexTask(taskId);
        if (task.status === "completed" && task.result) {
          setRag({ status: "ready", result: task.result });
          setOrganization({ status: "idle" });
        } else if (task.status === "failed") {
          setRag({
            status: "error",
            task,
            message: task.error ?? "L’indexation a échoué.",
          });
        } else {
          setRag({ status: "indexing", task });
        }
      } catch (error) {
        setRag({
          status: "error",
          task: rag.task,
          message: errorMessage(error, "Le suivi de l’indexation a échoué."),
        });
      }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [rag]);

  useEffect(() => {
    if (project.status !== "ready" || !["library", "relations"].includes(activeView)) return;
    let active = true;
    setLibrary({ status: "loading" });
    listProjectDocuments(project.project.id)
      .then((data) => active && setLibrary({ status: "ready", data }))
      .catch((error) => active && setLibrary({
        status: "error",
        message: errorMessage(error, "Impossible de charger les documents."),
      }));
    return () => {
      active = false;
    };
  }, [activeView, project, projectJobs.length, rag.status, libraryRefresh]);

  useEffect(() => {
    if (!connected || activeView !== "settings") return;
    getRuntimeInfo().then(setRuntimeInfo).catch(() => setRuntimeInfo(null));
  }, [activeView, connected]);

  useEffect(() => {
    if (project.status !== "ready" || activeView !== "assistant") return;
    let active = true;
    const projectId = project.project.id;
    setConversationLoading(true);
    setAssistantError("");
    listConversations(projectId)
      .then(async (items) => {
        if (!active) return;
        setConversations(items);
        const selectedId = activeConversation?.projectId === projectId
          ? activeConversation.id
          : items[0]?.id;
        const conversation = selectedId
          ? await getConversation(projectId, selectedId)
          : await createConversation(projectId);
        if (!active) return;
        setActiveConversation(conversation);
        if (items.length === 0) {
          setConversations([{
            id: conversation.id,
            projectId,
            title: conversation.title,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            messageCount: conversation.messages.length,
          }]);
        }
      })
      .catch((error) => active && setAssistantError(
        errorMessage(error, "Impossible de charger les conversations."),
      ))
      .finally(() => active && setConversationLoading(false));
    return () => { active = false; };
  }, [activeView, project]);

  function selectProject(selected?: RemoteProject) {
    setProject(selected ? { status: "ready", project: selected } : { status: "idle" });
    setBatch({ status: "idle" });
    setRag({ status: "idle" });
    setOrganization({ status: "idle" });
    setLibrary({ status: "idle" });
    setQuestion("");
    setConversations([]);
    setActiveConversation(null);
    setAssistantError("");
    setProjectMenu(null);
  }

  async function renameProject(item: RemoteProject) {
    const name = window.prompt("Nouveau nom du projet", item.name)?.trim();
    if (!name || name === item.name) return;
    try {
      const updated = await updateRemoteProject(item.id, name);
      setProjects((current) => current.map((candidate) => candidate.id === item.id ? updated : candidate));
      if (project.status === "ready" && project.project.id === item.id) {
        setProject({ status: "ready", project: updated });
      }
    } catch (error) {
      window.alert(errorMessage(error, "Impossible de renommer le projet."));
    } finally {
      setProjectMenu(null);
    }
  }

  async function removeProject(item: RemoteProject) {
    const confirmed = window.confirm(
      `Supprimer le projet « ${item.name} » de ClairDoc ?\n\nLes originaux ne seront pas supprimés. Les index, textes extraits et copies serveur de ce projet seront effacés.`,
    );
    if (!confirmed) return;
    try {
      await deleteRemoteProject(item.id);
      setProjects((current) => current.filter((candidate) => candidate.id !== item.id));
      if (project.status === "ready" && project.project.id === item.id) selectProject();
    } catch (error) {
      window.alert(errorMessage(error, "Impossible de supprimer le projet."));
    } finally {
      setProjectMenu(null);
    }
  }

  async function revealProject(item: RemoteProject) {
    if (!item.sourceRoot) {
      window.alert("Ce projet n’a pas encore de dossier source associé. Ajoutez d’abord un dossier.");
      return;
    }
    try {
      await openProjectFolder(item.sourceRoot);
    } catch (error) {
      window.alert(errorMessage(error, "Impossible d’ouvrir le dossier."));
    } finally {
      setProjectMenu(null);
    }
  }

  async function openTreeDocument(document: LibraryDocument) {
    if (project.status !== "ready" || !project.project.sourceRoot) {
      window.alert("Le dossier source de ce projet n’est pas disponible sur cet ordinateur.");
      return;
    }
    try {
      await openProjectFile(project.project.sourceRoot, document.sourceRelativePath);
    } catch (error) {
      window.alert(errorMessage(error, "Impossible d’ouvrir ce document."));
    }
  }

  async function selectRuntimeModel(model: string) {
    try {
      const updated = await updateRuntimeModel(model);
      setRuntimeInfo(updated);
    } catch (error) {
      window.alert(errorMessage(error, "Impossible de changer le modèle."));
    }
  }

  async function selectEmbeddingProvider(provider: string) {
    try {
      setRuntimeInfo(await updateRuntimeEmbeddings(provider));
    } catch (error) {
      window.alert(errorMessage(error, "Impossible de changer les embeddings."));
    }
  }

  function toggleCategory(category: string) {
    setCollapsedCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  async function quickCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newProjectName.trim();
    if (!name) return;
    setProject({ status: "creating" });
    try {
      const created = await createRemoteProject(name);
      setProjects((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setProject({ status: "ready", project: created });
      setNewProjectName("");
      setActiveView("import");
    } catch (error) {
      setProject({ status: "error", message: errorMessage(error, "Le projet n’a pas pu être créé.") });
    }
  }

  async function retestServer() {
    setConnection({ status: "testing" });
    try {
      const result = await testServerConnection();
      setConnection({ status: "connected", version: result.version });
    } catch (error) {
      setConnection({ status: "error", message: errorMessage(error, "Le serveur ne répond pas.") });
    }
  }

  async function chooseFolder() {
    const selected = await open({ directory: true, multiple: false, title: "Choisir le dossier à analyser" });
    if (!selected) return;
    setOcr({ status: "idle" });
    setRag({ status: "idle" });
    setOrganization({ status: "idle" });
    setBatch({ status: "idle" });
    setScan({ status: "scanning", path: selected });
    try {
      const summary = await invoke<FolderSummary>("scan_folder", { path: selected });
      setScan({ status: "ready", summary });
    } catch (error) {
      setScan({ status: "error", message: errorMessage(error, "Le dossier n’a pas pu être analysé.") });
    }
  }

  async function createProject() {
    if (scan.status !== "ready") return;
    setProject({ status: "creating" });
    try {
      const created = await createRemoteProject(scan.summary.folderName, scan.summary.rootPath);
      setProject({ status: "ready", project: created });
      setProjects((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    } catch (error) {
      setProject({ status: "error", message: errorMessage(error, "Le projet n’a pas pu être créé.") });
    }
  }

  async function importAllDocuments() {
    if (scan.status !== "ready" || project.status !== "ready") return;
    setBatch({ status: "discovering" });
    try {
      if (!project.project.sourceRoot) {
        const updated = await updateRemoteProject(
          project.project.id,
          undefined,
          scan.summary.rootPath,
        );
        setProject({ status: "ready", project: updated });
        setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      }
      const files = await listDocumentFiles(scan.summary.rootPath);
      if (files.length === 0) {
        setBatch({
          status: "error",
          message: "Aucun document pris en charge n’a été trouvé dans ce dossier.",
          files: [],
          next: 0,
          jobIds: [],
          paused: false,
        });
        return;
      }
      await resumeProjectOcr(project.project.id);
      setBatch({ status: "uploading", files, next: 0, jobIds: [], paused: false });
    } catch (error) {
      setBatch({
        status: "error",
        message: errorMessage(error, "Impossible de préparer l’import."),
        files: [],
        next: 0,
        jobIds: [],
        paused: false,
      });
    }
  }

  async function toggleBatchPause() {
    if (project.status !== "ready" || (batch.status !== "uploading" && batch.status !== "processing")) return;
    const paused = !batch.paused;
    try {
      if (paused) await pauseProjectOcr(project.project.id);
      else await resumeProjectOcr(project.project.id);
      setBatch((current) =>
        current.status === "uploading" || current.status === "processing"
          ? { ...current, paused }
          : current,
      );
    } catch (error) {
      setBatch((current) =>
        current.status === "uploading" || current.status === "processing"
          ? {
              status: "error",
              message: errorMessage(error, "Pause ou reprise impossible."),
              files: current.files,
              next: current.status === "uploading" ? current.next : current.files.length,
              jobIds: current.jobIds,
              paused: current.paused,
            }
          : current,
      );
    }
  }

  async function retryFailedJobs() {
    if (project.status !== "ready") return;
    const failed = projectJobs.filter((job) => job.status === "failed");
    try {
      await Promise.all(failed.map((job) => retryOcrJob(job.id)));
      await resumeProjectOcr(project.project.id);
      setBatch((current) => {
        const files = "files" in current ? current.files : [];
        const jobIds = failed.map((job) => job.id);
        return { status: "processing", files, jobIds, paused: false };
      });
    } catch (error) {
      setBatch({
        status: "error",
        message: errorMessage(error, "Impossible de relancer les travaux en échec."),
        files: [],
        next: 0,
        jobIds: failed.map((job) => job.id),
        paused: false,
      });
    }
  }

  function resumeUploadAfterError() {
    if (batch.status !== "error" || batch.files.length === 0) return;
    setBatch({
      status: "uploading",
      files: batch.files,
      next: batch.next,
      jobIds: batch.jobIds,
      paused: false,
    });
  }

  async function choosePdf() {
    if (project.status !== "ready") return;
    const selected = await open({
      directory: false,
      multiple: false,
      title: "Choisir un document à analyser",
      filters: [{ name: "Documents", extensions: ["pdf", "txt", "md", "csv", "docx", "xlsx", "pptx", "eml", "png", "jpg", "jpeg", "tif", "tiff"] }],
    });
    if (!selected) return;
    setOcr({ status: "uploading", path: selected });
    setRag({ status: "idle" });
    try {
      const job = await submitOcrJob(selected, project.project.id);
      setOcr({ status: "processing", path: selected, job });
    } catch (error) {
      setOcr({ status: "error", message: errorMessage(error, "Le document n’a pas pu être envoyé.") });
    }
  }

  async function buildIndex() {
    if (project.status !== "ready") return;
    setRag({ status: "estimating" });
    try {
      const estimate = await estimateProjectIndex(project.project.id);
      setRag({ status: "estimate", estimate });
    } catch (error) {
      setRag({ status: "error", message: errorMessage(error, "L’estimation a échoué.") });
    }
  }

  async function confirmIndex() {
    if (project.status !== "ready") return;
    try {
      const task = await startIndexProject(project.project.id);
      setRag({ status: "indexing", task });
    } catch (error) {
      setRag({ status: "error", message: errorMessage(error, "L’indexation n’a pas démarré.") });
    }
  }

  async function retryIndex() {
    if (rag.status !== "error" || !rag.task) return;
    try {
      const task = await retryIndexTask(rag.task.id);
      setRag({ status: "indexing", task });
    } catch (error) {
      setRag({ ...rag, message: errorMessage(error, "La relance a échoué.") });
    }
  }

  async function backupMetadata() {
    setBackup({ status: "saving" });
    try {
      const result = await createServerBackup();
      setBackup({ status: "saved", path: result.path, size: result.sizeBytes });
    } catch (error) {
      setBackup({ status: "error", message: errorMessage(error, "La sauvegarde a échoué.") });
    }
  }

  async function prepareOrganization() {
    if (project.status !== "ready") return;
    setOrganization({ status: "planning" });
    try {
      const plan = await createOrganizationPlan(project.project.id, renameFiles);
      setSelectedPlanEntries(plan.entries.map((entry) => entry.job_id));
      setOrganization({ status: "ready", plan });
    } catch (error) {
      setOrganization({
        status: "error",
        message: errorMessage(error, "Impossible de préparer le classement."),
      });
    }
  }

  function updateSuggestedPath(jobId: string, suggestedPath: string) {
    setOrganization((current) => {
      if (!("plan" in current) || !current.plan) return current;
      const plan: OrganizationPlan = {
        ...current.plan,
        entries: current.plan.entries.map((entry) =>
          entry.job_id === jobId ? { ...entry, suggested_path: suggestedPath } : entry,
        ),
      };
      return current.status === "applied"
        ? { ...current, plan }
        : { status: "ready", plan };
    });
  }

  async function applyPlan() {
    if (scan.status !== "ready" || !("plan" in organization) || !organization.plan) return;
    const outputPath = await open({
      directory: true,
      multiple: false,
      title: "Choisir le dossier qui recevra les copies classées",
    });
    if (!outputPath) return;
    const plan = organization.plan;
    const entries = plan.entries.filter((entry) => selectedPlanEntries.includes(entry.job_id));
    if (entries.length === 0) return;
    if (organizationMode === "move" && !window.confirm(
      "Mode déplacement : les fichiers originaux seront retirés de leur emplacement actuel après création et vérification de la nouvelle architecture. Une sauvegarde de sécurité permettra l’annulation. Continuer ?",
    )) return;
    setOrganization({ status: "applying", plan });
    try {
      const result = await applyOrganizationPlan(
        scan.summary.rootPath,
        outputPath,
        entries,
        organizationMode,
      );
      setOrganization({
        status: "applied",
        plan,
        manifestPath: result.manifestPath,
        copied: result.copied,
      });
    } catch (error) {
      setOrganization({
        status: "error",
        plan,
        message: errorMessage(error, "La copie classée n’a pas pu être créée."),
      });
    }
  }

  async function undoLastOrganization() {
    if (organization.status !== "applied") return;
    if (!window.confirm("Supprimer uniquement les copies créées par ce classement ?")) return;
    try {
      const result = await undoOrganization(organization.manifestPath);
      window.alert(`${result.removed} copie(s) supprimée(s), ${result.skipped} ignorée(s).`);
      setOrganization({ status: "ready", plan: organization.plan });
    } catch (error) {
      setOrganization({
        status: "error",
        plan: organization.plan,
        message: errorMessage(error, "L’annulation a échoué."),
      });
    }
  }

  async function newConversation() {
    if (project.status !== "ready") return;
    try {
      const created = await createConversation(project.project.id);
      setActiveConversation(created);
      setConversations((current) => [{
        id: created.id,
        projectId: created.projectId,
        title: created.title,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        messageCount: 0,
      }, ...current]);
      setAssistantError("");
    } catch (error) {
      setAssistantError(errorMessage(error, "Impossible de créer la conversation."));
    }
  }

  async function openConversation(conversationId: string) {
    if (project.status !== "ready") return;
    setConversationLoading(true);
    try {
      setActiveConversation(await getConversation(project.project.id, conversationId));
      setAssistantError("");
    } catch (error) {
      setAssistantError(errorMessage(error, "Impossible d’ouvrir la conversation."));
    } finally {
      setConversationLoading(false);
    }
  }

  async function removeConversation(conversationId: string) {
    if (project.status !== "ready" || !window.confirm("Supprimer cette conversation ?")) return;
    try {
      await deleteConversation(project.project.id, conversationId);
      const remaining = conversations.filter((item) => item.id !== conversationId);
      setConversations(remaining);
      if (activeConversation?.id === conversationId) {
        if (remaining[0]) await openConversation(remaining[0].id);
        else await newConversation();
      }
    } catch (error) {
      setAssistantError(errorMessage(error, "Impossible de supprimer la conversation."));
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (project.status !== "ready" || !question.trim() || assistantSending) return;
    let conversation = activeConversation;
    if (!conversation) {
      conversation = await createConversation(project.project.id);
      setActiveConversation(conversation);
    }
    const submitted = question.trim();
    setQuestion("");
    setAssistantSending(true);
    setAssistantError("");
    try {
      await sendConversationMessage(
        project.project.id,
        conversation.id,
        submitted,
        allowAssistantActions,
      );
      const refreshed = await getConversation(project.project.id, conversation.id);
      setActiveConversation(refreshed);
      setConversations(await listConversations(project.project.id));
      setLibraryRefresh((value) => value + 1);
      setAllowAssistantActions(false);
    } catch (error) {
      setQuestion(submitted);
      setAssistantError(errorMessage(error, "La question n’a pas pu être traitée."));
    } finally {
      setAssistantSending(false);
    }
  }

  const indexResult = "result" in rag ? rag.result : undefined;
  const organizationPlan = "plan" in organization ? organization.plan : undefined;
  const completedJobs = projectJobs.filter((job) => job.status === "completed");
  const failedJobs = projectJobs.filter((job) => job.status === "failed");
  const pendingJobs = projectJobs.filter(
    (job) => job.status === "queued" || job.status === "running",
  );
  const importStillSending = batch.status === "discovering" || batch.status === "uploading";
  const documentsReady =
    (completedJobs.length > 0 || ocr.status === "completed") &&
    pendingJobs.length === 0 &&
    !importStillSending;
  const libraryData = library.status === "ready" ? library.data : undefined;
  const linkedDocumentIds = new Set(
    (libraryData?.relationships ?? [])
      .filter((relationship) => linkFilter === "Tous" || relationship.kind === linkFilter)
      .flatMap((relationship) => [relationship.sourceJobId, relationship.targetJobId]),
  );
  const filteredDocuments = (libraryData?.documents ?? []).filter((document) => {
    const query = documentSearch.trim().toLocaleLowerCase("fr");
    const matchesSearch = !query || [
      document.name,
      document.sourceRelativePath,
      document.category,
      document.organization ?? "",
      ...document.people,
    ].some((value) => value.toLocaleLowerCase("fr").includes(query));
    const matchesCategory = categoryFilter === "Toutes" || document.category === categoryFilter;
    const matchesLink = linkFilter === "Tous" || linkedDocumentIds.has(document.jobId);
    return matchesSearch && matchesCategory && matchesLink;
  });
  const relationQuery = relationSearch.trim().toLocaleLowerCase("fr");
  const searchedRelationIds = new Set(
    (libraryData?.documents ?? [])
      .filter((document) => !relationQuery || [document.name, document.category, document.organization ?? "", ...document.people]
        .some((value) => value.toLocaleLowerCase("fr").includes(relationQuery)))
      .map((document) => document.jobId),
  );
  const visibleRelationships = (libraryData?.relationships ?? []).filter((relationship) => {
    const matchesKind = relationKind === "Tous" || relationship.kind === relationKind;
    const matchesFocus = focusDocument === "Tous"
      || relationship.sourceJobId === focusDocument
      || relationship.targetJobId === focusDocument;
    const matchesSearch = !relationQuery
      || searchedRelationIds.has(relationship.sourceJobId)
      || searchedRelationIds.has(relationship.targetJobId);
    return matchesKind && matchesFocus && matchesSearch;
  });
  const visibleRelationIds = new Set(visibleRelationships.flatMap((relationship) => [
    relationship.sourceJobId,
    relationship.targetJobId,
  ]));
  if (focusDocument !== "Tous") visibleRelationIds.add(focusDocument);
  const relationDocuments = (libraryData?.documents ?? []).filter((document) =>
    (focusDocument === "Tous" && !relationQuery && relationKind === "Tous")
      ? true
      : visibleRelationIds.has(document.jobId),
  );
  const relationGroups = Object.entries(
    relationDocuments.reduce<Record<string, LibraryDocument[]>>((groups, document) => {
      (groups[document.category] ??= []).push(document);
      return groups;
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right, "fr"));

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Navigation principale">
        <div className="brand sidebar-brand" aria-label="ClairDoc"><span className="brand-mark"><FolderIcon /></span><span>ClairDoc</span></div>
        <nav>
          {([
            ["home", "⌂", "Projets"],
            ["library", "▤", "Documents"],
            ["relations", "⌘", "Relations"],
            ["assistant", "✦", "Assistant"],
            ["import", "+", "Ajouter"],
          ] as const).map(([view, icon, label]) => (
            <button key={view} className={activeView === view ? "active" : ""} onClick={() => { setActiveView(view); if (view === "relations") setLibraryRefresh((value) => value + 1); }}>
              <span aria-hidden="true">{icon}</span>{label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className={activeView === "settings" ? "active" : ""} onClick={() => setActiveView("settings")}><span aria-hidden="true">⚙</span>Paramètres</button>
          <div className={`server-pill ${connected ? "online" : ""}`}><span />{connected ? "Serveur connecté" : "Serveur hors ligne"}</div>
        </div>
      </aside>
      <header className="topbar">
        <div>
          <small>{activeView === "home" ? "ESPACE DE TRAVAIL" : project.status === "ready" ? "PROJET ACTIF" : "CLAIRDOC"}</small>
          <strong>{activeView === "home" ? "Mes projets" : project.status === "ready" ? project.project.name : "Choisissez un projet"}</strong>
        </div>
        <div className="topbar-actions"><div className="privacy-note"><ShieldIcon /><span>Vos originaux restent inchangés</span></div><button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={theme === "light" ? "Activer le mode sombre" : "Activer le mode clair"}>{theme === "light" ? "☾" : "☀"}</button></div>
      </header>

      <main className="main-content">
        {activeView === "home" && (
          <section className="dashboard-view">
            <div className="page-heading"><div><p className="eyebrow">Vue d’ensemble</p><h1>Vos documents, enfin clairs.</h1><p>Créez un espace par thème, personne ou activité. Chaque projet garde ses documents, ses liens et ses conversations séparés.</p></div><button className="primary-button" onClick={() => setActiveView("import")}>+ Ajouter des documents</button></div>
            <div className="dashboard-grid">
              <article className="new-project-card">
                <div className="card-icon">+</div><h2>Nouveau projet</h2><p>Créez d’abord un espace vide, puis ajoutez un dossier complet ou quelques documents.</p>
                <form onSubmit={quickCreateProject}><input value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Ex. Administratif 2026" maxLength={120} required /><button className="primary-button" disabled={!connected || project.status === "creating"}>Créer</button></form>
              </article>
              {projects.map((item) => (
                <article className={`project-card ${project.status === "ready" && project.project.id === item.id ? "selected" : ""}`} key={item.id}>
                  <div className="project-card-top"><span className="project-folder"><FolderIcon /></span><button className="project-menu-button" aria-label={`Options de ${item.name}`} onClick={() => setProjectMenu(projectMenu === item.id ? null : item.id)}>•••</button>{projectMenu === item.id && <div className="project-menu"><button onClick={() => renameProject(item)}>Renommer</button><button onClick={() => revealProject(item)} disabled={!item.sourceRoot}>Ouvrir dans l’explorateur</button><button className="danger" onClick={() => removeProject(item)}>Supprimer</button></div>}</div>
                  <h2>{item.name}</h2><p>Documents, recherche et classement associés à ce projet.</p>
                  <button className="secondary-button" onClick={() => { selectProject(item); setActiveView("library"); }}>Ouvrir le projet</button>
                </article>
              ))}
            </div>
            {projects.length === 0 && connected && <p className="empty-hint">Aucun projet pour le moment. Créez votre premier espace ci-dessus.</p>}
          </section>
        )}

        {activeView === "library" && (
          <section className="library-view">
            <div className="page-heading compact"><div><p className="eyebrow">Bibliothèque</p><h1>Documents</h1><p>Retrouvez un fichier par son contenu, sa catégorie ou les liens détectés.</p></div><button className="primary-button" onClick={() => setActiveView("import")}>+ Ajouter</button></div>
            {project.status !== "ready" ? <div className="blank-panel"><FolderIcon /><h2>Sélectionnez un projet</h2><p>Ouvrez un projet depuis l’accueil pour afficher ses documents.</p><button className="secondary-button" onClick={() => setActiveView("home")}>Voir mes projets</button></div> : (
              <>
                <div className="library-toolbar">
                  <input type="search" value={documentSearch} onChange={(event) => setDocumentSearch(event.target.value)} placeholder="Rechercher un document, une personne, un organisme…" />
                  <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option>Toutes</option>{libraryData?.categories.map((category) => <option key={category}>{category}</option>)}</select>
                  <select value={linkFilter} onChange={(event) => setLinkFilter(event.target.value)}><option value="Tous">Tous les liens</option><option value="organization">Même organisme</option><option value="person">Même personne</option><option value="category">Même catégorie</option><option value="year">Même année</option></select>
                </div>
                {library.status === "loading" && <div className="blank-panel"><span className="mini-spinner" /><p>Chargement de la bibliothèque…</p></div>}
                {library.status === "error" && <div className="blank-panel error-result"><h2>Bibliothèque indisponible</h2><p>{library.message}</p></div>}
                {libraryData && (
                  <div className="document-browser">
                    <div className="browser-summary"><strong>{filteredDocuments.length} document(s)</strong><span>{libraryData.relationships.length} lien(s) détecté(s)</span></div>
                    <div className="document-table" role="table" aria-label="Documents du projet">
                      <div className="document-row table-head" role="row"><span>Nom</span><span>Catégorie</span><span>Date</span><span>Relations</span><span>État</span></div>
                      {filteredDocuments.map((document) => {
                        const relations = libraryData.relationships.filter((link) => link.sourceJobId === document.jobId || link.targetJobId === document.jobId);
                        return <article className="document-row" role="row" key={document.jobId}><span className="document-name"><b>{document.name}</b><small>{document.sourceRelativePath}</small></span><span><i className="category-chip">{document.category}</i></span><span>{document.documentDate ?? "—"}</span><span>{relations.length ? <span className="link-count">⌁ {relations.length}</span> : "—"}</span><span className={`status-chip ${document.status}`}>{document.status === "indexed" ? "Indexé" : "Prêt"}</span></article>;
                      })}
                    </div>
                    {filteredDocuments.length === 0 && <div className="no-results">Aucun document ne correspond à ces filtres.</div>}
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {activeView === "relations" && (
          <section className="relations-view">
            <div className="page-heading compact"><div><p className="eyebrow">Cartographie</p><h1>Arbre du projet</h1><p>Explorez les catégories et limitez l’arbre aux documents reliés à une recherche ou à un document précis.</p></div>{project.status === "ready" && <button className="secondary-button" onClick={() => setLibraryRefresh((value) => value + 1)}>Actualiser</button>}</div>
            {project.status !== "ready" ? <div className="blank-panel"><h2>Aucun projet sélectionné</h2><button className="secondary-button" onClick={() => setActiveView("home")}>Choisir un projet</button></div> : (
              <>
                <div className="relation-toolbar">
                  <input type="search" value={relationSearch} onChange={(event) => setRelationSearch(event.target.value)} placeholder="Rechercher une personne, un organisme…" />
                  <select value={focusDocument} onChange={(event) => setFocusDocument(event.target.value)}><option value="Tous">Tous les documents</option>{libraryData?.documents.map((document) => <option value={document.jobId} key={document.jobId}>{document.name}</option>)}</select>
                  <select value={relationKind} onChange={(event) => setRelationKind(event.target.value)}><option value="Tous">Tous les types de liens</option><option value="organization">Organisme</option><option value="person">Personne</option><option value="category">Catégorie</option><option value="year">Année</option></select>
                </div>
                {library.status === "loading" && <div className="blank-panel"><span className="mini-spinner" /><p>Construction de l’arbre…</p></div>}
                {libraryData && <div className="relation-canvas">
                  <div className="tree-root"><span className="tree-root-icon"><FolderIcon /></span><div><strong>{project.project.name}</strong><small>{relationDocuments.length} document(s) · {visibleRelationships.length} lien(s) affiché(s)</small></div></div>
                  <div className="tree-groups">
                    {relationGroups.map(([category, documents]) => <section className={`tree-branch ${collapsedCategories.has(category) ? "collapsed" : ""}`} key={category}><button className="tree-category" onClick={() => toggleCategory(category)} aria-expanded={!collapsedCategories.has(category)}><span /> <strong>{category}</strong><small>{documents.length}</small><b>{collapsedCategories.has(category) ? "+" : "−"}</b></button>{!collapsedCategories.has(category) && <div className="tree-documents">{documents.map((document) => {
                      const documentLinks = visibleRelationships.filter((relationship) => relationship.sourceJobId === document.jobId || relationship.targetJobId === document.jobId);
                      return <button className={`tree-document ${document.jobId === focusDocument ? "focused" : ""}`} key={document.jobId} onClick={() => openTreeDocument(document)}><div className="tree-document-title"><span>▤</span><div><strong>{document.name}</strong><small>{document.organization ?? document.sourceRelativePath}</small></div></div><div className="tree-links">{documentLinks.filter((link) => link.kind !== "category").slice(0, 4).map((link, index) => <span key={`${link.sourceJobId}-${link.targetJobId}-${link.kind}-${index}`}>{link.kind === "organization" ? "Organisme" : link.kind === "person" ? "Personne" : "Année"} · {link.label}</span>)}</div></button>;
                    })}</div>}</section>)}
                    {relationGroups.length === 0 && <div className="no-results">Aucun document relié ne correspond à ces filtres.</div>}
                  </div>
                </div>}
              </>
            )}
          </section>
        )}

        {activeView === "assistant" && (
          <section className="assistant-view">
            <div className="page-heading compact"><div><p className="eyebrow">Assistant documentaire</p><h1>Posez une question à vos documents</h1><p>Les réponses restent limitées au projet actif et affichent leurs sources.</p></div></div>
            {project.status !== "ready" ? <div className="blank-panel"><h2>Aucun projet sélectionné</h2><button className="secondary-button" onClick={() => setActiveView("home")}>Choisir un projet</button></div> : (
              <div className="assistant-layout">
                <aside className="conversation-sidebar">
                  <button className="primary-button new-conversation" onClick={newConversation}>+ Nouvelle conversation</button>
                  <div className="conversation-list">
                    {conversations.map((item) => <div className={`conversation-item ${activeConversation?.id === item.id ? "active" : ""}`} key={item.id}>
                      <button onClick={() => openConversation(item.id)}><strong>{item.title}</strong><small>{item.messageCount} message(s)</small></button>
                      <button className="conversation-delete" aria-label={`Supprimer ${item.title}`} onClick={() => removeConversation(item.id)}>×</button>
                    </div>)}
                  </div>
                </aside>
                <div className="chat-card">
                  <div className="chat-intro"><span>✦</span><div><strong>Assistant de {project.project.name}</strong><p>Demandez une date, un montant, un organisme ou une synthèse.</p></div></div>
                  {!indexResult && rag.status === "idle" && <div className="index-callout"><div><strong>Préparer la recherche intelligente</strong><p>ClairDoc doit créer l’index sémantique de ce projet avant la première question.</p></div><button className="primary-button" onClick={buildIndex}>Estimer l’indexation</button></div>}
                  {rag.status === "estimating" && <div className="ocr-progress"><span className="mini-spinner" /> Estimation en cours…</div>}
                  {rag.status === "estimate" && <div className="index-estimate"><strong>{formatNumber(rag.estimate.estimatedTokens)} tokens estimés</strong><p>{rag.estimate.documentsToEmbed} document(s) à encoder · coût approximatif {new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", minimumFractionDigits: 4 }).format(rag.estimate.estimatedCostUsd)}</p><button className="primary-button" onClick={confirmIndex}>Confirmer</button></div>}
                  {rag.status === "indexing" && <div className="ocr-progress"><span className="mini-spinner" /> Préparation de l’assistant…</div>}
                  {rag.status === "error" && <div className="error-result"><p>{rag.message}</p>{rag.task && <button className="secondary-button" onClick={retryIndex}>Relancer</button>}</div>}
                  {conversationLoading && <div className="ocr-progress"><span className="mini-spinner" /> Chargement de la conversation…</div>}
                  <div className="conversation">
                    {activeConversation?.messages.map((message) => message.role === "user"
                      ? <div className="user-message" key={message.id}>{message.content}</div>
                      : <div className="assistant-message" key={message.id}><span>✦</span><div><p>{message.content}</p>{message.actions.length > 0 && <div className="action-list">{message.actions.map((action, index) => <span className={action.status} key={`${message.id}-${index}`}>{action.summary}</span>)}</div>}<div className="source-list">{message.citations.map((citation, index) => <button type="button" key={`${citation.job_id}-${citation.chunk_index}`}><b>[{index + 1}] {citation.document_name}</b><small>{citation.page_number ? `Page ${citation.page_number} · ` : ""}{citation.excerpt}</small></button>)}</div></div></div>)}
                    {!conversationLoading && activeConversation?.messages.length === 0 && <p className="empty-hint">Cette conversation est vide. Demandez une recherche, une synthèse ou une action sur le projet.</p>}
                  </div>
                  {assistantError && <div className="error-result"><p>{assistantError}</p></div>}
                  <form className="chat-composer" onSubmit={ask}>
                    <label className="assistant-permission"><input type="checkbox" checked={allowAssistantActions} onChange={(event) => setAllowAssistantActions(event.target.checked)} /><span>Autoriser les modifications pour ce message</span></label>
                    <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Posez une question ou demandez une action…" minLength={3} maxLength={4000} required />
                    <button className="primary-button" disabled={assistantSending || conversationLoading}>{assistantSending ? "…" : "Envoyer"}</button>
                  </form>
                </div>
              </div>
            )}
          </section>
        )}

        <section className={`server-card ${activeView !== "settings" ? "view-hidden" : ""}`} aria-labelledby="server-title">
          <div className="server-heading">
            <div><p className="eyebrow">Serveur local</p><h2 id="server-title">Connexion à ClairDoc Server</h2></div>
            <span className={`connection-badge ${connected ? "online" : "offline"}`}>
              <span aria-hidden="true" />{connected ? `Connecté · v${connection.version}` : "Non connecté"}
            </span>
          </div>
          <div className="server-readonly"><div><span>Adresse configurée</span><strong>{serverUrl}</strong></div><button className="secondary-button small-button" type="button" disabled={connection.status === "testing"} onClick={retestServer}>{connection.status === "testing" ? "Test…" : "Tester la connexion"}</button></div>
          <div className="server-feedback" aria-live="polite">
            {connection.status === "error" && <p className="inline-error">{connection.message}</p>}
            {connected && (
              <div className="backup-controls">
                <p>Clé validée. Les documents peuvent être envoyés au serveur OCR.</p>
                <button className="text-button" type="button" disabled={backup.status === "saving"} onClick={backupMetadata}>
                  {backup.status === "saving" ? "Sauvegarde…" : "Sauvegarder les métadonnées"}
                </button>
                {backup.status === "saved" && <small>Sauvegarde créée : {backup.path} ({formatBytes(backup.size)})</small>}
                {backup.status === "error" && <small className="inline-error">{backup.message}</small>}
              </div>
            )}
            {!connected && connection.status !== "testing" && <p>L’adresse et la clé sont chargées depuis la configuration locale de l’application.</p>}
          </div>
          {connected && projects.length > 0 && (
            <label className="project-picker">
              Reprendre un projet existant
              <select
                value={project.status === "ready" ? project.project.id : ""}
                onChange={(event) => {
                  const selected = projects.find((item) => item.id === event.target.value);
                  selectProject(selected);
                }}
              >
                <option value="">Créer un nouveau projet</option>
                {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          )}
        </section>

        {activeView === "settings" && (
          <section className="settings-grid">
            <article className="settings-panel">
              <div className="settings-title"><span>✦</span><div><h2>Intelligence artificielle</h2><p>Modèles utilisés par le serveur pour ce poste.</p></div></div>
              <label className="model-picker">Modèle de réponse<select value={runtimeInfo?.llmModel ?? ""} disabled={!runtimeInfo} onChange={(event) => selectRuntimeModel(event.target.value)}>{runtimeInfo?.modelOptions.map((model) => <option key={model} value={model}>{model === "gpt-6-luna" ? "Luna · rapide et économique" : model === "gpt-5.6-terra" ? "Terra · équilibré" : "Sol · plus puissant"}</option>)}</select></label>
              <dl><div><dt>Modèle actif</dt><dd>{runtimeInfo?.llmModel ?? "—"}</dd></div><div><dt>Modèle d’embeddings</dt><dd>{runtimeInfo?.embeddingModel ?? "—"}</dd></div><div><dt>Dimensions</dt><dd>{runtimeInfo?.embeddingDimensions ?? "—"}</dd></div><div><dt>Clé OpenAI</dt><dd>{runtimeInfo?.openaiConfigured ? "Configurée" : "Non configurée"}</dd></div></dl>
              <label className="model-picker">Calcul des embeddings<select value={runtimeInfo?.embeddingProvider ?? "openai"} disabled={!runtimeInfo} onChange={(event) => selectEmbeddingProvider(event.target.value)}><option value="openai">API OpenAI</option><option value="local">Local sur le serveur · MiniLM multilingue</option></select></label>
              <p className="settings-explanation">En local, aucun texte n’est envoyé à OpenAI pour les embeddings. Le modèle est téléchargé une fois, puis fonctionne sur CPU. Relancez l’indexation de chaque projet pour changer son index. Les réponses et le renommage IA utilisent toujours OpenAI ; leurs extraits sont transmis à l’API.</p>
            </article>
            <article className="settings-panel">
              <div className="settings-title"><span>◫</span><div><h2>Traitement local</h2><p>OCR, stockage et limites de sécurité.</p></div></div>
              <dl><div><dt>Langues OCR</dt><dd>{runtimeInfo?.ocrLanguages ?? "—"}</dd></div><div><dt>Taille maximale</dt><dd>{runtimeInfo ? `${runtimeInfo.maxUploadMb} Mo` : "—"}</dd></div><div><dt>Limite d’indexation</dt><dd>{runtimeInfo ? `${formatNumber(runtimeInfo.maxIndexTokens)} tokens` : "—"}</dd></div><div><dt>Connexion chiffrée</dt><dd>{runtimeInfo?.tlsEnabled ? "TLS actif" : "Réseau local"}</dd></div></dl>
              <p className="settings-path">Données : {runtimeInfo?.dataDir ?? "Connexion au serveur requise"}</p>
            </article>
            <article className="settings-panel appearance-panel">
              <div className="settings-title"><span>{theme === "light" ? "☾" : "☀"}</span><div><h2>Apparence</h2><p>Choisissez le thème le plus confortable.</p></div></div>
              <div className="theme-choice"><button className={theme === "light" ? "selected" : ""} onClick={() => setTheme("light")}><span>☀</span>Clair</button><button className={theme === "dark" ? "selected" : ""} onClick={() => setTheme("dark")}><span>☾</span>Sombre</button></div>
            </article>
          </section>
        )}

        <section className={`hero ${activeView !== "import" ? "view-hidden" : ""}`} aria-labelledby="page-title">
          <p className="eyebrow">Nouveau classement</p>
          <h1 id="page-title">Commençons par vos documents</h1>
          <p className="hero-copy">Choisissez un dossier. Nous allons uniquement compter et identifier les fichiers qu’il contient, sans les déplacer ni les modifier.</p>
        </section>

        <section className={`workspace-card ${activeView !== "import" ? "view-hidden" : ""}`} aria-live="polite">
          {scan.status === "idle" && (
            <div className="empty-state">
              <div className="folder-illustration"><FolderIcon /></div>
              <h2>Choisir le dossier à organiser</h2>
              <p>Tous ses sous-dossiers seront inclus dans l’analyse.</p>
              <button className="primary-button" onClick={chooseFolder}><FolderIcon /> Choisir un dossier</button>
              <p className="reassurance">Aucune suppression et aucun déplacement ne seront effectués.</p>
            </div>
          )}

          {scan.status === "scanning" && (
            <div className="empty-state scanning-state"><div className="spinner" aria-hidden="true" /><h2>Analyse du dossier en cours…</h2><p className="path-label">{scan.path}</p></div>
          )}

          {scan.status === "error" && (
            <div className="empty-state error-state"><div className="status-symbol" aria-hidden="true">!</div><h2>Impossible d’analyser ce dossier</h2><p>{scan.message}</p><button className="primary-button" onClick={chooseFolder}>Essayer un autre dossier</button></div>
          )}

          {scan.status === "ready" && (
            <div className="summary-state">
              <div className="summary-heading">
                <div><p className="success-label">Analyse terminée</p><h2>{scan.summary.folderName}</h2><p className="path-label">{scan.summary.rootPath}</p></div>
                <span className="read-only-badge"><ShieldIcon /> Lecture seule</span>
              </div>

              <div className="metrics-grid">
                <article><strong>{formatNumber(scan.summary.fileCount)}</strong><span>fichiers</span></article>
                <article><strong>{formatNumber(scan.summary.directoryCount)}</strong><span>sous-dossiers</span></article>
                <article><strong>{formatBytes(scan.summary.totalBytes)}</strong><span>au total</span></article>
              </div>

              <div className="file-breakdown">
                <h3>Documents reconnus</h3>
                <div className="breakdown-row"><span>Documents PDF</span><strong>{formatNumber(scan.summary.pdfCount)}</strong></div>
                <div className="breakdown-row"><span>Images</span><strong>{formatNumber(scan.summary.imageCount)}</strong></div>
                <div className="breakdown-row"><span>Documents bureautiques</span><strong>{formatNumber(scan.summary.officeCount)}</strong></div>
                {scan.summary.inaccessibleCount > 0 && <div className="breakdown-row warning-row"><span>Éléments non accessibles</span><strong>{formatNumber(scan.summary.inaccessibleCount)}</strong></div>}
              </div>

              <div className="summary-actions">
                <button className="secondary-button" onClick={chooseFolder}>Choisir un autre dossier</button>
                <button className="primary-button" disabled={!connected || project.status === "creating" || project.status === "ready"} onClick={createProject}>
                  {project.status === "creating" ? "Création…" : project.status === "ready" ? "Projet créé" : "Créer le projet"}<span aria-hidden="true">→</span>
                </button>
              </div>
              {!connected && <p className="coming-soon">Connectez d’abord ClairDoc Server.</p>}
              {project.status === "error" && <p className="inline-error align-right">{project.message}</p>}

              {project.status === "ready" && (
                <>
                <section className="ocr-panel" aria-labelledby="ocr-title">
                  <div><p className="success-label">Projet prêt · {project.project.name}</p><h3 id="ocr-title">Importer les documents du dossier</h3><p>PDF, textes, Office, courriels et images sont inclus. Les fichiers identiques ne sont pas retraités.</p></div>
                  {batch.status === "idle" && (
                    <div className="import-actions"><button className="primary-button" onClick={importAllDocuments}>Importer tous les documents</button><button className="text-button" onClick={choosePdf}>Ou choisir un seul document</button></div>
                  )}
                  {batch.status === "discovering" && <div className="ocr-progress"><span className="mini-spinner" /> Recherche des documents…</div>}
                  {batch.status === "uploading" && (
                    <div className="batch-progress">
                      <div className="result-heading"><strong>Envoi {batch.next} / {batch.files.length}</strong><button className="secondary-button small-button" onClick={toggleBatchPause}>{batch.paused ? "Reprendre" : "Mettre en pause"}</button></div>
                      <progress value={batch.next} max={batch.files.length} />
                      <p>{batch.paused ? "Import en pause." : batch.files[batch.next]?.name ?? "Finalisation des envois…"}</p>
                    </div>
                  )}
                  {batch.status === "processing" && (
                    <div className="batch-progress">
                      <div className="result-heading"><strong>Traitement OCR · {completedJobs.length} terminé(s), {pendingJobs.length} en attente</strong><button className="secondary-button small-button" onClick={toggleBatchPause}>{batch.paused ? "Reprendre" : "Mettre en pause"}</button></div>
                      <progress value={completedJobs.length + failedJobs.length} max={Math.max(batch.jobIds.length, 1)} />
                    </div>
                  )}
                  {batch.status === "completed" && <div className="batch-complete"><strong>Import terminé</strong><span>{completedJobs.length} document(s) prêt(s), {failedJobs.length} échec(s).</span><button className="text-button" onClick={importAllDocuments}>Rechercher les nouveaux documents</button></div>}
                  {batch.status === "error" && <div className="ocr-result error-result"><p>{batch.message}</p>{batch.files.length > 0 && <button className="secondary-button" onClick={resumeUploadAfterError}>Reprendre l’envoi</button>}</div>}
                  {failedJobs.length > 0 && <button className="secondary-button retry-button" onClick={retryFailedJobs}>Relancer {failedJobs.length} échec(s)</button>}
                  {batch.status === "idle" && projectJobs.length > 0 && <p className="existing-jobs">Historique : {completedJobs.length} terminé(s), {pendingJobs.length} en cours, {failedJobs.length} en échec.</p>}
                  {ocr.status === "uploading" && <div className="ocr-progress"><span className="mini-spinner" /> Envoi du document…</div>}
                  {ocr.status === "processing" && <div className="ocr-progress"><span className="mini-spinner" /> OCR en cours · {ocr.job.original_filename}</div>}
                  {ocr.status === "error" && <div className="ocr-result error-result"><p>{ocr.message}</p><button className="secondary-button" onClick={choosePdf}>Réessayer</button></div>}
                  {ocr.status === "completed" && (
                    <div className="ocr-result">
                      <div className="result-heading"><strong>Texte extrait de {ocr.job.original_filename}</strong><button className="text-button" onClick={choosePdf}>Tester un autre document</button></div>
                      <pre>{ocr.text || "Aucun texte détecté dans ce document."}</pre>
                    </div>
                  )}
                </section>
                {documentsReady && (
                  <section className="rag-panel" aria-labelledby="rag-title">
                    <div className="rag-heading">
                      <div><p className="success-label">Recherche intelligente</p><h3 id="rag-title">Interroger les documents</h3><p>L’index et les embeddings sont conservés localement sur le serveur.</p></div>
                      {(rag.status === "idle" || (rag.status === "error" && !rag.result)) && <button className="primary-button" onClick={buildIndex}>Estimer l’indexation</button>}
                    </div>
                    {rag.status === "estimating" && <div className="ocr-progress"><span className="mini-spinner" /> Estimation du volume…</div>}
                    {rag.status === "estimate" && (
                      <div className="index-estimate">
                        <strong>Estimation avant calcul</strong>
                        <p>{formatNumber(rag.estimate.documentsToEmbed)} document(s) à encoder · {formatNumber(rag.estimate.documentsReused)} réutilisé(s)</p>
                        <p>Environ {formatNumber(rag.estimate.estimatedTokens)} tokens · coût estimé {new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD", minimumFractionDigits: 4 }).format(rag.estimate.estimatedCostUsd)}</p>
                        <small>Estimation indicative avec {rag.estimate.embeddingModel}. Aucun nouveau calcul n’a encore été lancé.</small>
                        <button className="primary-button" onClick={confirmIndex}>Confirmer l’indexation</button>
                      </div>
                    )}
                    {rag.status === "indexing" && <div className="ocr-progress"><span className="mini-spinner" /> Indexation persistante en arrière-plan · {rag.task.status === "queued" ? "en attente" : "embeddings en cours"}…</div>}
                    {rag.status === "error" && <div className="ocr-result error-result"><p>{rag.message}</p>{rag.task && <button className="secondary-button" onClick={retryIndex}>Relancer l’indexation</button>}</div>}
                    {indexResult && (
                      <>
                        <p className="index-summary">{indexResult.chunksIndexed} extraits prêts · {indexResult.documentsIndexed} document(s) indexé(s) · {indexResult.documentsReused} réutilisé(s)</p>
                        <form className="question-form" onSubmit={ask}>
                          <label htmlFor="document-question">Votre question</label>
                          <textarea id="document-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Exemple : quelle est la date de la dernière facture ?" minLength={3} maxLength={4000} required />
                          <button className="primary-button" disabled={rag.status === "asking"}>{rag.status === "asking" ? "Recherche…" : "Poser la question"}</button>
                        </form>
                      </>
                    )}
                    {rag.status === "answered" && (
                      <div className="answer-card">
                        <strong>Réponse</strong>
                        <p>{rag.answer.answer}</p>
                        <h4>Sources utilisées</h4>
                        <ul>{rag.answer.citations.map((citation, index) => <li key={`${citation.job_id}-${citation.chunk_index}`}><b>[{index + 1}] {citation.document_name}{citation.page_number ? ` · page ${citation.page_number}` : ""}</b><span>{citation.excerpt}</span></li>)}</ul>
                      </div>
                    )}
                    {indexResult && organization.status !== "applied" && <div className="organization-start"><label><input type="checkbox" checked={renameFiles} disabled={organization.status === "planning" || organization.status === "applying"} onChange={(event) => { setRenameFiles(event.target.checked); setOrganization({ status: "idle" }); }} /> Autoriser l’IA à proposer de nouveaux noms d’après le contenu</label><p>Sans cette option, les noms actuels sont conservés (sauf doublons). Les propositions sont modifiables avant validation. Le renommage IA utilise OpenAI.</p>{organization.status === "idle" && <button className="secondary-button" onClick={prepareOrganization}>Préparer le classement</button>}</div>}
                    {organization.status === "planning" && <div className="ocr-progress organization-start"><span className="mini-spinner" /> Analyse des catégories et des noms…</div>}
                    {organization.status === "error" && <div className="ocr-result error-result organization-start"><p>{organization.message}</p><button className="secondary-button" onClick={prepareOrganization}>Réessayer</button></div>}
                    {organizationPlan && (
                      <div className="organization-preview">
                        <div className="result-heading"><div><strong>Prévisualisation du classement</strong><p>{selectedPlanEntries.length} document(s) sélectionné(s) sur {organizationPlan.entries.length}. Les originaux resteront inchangés.</p></div><button className="text-button" onClick={() => setSelectedPlanEntries(selectedPlanEntries.length === organizationPlan.entries.length ? [] : organizationPlan.entries.map((entry) => entry.job_id))}>{selectedPlanEntries.length === organizationPlan.entries.length ? "Tout désélectionner" : "Tout sélectionner"}</button></div>
                        <div className="plan-list">
                          {organizationPlan.entries.map((entry) => (
                            <article key={entry.job_id} className={selectedPlanEntries.includes(entry.job_id) ? "selected" : ""}>
                              <input type="checkbox" aria-label={`Classer ${entry.original_filename}`} checked={selectedPlanEntries.includes(entry.job_id)} onChange={() => setSelectedPlanEntries((current) => current.includes(entry.job_id) ? current.filter((id) => id !== entry.job_id) : [...current, entry.job_id])} />
                              <div><strong>{entry.original_filename}</strong><span>{entry.category}{entry.document_date ? ` · ${entry.document_date}` : ""}</span><small>{entry.reason}</small><input aria-label={`Chemin proposé pour ${entry.original_filename}`} value={entry.suggested_path} onChange={(event) => updateSuggestedPath(entry.job_id, event.target.value)} /></div>
                            </article>
                          ))}
                        </div>
                        {organization.status !== "applied" && <><div className="organization-mode"><label className={organizationMode === "copy" ? "selected" : ""}><input type="radio" name="organization-mode" checked={organizationMode === "copy"} onChange={() => setOrganizationMode("copy")} /><strong>Copier</strong><span>Conserver les originaux à leur emplacement actuel.</span></label><label className={organizationMode === "move" ? "selected danger-choice" : ""}><input type="radio" name="organization-mode" checked={organizationMode === "move"} onChange={() => setOrganizationMode("move")} /><strong>Déplacer et nettoyer</strong><span>Utiliser les PDF OCRisés, créer l’architecture puis retirer les anciens fichiers.</span></label></div><button className="primary-button" disabled={organization.status === "applying" || selectedPlanEntries.length === 0} onClick={applyPlan}>{organization.status === "applying" ? "Classement en cours…" : organizationMode === "copy" ? "Valider et copier" : "Valider et déplacer"}</button></>}
                        {organization.status === "applied" && <div className="organization-success"><strong>{organization.copied} document(s) classé(s)</strong><span>Le manifeste et la sauvegarde de sécurité permettent une annulation contrôlée tant que les nouveaux fichiers ne sont pas modifiés.</span><button className="secondary-button" onClick={undoLastOrganization}>Annuler ce classement</button></div>}
                      </div>
                    )}
                  </section>
                )}
                </>
              )}
            </div>
          )}
        </section>

        <section className={`steps ${activeView !== "import" ? "view-hidden" : ""}`} aria-label="Étapes du classement">
          <div className="step active"><span>1</span><div><strong>Choisir</strong><small>Votre dossier</small></div></div><div className="step-line" />
          <div className={`step ${project.status === "ready" ? "active" : ""}`}><span>2</span><div><strong>Analyser</strong><small>Vos documents</small></div></div><div className="step-line" />
          <div className={`step ${ocr.status === "completed" ? "active" : ""}`}><span>3</span><div><strong>Vérifier</strong><small>Les résultats</small></div></div>
        </section>
      </main>
    </div>
  );
}

export default App;
