import { FirstPassOptions } from "./firstPass";

type Props = {
  options: FirstPassOptions;
  onChange: (options: FirstPassOptions) => void;
  standalone?: boolean;
  disabled?: boolean;
};

export default function FirstPassSettings({ options, onChange, standalone = false, disabled = false }: Props) {
  function change<K extends keyof FirstPassOptions>(key: K, value: FirstPassOptions[K]) {
    onChange({ ...options, [key]: value });
  }

  return <div className="first-pass-options">
    <h3>Premier nettoyage du projet</h3>
    <p>Tous les documents du dossier et de ses sous-dossiers seront inclus. L’assistant préparera des propositions à vérifier : aucun fichier ne sera modifié avant votre validation.</p>
    <label className={`first-pass-choice first-pass-economy ${options.namesOnly ? "selected" : ""}`}><input type="checkbox" checked={options.namesOnly} disabled={disabled} onChange={(event) => change("namesOnly", event.target.checked)} /> <span><strong>Mode économique : utiliser uniquement les noms de fichiers</strong><small>Le contenu, les extraits et l’OCR ne seront pas consultés pour le nettoyage et le tri. Les noms ambigus resteront à vérifier.</small></span></label>
    <label className="first-pass-choice"><input type="checkbox" checked={options.ocr} disabled={disabled} onChange={(event) => change("ocr", event.target.checked)} /> {standalone ? "Lire les PDF scannés et les images avec OpenAI" : "Passer l’OCR sur les documents scannés"}</label>
    <details className="first-pass-help"><summary aria-label="Qu’est-ce que l’OCR ?">?</summary><p>{standalone ? "L’OCR transforme une image de texte en texte recherchable. Sans serveur, ClairDoc ne dispose pas d’OCRmyPDF : l’analyse visuelle peut être demandée à OpenAI après création du projet, avec votre confirmation du coût. La création seule n’envoie aucun fichier." : "L’OCR reconnaît le texte dans les PDF scannés et les images. Il permet de les rechercher et d’aider l’assistant à les comprendre. Sans OCR, les PDF déjà textuels restent lisibles ; les scans sans texte seront recherchables par leur nom uniquement."}</p></details>
    <label className="first-pass-choice"><input type="checkbox" checked={options.rename} disabled={disabled} onChange={(event) => change("rename", event.target.checked)} /> Proposer des noms clairs et cohérents</label>
    <label className="first-pass-choice"><input type="checkbox" checked={options.normalizeDates} disabled={disabled || !options.rename} onChange={(event) => change("normalizeDates", event.target.checked)} /> Uniformiser les dates des noms en JJ-MM-AAAA</label>
    <label className="first-pass-choice"><input type="checkbox" checked={options.organize} disabled={disabled} onChange={(event) => change("organize", event.target.checked)} /> Proposer des sous-dossiers simples</label>
    {options.organize && <>
      <label className="first-pass-depth">Profondeur maximale des sous-dossiers
        <select value={options.maxDepth ?? "unlimited"} disabled={disabled} onChange={(event) => change("maxDepth", event.target.value === "unlimited" ? null : Number(event.target.value))}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((depth) => <option key={depth} value={depth}>{depth}</option>)}
          <option value="unlimited">Sans limite</option>
        </select>
      </label>
      <label className="first-pass-depth">Sous-dossiers directs au maximum dans chaque dossier
        <select value={options.maxChildren ?? "unlimited"} disabled={disabled} onChange={(event) => change("maxChildren", event.target.value === "unlimited" ? null : Number(event.target.value))}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((count) => <option key={count} value={count}>{count}</option>)}
          <option value="unlimited">Sans limite</option>
        </select>
      </label>
    </>}
    <small>{options.namesOnly ? "Mode économique activé : seules les informations visibles dans les noms et les chemins seront utilisées pour ce classement." : "L’assistant se basera d’abord sur les noms, et lira le contenu seulement en cas de doute."} Les doublons et les dates ambiguës seront signalés, jamais supprimés automatiquement.</small>
  </div>;
}
