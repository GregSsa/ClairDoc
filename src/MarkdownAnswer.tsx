import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MARKDOWN_PLUGINS = [remarkGfm];

export default function MarkdownAnswer({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} skipHtml>{content}</ReactMarkdown>
    </div>
  );
}
