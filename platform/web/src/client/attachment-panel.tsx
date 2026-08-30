import {
  IconChevronLeft,
  IconChevronRight,
  IconDownload,
  IconFileText,
  IconPhoto,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { MessageAttachmentReadModel } from "../shared/protocol/events";
import type { ConversationAttachmentContent } from "../shared/protocol/snapshots";
import { runtimeStore } from "./runtime/event-store";
import { AttachmentThumbnail } from "./conversation-panel";

export function AttachmentPanel({
  attachments,
  index,
  onSelect,
  onClose,
}: {
  attachments: MessageAttachmentReadModel[];
  index: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const attachment = attachments[index]!;
  const [content, setContent] = useState<ConversationAttachmentContent>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setContent(undefined);
    setError("");
    void runtimeStore
      .conversationAttachment(attachment.sourceEntryId, attachment.index, controller.signal)
      .then(setContent)
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load attachment");
      });
    return () => controller.abort();
  }, [attachment.sourceEntryId, attachment.index, retry]);

  /** The arrows are the primary way through a message's files, so the arrow
      keys drive them too — unless the person is typing. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      const next = index + (event.key === "ArrowRight" ? 1 : -1);
      if (next < 0 || next >= attachments.length) return;
      event.preventDefault();
      onSelect(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index, attachments.length, onSelect]);

  const download = () => {
    if (!content) return;
    const blob =
      content.kind === "image"
        ? new Blob([base64Bytes(content.data)], { type: content.mimeType })
        : new Blob([content.text], { type: `${content.mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = content.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <aside id="attachment-panel" className="inspector attachment-panel is-open" aria-labelledby="attachment-title">
      <header>
        <div>
          {attachment.kind === "image" ? <IconPhoto size={18} /> : <IconFileText size={18} />}
          <strong id="attachment-title">Attachment</strong>
        </div>
        <div>
          <button
            className="icon-button"
            type="button"
            onClick={download}
            disabled={!content}
            title="Download"
            aria-label="Download attachment">
            <IconDownload size={17} />
          </button>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close attachment details">
            <IconX size={17} />
          </button>
        </div>
      </header>

      <div className="attachment-panel-body">
        <div className="attachment-head">
          <strong title={attachment.name}>{attachment.name}</strong>
          <span className="mono">
            {attachment.mimeType} · {formatBytes(attachment.size)}
          </span>
          {attachments.length > 1 && (
            <span className="attachment-nav">
              <button
                className="icon-button"
                type="button"
                onClick={() => onSelect(index - 1)}
                disabled={index === 0}
                title="Previous attachment"
                aria-label="Previous attachment">
                <IconChevronLeft size={15} />
              </button>
              <span className="attachment-count">
                {index + 1} of {attachments.length}
              </span>
              <button
                className="icon-button"
                type="button"
                onClick={() => onSelect(index + 1)}
                disabled={index === attachments.length - 1}
                title="Next attachment"
                aria-label="Next attachment">
                <IconChevronRight size={15} />
              </button>
            </span>
          )}
        </div>

        {/* Jumping straight to one, when going in order is the long way round. */}
        {attachments.length > 1 && (
          <div className="attachment-strip" aria-label="Attachments in this message">
            {attachments.map((item, itemIndex) => (
              <button
                type="button"
                key={`${item.sourceEntryId}:${item.index}`}
                onClick={() => onSelect(itemIndex)}
                aria-current={itemIndex === index}
                title={item.name}
                aria-label={item.name}>
                {item.kind === "image" ? (
                  <AttachmentThumbnail attachment={item} reloadKey="panel" />
                ) : (
                  <IconFileText size={15} />
                )}
              </button>
            ))}
          </div>
        )}

        {!content && !error && (
          <div className="attachment-panel-loading" role="status" aria-label="Loading attachment">
            <span />
            <span />
            <span />
          </div>
        )}
        {error && (
          <div className="attachment-panel-error" role="alert">
            <p>{error}</p>
            <button className="secondary-button" type="button" onClick={() => setRetry(value => value + 1)}>
              <IconRefresh size={14} />
              Retry
            </button>
          </div>
        )}
        {content?.kind === "image" && (
          <div className="attachment-image-preview">
            <img src={`data:${content.mimeType};base64,${content.data}`} alt={content.name} />
          </div>
        )}
        {content?.kind === "file" && <pre className="attachment-text-preview">{content.text}</pre>}
      </div>
    </aside>
  );
}

function base64Bytes(data: string): ArrayBuffer {
  const decoded = atob(data);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
