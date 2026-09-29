import { FormEvent, useRef, useState } from "react";
import {
  DocumentSearchResult,
  RemoteProject,
  RuntimeInfo,
  openProjectFile,
  searchProjectDocuments,
} from "./server";

type Props = {
  project: RemoteProject;
  runtimeInfo: RuntimeInfo | null;
  searchDocuments?: (projectId: string, query: string, mode: "local" | "ai", limit: number) => Promise<DocumentSearchResult>;
  standalone?: boolean;
};

export default function DocumentSearch({ project, runtimeInfo, searchDocuments = searchProjectDocuments, standalone = false }: Props) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"local" | "ai">("local");
  const [limit, setLimit] = useState(10);
  const [result, setResult] = useState<DocumentSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const searchId = useRef(0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    const id = ++searchId.current;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const response = await searchDocuments(project.id, trimmed, mode, limit);
      if (id === searchId.current) setResult(response);
    } catch (failure) {
      if (id === searchId.current) setError(typeof failure === "string" ? failure : "La recherche a échoué.");
    } finally {
      if (id === searchId.current) setLoading(false);
    }
  }

  async function openDocument(relativePath: string) {
    if (!project.sourceRoot) return;
    try {
      await openProjectFile(project.sourceRoot, relativePath);
    } catch (failure) {
      setError(typeof failure === "string" ? failure : "Impossible d’ouvrir ce document.");
    }
  }

  return (
    <section className="search-view">
      <div className="page-heading compact">
        <div>
          <p className="eyebrow">Recherche documentaire</p>
          <h1>Retrouver un document</h1>
          <p>Recherchez dans les noms et le contenu indexé. Les résultats montrent les passages trouvés, sans réponse de l’assistant.</p>
        </div>
      </div>
      <form className="search-panel" onSubmit={submit}>
        <label htmlFor="project-search">Que recherchez-vous ?</label>
        <div className="search-input-row">
          <input id="project-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ex. facture d’électricité de mars 2025" minLength={2} maxLength={1000} required autoFocus />
          <button className="primary-button" disabled={loading || query.trim().length < 2}>{loading ? "Recherche…" : "Rechercher"}</button>
        </div>
        <div className="search-controls">
          <fieldset className="search-mode">
            <legend>Mode de recherche</legend>
            <label className={mode === "local" ? "selected" : ""}><input type="radio" name="search-mode" checked={mode === "local"} onChange={() => setMode("local")} /> Sans IA générative</label>
            <label className={mode === "ai" ? "selected" : ""}><input type="radio" name="search-mode" checked={mode === "ai"} onChange={() => setMode("ai")} /> Avec IA</label>
          </fieldset>
          <label className="search-limit">Documents affichés
            <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {[5, 10, 20].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <p className="search-explanation">
          {mode === "local"
            ? `Classement par noms, contenu et similarité des embeddings. ${standalone || runtimeInfo?.embeddingProvider === "openai" ? "L’encodage de votre requête utilise l’API OpenAI, sans modèle conversationnel." : "Avec un index local, aucun appel à OpenAI n’est nécessaire."}`
            : "OpenAI trie les extraits candidats. Seuls les noms des documents et leurs passages indexés sont renvoyés ; l’IA ne rédige pas de réponse."}
        </p>
      </form>
      {loading && <div className="search-feedback" role="status"><span className="mini-spinner" /> Recherche dans le projet…</div>}
      {error && <div className="search-feedback search-error" role="alert">{error}</div>}
      {result && !loading && (
        <div className="search-results" aria-live="polite">
          <div className="search-results-heading"><h2>{result.results.length} document{result.results.length > 1 ? "s" : ""} trouvé{result.results.length > 1 ? "s" : ""}</h2><span>{result.mode === "ai" ? `Tri IA${result.model ? ` · ${result.model}` : ""}` : "Tri sémantique"}</span></div>
          {result.results.length === 0 && <div className="search-feedback">Aucun passage pertinent trouvé. Essayez d’autres mots ou vérifiez que le projet est indexé.</div>}
          <ol className="search-result-list">
            {result.results.map((document) => (
              <li className="search-result-card" key={document.jobId}>
                <div className="search-result-head">
                  <div><h3>{document.documentName}</h3><p>{document.sourceRelativePath}</p></div>
                  <span className="category-chip">{document.category}</span>
                </div>
                {document.indexingMode === "name_only" ? <p className="search-no-text">Document indexé sur son nom uniquement : aucun texte n’a été extrait après OCR.</p> : document.passages.length === 0 ? <p className="search-no-text">Document retrouvé grâce à son titre ou ses métadonnées : aucun extrait du contenu n’est suffisamment pertinent.</p> : (
                  <div className="search-passages">{document.passages.map((passage) => <blockquote key={passage.chunkIndex}><small>{passage.pageNumber ? `Page ${passage.pageNumber}` : "Extrait du document"}</small><p>{passage.text}</p></blockquote>)}</div>
                )}
                {project.sourceRoot && <button className="secondary-button" type="button" onClick={() => void openDocument(document.sourceRelativePath)}>Ouvrir le document</button>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
