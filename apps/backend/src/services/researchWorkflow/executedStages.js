/**
 * The workflow stages whose Harness Run actually executes.
 *
 * The interactive workflow and automatic research chain invoke these stages.
 * Direction is supplied by the user. Two modules need this fact — the skill bindings and
 * the research-stage-assistant role's scope — so it lives here rather than in
 * either of them, and a test asserts it still matches the invocations in
 * researchWorkflow/application.js.
 */
export const HARNESS_EXECUTED_STAGES = Object.freeze(['search', 'selection', 'replication', 'ideation', 'method', 'experiment', 'writing']);
