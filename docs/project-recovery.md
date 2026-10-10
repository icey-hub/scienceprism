# Project backup and recovery / 项目备份与恢复

## 本地启动与配置

使用 Node.js 26，在仓库目录执行 `npm ci`、`npm run dev`。前端为 `http://localhost:5173`，后端为 `http://localhost:8787`。也可运行 `npm run build` 后执行 `node apps/backend/src/index.js`，直接打开后端地址使用构建后的页面；重新构建后重启后端。

未配置模型时仍可创建项目、管理材料、编辑文稿和使用本地编译器。AI 操作需要在工作区设置中填写兼容端点、模型和 API key，或设置 `SCIENCEPRISM_LLM_ENDPOINT`、`SCIENCEPRISM_LLM_MODEL`、`SCIENCEPRISM_LLM_API_KEY`。普通启动命令不会自动读取 `.env`；使用环境文件时执行 `node --env-file=.env apps/backend/src/index.js`。备份恢复后重新配置模型凭据。

编译需要已安装的 Tectonic 或相应 TeX 引擎，并在编辑器中选择该引擎。缺少引擎时查看编译日志；已有 PDF 不能证明本次编译成功。PDF 的输入清单对应实际编译版本，协作或本地修改后可能显示“源码已变化”，保存并重新编译即可生成当前版本。

如果需要跨后端重启保留协作邀请，在启动前配置固定的 `SCIENCEPRISM_COLLAB_TOKEN_SECRET`；未配置时邀请只在本次服务进程有效。隧道访问需要项目邀请，包括经过本机代理的访问。先以本地模式和固定密钥创建邀请，再以同一密钥启动隧道并使用邀请进入；普通本地模式仍可管理所有本地项目。

## 备份与恢复

1. 停止正在执行的实验，保存编辑器草稿；备份包含已落盘的项目文件。
2. 在项目列表的更多菜单选择“下载项目备份”，保留下载的 JSON 文件。备份包含研究工作流、审批、Evidence、Run 和已归档产物。
3. 恢复时打开“导入项目”中的“恢复项目备份”，选择该 JSON 文件。
4. 恢复保留项目及 Run 的原 ID；同 ID 已存在时会拒绝覆盖。升级回退应使用新的空数据目录，不能通过改备份 ID 绕过原有来源关系。

备份格式为 `scienceprism-project-backup`，版本 1；每个文件含字节数和 SHA-256，损坏文件会使恢复失败。总文件数据上限为 64 MiB、最多 10,000 个文件；超限项目需另行保留原始数据。备份排除缓存、编译临时目录、依赖、版本库、已知凭据路径和项目配置中的凭据字段。项目中的符号链接会使备份失败，请先处理链接。备份下载和恢复用于本机访问，启用隧道时不可用。

默认数据目录为仓库内的 `data/`。回退示例：

```sh
# 先正常停止原后端，再使用新的目录启动需要恢复的版本。
SCIENCEPRISM_DATA_DIR="$PWD/data-restored" node apps/backend/src/index.js
```

在新实例中恢复备份，检查文稿、工作流、审批、Run 和编译结果后再决定是否切换使用。原目录保留，恢复失败会清理暂存目录，不发布半个项目。不要同时让多个后端写入同一数据目录。

旧 `.openprism/research-workflow.json` 的 schema 1/2 可读取并迁移到 `.scienceprism/` 的当前 schema 3，保留阶段数据和未知字段。未知的新 schema 会明确拒绝读取；升级前备份，失败后恢复到空目录。

## 实验执行与中断

准备复现或实验计划后，先人工批准相应阶段，再创建 Run 并明确批准该 Run。变更命令、数据版本或执行参数需要重新检查及批准，不能沿用旧批准执行新计划。重试产生新 Run，原失败记录保留。

Run 在执行前保存实际 `input.json`、指纹覆盖的代码/数据字节和 `input-snapshot.json`，同时归档环境、清单、日志及可获得产物。输入副本不会随子进程或原项目的后续改动变化。输入快照的总字节预算为 `maxArtifactBytes`；超限或没有指纹的文件会标记 `not-archived`，`complete: false` 表示必须另外保存这些原始文件。输出使用 `results/` 等路径，不能覆盖保留的输入和日志位置。

正常 SIGTERM/SIGINT 退出会停止活动实验并等待日志归档；重启后显示可重试的 `EXPERIMENT_INTERRUPTED`，并要求新 Run 再次批准。恢复读取也会把无活动执行器的残留 `running` 标为中断。强制杀死服务或断电可能丢失尚未归档的输出，不等同正常退出；这时先确认旧进程已停止，再重启及重试。

运行完成后，指标和产物仍是待人工核验的 Evidence。失败、取消、中断及部分产物不能支持成功结论；Writing Brief 保留 Run 来源和这些限制。

## English summary

Use Node.js 26, `npm ci`, then `npm run dev`. For the built UI, run `npm run build` and `node apps/backend/src/index.js`; restart the backend after rebuilding. Model configuration is optional for project management and editing. Plain startup does not load `.env`; use `node --env-file=.env apps/backend/src/index.js` when needed. Compilation requires the selected local TeX engine.

Download a backup from a project's menu after saving files and stopping active experiments. Restore it through **Import project → Restore project backup**. Restore preserves lineage IDs and refuses to overwrite an existing project. For rollback, start the intended application version with a new empty `SCIENCEPRISM_DATA_DIR`, restore there, and retain the original directory. Do not run multiple backend writers against the same data directory. Backups verify file hashes, exclude known credentials and caches, and are limited to 64 MiB of file data and 10,000 files; symlinks are rejected. Reconfigure model credentials after restoring. Backup operations are local-only and unavailable in tunnel mode.

Legacy workflow schemas 1/2 migrate to schema 3 without discarding stage data. Unsupported schemas fail explicitly. Run retries retain the original record and require approval again. Execution inputs and fingerprinted source bytes are archived before launch; `input-snapshot.json` identifies files omitted by the archive budget. Normal shutdown stops active experiments and archives logs; abrupt termination can lose unarchived output. Completed Runs remain pending scientific verification, and Writing Briefs retain their evidence limits.
