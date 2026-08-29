import { IconDownload, IconFileText, IconPhoto, IconRefresh, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { MessageAttachmentReadModel } from "../shared/protocol/events";
import type { ConversationAttachmentContent } from "../shared/protocol/snapshots";
import { runtimeStore } from "./runtime/event-store";

export function AttachmentPanel({
  attachment,
  onClose,
}: {
  attachment: MessageAttachmentReadModel;
  onClose: () => void;
}) {
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
          <strong id="attachment-title">Attachment details</strong>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close attachment details">
          <IconX size={17} />
        </button>
      </header>
      <div className="attachment-panel-body">
        <div className="attachment-panel-heading">
          <div>
            <strong title={attachment.name}>{attachment.name}</strong>
            <span>
              {attachment.mimeType} · {formatBytes(attachment.size)}
            </span>
          </div>
          {content && (
            <button className="secondary-button" type="button" onClick={download}>
              <IconDownload size={14} />
              Download
            </button>
          )}
        </div>
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
