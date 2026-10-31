/**
 * 「新建项目」的建在哪（2026-10-31 用户拍板；tests/new-project-parent.test.ts）。
 * 记住上次新建用的上级文件夹（本机 localStorage），下次从那里开始；没记过或那个文件夹不在了
 * （移动硬盘没插）由后端 default_project_parent 回落系统「文档」。
 * 所选位置在网盘同步范围里（后端 cloud_sync_provider 判）时弹窗提醒一句，不拦。
 */

export const NEW_PROJECT_PARENT_KEY = "ccode.newProjectParent";

export function loadNewProjectParent(): string | null {
  try {
    const v = localStorage.getItem(NEW_PROJECT_PARENT_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export function saveNewProjectParent(dir: string): void {
  if (!dir.trim()) return;
  try {
    localStorage.setItem(NEW_PROJECT_PARENT_KEY, dir);
  } catch {
    /* 存不了就下次再回落「文档」 */
  }
}

/** 同步盘提醒文案；provider 为空 = 不提醒 */
export function cloudSyncHint(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return `这个位置会被 ${provider} 同步。项目里的 Git 记录和大数据文件放在同步盘里容易冲突、被挪到云端，建议换个不同步的文件夹。`;
}
