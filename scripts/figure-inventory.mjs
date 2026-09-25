/**
 * The inventory of figures that are derived from experiment data.
 *
 * Shared by the figure gates (which regenerate them) and the paper structure
 * check (which requires a results paper to carry one), so the two cannot drift
 * into disagreeing about which figures are data-derived.
 */
export const EXPERIMENT_FIGURES = [
  {
    id: 'cot-results',
    script: 'build-cot-figure.mjs',
    dataFiles: [
      'experiment-cot-gsm8k.json',
      'experiment-cot-gsm8k-analysis.json',
      'experiment-cot-gsm8k-artifacts.json'
    ]
  },
  {
    id: 'experiment-results',
    script: 'build-experiment-figure.mjs',
    dataFiles: ['experiment-evidence-gate.json']
  }
];

export const DATA_DERIVED_FIGURE_IDS = EXPERIMENT_FIGURES.map((figure) => figure.id);

/** System figures are hand-authored and describe the pipeline, not a result. */
export const SYSTEM_FIGURE_IDS = ['sequence-flow', 'module-graph'];

export function isDataDerivedFigure(id) {
  return DATA_DERIVED_FIGURE_IDS.includes(id);
}

export function isKnownFigure(id) {
  return DATA_DERIVED_FIGURE_IDS.includes(id) || SYSTEM_FIGURE_IDS.includes(id);
}
