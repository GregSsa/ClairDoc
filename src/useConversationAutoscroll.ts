import { useLayoutEffect, useRef } from "react";

export function useConversationAutoscroll(conversationId: string | undefined, messageCount: number, pending: boolean, visible: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !visible) return;
    let frame = 0;
    const scrollToBottom = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { element.scrollTop = element.scrollHeight; });
    };
    scrollToBottom();
    const observer = new MutationObserver(scrollToBottom);
    observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open"] });
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [conversationId, messageCount, pending, visible]);

  return ref;
}
