import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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

  async function chooseFolder() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choisir le dossier à analyser",
    });

    if (!selected) return;
    setScan({ status: "scanning", path: selected });

    try {
      const summary = await invoke<FolderSummary>("scan_folder", { path: selected });
      setScan({ status: "ready", summary });
    } catch (error) {
      setScan({
        status: "error",
        message: typeof error === "string" ? error : "Le dossier n’a pas pu être analysé.",
      });
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Assistant Documents">
          <span className="brand-mark"><FolderIcon /></span>
          <span>Assistant Documents</span>
        </div>
        <div className="privacy-note">
          <ShieldIcon />
          <span>Vos originaux restent inchangés</span>
        </div>
      </header>

      <main className="main-content">
        <section className="hero" aria-labelledby="page-title">
          <p className="eyebrow">Nouveau classement</p>
          <h1 id="page-title">Commençons par vos documents</h1>
          <p className="hero-copy">
            Choisissez un dossier. Nous allons uniquement compter et identifier les fichiers
            qu’il contient, sans les déplacer ni les modifier.
          </p>
        </section>

        <section className="workspace-card" aria-live="polite">
          {scan.status === "idle" && (
            <div className="empty-state">
              <div className="folder-illustration"><FolderIcon /></div>
              <h2>Choisir le dossier à organiser</h2>
              <p>
                Tous ses sous-dossiers seront inclus dans l’analyse. Vous pourrez vérifier le
                résultat avant de continuer.
              </p>
              <button className="primary-button" onClick={chooseFolder}>
                <FolderIcon />
                Choisir un dossier
              </button>
              <p className="reassurance">
                Aucune suppression et aucun déplacement ne seront effectués.
              </p>
            </div>
          )}

          {scan.status === "scanning" && (
            <div className="empty-state scanning-state">
              <div className="spinner" aria-hidden="true" />
              <h2>Analyse du dossier en cours…</h2>
              <p className="path-label">{scan.path}</p>
              <p>Cette étape peut prendre un moment pour un grand dossier.</p>
            </div>
          )}

          {scan.status === "error" && (
            <div className="empty-state error-state">
              <div className="status-symbol" aria-hidden="true">!</div>
              <h2>Impossible d’analyser ce dossier</h2>
              <p>{scan.message}</p>
              <button className="primary-button" onClick={chooseFolder}>
                Essayer un autre dossier
              </button>
            </div>
          )}

          {scan.status === "ready" && (
            <div className="summary-state">
              <div className="summary-heading">
                <div>
                  <p className="success-label">Analyse terminée</p>
                  <h2>{scan.summary.folderName}</h2>
                  <p className="path-label">{scan.summary.rootPath}</p>
                </div>
                <span className="read-only-badge"><ShieldIcon /> Lecture seule</span>
              </div>

              <div className="metrics-grid">
                <article>
                  <strong>{formatNumber(scan.summary.fileCount)}</strong>
                  <span>fichiers</span>
                </article>
                <article>
                  <strong>{formatNumber(scan.summary.directoryCount)}</strong>
                  <span>sous-dossiers</span>
                </article>
                <article>
                  <strong>{formatBytes(scan.summary.totalBytes)}</strong>
                  <span>au total</span>
                </article>
              </div>

              <div className="file-breakdown">
                <h3>Documents reconnus</h3>
                <div className="breakdown-row">
                  <span>Documents PDF</span>
                  <strong>{formatNumber(scan.summary.pdfCount)}</strong>
                </div>
                <div className="breakdown-row">
                  <span>Images</span>
                  <strong>{formatNumber(scan.summary.imageCount)}</strong>
                </div>
                <div className="breakdown-row">
                  <span>Documents bureautiques</span>
                  <strong>{formatNumber(scan.summary.officeCount)}</strong>
                </div>
                {scan.summary.inaccessibleCount > 0 && (
                  <div className="breakdown-row warning-row">
                    <span>Éléments non accessibles</span>
                    <strong>{formatNumber(scan.summary.inaccessibleCount)}</strong>
                  </div>
                )}
              </div>

              <div className="summary-actions">
                <button className="secondary-button" onClick={chooseFolder}>
                  Choisir un autre dossier
                </button>
                <button className="primary-button" disabled>
                  Créer le projet <span aria-hidden="true">→</span>
                </button>
              </div>
              <p className="coming-soon">
                La création du projet sera activée à la prochaine étape.
              </p>
            </div>
          )}
        </section>

        <section className="steps" aria-label="Étapes du classement">
          <div className="step active">
            <span>1</span><div><strong>Choisir</strong><small>Votre dossier</small></div>
          </div>
          <div className="step-line" />
          <div className="step">
            <span>2</span><div><strong>Analyser</strong><small>Vos documents</small></div>
          </div>
          <div className="step-line" />
          <div className="step">
            <span>3</span><div><strong>Vérifier</strong><small>Les propositions</small></div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
