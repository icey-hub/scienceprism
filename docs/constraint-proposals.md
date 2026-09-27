# Chat-origin project constraints

In the editor's **Chat** panel, describe a durable project rule, for example: “以后不要在回复里使用 fabricated” or “不要修改 main.tex”. The chat response may include a constraint proposal. SciencePrism saves it as **pending** and shows the originating message, model, generated JavaScript, and regression-test draft in the same panel.

Review the proposal before choosing **确认并启用** or **拒绝**. If the model misunderstood the rule, use **修改提案** to correct the type, literal value, or statement while it is pending. The code and test draft are regenerated from those fields, and the change is audited. Nothing is enforced while it is pending. An accepted constraint can later be disabled and enabled again; each decision is recorded in the project audit trail. The generated `constraint.mjs` and `constraint.test.mjs` files are written under the project's `.scienceprism/approved-constraints/<proposal-id>/` directory only after acceptance. At enforcement time SciencePrism verifies that the source still matches its reviewed, deterministic template. It rejects a missing or modified file instead of executing arbitrary model-supplied JavaScript.

This first version supports three precise rule types:

| Rule | Enforcement point |
| --- | --- |
| `reply.forbid_text` | Blocks an editor Chat or Agent response containing the literal phrase, ignoring case. |
| `patch.forbid_path` | Blocks application of an accepted Harness Patch to the specified project-relative path or its descendants. All selected Patch paths are checked before writing any file. |
| `patch.forbid_text` | Blocks application of a non-deletion Harness Patch whose proposed file content contains the literal phrase, ignoring case. |

The model may suggest a rule, but it cannot activate one. Unsupported requests do not turn into prompt-only “constraints”; the UI reports that no enforceable proposal was created. These rules are project-local and separate from the built-in core constraint registry. They do not semantically verify claims, regulate every editor file write, or change the research Evidence Ledger.

API: `GET /api/projects/:id/constraint-proposals` lists proposals. `PATCH /api/projects/:id/constraint-proposals/:proposalId` revises a pending proposal with `kind`, `value`, `statement`, and a human actor. `POST /api/projects/:id/constraint-proposals/:proposalId/decision` takes `decision: accept | reject | enable | disable` and an identified human actor. The editor Chat path creates proposals when its structured model reply contains a supported `constraintProposal` object; arbitrary JavaScript from the model is never accepted.
