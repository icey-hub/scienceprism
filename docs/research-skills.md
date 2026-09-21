# Research Skills

SciencePrism bundles six DeepSeek Harness skills under `.dsh/skills`. They are
automatically copied into the isolated Harness workspace for research-stage
runs, so a normal run can discover them through the Harness `skill` tool.

| Skill | Workflow stages | Purpose |
| --- | --- | --- |
| `literature-search` | Direction, Search | Expand the human question into traceable queries and sources. |
| `paper-screening` | Selection | Explain quality evidence without overriding the server quality gate. |
| `paper-card` | Replication, Ideation, Method | Connect paper claims, methods, experiments, and limitations. |
| `dataset-audit` | Experiment, Writing | Check dataset provenance, access, licensing, and reproducibility. |
| `statistics-audit` | Experiment, Writing | Check experimental units, replication, uncertainty, and comparisons. |
| `research-writing` | Writing | Build evidence-bounded claims, outline, citations, and limitations. |

## Adding a project-specific skill

DeepSeek Harness discovers a project skill at:

```text
<project-root>/.dsh/skills/<kebab-case-name>/SKILL.md
```

The file must start with YAML frontmatter containing `name` and `description`.
The name must be kebab-case. A project-local skill with the same name takes
precedence over the bundled copy in the temporary workspace, so it can be
customized without changing SciencePrism.

You can add a project Skill from the first workflow page at
`/editor/:projectId/research/direction`. Select the Skill directory in the
**添加 Skill** control, refresh the catalog if needed, and enable it for one or
more compatible stages. SciencePrism only uploads the selected files under
`.dsh/skills`; it does not execute Skill files during upload.

Skills are instructions, not authority. The research workflow still enforces
server-side paper quality checks, stage ordering, audit logging, and human
approval. A skill cannot approve a paper, select an innovation, authorize a
command, or fabricate an experiment result.

The current bundle intentionally does not include the broader scheduled
literature-pipeline skill: recurring searches, notifications, and archival are
outside the interactive workflow and would require a separate scheduler and
consent model.

The `nature-*` skills installed in Codex are useful source material, but they
are Codex skills with their own routers, scripts, and optional MCP servers. Do
not copy `~/.codex/skills` wholesale into this project. Adapt a needed skill to
the Harness `SKILL.md` format and place it in the project `.dsh/skills` root so
the isolated research run can discover it.
