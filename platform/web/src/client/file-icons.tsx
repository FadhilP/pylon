import { fileIconId, folderIconId } from "../shared/file-icon";

export function FileTypeIcon({ path, size = 14 }: { path: string; size?: number }) {
  return (
    <img
      className="file-type-icon"
      src={`/file-icons/${fileIconId(path)}.svg`}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      alt=""
    />
  );
}

export function FolderTypeIcon({ name, open, size = 14 }: { name: string; open: boolean; size?: number }) {
  return (
    <img
      className="folder-icon"
      src={`/file-icons/${folderIconId(name, open)}.svg`}
      width={size}
      height={size}
      decoding="async"
      alt=""
    />
  );
}
