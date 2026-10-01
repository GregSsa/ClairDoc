import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  label: string;
  children: string;
  className?: string;
};

export default function HelpTip({ label, children, className = "" }: Props) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <span className={`help-tip ${className}`.trim()}>
      <button ref={triggerRef} type="button" className="help-tip-trigger" aria-label={label} title={label} aria-expanded={open} aria-controls={descriptionId} onClick={() => setOpen(true)}>?</button>
      {open && createPortal(
        <div className="help-tip-overlay" role="presentation" onMouseDown={() => { setOpen(false); triggerRef.current?.focus(); }}>
          <div className="help-tip-dialog" role="dialog" aria-modal="true" aria-label={label} aria-describedby={descriptionId} onMouseDown={(event) => event.stopPropagation()}>
            <div className="help-tip-dialog-heading"><strong>{label}</strong><button type="button" aria-label="Fermer l’aide" autoFocus onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>×</button></div>
            <p id={descriptionId}>{children}</p>
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
