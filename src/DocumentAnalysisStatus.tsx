type Props = {
  status: string;
  analyzed?: boolean;
};

export default function DocumentAnalysisStatus({ status, analyzed = false }: Props) {
  const contentAnalyzed = status === "indexed";
  const nameOnly = status === "indexed_name" || analyzed;
  const label = contentAnalyzed ? "Contenu analysé" : nameOnly ? "Nom seul" : "À analyser";
  return (
    <span className="document-analysis-status">
      <span className={`status-chip ${contentAnalyzed ? "indexed" : nameOnly ? "indexed_name" : status}`}>{label}</span>
    </span>
  );
}
