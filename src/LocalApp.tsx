import { FormEvent, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ProjectExplorer from "./ProjectExplorer";
import DocumentSearch from "./DocumentSearch";
import FolderIcon from "./FolderIcon";
import ConversationDetails from "./ConversationDetails";
import { useConversationAutoscroll } from "./useConversationAutoscroll";
import { openProjectFile, openProjectFolder, type Conversation, type ConversationSummary, type DocumentLibrary, type DocumentSearchResult, type LibraryDocument, type ProjectDraft, type RemoteProject } from "./server";
import "./LocalApp.css";

type LocalStatus = { configured: boolean; model: string; modelOptions: string[]; dataDir: string };
type CatalogResult = { total: number; added: number; reused: number; pending: number };
type View = "home" | "library" | "search" | "relations" | "assistant" | "import" | "settings";
const MarkdownAnswer = lazy(() => import("./MarkdownAnswer"));

function message(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Une erreur est survenue.";
}

export default function LocalApp({ serverUrl, onRetryServer }: { serverUrl: string; onRetryServer: () => Promise<void> }) {
  const [view, setView] = useState<View>("home");
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [project, setProject] = useState<RemoteProject | null>(null);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [name, setName] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [library, setLibrary] = useState<DocumentLibrary | null>(null);
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [analysis, setAnalysis] = useState<{current: number; total: number; failed: number; lastError: string} | null>(null);
  const pauseAnalysis = useRef(false);
  const [batchSize, setBatchSize] = useState(20);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [documentSearch, setDocumentSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("Toutes");
  const [linkFilter, setLinkFilter] = useState("Tous");
  const [relationView, setRelationView] = useState<"folders" | "links">("folders");
  const [relationSearch, setRelationSearch] = useState("");
  const [relationKind, setRelationKind] = useState("Tous");
  const [focusDocument, setFocusDocument] = useState("Tous");
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [importNotice, setImportNotice] = useState("");
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [draftApplying, setDraftApplying] = useState<{current:number;total:number} | null>(null);
  const [allowActions, setAllowActions] = useState(() => localStorage.getItem("clairdoc-local-allow-actions") === "true");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("clairdoc-theme") === "dark" ? "dark" : "light");
  const conversationRef = useConversationAutoscroll(conversation?.id, conversation?.messages.length ?? 0, !!pending, view === "assistant");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("clairdoc-theme", theme);
  }, [theme]);

  useEffect(() => { localStorage.setItem("clairdoc-local-allow-actions", String(allowActions)); }, [allowActions]);

  useEffect(() => {
    setDocumentSearch("");
    setCategoryFilter("Toutes");
    setLinkFilter("Tous");
    setRelationSearch("");
    setRelationKind("Tous");
    setFocusDocument("Tous");
    setCollapsedCategories(new Set());
  }, [project?.id]);

  useEffect(() => {
    let active = true;
    Promise.all([invoke<LocalStatus>("local_status"), invoke<RemoteProject[]>("local_list_projects")])
      .then(([localStatus, items]) => { if (active) { setStatus(localStatus); setProjects(items); } })
      .catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!project?.sourceRoot) { setLibrary(null); setCatalog(null); return; }
    let active = true;
    invoke<CatalogResult>("local_catalog_project", { projectId: project.id })
      .then(async (result) => {
        if (!active) return;
        setCatalog(result);
        const loaded = await invoke<DocumentLibrary>("local_list_library", { projectId: project.id });
        if (active) setLibrary(loaded);
      })
      .catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [project]);

  useEffect(() => {
    if (!project?.sourceRoot) { setDraft(null); return; }
    let active = true;
    invoke<ProjectDraft>("local_get_draft", { projectId: project.id })
      .then((value) => { if (active) setDraft(value); })
      .catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [project]);

  useEffect(() => {
    if (!project || view !== "assistant") return;
    let active = true;
    invoke<ConversationSummary[]>("local_list_conversations", { projectId: project.id })
      .then(async (items) => {
        if (!active) return;
        setConversations(items);
        const selectedId = conversation?.projectId === project.id && items.some((item) => item.id === conversation.id)
          ? conversation.id : items[0]?.id;
        const selected = selectedId
          ? await invoke<Conversation>("local_get_conversation", { projectId: project.id, conversationId: selectedId })
          : await invoke<Conversation>("local_create_conversation", { projectId: project.id });
        if (active) setConversation(selected);
      })
      .catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [project, view]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError("");
    try {
      const item = await invoke<RemoteProject>("local_create_project", { name: name.trim(), sourceRoot: null });
      setProjects((current) => [...current, item]); setProject(item); setName(""); setView("import");
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }

  async function attachFolder() {
    if (!project) return;
    const selected = await open({ directory: true, multiple: false, title: "Choisir le dossier de ce projet" });
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const updated = await invoke<RemoteProject>("local_update_project", { projectId: project.id, sourceRoot: selected });
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item)); setProject(updated);
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }

  async function addFolderProject() {
    const selected = await open({ directory: true, multiple: false, title: "Choisir un dossier à ajouter" });
    if (!selected) return;
    const parts = selected.split(/[\\/]/).filter(Boolean);
    const folderName = parts[parts.length - 1] ?? "Nouveau projet";
    setBusy(true); setError("");
    try {
      const item = await invoke<RemoteProject>("local_create_project", { name: folderName, sourceRoot: selected });
      setProjects((current) => [...current, item]); setProject(item); setView("import");
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }

  async function renameProject(item: RemoteProject) {
    const newName = window.prompt("Nouveau nom du projet", item.name)?.trim();
    if (!newName || newName === item.name) return;
    try {
      const updated = await invoke<RemoteProject>("local_update_project", { projectId: item.id, name: newName });
      setProjects((current) => current.map((candidate) => candidate.id === item.id ? updated : candidate));
      if (project?.id === item.id) setProject(updated);
    } catch (failure) { setError(message(failure)); }
  }

  async function removeProject(item: RemoteProject) {
    if (!window.confirm(`Retirer « ${item.name} » de ClairDoc ? Les fichiers du dossier ne seront pas supprimés.`)) return;
    try {
      await invoke("local_delete_project", { projectId: item.id });
      setProjects((current) => current.filter((candidate) => candidate.id !== item.id));
      if (project?.id === item.id) { setProject(null); setView("home"); }
    } catch (failure) { setError(message(failure)); }
  }

  async function saveKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      setStatus(await invoke<LocalStatus>("local_set_openai_key", { apiKey: keyInput })); setKeyInput("");
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }

  async function setModel(model: string) {
    try { setStatus(await invoke<LocalStatus>("local_set_model", { model })); }
    catch (failure) { setError(message(failure)); }
  }

  async function newConversation() {
    if (!project) return;
    try {
      const created = await invoke<Conversation>("local_create_conversation", { projectId: project.id });
      setConversation(created);
      setConversations(await invoke<ConversationSummary[]>("local_list_conversations", { projectId: project.id }));
    } catch (failure) { setError(message(failure)); }
  }

  async function selectConversation(id: string) {
    if (!project) return;
    try { setConversation(await invoke<Conversation>("local_get_conversation", { projectId: project.id, conversationId: id })); }
    catch (failure) { setError(message(failure)); }
  }

  async function removeConversation(id: string) {
    if (!project || !window.confirm("Supprimer cette conversation locale ?")) return;
    try {
      await invoke("local_delete_conversation", { projectId: project.id, conversationId: id });
      const remaining = await invoke<ConversationSummary[]>("local_list_conversations", { projectId: project.id });
      setConversations(remaining);
      if (conversation?.id === id) setConversation(remaining[0] ? await invoke<Conversation>("local_get_conversation", { projectId: project.id, conversationId: remaining[0].id }) : null);
    } catch (failure) { setError(message(failure)); }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !question.trim() || busy) return;
    const submitted = question.trim(); setQuestion(""); setPending(submitted); setBusy(true); setError("");
    try {
      const active = conversation ?? await invoke<Conversation>("local_create_conversation", { projectId: project.id });
      await invoke("local_send_message", { projectId: project.id, conversationId: active.id, question: submitted, allowActions });
      setConversation(await invoke<Conversation>("local_get_conversation", { projectId: project.id, conversationId: active.id }));
      setConversations(await invoke<ConversationSummary[]>("local_list_conversations", { projectId: project.id }));
      if (project.sourceRoot) setDraft(await invoke<ProjectDraft>("local_get_draft", { projectId: project.id }));
    } catch (failure) { setError(message(failure)); setQuestion(submitted); }
    finally { setPending(null); setBusy(false); }
  }

  async function analyzeDocuments() {
    if (!project || !library || !status?.configured || analysis) return;
    const pendingDocs = library.documents.filter((item) => !item.analyzed);
    const selected = pendingDocs.slice(0, batchSize || pendingDocs.length);
    if (selected.length === 0) return;
    if (!window.confirm(`Analyser ${selected.length} document(s) avec OpenAI ?\n\nChaque PDF, image ou document Office traité sera envoyé à l’API. Le coût dépend de la taille et du nombre de pages et n’est pas estimé ici. Les fichiers de plus de 10 Mo restent indexés par nom. Vous pourrez interrompre le traitement après le document en cours.`)) return;
    pauseAnalysis.current = false;
    setAnalysis({ current: 0, total: selected.length, failed: 0, lastError: "" });
    let failed = 0;
    let lastError = "";
    try {
      for (let index = 0; index < selected.length; index += 1) {
        if (pauseAnalysis.current) break;
        try {
          await invoke("local_analyze_document", { projectId: project.id, documentId: selected[index].jobId });
        } catch (failure) { failed += 1; lastError = `${selected[index].name} : ${message(failure)}`; }
        setAnalysis({ current: index + 1, total: selected.length, failed, lastError });
        if ((index + 1) % 10 === 0) setLibrary(await invoke<DocumentLibrary>("local_list_library", { projectId: project.id }));
      }
      setLibrary(await invoke<DocumentLibrary>("local_list_library", { projectId: project.id }));
      if (lastError) setError(`${failed} document(s) non analysé(s). Dernier problème : ${lastError}`);
    } catch (failure) { setError(message(failure)); }
    finally { setAnalysis(null); }
  }

  async function removeDraftAction(_conversationId: string, actionId: string) {
    if (!project || draftApplying) return;
    try { setDraft(await invoke<ProjectDraft>("local_cancel_draft_action", { projectId: project.id, actionId })); }
    catch (failure) { setError(message(failure)); }
  }

  async function applyDraft() {
    if (!project || !draft?.actions.length || draftApplying) return;
    const preview = draft.actions.slice(0, 8).map((action) => `• ${action.summary}`).join("\n");
    if (!window.confirm(`Appliquer ${draft.actions.length} modification(s) sur ce PC ?\n\n${preview}\n\nLes fichiers existants ne seront pas remplacés. Les suppressions vont dans .clairdoc/trash.`)) return;
    setError("");
    let current = draft;
    let applied = 0;
    try {
      while (current.actions.length) {
        setDraftApplying({ current: applied + 1, total: draft.actions.length });
        current = await invoke<ProjectDraft>("local_apply_draft_action", { projectId: project.id, actionId: current.actions[0].id });
        applied += 1;
        setDraft(current);
      }
      setCatalog(await invoke<CatalogResult>("local_catalog_project", { projectId: project.id }));
      setLibrary(await invoke<DocumentLibrary>("local_list_library", { projectId: project.id }));
    } catch (failure) { setError(`${applied} action(s) appliquée(s), puis arrêt : ${message(failure)}. Les autres restent dans le brouillon.`); }
    finally { setDraftApplying(null); }
  }

  async function refreshLibrary() {
    if (!project?.sourceRoot) return false;
    try {
      setCatalog(await invoke<CatalogResult>("local_catalog_project", { projectId: project.id }));
      setLibrary(await invoke<DocumentLibrary>("local_list_library", { projectId: project.id }));
      return true;
    } catch (failure) { setError(message(failure)); return false; }
  }

  async function addFiles() {
    if (!project?.sourceRoot) return;
    const selection = await open({ multiple: true, directory: false, title: "Choisir des documents à copier dans ce projet" });
    if (!selection) return;
    const paths = Array.isArray(selection) ? selection : [selection];
    if (!window.confirm(`Copier ${paths.length} fichier(s) dans le dossier « Ajouts » du projet ? Les originaux resteront à leur emplacement.`)) return;
    setBusy(true); setError(""); setImportNotice("");
    try {
      const result = await invoke<{ copied: number; skipped: number }>("local_import_files", { projectId: project.id, paths });
      const refreshed = await refreshLibrary();
      setImportNotice(`${result.copied} document(s) ajouté(s) · ${result.skipped} ignoré(s). ${refreshed ? "Leurs noms sont catalogués ; lancez l’analyse OpenAI si vous souhaitez chercher dans leur contenu." : "Le catalogue n’a pas pu être actualisé ; réessayez avec « Actualiser le catalogue »."}`);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  const filteredDocuments = useMemo(() => {
    if (!library) return [];
    const linkedIds = new Set<string>();
    for (const link of library.relationships) {
      if (linkFilter === "Tous" || link.kind === linkFilter) {
        linkedIds.add(link.sourceJobId); linkedIds.add(link.targetJobId);
      }
    }
    const query = documentSearch.trim().toLocaleLowerCase("fr");
    return library.documents.filter((item) =>
      (categoryFilter === "Toutes" || item.category === categoryFilter)
      && (linkFilter === "Tous" || linkedIds.has(item.jobId))
      && (!query || [item.name, item.sourceRelativePath, item.category, item.organization ?? "", ...item.people].some((part) => part.toLocaleLowerCase("fr").includes(query)))
    );
  }, [library, documentSearch, categoryFilter, linkFilter]);

  const linkCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of library?.relationships ?? []) {
      counts.set(link.sourceJobId, (counts.get(link.sourceJobId) ?? 0) + 1);
      counts.set(link.targetJobId, (counts.get(link.targetJobId) ?? 0) + 1);
    }
    return counts;
  }, [library]);

  const relationData = useMemo(() => {
    if (!library) return { relationships: [], groups: [] as [string, LibraryDocument[]][], linksByDocument: new Map<string, DocumentLibrary["relationships"]>() };
    const query = relationSearch.trim().toLocaleLowerCase("fr");
    const matching = library.documents.filter((item) =>
      !query || [item.name, item.category, item.organization ?? "", ...item.people].some((part) => part.toLocaleLowerCase("fr").includes(query))
    );
    const matchingIds = new Set(matching.map((item) => item.jobId));
    const relationships = library.relationships.filter((link) =>
      (relationKind === "Tous" || link.kind === relationKind)
      && (focusDocument === "Tous" || link.sourceJobId === focusDocument || link.targetJobId === focusDocument)
      && (!query || matchingIds.has(link.sourceJobId) || matchingIds.has(link.targetJobId))
    );
    const linksByDocument = new Map<string, DocumentLibrary["relationships"]>();
    for (const link of relationships) {
      if (link.kind === "category") continue;
      for (const id of [link.sourceJobId, link.targetJobId]) {
        const links = linksByDocument.get(id) ?? [];
        links.push(link);
        linksByDocument.set(id, links);
      }
    }
    const visibleIds = new Set(relationships.flatMap((link) => [link.sourceJobId, link.targetJobId]));
    if (focusDocument !== "Tous") visibleIds.add(focusDocument);
    const visible = focusDocument === "Tous" && !query && relationKind === "Tous"
      ? library.documents
      : library.documents.filter((item) => visibleIds.has(item.jobId));
    const grouped = new Map<string, LibraryDocument[]>();
    for (const item of visible) {
      const group = grouped.get(item.category) ?? [];
      group.push(item);
      grouped.set(item.category, group);
    }
    return { relationships, linksByDocument, groups: [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, "fr")) };
  }, [library, relationSearch, relationKind, focusDocument]);

  function toggleCategory(category: string) {
    setCollapsedCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category); else next.add(category);
      return next;
    });
  }

  return <div className="app-shell local-app">
    <aside className="sidebar" aria-label="Navigation principale">
      <div className="brand sidebar-brand" aria-label="ClairDoc"><span className="brand-mark"><FolderIcon /></span><span>ClairDoc</span></div>
      <nav>{([ ["home", "⌂", "Projets"], ["library", "▤", "Documents"], ["search", "⌕", "Recherche"], ["relations", "▣", "Explorateur"], ["assistant", "✦", "Assistant"], ["import", "+", "Ajouter"] ] as const).map(([target, icon, label]) =>
        <button key={target} className={view === target ? "active" : ""} onClick={() => setView(target)}><span aria-hidden="true">{icon}</span>{label}</button>)}</nav>
      <div className="sidebar-footer"><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><span aria-hidden="true">⚙</span>Paramètres</button><div className="server-pill"><span /> Mode autonome · OpenAI</div></div>
    </aside>
    <header className="topbar"><div><small>{view === "home" ? "ESPACE DE TRAVAIL" : project ? "PROJET ACTIF" : "CLAIRDOC"}</small><strong>{view === "home" ? "Mes projets" : project?.name ?? "Choisissez un projet"}</strong></div><div className="topbar-actions"><span className="privacy-note">Vos originaux restent inchangés · Mode autonome</span><button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label={theme === "light" ? "Activer le mode sombre" : "Activer le mode clair"}>{theme === "light" ? "☾" : "☀"}</button></div></header>
    <main className="main-content">
      {error && <p className="local-error" role="alert">{error}</p>}
      {view === "home" && <section className="dashboard-view">
        <div className="page-heading"><div><p className="eyebrow">Vue d’ensemble</p><h1>Vos documents, enfin clairs.</h1><p>Créez un espace par thème, personne ou activité. Chaque projet garde ses documents et conversations séparés.</p></div><button className="primary-button" onClick={() => void addFolderProject()} disabled={busy}>Importer un dossier existant</button></div>
        <div className="dashboard-grid"><article className="new-project-card"><div className="card-icon">+</div><h2>Nouveau projet</h2><p>Créez d’abord un espace vide, puis ajoutez un dossier complet ou quelques documents.</p><form onSubmit={createProject}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex. Administratif 2026" maxLength={120} required /><button className="primary-button" disabled={busy}>Créer</button></form></article>
          {projects.map((item) => <article className={`project-card ${project?.id === item.id ? "selected" : ""}`} key={item.id}><div className="project-card-top"><span className="project-folder"><FolderIcon /></span><button className="project-menu-button" aria-label={`Options de ${item.name}`} onClick={() => setProjectMenu(projectMenu === item.id ? null : item.id)}>•••</button>{projectMenu === item.id && <div className="project-menu"><button onClick={() => void renameProject(item)}>Renommer</button><button onClick={() => item.sourceRoot && void openProjectFolder(item.sourceRoot)} disabled={!item.sourceRoot}>Ouvrir dans l’explorateur</button><button className="danger" onClick={() => void removeProject(item)}>Retirer le projet</button></div>}</div><h2>{item.name}</h2><p>Documents, recherche et classement associés à ce projet.</p><button className="secondary-button" onClick={() => { setConversation(null); setProject(item); setView("library"); }}>Ouvrir le projet</button></article>)}
        </div>
        {projects.length === 0 && <p className="empty-hint">Aucun projet pour le moment. Créez votre premier espace ci-dessus.</p>}
        <p className="local-info">Les projets enregistrés uniquement sur le serveur ne sont pas automatiquement synchronisés. Associez leur dossier à un projet local pour y accéder sans serveur.</p>
      </section>}
      {view === "library" && <section className="library-view">
        <div className="page-heading compact"><div><p className="eyebrow">Bibliothèque</p><h1>Documents</h1><p>Retrouvez un fichier par son contenu, sa catégorie ou les liens détectés.</p></div><button className="primary-button" onClick={() => setView("import")}>+ Ajouter</button></div>
        {!project ? <div className="blank-panel"><FolderIcon /><h2>Sélectionnez un projet</h2><p>Ouvrez un projet depuis l’accueil pour afficher ses documents.</p><button className="secondary-button" onClick={() => setView("home")}>Voir mes projets</button></div>
          : !project.sourceRoot ? <div className="blank-panel"><FolderIcon /><h2>Associez un dossier</h2><p>Le dossier et ses sous-dossiers apparaîtront ici.</p><button className="primary-button" onClick={() => void attachFolder()}>Choisir le dossier</button></div>
          : <><div className="library-toolbar"><input type="search" value={documentSearch} onChange={(event) => setDocumentSearch(event.target.value)} placeholder="Rechercher un document, une personne, un organisme…" /><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option>Toutes</option>{library?.categories.map((category) => <option key={category}>{category}</option>)}</select><select value={linkFilter} onChange={(event) => setLinkFilter(event.target.value)}><option value="Tous">Tous les liens</option><option value="organization">Même organisme</option><option value="person">Même personne</option><option value="category">Même catégorie</option><option value="year">Même année</option></select></div>
            {!library ? <div className="blank-panel"><span className="mini-spinner" /><p>Chargement de la bibliothèque…</p></div> : <div className="document-browser"><div className="browser-summary"><strong>{filteredDocuments.length} document(s)</strong><span>{library.relationships.length} lien(s) détecté(s)</span></div><div className="document-table" role="table" aria-label="Documents du projet"><div className="document-row table-head" role="row"><span>Nom</span><span>Catégorie</span><span>Date</span><span>Relations</span><span>État</span></div>{filteredDocuments.map((item) => <article className="document-row" role="row" key={item.jobId}><span className="document-name"><b>{item.name}</b><small>{item.sourceRelativePath}</small>{item.textWarning && <small>{item.textWarning}</small>}</span><span><i className="category-chip">{item.category}</i></span><span>{item.documentDate ?? "—"}</span><span>{(linkCounts.get(item.jobId) ?? 0) > 0 ? <span className="link-count">⌁ {linkCounts.get(item.jobId)}</span> : "—"}</span><span className={`status-chip ${item.status}`}>{item.status === "indexed" ? "Indexé" : item.analyzed ? "Indexé · nom seul" : "À analyser"}</span></article>)}</div>{filteredDocuments.length === 0 && <div className="no-results">Aucun document ne correspond à ces filtres.</div>}</div>}</>}
      </section>}
      {view === "relations" && <section className="relations-view">
        <div className="page-heading compact"><div><p className="eyebrow">Explorateur</p><h1>Dossiers et relations</h1><p>Parcourez les sous-dossiers un niveau à la fois, ou consultez les liens entre documents.</p></div>{project?.sourceRoot && <button className="secondary-button" onClick={() => void refreshLibrary()}>Actualiser</button>}</div>
        {!project ? <div className="blank-panel"><h2>Aucun projet sélectionné</h2><button className="secondary-button" onClick={() => setView("home")}>Choisir un projet</button></div>
          : !project.sourceRoot ? <div className="blank-panel"><FolderIcon /><h2>Associez un dossier</h2><button className="primary-button" onClick={() => void attachFolder()}>Choisir le dossier</button></div>
          : <><div className="relation-view-switch" role="group" aria-label="Mode de l’explorateur"><button type="button" className={relationView === "folders" ? "active" : ""} onClick={() => setRelationView("folders")}>Dossiers</button><button type="button" className={relationView === "links" ? "active" : ""} onClick={() => setRelationView("links")}>Relations</button></div>
            {relationView === "folders" ? <ProjectExplorer key={`${project.id}-${catalog?.total ?? 0}`} projectName={project.name} rootPath={project.sourceRoot} library={library} draft={draft} draftApplying={draftApplying} draftError={error} draftNotice="" onApplyDraft={() => void applyDraft()} onRemoveDraftItem={(conversationId,actionId) => void removeDraftAction(conversationId,actionId)} />
              : <><div className="relation-toolbar"><input type="search" value={relationSearch} onChange={(event) => setRelationSearch(event.target.value)} placeholder="Rechercher une personne, un organisme…" /><select value={focusDocument} onChange={(event) => setFocusDocument(event.target.value)}><option value="Tous">Tous les documents</option>{library?.documents.map((item) => <option value={item.jobId} key={item.jobId}>{item.name}</option>)}</select><select value={relationKind} onChange={(event) => setRelationKind(event.target.value)}><option value="Tous">Tous les types de liens</option><option value="organization">Organisme</option><option value="person">Personne</option><option value="category">Catégorie</option><option value="year">Année</option></select></div>
                {!library ? <div className="blank-panel"><span className="mini-spinner" /><p>Construction de l’arbre…</p></div> : <div className="relation-canvas">
                  <div className="tree-root"><span className="tree-root-icon"><FolderIcon /></span><div><strong>{project.name}</strong><small>{relationData.groups.reduce((sum, [, items]) => sum + items.length, 0)} document(s) · {relationData.relationships.length} lien(s) affiché(s)</small></div></div>
                  <div className="tree-groups">{relationData.groups.map(([category, items]) => <section className={`tree-branch ${collapsedCategories.has(category) ? "collapsed" : ""}`} key={category}>
                    <button className="tree-category" onClick={() => toggleCategory(category)} aria-expanded={!collapsedCategories.has(category)}><span /><strong>{category}</strong><small>{items.length}</small><b>{collapsedCategories.has(category) ? "+" : "−"}</b></button>
                    {!collapsedCategories.has(category) && <div className="tree-documents">{items.map((item) => <button className={`tree-document ${item.jobId === focusDocument ? "focused" : ""}`} key={item.jobId} onClick={() => void openProjectFile(project.sourceRoot!, item.sourceRelativePath)}><div className="tree-document-title"><span>▤</span><div><strong>{item.name}</strong><small>{item.organization ?? item.sourceRelativePath}</small></div></div><div className="tree-links">{(relationData.linksByDocument.get(item.jobId) ?? []).slice(0, 4).map((link, index) => <span key={`${link.sourceJobId}-${link.targetJobId}-${index}`}>{link.kind === "organization" ? "Organisme" : link.kind === "person" ? "Personne" : "Année"} · {link.label}</span>)}</div></button>)}</div>}
                  </section>)}</div>
                </div>}</>}
          </>}
      </section>}
      {view === "search" && (project?.sourceRoot ? <DocumentSearch key={project.id} project={project} runtimeInfo={null} standalone searchDocuments={(projectId, query, mode, limit) => invoke<DocumentSearchResult>("local_search_index", { projectId, query, mode, limit })} /> : <section className="blank-panel"><h2>Sélectionnez un projet avec un dossier</h2><p>Ouvrez un projet depuis l’accueil pour rechercher ses documents.</p><button className="secondary-button" onClick={() => setView(project ? "import" : "home")}>{project ? "Associer un dossier" : "Voir mes projets"}</button></section>)}
      {view === "assistant" && <section className="assistant-view"><div className="page-heading compact"><div><p className="eyebrow">Assistant documentaire</p><h1>Posez une question à vos documents</h1><p>Les réponses restent limitées au projet actif et affichent leurs sources.</p></div></div>
        {!project ? <div className="blank-panel"><h2>Aucun projet sélectionné</h2><button className="secondary-button" onClick={() => setView("home")}>Choisir un projet</button></div>
          : <div className="assistant-layout"><aside className="conversation-sidebar"><button className="primary-button new-conversation" onClick={() => void newConversation()}>+ Nouvelle conversation</button><div className="conversation-list">{conversations.map((item) => <div className={`conversation-item ${conversation?.id === item.id ? "active" : ""}`} key={item.id}><button onClick={() => void selectConversation(item.id)}><strong>{item.title}</strong><small>{item.messageCount} message(s)</small></button><button className="conversation-delete" aria-label={`Supprimer ${item.title}`} onClick={() => void removeConversation(item.id)}>×</button></div>)}</div></aside>
            <div className="chat-card"><div className="chat-intro"><span>✦</span><div><strong>Assistant de {project.name}</strong><p>Demandez une date, un montant, un organisme ou une synthèse.</p></div></div>
              {project.sourceRoot && <div className="source-access-note"><strong>Brouillon avant toute modification</strong><p>L’assistant prépare les changements sans toucher aux fichiers. Vérifiez l’ébauche dans l’Explorateur, puis utilisez le bouton de validation.</p></div>}
              {!!draft?.actions.length && <div className="assistant-draft-banner"><span><strong>{draft.actions.length} modification(s) en brouillon</strong><small>Aucun fichier local modifié pour le moment.</small></span><button type="button" className="secondary-button" onClick={() => setView("relations")}>Voir dans l’Explorateur</button><button type="button" className="primary-button" disabled={!!draftApplying} onClick={() => void applyDraft()}>{draftApplying ? `Application ${draftApplying.current}/${draftApplying.total}…` : "Valider le brouillon"}</button></div>}
              <div className="conversation" ref={conversationRef}>{conversation?.messages.map((item) => item.role === "user" ? <div className="user-message" key={item.id}>{item.content}</div> : <div className="assistant-message" key={item.id}><span>✦</span><div><Suspense fallback={<p>Affichage…</p>}><MarkdownAnswer content={item.content} /></Suspense><ConversationDetails actions={item.actions} citations={item.citations} sourceLabel="document(s) proposés à l’assistant" /></div></div>)}{pending && <><div className="user-message pending" aria-live="polite">{pending}</div><div className="assistant-message assistant-loading" role="status" aria-live="polite"><span>✦</span><div><span className="mini-spinner" aria-hidden="true" /><p>L’assistant réfléchit et consulte les documents nécessaires…</p></div></div></>}{!conversation?.messages.length && !pending && <p className="empty-hint">Cette conversation est vide. Demandez une recherche, une synthèse ou une action sur le projet.</p>}</div>
              {!status?.configured && <p className="local-warning">Ajoutez votre clé OpenAI dans Paramètres pour utiliser l’assistant.</p>}
              <form className="chat-composer" onSubmit={ask}><label className="assistant-permission"><input type="checkbox" checked={allowActions} onChange={(event) => setAllowActions(event.target.checked)} /><span>Autoriser l’assistant à préparer des modifications. Les fichiers restent en brouillon jusqu’à validation.</span></label><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Posez une question ou demandez une action…" minLength={3} maxLength={4000} required /><button className="primary-button" disabled={busy || !status?.configured}>{busy ? "…" : "Envoyer"}</button></form>
            </div>
          </div>}
      </section>}
      {view === "settings" && <section className="settings-grid"><article className="settings-panel"><div className="settings-title"><span>✦</span><div><h2>OpenAI</h2><p>Connexion directe depuis cette application, sans ClairDoc Server.</p></div></div><p>Clé API : {status?.configured ? "configurée" : "non configurée"}</p><form className="local-key-form" onSubmit={saveKey}><label htmlFor="local-openai-key">Clé API OpenAI</label><input id="local-openai-key" type="password" autoComplete="off" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} placeholder="sk-…" required /><button className="primary-button" disabled={busy}>Enregistrer la clé</button></form><label className="model-picker">Modèle<select value={status?.model ?? "gpt-6-luna"} onChange={(event) => void setModel(event.target.value)}>{status?.modelOptions.map((option) => <option key={option}>{option}</option>)}</select></label><p className="settings-explanation">La clé est conservée sur ce PC, hors de l’interface web. Les questions, les noms de fichiers pertinents, quelques extraits de petits fichiers texte et les PDF cités explicitement (5 Mo maximum) peuvent être transmis à OpenAI. Les modifications préparées par l’assistant ne touchent les fichiers qu’après votre validation.</p></article><article className="settings-panel"><h2>Serveur</h2><p>Adresse : {serverUrl}</p><button className="secondary-button" onClick={() => void onRetryServer()}>Rechercher le serveur</button><p>Données locales : {status?.dataDir ?? "Chargement…"}</p></article></section>}
      {view === "import" && <>
        <section className="hero"><p className="eyebrow">Nouveau classement</p><h1>Commençons par vos documents</h1><p className="hero-copy">Choisissez un dossier. ClairDoc identifie les fichiers et leurs sous-dossiers sans déplacer ni modifier les originaux.</p></section>
        <section className="workspace-card">
          {!project ? <div className="empty-state"><div className="folder-illustration"><FolderIcon /></div><h2>Choisir le dossier à organiser</h2><p>Un nouveau projet sera créé pour ce dossier et tous ses sous-dossiers.</p><button className="primary-button" onClick={() => void addFolderProject()}><FolderIcon /> Choisir un dossier</button></div>
            : !project.sourceRoot ? <div className="empty-state"><div className="folder-illustration"><FolderIcon /></div><h2>Associer un dossier à {project.name}</h2><p>Tous ses sous-dossiers seront inclus dans le catalogue.</p><button className="primary-button" onClick={() => void attachFolder()}><FolderIcon /> Choisir un dossier</button></div>
            : <><div className="local-import-heading"><div><h2>{project.name}</h2><p>{project.sourceRoot}</p></div><button className="secondary-button" onClick={() => void openProjectFolder(project.sourceRoot!)}>Ouvrir le dossier</button></div><div className="local-import-actions"><button className="primary-button" disabled={busy} onClick={() => void addFiles()}>+ Ajouter des fichiers</button><button className="secondary-button" onClick={() => void addFolderProject()}>Créer un projet depuis un autre dossier</button><button className="secondary-button" onClick={() => void refreshLibrary()}>Actualiser le catalogue</button></div><p className="reassurance">Les fichiers ajoutés sont copiés dans « Ajouts » ; leurs originaux restent à leur place.</p>{importNotice && <div className="batch-complete" role="status">{importNotice}</div>}
              <div className="local-analysis-panel"><div><strong>{catalog?.total ?? library?.documents.length ?? 0} document(s) catalogué(s)</strong><p>{library?.documents.filter((item) => item.status === "indexed").length ?? 0} avec contenu · {library?.documents.filter((item) => item.status !== "indexed").length ?? 0} sur le nom uniquement · {library?.documents.filter((item) => !item.analyzed).length ?? 0} à analyser</p><small>Le catalogage des noms est gratuit. L’analyse extrait le contenu et crée des embeddings via OpenAI ; elle peut engendrer des frais.</small></div><div className="local-heading-actions"><label>Nombre à analyser <select value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))}><option value={5}>5</option><option value={20}>20</option><option value={100}>100</option><option value={0}>Tous</option></select></label><button className="primary-button" disabled={!status?.configured || !!analysis || !library?.documents.some((item) => !item.analyzed)} onClick={() => void analyzeDocuments()}>Analyser les documents</button>{analysis && <button className="secondary-button" onClick={() => { pauseAnalysis.current = true; }}>Arrêter après ce fichier</button>}</div>{analysis && <p role="status">{analysis.current}/{analysis.total} traité(s) · {analysis.failed} échec(s){analysis.lastError ? ` · ${analysis.lastError}` : ""}</p>}</div>
              {!status?.configured && <p className="local-warning">Ajoutez votre clé OpenAI dans Paramètres pour analyser le contenu des documents.</p>}
            </>}
        </section>
      </>}
    </main>
  </div>;
}
