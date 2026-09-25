import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  askProject,
  configureServer,
  createRemoteProject,
  getOcrJob,
  getOcrText,
  getServerConfig,
  indexProject,
  listPdfFiles,
  listProjectJobs,
  listRemoteProjects,
  pauseProjectOcr,
  PdfFile,
  AskResult,
  IndexResult,
  OcrJob,
  RemoteProject,
  submitOcrJob,
  testServerConnection,
  resumeProjectOcr,
  retryOcrJob,
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
  | { status: "indexing" }
  | { status: "ready"; result: IndexResult }
  | { status: "asking"; result: IndexResult }
  | { status: "answered"; result: IndexResult; answer: AskResult }
  | { status: "error"; message: string; result?: IndexResult };

type BatchState =
  | { status: "idle" }
  | { status: "discovering" }
  | { status: "uploading"; files: PdfFile[]; next: number; jobIds: string[]; paused: boolean }
  | { status: "processing"; files: PdfFile[]; jobIds: string[]; paused: boolean }
  | { status: "completed"; files: PdfFile[]; jobIds: string[] }
  | {
      status: "error";
      message: string;
      files: PdfFile[];
      next: number;
      jobIds: string[];
      paused: boolean;
    };

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
  const [apiKey, setApiKey] = useState("");
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>({ status: "loading" });
  const [project, setProject] = useState<ProjectState>({ status: "idle" });
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [ocr, setOcr] = useState<OcrState>({ status: "idle" });
  const [batch, setBatch] = useState<BatchState>({ status: "idle" });
  const [projectJobs, setProjectJobs] = useState<OcrJob[]>([]);
  const [rag, setRag] = useState<RagState>({ status: "idle" });
  const [question, setQuestion] = useState("");

  useEffect(() => {
    let active = true;
    getServerConfig()
      .then(async (config) => {
        if (!active) return;
        setServerUrl(config.serverUrl);
        setHasSavedKey(config.configured);
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
    submitOcrJob(file.path, project.project.id)
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

  async function saveServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnection({ status: "testing" });
    try {
      const result = await configureServer(serverUrl, apiKey);
      setApiKey("");
      setHasSavedKey(true);
      setConnection({ status: "connected", version: result.version });
    } catch (error) {
      setConnection({
        status: "error",
        message: errorMessage(error, "La configuration n’a pas pu être enregistrée."),
      });
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
      const created = await createRemoteProject(scan.summary.folderName);
      setProject({ status: "ready", project: created });
      setProjects((current) => [created, ...current.filter((item) => item.id !== created.id)]);
    } catch (error) {
      setProject({ status: "error", message: errorMessage(error, "Le projet n’a pas pu être créé.") });
    }
  }

  async function importAllPdfs() {
    if (scan.status !== "ready" || project.status !== "ready") return;
    setBatch({ status: "discovering" });
    try {
      const files = await listPdfFiles(scan.summary.rootPath);
      if (files.length === 0) {
        setBatch({
          status: "error",
          message: "Aucun PDF n’a été trouvé dans ce dossier.",
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
      title: "Choisir un PDF à OCRiser",
      filters: [{ name: "Document PDF", extensions: ["pdf"] }],
    });
    if (!selected) return;
    setOcr({ status: "uploading", path: selected });
    setRag({ status: "idle" });
    try {
      const job = await submitOcrJob(selected, project.project.id);
      setOcr({ status: "processing", path: selected, job });
    } catch (error) {
      setOcr({ status: "error", message: errorMessage(error, "Le PDF n’a pas pu être envoyé.") });
    }
  }

  async function buildIndex() {
    if (project.status !== "ready") return;
    setRag({ status: "indexing" });
    try {
      const result = await indexProject(project.project.id);
      setRag({ status: "ready", result });
    } catch (error) {
      setRag({ status: "error", message: errorMessage(error, "L’indexation a échoué.") });
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (project.status !== "ready" || (rag.status !== "ready" && rag.status !== "answered")) return;
    const result = rag.result;
    setRag({ status: "asking", result });
    try {
      const answer = await askProject(project.project.id, question.trim());
      setRag({ status: "answered", result, answer });
    } catch (error) {
      setRag({
        status: "error",
        result,
        message: errorMessage(error, "La question n’a pas pu être traitée."),
      });
    }
  }

  const connected = connection.status === "connected";
  const indexResult = "result" in rag ? rag.result : undefined;
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="ClairDoc"><span className="brand-mark"><FolderIcon /></span><span>ClairDoc</span></div>
        <div className="privacy-note"><ShieldIcon /><span>Vos originaux restent inchangés</span></div>
      </header>

      <main className="main-content">
        <section className="server-card" aria-labelledby="server-title">
          <div className="server-heading">
            <div><p className="eyebrow">Serveur local</p><h2 id="server-title">Connexion à ClairDoc Server</h2></div>
            <span className={`connection-badge ${connected ? "online" : "offline"}`}>
              <span aria-hidden="true" />{connected ? `Connecté · v${connection.version}` : "Non connecté"}
            </span>
          </div>
          <form className="server-form" onSubmit={saveServer}>
            <label>
              Adresse du serveur
              <input type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://127.0.0.1:8787" required />
            </label>
            <label>
              Clé ClairDoc
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={hasSavedKey ? "Clé déjà enregistrée" : "Collez CLAIRDOC_API_KEY"} autoComplete="new-password" minLength={16} required />
            </label>
            <button className="primary-button compact-button" disabled={connection.status === "testing"}>
              {connection.status === "testing" ? "Connexion…" : "Enregistrer et tester"}
            </button>
          </form>
          <div className="server-feedback" aria-live="polite">
            {connection.status === "error" && <p className="inline-error">{connection.message}</p>}
            {connected && <p>Clé validée. Les documents peuvent être envoyés au serveur OCR.</p>}
            {hasSavedKey && !connected && connection.status !== "testing" && <button className="text-button" type="button" onClick={retestServer}>Retester la clé enregistrée</button>}
          </div>
          {connected && projects.length > 0 && (
            <label className="project-picker">
              Reprendre un projet existant
              <select
                value={project.status === "ready" ? project.project.id : ""}
                onChange={(event) => {
                  const selected = projects.find((item) => item.id === event.target.value);
                  setProject(selected ? { status: "ready", project: selected } : { status: "idle" });
                  setBatch({ status: "idle" });
                  setRag({ status: "idle" });
                }}
              >
                <option value="">Créer un nouveau projet</option>
                {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          )}
        </section>

        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow">Nouveau classement</p>
          <h1 id="page-title">Commençons par vos documents</h1>
          <p className="hero-copy">Choisissez un dossier. Nous allons uniquement compter et identifier les fichiers qu’il contient, sans les déplacer ni les modifier.</p>
        </section>

        <section className="workspace-card" aria-live="polite">
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
                  <div><p className="success-label">Projet prêt · {project.project.name}</p><h3 id="ocr-title">Importer les PDF du dossier</h3><p>Les sous-dossiers sont inclus. Les fichiers identiques déjà connus ne sont pas retraités.</p></div>
                  {batch.status === "idle" && (
                    <div className="import-actions"><button className="primary-button" onClick={importAllPdfs}>Importer tous les PDF</button><button className="text-button" onClick={choosePdf}>Ou choisir un seul PDF</button></div>
                  )}
                  {batch.status === "discovering" && <div className="ocr-progress"><span className="mini-spinner" /> Recherche des PDF…</div>}
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
                  {batch.status === "completed" && <div className="batch-complete"><strong>Import terminé</strong><span>{completedJobs.length} document(s) prêt(s), {failedJobs.length} échec(s).</span><button className="text-button" onClick={importAllPdfs}>Rechercher les nouveaux PDF</button></div>}
                  {batch.status === "error" && <div className="ocr-result error-result"><p>{batch.message}</p>{batch.files.length > 0 && <button className="secondary-button" onClick={resumeUploadAfterError}>Reprendre l’envoi</button>}</div>}
                  {failedJobs.length > 0 && <button className="secondary-button retry-button" onClick={retryFailedJobs}>Relancer {failedJobs.length} échec(s)</button>}
                  {batch.status === "idle" && projectJobs.length > 0 && <p className="existing-jobs">Historique : {completedJobs.length} terminé(s), {pendingJobs.length} en cours, {failedJobs.length} en échec.</p>}
                  {ocr.status === "uploading" && <div className="ocr-progress"><span className="mini-spinner" /> Envoi du PDF…</div>}
                  {ocr.status === "processing" && <div className="ocr-progress"><span className="mini-spinner" /> OCR en cours · {ocr.job.original_filename}</div>}
                  {ocr.status === "error" && <div className="ocr-result error-result"><p>{ocr.message}</p><button className="secondary-button" onClick={choosePdf}>Réessayer</button></div>}
                  {ocr.status === "completed" && (
                    <div className="ocr-result">
                      <div className="result-heading"><strong>Texte extrait de {ocr.job.original_filename}</strong><button className="text-button" onClick={choosePdf}>Tester un autre PDF</button></div>
                      <pre>{ocr.text || "Aucun texte détecté dans ce document."}</pre>
                    </div>
                  )}
                </section>
                {documentsReady && (
                  <section className="rag-panel" aria-labelledby="rag-title">
                    <div className="rag-heading">
                      <div><p className="success-label">Recherche intelligente</p><h3 id="rag-title">Interroger les documents</h3><p>L’index et les embeddings sont conservés localement sur le serveur.</p></div>
                      {(rag.status === "idle" || (rag.status === "error" && !rag.result)) && <button className="primary-button" onClick={buildIndex}>Créer l’index</button>}
                    </div>
                    {rag.status === "indexing" && <div className="ocr-progress"><span className="mini-spinner" /> Création des embeddings…</div>}
                    {rag.status === "error" && <p className="inline-error">{rag.message}</p>}
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
                        <ul>{rag.answer.citations.map((citation, index) => <li key={`${citation.job_id}-${citation.chunk_index}`}><b>[{index + 1}] {citation.document_name}</b><span>{citation.excerpt}</span></li>)}</ul>
                      </div>
                    )}
                  </section>
                )}
                </>
              )}
            </div>
          )}
        </section>

        <section className="steps" aria-label="Étapes du classement">
          <div className="step active"><span>1</span><div><strong>Choisir</strong><small>Votre dossier</small></div></div><div className="step-line" />
          <div className={`step ${project.status === "ready" ? "active" : ""}`}><span>2</span><div><strong>Analyser</strong><small>Vos documents</small></div></div><div className="step-line" />
          <div className={`step ${ocr.status === "completed" ? "active" : ""}`}><span>3</span><div><strong>Vérifier</strong><small>Les résultats</small></div></div>
        </section>
      </main>
    </div>
  );
}

export default App;
