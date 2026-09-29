export type FirstPassOptions = {
  ocr: boolean;
  rename: boolean;
  normalizeDates: boolean;
  organize: boolean;
  maxDepth: number | null;
  maxChildren: number | null;
};

export const defaultFirstPassOptions: FirstPassOptions = {
  ocr: true,
  rename: true,
  normalizeDates: true,
  organize: true,
  maxDepth: 2,
  maxChildren: null,
};

export function saveFirstPassOptions(projectId: string, options: FirstPassOptions): void {
  localStorage.setItem(`clairdoc-first-pass-${projectId}`, JSON.stringify(options));
}

export function readFirstPassOptions(projectId: string): FirstPassOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(`clairdoc-first-pass-${projectId}`) ?? "null");
    if (!saved || typeof saved !== "object") return { ...defaultFirstPassOptions };
    const bounded = (value: unknown, fallback: number | null) =>
      value === null || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10)
        ? value as number | null : fallback;
    return {
      ocr: typeof saved.ocr === "boolean" ? saved.ocr : true,
      rename: typeof saved.rename === "boolean" ? saved.rename : true,
      normalizeDates: typeof saved.normalizeDates === "boolean" ? saved.normalizeDates : true,
      organize: typeof saved.organize === "boolean" ? saved.organize : true,
      maxDepth: bounded(saved.maxDepth, 2),
      maxChildren: bounded(saved.maxChildren, null),
    };
  } catch {
    return { ...defaultFirstPassOptions };
  }
}

export function firstPassPrompt(options: FirstPassOptions): string {
  const depth = options.maxDepth === null ? "sans limite de profondeur" :
    `${options.maxDepth} niveau(x) de sous-dossiers au maximum sous la racine du projet`;
  const children = options.maxChildren === null ? "sans limite de sous-dossiers directs par dossier" :
    `${options.maxChildren} sous-dossier(s) direct(s) au maximum dans chaque dossier`;
  return [
    "Effectue le premier nettoyage de ce projet entier. Prépare uniquement un brouillon de modifications : ne valide, ne supprime et ne déplace rien réellement sans mon accord explicite.",
    "Le périmètre est le projet entier, sous-dossiers inclus. Commence par inventorier les noms et l'architecture actuelle. Pour un grand projet, avance par pages/lots, garde la position de reprise et ne prétends pas avoir terminé si des documents restent à parcourir.",
    "Utilise d'abord les noms et chemins comme indices ; lis le contenu uniquement si un nom est ambigu ou si tu as besoin de vérifier une proposition. N'invente jamais une date, une catégorie ou le contenu d'un document.",
    options.rename ? "Propose des noms de fichiers courts, descriptifs et cohérents. Préserve l'extension et le sens du nom d'origine." : "Conserve les noms des fichiers.",
    options.normalizeDates ? "Dans les noms modifiés, convertis les dates identifiables au format JJ-MM-AAAA. Si une date est ambiguë, garde-la telle quelle et signale-la." : "Ne modifie pas le format des dates dans les noms.",
    options.organize ? `Propose des sous-dossiers simples selon les noms et le contexte, avec ${depth} et ${children}. Évite les dossiers à un seul document et les catégories redondantes.` : "Conserve l'organisation actuelle des sous-dossiers.",
    "Ne supprime aucun document et ne remplace aucun fichier. Signale les doublons probables et les cas incertains pour ma revue.",
    "À la fin, résume le nombre de documents examinés, les modifications en brouillon, les incertitudes et ce qui reste à valider.",
  ].join("\n");
}
