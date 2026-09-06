import { fileTypeIcon } from "../file-icons";

/** 文件行类型徽标：短标签 + 固定识别色。未收录类型留空槽，行仍对齐。 */
export default function FileTypeMark({ path }: { path: string }) {
  const icon = fileTypeIcon(path);
  return (
    <span
      aria-hidden="true"
      className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm px-0.5 font-mono text-micro leading-4"
      style={
        icon
          ? { color: icon.color, backgroundColor: `${icon.color}26` }
          : undefined
      }
    >
      {icon?.label ?? ""}
    </span>
  );
}
