type TreeNode = {
  children: Map<string, TreeNode>;
  files: string[];
  total: number;
};

const createNode = (): TreeNode => ({ children: new Map(), files: [], total: 0 });

function cleanPart(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
}

export function buildProjectTree(paths: string[], maxCharacters = 1200): string {
  const root = createNode();
  const normalized = [...new Set(paths
    .map((path) => path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
    .filter((path) => path && !path.startsWith(".clairdoc/")))]
    .sort((left, right) => left.localeCompare(right, "fr", { sensitivity: "base" }));

  for (const path of normalized) {
    const parts = path.split("/").map(cleanPart).filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;
    node.total += 1;
    for (const folder of parts.slice(0, -1)) {
      let child = node.children.get(folder);
      if (!child) {
        child = createNode();
        node.children.set(folder, child);
      }
      child.total += 1;
      node = child;
    }
    node.files.push(parts[parts.length - 1]);
  }

  if (root.total === 0) return "";

  const lines = [`./ — ${root.total} document(s) au total`];
  const render = (node: TreeNode, prefix: string) => {
    const folders = [...node.children.entries()].sort(([left], [right]) =>
      left.localeCompare(right, "fr", { sensitivity: "base" }),
    );
    folders.forEach(([name, child], index) => {
      const last = index === folders.length - 1;
      const direct = child.files.length;
      lines.push(`${prefix}${last ? "└─" : "├─"} ${name}/ — ${child.total} document(s)${direct ? `, ${direct} direct(s)` : ""}`);
      render(child, `${prefix}${last ? "   " : "│  "}`);
    });
    const samples = node.files.slice(0, 2);
    samples.forEach((name) => lines.push(`${prefix}• ${name}`));
    if (node.files.length > samples.length) {
      lines.push(`${prefix}• … ${node.files.length - samples.length} autre(s) fichier(s) dans ce dossier`);
    }
  };
  render(root, "");

  const truncation = "[… aperçu tronqué : poursuivre l’inventaire avec les outils paginés avant de conclure.]";
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const addition = line.length + (kept.length ? 1 : 0);
    if (length + addition + truncation.length + 1 > maxCharacters) break;
    kept.push(line);
    length += addition;
  }
  if (kept.length < lines.length) kept.push(truncation);
  return kept.join("\n");
}
