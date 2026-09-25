import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  configureServer,
  createRemoteProject,
  getOcrJob,
  getOcrText,
  getServerConfig,
  OcrJob,
  RemoteProject,
  submitOcrJob,
  testServerConnection,
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
  const [ocr, setOcr] = useState<OcrState>({ status: "idle" });

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
    setProject({ status: "idle" });
    setOcr({ status: "idle" });
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
    } catch (error) {
      setProject({ status: "error", message: errorMessage(error, "Le projet n’a pas pu être créé.") });
    }
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
    try {
      const job = await submitOcrJob(selected, project.project.id);
      setOcr({ status: "processing", path: selected, job });
    } catch (error) {
      setOcr({ status: "error", message: errorMessage(error, "Le PDF n’a pas pu être envoyé.") });
    }
  }

  const connected = connection.status === "connected";

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
                <section className="ocr-panel" aria-labelledby="ocr-title">
                  <div><p className="success-label">Projet prêt</p><h3 id="ocr-title">Tester l’OCR avec un PDF</h3><p>Le fichier original reste intact. Une copie est envoyée au serveur local.</p></div>
                  {ocr.status === "idle" && <button className="primary-button" onClick={choosePdf}>Choisir un PDF</button>}
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
