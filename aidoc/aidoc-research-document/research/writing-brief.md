# Prompting Condition Barely Changes Outcomes for a Reasoning Model: Direct, Chain-of-Thought, and Explicit-Format Prompting on 200 GSM8K Test Questions

<!-- scienceprism-writing-brief: generatedAt=2026-09-25T07:41:57.970Z -->

## Outline
- Abstract: state that the study compares direct, chain-of-thought, and explicit-answer-format prompting on a reasoning model over 200 GSM8K test questions at temperature 0 (600 generations), and flag that every empirical number currently rests on an experiment record that is not yet confirmed in this project.
- Introduction: frame the question of whether prompting condition changes outcomes for a model that already reasons in a hidden channel; cite the chain-of-thought, zero-shot reasoner, self-consistency, GSM8K, and reasoning-model papers as the background this result speaks to.
- Related work: chain-of-thought prompting (Wei et al.), zero-shot reasoning (Kojima et al.), self-consistency decoding (Wang et al.), GSM8K (Cobbe et al.), and reasoning models (DeepSeek-R1).
- Method: three conditions (direct, chain-of-thought, explicit #### answer format) on the GSM8K test split, temperature 0, one generation per item, exact-match grading plus a numeric-equivalence check.
- Results (pending verification): declared accuracy 0.955 direct, 0.955 chain-of-thought, 0.945 explicit format; per-item pairing 190 both-correct, 1 direct-only, 1 chain-of-thought-only, 8 neither, 4 changed; hidden-trace versus visible-answer disagreement 25 versus 1; grading under-count of 1.0 percentage point from 6 textually different but numerically equal responses and 2 parse failures.
- Analysis: prompting condition barely changes the outcome; item difficulty and the grading rule dominate measured error rather than the prompt.
- Limitations and threats to validity: one model, one dataset, one temperature, one generation per item; no population estimate; the supporting experiment record is unconfirmed.
- Data and code availability: the experiment command and dataset are stated in the approved plan but no dataset, code, or run artifacts were supplied to this brief.

## Claims And Evidence
- Cobbe et al. introduce GSM8K as a dataset of 8.5K grade-school math word problems on which even the largest transformer models fail to reach high test performance. An experiment record not yet confirmed in this project reports running 200 GSM8K test questions under three prompting conditions at temperature 0, with 600 generations in total; that configuration is unverified here.
  - Claim ID: `claim-study-design`
  - Evidence IDs: `paper-cobbe-2021-gsm8k`
  - Confidence: 0.3
- Wei et al. report that generating a chain of intermediate reasoning steps substantially improves complex reasoning. The unverified experiment record reports declared accuracy of 0.955 for direct, 0.955 for chain-of-thought, and 0.945 for an explicit answer format, which would mean no measurable chain-of-thought gain and a 0.010 cost from the format requirement; those numbers are not confirmed.
  - Claim ID: `claim-accuracy-null`
  - Evidence IDs: `paper-wei-2022-cot`, `paper-deepseek-2025-r1`
  - Confidence: 0.3
- The unverified experiment record reports per-item pairing on the same 200 questions: 190 were answered correctly by both direct and chain-of-thought, 1 by direct alone, 1 by chain-of-thought alone, 8 by neither, and only 4 questions changed outcome across conditions at all. This item-level pairing is not confirmed.
  - Claim ID: `claim-pairing`
  - Evidence IDs: `paper-cobbe-2021-gsm8k`, `paper-wei-2022-cot`
  - Confidence: 0.25
- DeepSeek-R1 is trained to produce long reasoning traces through reinforcement learning, so reasoning already occurs in a hidden channel. The unverified experiment record reports that the hidden reasoning trace was a worse answer source than the visible answer: 25 generations had a correct answer but a wrong last number in the reasoning, against 1 in the other direction.
  - Claim ID: `claim-trace`
  - Evidence IDs: `paper-deepseek-2025-r1`
  - Confidence: 0.3
- GSM8K was introduced by Cobbe et al. as a dataset of 8.5K grade-school math word problems. The unverified experiment record reports that exact-match grading under-counted accuracy by 1.0 percentage points because 6 responses were numerically equal but textually different (for example 12 against 12.00) and 2 failed to parse.
  - Claim ID: `claim-grading`
  - Evidence IDs: `paper-cobbe-2021-gsm8k`
  - Confidence: 0.25
- Read against the background that chain-of-thought prompting helps conventional LLMs (Wei et al.) while a reasoning model such as DeepSeek-R1 already reasons in a hidden channel, the unverified experiment record suggests that for a reasoning model the prompting condition barely changes the outcome and that the dominant measured error sources are item difficulty and the grading rule rather than the prompt. This conclusion is an interpretation of an unverified record, not a confirmed result.
  - Claim ID: `claim-conclusion`
  - Evidence IDs: `paper-deepseek-2025-r1`, `paper-wei-2022-cot`
  - Confidence: 0.25
- A plausible mechanism, not demonstrated in this project, is that because a reasoning model is trained to produce hidden reasoning traces, an explicit chain-of-thought instruction adds little. Kojima et al. show a single zero-shot trigger phrase elicits reasoning without exemplars, and Wang et al. propose self-consistency decoding as a strategy that improves reasoning accuracy, making it a candidate next lever; neither the mechanism nor the prompting result is confirmed here.
  - Claim ID: `claim-mechanism`
  - Evidence IDs: `paper-deepseek-2025-r1`, `paper-kojima-2022-zero-shot`, `paper-wang-2022-self-consistency`
  - Confidence: 0.2
- Kojima et al. show that a single zero-shot trigger phrase elicits chain-of-thought reasoning without exemplars, which motivates varying only the instruction rather than adding demonstrations.
  - Claim ID: `claim-zeroshot-background`
  - Evidence IDs: `paper-kojima-2022-zero-shot`
  - Confidence: 0.8
- Wang et al. propose self-consistency as a decoding strategy that replaces greedy decoding in chain-of-thought prompting and improves reasoning accuracy, making it a candidate next lever if prompt-level changes prove inert.
  - Claim ID: `claim-selfconsistency-background`
  - Evidence IDs: `paper-wang-2022-self-consistency`
  - Confidence: 0.8

## Limitations
- One model (global:deepseek-v4.1-flash), one dataset (GSM8K test split), one temperature (0), and one generation per item, so the results characterise that configuration and do not estimate a population.
- Every empirical number depends on an experiment record (evidence-cot-gsm8k-experiment) that is not present as confirmed Evidence in this project's evidence graph; those numbers remain unverified pending human confirmation.
- No confidence intervals, repeated sampling, or per-item difficulty model are available, so no uncertainty estimate accompanies the reported accuracy figures.
- Exact-match and numeric-equivalence grading were applied post hoc, and the 2 parse failures are not broken down by condition.
- The background papers address conventional prompting, datasets, and reasoning models, not retrieval-augmented-generation provenance, so they can frame but cannot confirm any claim about claim-to-source traceability.
- The study design, the direction, and the conclusion are the human's approved framing; the assistant has not independently verified the run or the experiment command.
- No dataset, code, or run artifacts were supplied with the stage input, so data and code availability cannot be asserted.

## Unverified Claims
- claim-study-design: the 200-question, three-condition, temperature-0, 600-generation configuration comes from an experiment record (evidence-cot-gsm8k-experiment) that is not present as confirmed Evidence in this project's evidence graph; the configuration is unverified.
- claim-accuracy-null: the declared accuracies 0.955 direct, 0.955 chain-of-thought, and 0.945 explicit format, the reading of no measurable chain-of-thought gain, and the 0.010 format cost are unverified; their experiment-run Evidence entry is not in the confirmed evidence graph.
- claim-pairing: the per-item pairing of 190 both-correct, 1 direct-only, 1 chain-of-thought-only, 8 neither, and 4 changed questions is unverified.
- claim-trace: the 25 generations with a correct answer but a wrong last reasoning number against 1 in the other direction are unverified.
- claim-grading: the 1.0 percentage-point exact-match under-count, the 6 numerically equal but textually different responses (for example 12 against 12.00), and the 2 parse failures are unverified.
- claim-conclusion: the conclusion that prompting barely changes the outcome and that item difficulty and the grading rule dominate measured error is an interpretation of an unverified record, not a confirmed result.
- claim-mechanism: the proposed hidden-channel explanation for why explicit chain-of-thought adds little is a hypothesis, not a demonstrated result.
- Unstated metadata: venue, venueLevel, peerReviewed, citationCount, hasCode, and doi are null for the three stage-input papers, and no project evidence entry confirms them.
