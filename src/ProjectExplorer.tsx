import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  createProjectDirectory,
  listProjectDirectory,
  openProjectDirectory,
  openProjectFile,
  removeEmptyProjectDirectory,
  type DocumentLibrary,
  type DraftAction,
  type LibraryDocument,
  type ProjectDraft,
  type ProjectDirectoryEntry,
  type ProjectDirectoryPage,
} from "./server";
import "./ProjectExplorer.css";

const PAGE_SIZE = 100;
const EMPTY_DOCUMENTS: LibraryDocument[] = [];

function ExplorerItemIcon({ name, directory = false }: { name: string; directory?: boolean }) {
  if (directory) {
    return <span className="explorer-file-icon folder" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M2.5 6.5a2 2 0 0 1 2-2h5l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" /></svg></span>;
  }
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const type = extension === "pdf" ? "pdf"
    : ["doc", "docx", "odt"].includes(extension) ? "word"
    : ["xls", "xlsx", "ods", "csv"].includes(extension) ? "sheet"
    : ["ppt", "pptx", "odp"].includes(extension) ? "slide"
    : ["png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "bmp", "heic"].includes(extension) ? "image"
    : ["txt", "md", "rtf"].includes(extension) ? "text"
    : ["zip", "7z", "rar"].includes(extension) ? "archive" : "generic";
  const label = { pdf: "PDF", word: "DOC", sheet: "XLS", slide: "PPT", image: "IMG", text: "TXT", archive: "ZIP", generic: "DOC" }[type];
  return <span className={`explorer-file-icon ${type}`} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 2.5h8l4.5 4.5v14.5H6a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2z" /><path d="M14 2.5V7h4.5" /></svg><span>{label}</span></span>;
}

type Props = {
  projectName: string;
  rootPath: string | null;
  library: DocumentLibrary | null;
  draft: ProjectDraft | null;
  draftApplying: { current: number; total: number } | null;
  draftError: string;
  draftNotice: string;
  onApplyDraft: () => void;
  onRemoveDraftItem: (conversationId: string, actionId: string) => void;
};

const EMPTY_DRAFT_ACTIONS: DraftAction[] = [];

function plannedEntries(
  documents: LibraryDocument[],
  originalPaths: Set<string>,
  path: string,
): ProjectDirectoryEntry[] {
  const prefix = path ? `${path}/` : "";
  const entries = new Map<string, ProjectDirectoryEntry>();
  for (const document of documents) {
    const destination = document.sourceRelativePath;
    if (originalPaths.has(destination) || !destination.startsWith(prefix)) continue;
    const remainder = destination.slice(prefix.length);
    const separator = remainder.indexOf("/");
    const name = separator < 0 ? remainder : remainder.slice(0, separator);
    if (!name) continue;
    const relativePath = `${prefix}${name}`;
    entries.set(relativePath, { name, relativePath, kind: separator < 0 ? "file" : "directory", bytes: 0 });
  }
  return [...entries.values()];
}

function parentPath(path: string) {
  const position = path.lastIndexOf("/");
  return position < 0 ? "" : path.slice(0, position);
}

function virtualPage(documents: LibraryDocument[], path: string, offset: number): ProjectDirectoryPage {
  const prefix = path ? `${path}/` : "";
  const folders = new Set<string>();
  const files: ProjectDirectoryEntry[] = [];
  for (const document of documents) {
    const relative = document.sourceRelativePath;
    if (!relative.startsWith(prefix)) continue;
    const remainder = relative.slice(prefix.length);
    const separator = remainder.indexOf("/");
    if (separator >= 0) folders.add(remainder.slice(0, separator));
    else files.push({ name: remainder, relativePath: relative, kind: "file", bytes: 0 });
  }
  const entries: ProjectDirectoryEntry[] = [
    ...Array.from(folders, (name) => ({ name, relativePath: `${prefix}${name}`, kind: "directory" as const, bytes: 0 })),
    ...files,
  ].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
  return { entries: entries.slice(offset, offset + PAGE_SIZE), total: entries.length, offset, limit: PAGE_SIZE };
}

export default function ProjectExplorer({ projectName, rootPath, library, draft, draftApplying, draftError, draftNotice, onApplyDraft, onRemoveDraftItem }: Props) {
  const documents = library?.documents ?? EMPTY_DOCUMENTS;
  const draftActions = draft?.actions ?? EMPTY_DRAFT_ACTIONS;
  const [path, setPath] = useState("");
  const [page, setPage] = useState(0);
  const [directory, setDirectory] = useState<ProjectDirectoryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [localAvailable, setLocalAvailable] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase("fr"));
  const [category, setCategory] = useState("Toutes");
  const [linkedTo, setLinkedTo] = useState<string | null>(null);
  const [resultLimit, setResultLimit] = useState(PAGE_SIZE);
  const [draftLimit, setDraftLimit] = useState(30);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const originalPaths = useMemo(
    () => new Set(documents.map((document) => document.sourceRelativePath)),
    [documents],
  );
  const lastPendingActionIds = useMemo(() => {
    const lastByJob = new Map<string, string>();
    for (const action of draftActions) lastByJob.set(action.job_id, action.id);
    return new Set(lastByJob.values());
  }, [draftActions]);

  const previewDocuments = useMemo(() => {
    const actionsByJob = new Map<string, DraftAction[]>();
    for (const action of draftActions) {
      const list = actionsByJob.get(action.job_id) ?? [];
      list.push(action);
      actionsByJob.set(action.job_id, list);
    }
    const result: LibraryDocument[] = [];
    for (const document of documents) {
      const actions = actionsByJob.get(document.jobId) ?? [];
      let currentPath: string | null = document.sourceRelativePath;
      for (const action of actions) {
        if (action.tool === "copy_document" && action.destination_relative_path) {
          const destination = action.destination_relative_path;
          result.push({ ...document, name: destination.slice(destination.lastIndexOf("/") + 1), sourceRelativePath: destination });
        } else if (action.tool === "delete_document") {
          currentPath = null;
        } else if (action.destination_relative_path) {
          currentPath = action.destination_relative_path;
        }
      }
      if (currentPath) result.push({ ...document, name: currentPath.slice(currentPath.lastIndexOf("/") + 1), sourceRelativePath: currentPath });
    }
    return result;
  }, [documents, draftActions]);
  const documentByPath = useMemo(() => new Map(previewDocuments.map((document) => [document.sourceRelativePath, document])), [previewDocuments]);
  const selectedDocument = selectedPath ? documentByPath.get(selectedPath) : undefined;
  const linkedDocument = linkedTo ? documents.find((document) => document.jobId === linkedTo) : undefined;
  const linkedIds = useMemo(() => {
    const ids = new Set<string>();
    if (!linkedTo) return ids;
    for (const relationship of library?.relationships ?? []) {
      if (relationship.sourceJobId === linkedTo) ids.add(relationship.targetJobId);
      if (relationship.targetJobId === linkedTo) ids.add(relationship.sourceJobId);
    }
    return ids;
  }, [library?.relationships, linkedTo]);
  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const relationship of library?.relationships ?? []) {
      counts.set(relationship.sourceJobId, (counts.get(relationship.sourceJobId) ?? 0) + 1);
      counts.set(relationship.targetJobId, (counts.get(relationship.targetJobId) ?? 0) + 1);
    }
    return counts;
  }, [library?.relationships]);
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const prefix = path ? `${path}/` : "";
    for (const document of previewDocuments) {
      if (!document.sourceRelativePath.startsWith(prefix)) continue;
      const remainder = document.sourceRelativePath.slice(prefix.length);
      const separator = remainder.indexOf("/");
      if (separator >= 0) {
        const folder = remainder.slice(0, separator);
        counts.set(folder, (counts.get(folder) ?? 0) + 1);
      }
    }
    return counts;
  }, [previewDocuments, path]);
  const displayedEntries = useMemo(() => {
    const finalPaths = new Set(previewDocuments.map((document) => document.sourceRelativePath));
    const hidden = new Set([...originalPaths].filter((original) => !finalPaths.has(original)));
    const entries = (directory?.entries ?? []).filter((entry) => !hidden.has(entry.relativePath));
    const known = new Set(entries.map((entry) => entry.relativePath));
    for (const entry of plannedEntries(previewDocuments, originalPaths, path)) {
      if (!known.has(entry.relativePath)) entries.push(entry);
    }
    return entries.sort((left, right) => Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name, "fr", { sensitivity: "base" }));
  }, [directory, originalPaths, previewDocuments, path]);
  const plannedPaths = useMemo(() => new Set(previewDocuments.map((document) => document.sourceRelativePath).filter((value) => !originalPaths.has(value))), [originalPaths, previewDocuments]);
  const plannedFolders = useMemo(() => [...new Set([...plannedPaths].map(parentPath).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr")), [plannedPaths]);
  const plannedDirectoryPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const folder of plannedFolders) {
      const parts = folder.split("/");
      for (let index = 1; index <= parts.length; index += 1) paths.add(parts.slice(0, index).join("/"));
    }
    return paths;
  }, [plannedFolders]);
  const searchMode = Boolean(deferredSearch || category !== "Toutes" || linkedTo);
  const results = useMemo(() => previewDocuments.filter((document) => {
    if (category !== "Toutes" && document.category !== category) return false;
    if (linkedTo && !linkedIds.has(document.jobId)) return false;
    return !deferredSearch || [document.name, document.sourceRelativePath, document.category, document.organization ?? ""]
      .some((value) => value.toLocaleLowerCase("fr").includes(deferredSearch));
  }), [category, deferredSearch, previewDocuments, linkedIds, linkedTo]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    if (!rootPath) {
      setDirectory(virtualPage(documents, path, page * PAGE_SIZE));
      setLocalAvailable(false);
      setLoading(false);
      return;
    }
    listProjectDirectory(rootPath, path, page * PAGE_SIZE, PAGE_SIZE)
      .then((result) => {
        if (!active) return;
        if (page > 0 && result.total <= page * PAGE_SIZE) {
          setPage(Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1));
          return;
        }
        setDirectory(result);
        setLocalAvailable(true);
      })
      .catch(() => {
        if (!active) return;
        const result = virtualPage(documents, path, page * PAGE_SIZE);
        if (page > 0 && result.total <= page * PAGE_SIZE) {
          setPage(Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1));
          return;
        }
        setDirectory(result);
        setLocalAvailable(false);
      })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [rootPath, path, page, refresh, documents]);

  function navigate(nextPath: string) {
    setPath(nextPath);
    setPage(0);
    setSelectedPath(null);
    setError("");
  }

  async function createFolder() {
    if (!rootPath || !localAvailable) return;
    const name = window.prompt("Nom du nouveau dossier")?.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      await createProjectDirectory(rootPath, path, name);
      setPage(0);
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(typeof caught === "string" ? caught : "Impossible de créer ce dossier.");
    } finally {
      setBusy(false);
    }
  }

  async function removeFolder() {
    if (!rootPath || !localAvailable || !path) return;
    if (!window.confirm(`Supprimer le dossier vide « ${path} » ?\n\nUn dossier contenant des fichiers ou d'autres dossiers ne sera jamais supprimé ici.`)) return;
    setBusy(true);
    setError("");
    try {
      await removeEmptyProjectDirectory(rootPath, path);
      navigate(parentPath(path));
      setRefresh((value) => value + 1);
    } catch (caught) {
      setError(typeof caught === "string" ? caught : "Ce dossier n'est pas vide ou ne peut pas être supprimé.");
    } finally {
      setBusy(false);
    }
  }

  async function openSelected(relativePath: string) {
    if (!rootPath || !localAvailable) return;
    try {
      await openProjectFile(rootPath, relativePath);
    } catch (caught) {
      setError(typeof caught === "string" ? caught : "Impossible d'ouvrir le fichier.");
    }
  }

  async function openCurrentFolder() {
    if (!rootPath || !localAvailable) return;
    try {
      await openProjectDirectory(rootPath, path);
    } catch (caught) {
      setError(typeof caught === "string" ? caught : "Impossible d'ouvrir le dossier.");
    }
  }

  const segments = path ? path.split("/") : [];
  const breadcrumbs = segments.map((name, index) => ({ name, path: segments.slice(0, index + 1).join("/") }));
  const hiddenAncestors = breadcrumbs.slice(0, -3);
  const shownAncestors = breadcrumbs.slice(-3);
  const displayedResults = results.slice(0, resultLimit);
  const selectedIsPlanned = selectedPath ? plannedPaths.has(selectedPath) : false;

  return (
    <div className="project-explorer">
      <div className="explorer-topline">
        <div className="explorer-breadcrumbs" aria-label="Chemin du dossier">
          <button type="button" onClick={() => navigate("")} title={projectName}>{projectName}</button>
          {hiddenAncestors.length > 0 && <select aria-label="Dossiers parents" value="" onChange={(event) => navigate(event.target.value)}><option value="">…</option>{hiddenAncestors.map((item) => <option value={item.path} key={item.path}>{item.name}</option>)}</select>}
          {shownAncestors.map((item) => <span key={item.path}><span aria-hidden="true">/</span><button type="button" onClick={() => navigate(item.path)} title={item.path}>{item.name}</button></span>)}
        </div>
        <button type="button" className="explorer-refresh" onClick={() => setRefresh((value) => value + 1)}>Actualiser</button>
      </div>
      {!localAvailable && !loading && <p className="explorer-notice">{plannedDirectoryPaths.has(path) ? "Ce dossier fait partie du brouillon : il sera créé lors de la validation." : "Le dossier local n'est pas accessible sur ce PC. Affichage des documents déjà importés ; les dossiers vides et les fichiers non importés ne sont pas visibles."}</p>}
      {draftActions.length > 0 && <section className="explorer-draft" aria-label="Brouillon des modifications"><div className="explorer-draft-heading"><div><span className="explorer-draft-kicker">APERÇU · RIEN N'EST ENCORE MODIFIÉ</span><h2>{draftActions.length} modification(s) prévues</h2><p>Les nouveaux chemins apparaissent dans l'arbre ci-dessous. Vérifiez-les avant d'appliquer le brouillon au dossier du PC. Les étapes d'un même fichier seront appliquées dans l'ordre.</p></div><button type="button" disabled={!!draftApplying} onClick={onApplyDraft}>{draftApplying ? `Application ${draftApplying.current}/${draftApplying.total}…` : "Valider le brouillon"}</button></div>{plannedFolders.length > 0 && <div className="explorer-draft-folders"><strong>Dossiers de destination</strong><div>{plannedFolders.slice(0, 20).map((folder) => <button type="button" key={folder} onClick={() => navigate(folder)}>▰ {folder}</button>)}{plannedFolders.length > 20 && <small>+ {plannedFolders.length - 20} autre(s) dossier(s)</small>}</div></div>}<div className="explorer-draft-list">{draftActions.slice(0, draftLimit).map((action) => <div className="explorer-draft-action" key={action.id}><span><strong>{action.tool === "copy_document" ? "Copier" : action.tool === "move_document" ? "Déplacer" : action.tool === "rename_document" ? "Renommer" : "Corbeille"}</strong><small>{action.source_relative_path}{action.destination_relative_path ? ` → ${action.destination_relative_path}` : " → .clairdoc/trash"}</small></span><button type="button" disabled={!!draftApplying || !lastPendingActionIds.has(action.id)} title={lastPendingActionIds.has(action.id) ? "Retirer cette étape" : "Retirez d'abord les étapes suivantes de ce fichier"} onClick={() => onRemoveDraftItem(action.conversation_id, action.id)}>Retirer</button></div>)}{draftActions.length > draftLimit && <button type="button" className="explorer-draft-more" onClick={() => setDraftLimit((value) => value + 30)}>Afficher davantage</button>}</div></section>}
      {draftError && <p className="explorer-error" role="alert">{draftError}</p>}
      {draftNotice && <p className="explorer-notice" role="status">{draftNotice}</p>}
      <div className="explorer-toolbar">
        <label>Rechercher dans tout le projet<input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setResultLimit(PAGE_SIZE); }} placeholder="Nom, chemin ou organisme…" /></label>
        <label>Catégorie<select value={category} onChange={(event) => { setCategory(event.target.value); setResultLimit(PAGE_SIZE); }}><option value="Toutes">Toutes les catégories</option>{library?.categories.map((item) => <option key={item}>{item}</option>)}</select></label>
      </div>
      {linkedDocument && <div className="explorer-link-filter"><span>Documents liés à <strong>{linkedDocument.name}</strong></span><button type="button" onClick={() => setLinkedTo(null)}>Effacer ce filtre</button></div>}
      <div className="explorer-actions">
        <span>{searchMode ? `${results.length} document(s) trouvé(s)` : `${displayedEntries.length} élément(s) affiché(s) dans ce dossier${draftActions.length ? " · aperçu inclus" : ""}`}</span>
        <div>
          <button type="button" disabled={!localAvailable || busy} onClick={openCurrentFolder}>Ouvrir dans l'explorateur</button>
          <button type="button" disabled={!localAvailable || busy} onClick={createFolder}>+ Nouveau dossier</button>
          {path && <button type="button" className="danger" disabled={!localAvailable || busy} onClick={removeFolder}>Supprimer le dossier vide</button>}
        </div>
      </div>
      {error && <p className="explorer-error" role="alert">{error}</p>}
      <div className="explorer-list" aria-label={searchMode ? "Résultats de recherche" : "Contenu du dossier"}>
        {!searchMode && loading && <p className="explorer-empty">Chargement du dossier…</p>}
        {!searchMode && !loading && path && <button type="button" className="explorer-row explorer-parent" onClick={() => navigate(parentPath(path))}><span aria-hidden="true">↶</span><span><strong>Dossier parent</strong><small>Remonter d'un niveau</small></span></button>}
        {!searchMode && !loading && displayedEntries.map((entry) => entry.kind === "directory" ? (
          <button type="button" className={`explorer-row ${plannedDirectoryPaths.has(entry.relativePath) ? "planned" : ""}`} key={entry.relativePath} onClick={() => navigate(entry.relativePath)}><ExplorerItemIcon name={entry.name} directory /><span><strong>{entry.name}</strong><small>{plannedDirectoryPaths.has(entry.relativePath) ? "Dossier présent dans le brouillon" : `${folderCounts.get(entry.name) ?? 0} document(s) importé(s) dans ce dossier et ses sous-dossiers`}</small></span><span className="explorer-row-end" aria-hidden="true">›</span></button>
        ) : (
          <button type="button" className={`explorer-row ${selectedPath === entry.relativePath ? "selected" : ""} ${plannedPaths.has(entry.relativePath) ? "planned" : ""}`} key={entry.relativePath} onClick={() => setSelectedPath(entry.relativePath)} onDoubleClick={() => { if (!plannedPaths.has(entry.relativePath)) void openSelected(entry.relativePath); }}><ExplorerItemIcon name={entry.name} /><span><strong>{entry.name}</strong><small>{plannedPaths.has(entry.relativePath) ? "Prévu dans le brouillon · non présent sur le disque" : documentByPath.has(entry.relativePath) ? `${documentByPath.get(entry.relativePath)?.category} · importé` : "Non importé"}{entry.bytes ? ` · ${new Intl.NumberFormat("fr-FR").format(entry.bytes)} octets` : ""}</small></span><span className="explorer-row-end" aria-hidden="true">›</span></button>
        ))}
        {!searchMode && !loading && displayedEntries.length === 0 && <p className="explorer-empty">Ce dossier est vide.</p>}
        {searchMode && displayedResults.map((document) => <button type="button" className={`explorer-row ${selectedPath === document.sourceRelativePath ? "selected" : ""} ${plannedPaths.has(document.sourceRelativePath) ? "planned" : ""}`} key={`${document.jobId}-${document.sourceRelativePath}`} onClick={() => setSelectedPath(document.sourceRelativePath)}><ExplorerItemIcon name={document.name} /><span><strong>{document.name}</strong><small>{document.sourceRelativePath} · {document.category}{plannedPaths.has(document.sourceRelativePath) ? " · brouillon" : ""}</small></span><span className="explorer-row-end">{relationCounts.get(document.jobId) ?? 0} lien(s)</span></button>)}
        {searchMode && results.length === 0 && <p className="explorer-empty">Aucun document ne correspond à ces filtres.</p>}
      </div>
      {!searchMode && directory && directory.total > PAGE_SIZE && <div className="explorer-pagination"><button type="button" disabled={page === 0 || loading} onClick={() => setPage((value) => Math.max(0, value - 1))}>Précédent</button><span>Page {page + 1} sur {Math.ceil(directory.total / PAGE_SIZE)}</span><button type="button" disabled={loading || (page + 1) * PAGE_SIZE >= directory.total} onClick={() => setPage((value) => value + 1)}>Suivant</button></div>}
      {searchMode && results.length > resultLimit && <button type="button" className="explorer-more" onClick={() => setResultLimit((value) => value + PAGE_SIZE)}>Afficher {Math.min(PAGE_SIZE, results.length - resultLimit)} résultats supplémentaires</button>}
      {selectedPath && <div className="explorer-selection"><div><strong>{selectedPath.slice(selectedPath.lastIndexOf("/") + 1)}</strong><small>{selectedPath}</small>{selectedIsPlanned ? <p>Chemin prévu : le fichier sera disponible après validation.</p> : selectedDocument && <p>{selectedDocument.category} · {relationCounts.get(selectedDocument.jobId) ?? 0} lien(s) · {selectedDocument.status === "indexed" ? "indexé" : "à indexer"}</p>}</div><div><button type="button" disabled={!localAvailable || selectedIsPlanned} onClick={() => void openSelected(selectedPath)}>Ouvrir le fichier</button>{selectedDocument && <button type="button" onClick={() => { setLinkedTo(selectedDocument.jobId); setResultLimit(PAGE_SIZE); }}>Voir ses liens</button>}{!searchMode && selectedDocument && <button type="button" onClick={() => { setSearch(selectedDocument.name); setResultLimit(PAGE_SIZE); }}>Rechercher ce nom</button>}</div></div>}
    </div>
  );
}
