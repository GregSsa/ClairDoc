import { useEffect, useState } from "react";

export type FontSize = "standard" | "large" | "xlarge" | "maximum";

const choices: Array<{ value: FontSize; label: string; detail: string }> = [
  { value: "standard", label: "Standard", detail: "100 %" },
  { value: "large", label: "Grand", detail: "115 %" },
  { value: "xlarge", label: "Très grand", detail: "130 %" },
  { value: "maximum", label: "Maximum", detail: "150 %" },
];

function savedFontSize(): FontSize {
  const saved = localStorage.getItem("clairdoc-font-size");
  return choices.some((choice) => choice.value === saved) ? saved as FontSize : "standard";
}

const initialFontSize = savedFontSize();
document.documentElement.dataset.fontSize = initialFontSize;

export default function FontSizeSettings() {
  const [fontSize, setFontSize] = useState<FontSize>(initialFontSize);

  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize;
    localStorage.setItem("clairdoc-font-size", fontSize);
  }, [fontSize]);

  return <fieldset className="font-size-settings">
    <legend>Taille du texte</legend>
    <p>Augmente tous les textes de ClairDoc. Le choix est conservé sur cet ordinateur.</p>
    <div className="font-size-choice">
      {choices.map((choice) => <button
        type="button"
        key={choice.value}
        className={fontSize === choice.value ? "selected" : ""}
        aria-pressed={fontSize === choice.value}
        onClick={() => setFontSize(choice.value)}
      ><strong>{choice.label}</strong><span>{choice.detail}</span></button>)}
    </div>
    <div className="font-size-preview" aria-live="polite">
      <span aria-hidden="true">Aa</span>
      <strong>Aperçu du texte</strong>
    </div>
  </fieldset>;
}
