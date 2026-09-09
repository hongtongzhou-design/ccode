/** 后端读取快照：只有完整、可写的 UTF-8 文件才携带保存版本。 */
export interface FilePreviewSnapshot {
  text: string;
  truncated: boolean;
  revision: string | null;
  readOnlyReason: string | null;
}

/** 保存期间继续输入时，只更新磁盘基线，不能把后输入的内容标成已保存。 */
export function previewSaveCompletion(submitted: string, current: string, revision: string) {
  return {
    snapshot: { text: submitted, truncated: false, revision, readOnlyReason: null } satisfies FilePreviewSnapshot,
    dirty: current !== submitted,
  };
}
