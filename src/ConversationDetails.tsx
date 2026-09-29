import { useState } from "react";
import type { AssistantAction, Citation } from "./server";

type Props = {
  actions: AssistantAction[];
  citations: Citation[];
  sourceLabel?: string;
};

export default function ConversationDetails({ actions, citations, sourceLabel = "document(s) consulté(s)" }: Props) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const documentCount = new Set(citations.map((citation) => citation.job_id)).size;

  return <div className="conversation-details">
    {documentCount > 0 && <details className="conversation-detail" onToggle={(event) => setSourcesOpen(event.currentTarget.open)}>
      <summary>{documentCount} {sourceLabel}<span aria-hidden="true">⌄</span></summary>
      {sourcesOpen && <div className="source-list">
        {citations.map((citation, index) => <div className="source-item" key={`${citation.job_id}-${citation.chunk_index}-${index}`}>
          <b>{citation.document_name}</b>
          {citation.excerpt && <small>{citation.page_number ? `Page ${citation.page_number} · ` : ""}{citation.excerpt}</small>}
        </div>)}
      </div>}
    </details>}
    {actions.length > 0 && <details className="conversation-detail" onToggle={(event) => setActionsOpen(event.currentTarget.open)}>
      <summary>{actions.length} modification(s) ou action(s)<span aria-hidden="true">⌄</span></summary>
      {actionsOpen && <div className="action-list">{actions.map((action, index) => <span className={action.status} key={`${action.id ?? index}-${index}`}>{action.summary}</span>)}</div>}
    </details>}
  </div>;
}
