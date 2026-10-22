import { Paperclip, X } from "lucide-react";
import type { MessageAttachmentInput } from "@/lib/types";
import { attachmentPreviewUrl } from "@/lib/workbench-logic";
import { cn } from "@/lib/utils";

export function ComposerAttachments({ attachments, onRemove }: {
  attachments: MessageAttachmentInput[];
  onRemove: (index: number) => void;
}) {
  if (!attachments.length) return null;
  return <div className="flex flex-wrap gap-2 px-3 pt-3" data-composer-attachments>
    {attachments.map((attachment, index) => {
      const preview = attachmentPreviewUrl(attachment);
      return <div
        className={cn(
          "group relative overflow-hidden rounded-md border motion-safe:animate-chip-pop",
          preview ? "size-16" : "inline-flex items-center gap-1.5 px-2 py-1 text-xs",
          "border-line bg-surface-tint text-ink-soft",
        )}
        data-composer-attachment
        key={`${attachment.name}-${index}`}
        style={{ animationDelay: `${index * 50}ms` }}
      >
        {preview
          ? <img alt={attachment.name} className="size-full object-cover" src={preview} />
          : <><Paperclip className="size-3" /><span className="max-w-40 truncate">{attachment.name}</span></>}
        <button
          aria-label={`移除 ${attachment.name}`}
          className={cn(preview && "absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-surface")}
          onClick={() => onRemove(index)}
          type="button"
        >
          <X className="size-3" />
        </button>
      </div>;
    })}
  </div>;
}
