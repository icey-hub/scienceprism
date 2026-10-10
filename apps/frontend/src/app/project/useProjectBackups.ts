import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getProjectBackup, restoreProjectBackup } from '../../api/projectAdapter';
import type { ProjectMeta } from '../../api/projectAdapter';

export function useProjectBackups({ onStatus, onRestored }: { onStatus: (message: string) => void; onRestored: (project: ProjectMeta) => Promise<void> }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pending = useRef(false);
  async function perform(operation: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try { await operation(); }
    catch (error) { onStatus(t('备份操作失败: {{error}}', { error: error instanceof Error ? error.message : String(error) })); }
    finally { pending.current = false; setBusy(false); }
  }
  function download(project: ProjectMeta) {
    return perform(async () => {
      const backup = await getProjectBackup(project.id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
      const link = document.createElement('a');
      try { link.href = url; link.download = `${project.id}.scienceprism-backup.json`; document.body.append(link); link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      onStatus(t('项目备份已下载。配置密钥已排除，请妥善保存项目内容。'));
    });
  }
  function restore(file: File) {
    return perform(async () => {
      if (file.size > 90 * 1024 * 1024) throw new Error(t('备份文件超过 90 MiB 限制。'));
      let backup;
      try { backup = JSON.parse(await file.text()); } catch { throw new Error(t('无法读取备份文件，请选择 SciencePrism 项目备份。')); }
      const { project } = await restoreProjectBackup(backup);
      await onRestored(project);
      onStatus(t('项目备份已恢复。'));
    });
  }
  return { busy, inputRef, download, restore };
}
