import HelpTip from "./HelpTip";

type Props = {
  status: string;
  analyzed?: boolean;
};

export default function DocumentAnalysisStatus({ status, analyzed = false }: Props) {
  const contentAnalyzed = status === "indexed";
  const nameOnly = status === "indexed_name" || analyzed;
  const label = contentAnalyzed ? "Contenu analysé" : nameOnly ? "Nom seul" : "À analyser";
  const explanation = contentAnalyzed
    ? "ClairDoc a lu le texte de ce document. Son contenu peut être utilisé pour la recherche, les liens et les réponses de l’assistant."
    : nameOnly
      ? "ClairDoc utilise uniquement le nom et le chemin de ce fichier. Son contenu n’a pas été lu, ce qui économise des traitements et des jetons d’IA."
      : "Le fichier est catalogué, mais son contenu n’a pas encore été analysé. Il reste retrouvable grâce à son nom et à son emplacement.";

  return (
    <span className="document-analysis-status">
      <span className={`status-chip ${contentAnalyzed ? "indexed" : nameOnly ? "indexed_name" : status}`}>{label}</span>
      <HelpTip label={`Que signifie « ${label} » ?`}>{explanation}</HelpTip>
    </span>
  );
}
