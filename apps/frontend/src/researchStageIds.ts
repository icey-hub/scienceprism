/**
 * The research stage vocabulary, shared by the API layer and the UI.
 *
 * There are two names for one stage list, and they are deliberately distinct
 * types rather than one list with a comment:
 *
 * - `ResearchStageId` is what the UI navigates by, and it calls stage 5
 *   `innovation`.
 * - `HarnessResearchStageId` is what the workflow service accepts, and it calls
 *   stage 5 `ideation`.
 *
 * These used to be two independent literal lists in two files, both named
 * `ResearchStageId`. They differed, so passing one where the other was expected
 * failed to typecheck with no hint that two vocabularies existed. They now come
 * from here, and the names say which vocabulary they belong to.
 */
export type ResearchStageId =
  | 'direction'
  | 'search'
  | 'selection'
  | 'replication'
  | 'innovation'
  | 'method'
  | 'experiment'
  | 'writing';

/** The workflow service calls the innovation stage `ideation`. */
export type HarnessResearchStageId = Exclude<ResearchStageId, 'innovation'> | 'ideation';
