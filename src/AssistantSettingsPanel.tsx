export type AssistantSettings = {
  namesOnly: boolean;
  allowRename: boolean;
  allowMove: boolean;
  includeProjectTree: boolean;
};

export const defaultAssistantSettings: AssistantSettings = {
  namesOnly: false,
  allowRename: true,
  allowMove: true,
  includeProjectTree: true,
};

const STORAGE_KEY = "clairdoc-assistant-settings";

export function readAssistantSettings(): AssistantSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return { ...defaultAssistantSettings };
    return {
      namesOnly: typeof saved.namesOnly === "boolean" ? saved.namesOnly : false,
      allowRename: typeof saved.allowRename === "boolean" ? saved.allowRename : true,
      allowMove: typeof saved.allowMove === "boolean" ? saved.allowMove : true,
      includeProjectTree: typeof saved.includeProjectTree === "boolean" ? saved.includeProjectTree : true,
    };
  } catch {
    return { ...defaultAssistantSettings };
  }
}

export function saveAssistantSettings(settings: AssistantSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export default function AssistantSettingsPanel({ settings, onChange }: {
  settings: AssistantSettings;
  onChange: (settings: AssistantSettings) => void;
}) {
  const update = (field: keyof AssistantSettings, value: boolean) => onChange({ ...settings, [field]: value });
  return (
    <section id="assistant-settings-panel" className="assistant-settings-panel" aria-label="Réglages de l’assistant">
      <div><strong>Accès et actions de l’assistant</strong><p>Ces choix sont mémorisés sur cet ordinateur.</p></div>
      <label><input type="checkbox" checked={settings.namesOnly} onChange={(event) => update("namesOnly", event.target.checked)} /><span><strong>Noms uniquement</strong><small>Autoriser seulement les noms des dossiers et fichiers, sans lire leur contenu.</small></span></label>
      <label><input type="checkbox" checked={settings.allowRename} onChange={(event) => update("allowRename", event.target.checked)} /><span><strong>Autoriser le renommage</strong><small>L’assistant peut préparer des changements de noms dans le brouillon.</small></span></label>
      <label><input type="checkbox" checked={settings.allowMove} onChange={(event) => update("allowMove", event.target.checked)} /><span><strong>Autoriser les déplacements</strong><small>L’assistant peut préparer des déplacements qui modifient l’architecture.</small></span></label>
      <label><input type="checkbox" checked={settings.includeProjectTree} onChange={(event) => update("includeProjectTree", event.target.checked)} /><span><strong>Ajouter l’arborescence au contexte</strong><small>Transmettre une vue compacte du projet avant chaque demande.</small></span></label>
    </section>
  );
}
