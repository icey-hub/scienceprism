/**
 * The workflow stages whose Harness Run actually executes.
 *
 * Only four contract stages are ever invoked (search_strategy,
 * innovation_ideas, method_proposals, writing_brief), which normalise to these
 * workflow stages. Two modules need this fact — the research skill bindings and
 * the research-stage-assistant role's scope — so it lives here rather than in
 * either of them, and a test asserts it still matches the invocations in
 * researchWorkflow/application.js.
 */
export const HARNESS_EXECUTED_STAGES = Object.freeze(['search', 'ideation', 'method', 'writing']);
