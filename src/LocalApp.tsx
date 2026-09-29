import { FormEvent, Suspense, lazy, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import ProjectExplorer from "./ProjectExplorer";
import { listDocumentFiles, openProjectFile, openProjectFolder, type Conversation, type ConversationSummary, type DocumentFile, type DocumentLibrary, type RemoteProject } from "./server";
import "./LocalApp.css";

type LocalStatus = { configured: boolean; model: string; modelOptions: string[]; dataDir: string };
type SearchHit = { relativePath: string; name: string; excerpt: string | null };
type View = "projects" | "explorer" | "search" | "assistant" | "settings";
const MarkdownAnswer = lazy(() => import("./MarkdownAnswer"));

function message(error: unknown) {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Une erreur est survenue.";
}

export default function LocalApp({ serverUrl, onRetryServer }: { serverUrl: string; onRetryServer: () => Promise<void> }) {
  const [view, setView] = useState<View>("projects");
  const [projects, setProjects] = useState<RemoteProject[]>([]);
  const [project, setProject] = useState<RemoteProject | null>(null);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [name, setName] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [files, setFiles] = useState<DocumentFile[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("clairdoc-theme") === "dark" ? "dark" : "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("clairdoc-theme", theme);
  }, [theme]);

  useEffect(() => {
    let active = true;
    Promise.all([invoke<LocalStatus>("local_status"), invoke<RemoteProject[]>("local_list_projects")])
      .then(([localStatus, items]) => { if (active) { setStatus(localStatus); setProjects(items); } })
      .catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!project?.sourceRoot) { setFiles([]); return; }
    let active = true;
    listDocumentFiles(project.sourceRoot)
      .then((items) => { if (active) setFiles(items); })
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

  const library = useMemo<DocumentLibrary | null>(() => project ? {
    projectId: project.id,
    documents: files.map((file) => ({
      jobId: file.relativePath, name: file.name, sourceRelativePath: file.relativePath,
      status: "indexed_name", textWarning: null, category: "Documents", documentDate: null,
      organization: null, people: [], amounts: [], chunks: 0,
    })),
    categories: ["Documents"], relationships: [],
  } : null, [project, files]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError("");
    try {
      const item = await invoke<RemoteProject>("local_create_project", { name: name.trim(), sourceRoot: null });
      setProjects((current) => [...current, item]); setProject(item); setName(""); setView("explorer");
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
      setProjects((current) => [...current, item]); setProject(item); setView("explorer");
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
      if (project?.id === item.id) { setProject(null); setView("projects"); }
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
      await invoke("local_send_message", { projectId: project.id, conversationId: active.id, question: submitted });
      setConversation(await invoke<Conversation>("local_get_conversation", { projectId: project.id, conversationId: active.id }));
      setConversations(await invoke<ConversationSummary[]>("local_list_conversations", { projectId: project.id }));
    } catch (failure) { setError(message(failure)); setQuestion(submitted); }
    finally { setPending(null); setBusy(false); }
  }

  async function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!project || !search.trim()) return;
    setBusy(true); setError("");
    try { setHits(await invoke<SearchHit[]>("local_search_documents", { projectId: project.id, query: search.trim() })); }
    catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }

  return <div className="app-shell local-app">
    <aside className="sidebar" aria-label="Navigation principale">
      <div className="brand sidebar-brand">▰ <span>ClairDoc</span></div>
      <nav>{([ ["projects", "⌂", "Projets"], ["explorer", "▣", "Explorateur"], ["search", "⌕", "Recherche"], ["assistant", "✦", "Assistant"] ] as const).map(([target, icon, label]) =>
        <button key={target} className={view === target ? "active" : ""} disabled={target !== "projects" && !project} onClick={() => setView(target)}><span aria-hidden="true">{icon}</span>{label}</button>)}</nav>
      <div className="sidebar-footer"><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>⚙ Paramètres</button><div className="server-pill"><span /> Mode autonome · OpenAI</div></div>
    </aside>
    <header className="topbar"><div><small>MODE AUTONOME</small><strong>{project?.name ?? "Mes projets locaux"}</strong></div><div className="topbar-actions"><span className="privacy-note">Le serveur ClairDoc est indisponible</span><button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label="Changer le thème">{theme === "light" ? "☾" : "☀"}</button></div></header>
    <main className="main-content">
      {error && <p className="local-error" role="alert">{error}</p>}
      {view === "projects" && <section className="dashboard-view"><div className="page-heading"><div><p className="eyebrow">Sans serveur</p><h1>Vos projets sur ce PC</h1><p>Les dossiers restent sur votre ordinateur. L’assistant utilise directement votre clé OpenAI lorsque vous lui posez une question.</p></div><button className="primary-button" onClick={() => void addFolderProject()} disabled={busy}>Ajouter un dossier existant</button></div><p className="local-info">Les projets enregistrés uniquement sur ClairDoc Server ne sont pas synchronisés ici. Pour consulter leur dossier sans serveur, ajoutez-le comme projet local.</p><div className="dashboard-grid"><article className="new-project-card"><h2>Nouveau projet</h2><p>Créez un projet puis associez-lui un dossier.</p><form onSubmit={createProject}><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nom du projet" maxLength={120} required /><button className="primary-button" disabled={busy}>Créer</button></form></article>{projects.map((item) => <article className="project-card" key={item.id}><h2>{item.name}</h2><p>{item.sourceRoot ?? "Aucun dossier associé"}</p><div className="local-card-actions"><button className="secondary-button" onClick={() => { setConversation(null); setProject(item); setView("explorer"); }}>Ouvrir</button><button className="text-button" onClick={() => void renameProject(item)}>Renommer</button><button className="text-button" onClick={() => void removeProject(item)}>Retirer</button></div></article>)}</div></section>}
      {view === "explorer" && project && <section><div className="page-heading compact"><div><p className="eyebrow">Projet local</p><h1>Explorateur</h1><p>{project.sourceRoot ?? "Associez un dossier pour voir ses fichiers."}</p></div><div className="local-heading-actions"><button className="secondary-button" onClick={() => void attachFolder()} disabled={busy}>{project.sourceRoot ? "Changer le dossier" : "Associer un dossier"}</button>{project.sourceRoot && <button className="secondary-button" onClick={() => void openProjectFolder(project.sourceRoot!)}>Ouvrir sur le PC</button>}</div></div>{project.sourceRoot && <ProjectExplorer key={project.id} projectName={project.name} rootPath={project.sourceRoot} library={library} draft={null} draftApplying={null} draftError="" draftNotice="" onApplyDraft={() => {}} onRemoveDraftItem={() => {}} />}</section>}
      {view === "search" && project && <section className="search-view"><div className="page-heading compact"><div><p className="eyebrow">Recherche locale</p><h1>Retrouver un document</h1><p>Recherche dans les noms et les petits fichiers texte. Les PDF ne sont pas indexés dans ce mode.</p></div></div><form className="search-panel" onSubmit={find}><label htmlFor="local-search">Mots recherchés</label><div className="search-input-row"><input id="local-search" value={search} onChange={(event) => setSearch(event.target.value)} minLength={2} required /><button className="primary-button" disabled={busy}>Rechercher</button></div></form>{hits && <ol className="search-result-list">{hits.map((hit) => <li className="search-result-card" key={hit.relativePath}><h3>{hit.name}</h3><p>{hit.relativePath}</p>{hit.excerpt && <blockquote>{hit.excerpt}</blockquote>}<button className="secondary-button" onClick={() => project.sourceRoot && openProjectFile(project.sourceRoot, hit.relativePath)}>Ouvrir</button></li>)}{hits.length === 0 && <p>Aucun document trouvé.</p>}</ol>}</section>}
      {view === "assistant" && project && <section className="local-chat-layout"><aside className="conversation-sidebar"><button className="secondary-button new-conversation" onClick={() => void newConversation()}>+ Nouvelle conversation</button><div className="conversation-list">{conversations.map((item) => <div className={`conversation-item ${conversation?.id === item.id ? "active" : ""}`} key={item.id}><button onClick={() => void selectConversation(item.id)}><strong>{item.title}</strong><small>{item.messageCount} message(s)</small></button><button className="conversation-delete" aria-label={`Supprimer ${item.title}`} onClick={() => void removeConversation(item.id)}>×</button></div>)}</div></aside><div className="chat-card"><div className="chat-intro"><span>✦</span><div><strong>Assistant du projet</strong><p>Répond avec OpenAI. Aucun fichier ne sera modifié par l’assistant dans ce mode.</p></div></div><div className="conversation">{conversation?.messages.map((item) => item.role === "user" ? <div className="local-user-message" key={item.id}>{item.content}</div> : <div className="assistant-message" key={item.id}><span>✦</span><Suspense fallback={<p>Affichage…</p>}><MarkdownAnswer content={item.content} /></Suspense></div>)}{pending && <><div className="local-user-message">{pending}</div><div className="assistant-message"><span>✦</span><p>Réponse en cours…</p></div></>}{!conversation?.messages.length && !pending && <p>Posez une question, par exemple « Résume le document facture.pdf ». Le PDF cité sera envoyé à OpenAI s’il fait 5 Mo ou moins.</p>}</div><form className="chat-composer" onSubmit={ask}><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Posez votre question…" required /><button className="primary-button" disabled={busy || !status?.configured}>{busy ? "En cours…" : "Envoyer"}</button></form>{!status?.configured && <p className="local-warning">Ajoutez votre clé OpenAI dans Paramètres pour utiliser l’assistant.</p>}</div></section>}
      {view === "settings" && <section className="settings-grid"><article className="settings-panel"><div className="settings-title"><span>✦</span><div><h2>OpenAI</h2><p>Connexion directe depuis cette application, sans ClairDoc Server.</p></div></div><p>Clé API : {status?.configured ? "configurée" : "non configurée"}</p><form className="local-key-form" onSubmit={saveKey}><label htmlFor="local-openai-key">Clé API OpenAI</label><input id="local-openai-key" type="password" autoComplete="off" value={keyInput} onChange={(event) => setKeyInput(event.target.value)} placeholder="sk-…" required /><button className="primary-button" disabled={busy}>Enregistrer la clé</button></form><label className="model-picker">Modèle<select value={status?.model ?? "gpt-6-luna"} onChange={(event) => void setModel(event.target.value)}>{status?.modelOptions.map((option) => <option key={option}>{option}</option>)}</select></label><p className="settings-explanation">La clé est conservée sur ce PC, hors de l’interface web. Les questions, les noms de fichiers pertinents, quelques extraits de petits fichiers texte et les PDF cités explicitement (5 Mo maximum) peuvent être transmis à OpenAI. Les originaux ne sont jamais modifiés par l’assistant autonome.</p></article><article className="settings-panel"><h2>Serveur</h2><p>Adresse : {serverUrl}</p><button className="secondary-button" onClick={() => void onRetryServer()}>Rechercher le serveur</button><p>Données locales : {status?.dataDir ?? "Chargement…"}</p></article></section>}
    </main>
  </div>;
}
