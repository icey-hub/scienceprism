import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { runAgent, type LLMConfig } from '../../api/editorAdapter';
import { serialModelRequest } from './serialModelRequest';
export function usePaperReview({projectId,activePath,compileLog,llmConfig,onReport}:{projectId:string;activePath:string;compileLog:string;llmConfig:Partial<LLMConfig>;onReport:()=>void}){
 const {t}=useTranslation();const alive=useRef(true),running=useRef(false);
 const [reviewBusy,setReviewBusy]=useState(false),[reviewError,setReviewError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const ask=(payload:Parameters<typeof runAgent>[0])=>serialModelRequest(async()=>{if(!alive.current)throw new Error('Session closed');const result=await runAgent(payload);if(!alive.current)throw new Error('Session closed');if(!result.ok)throw new Error(result.reply||'Review failed');return result;});
 const perform=async(work:()=>Promise<void>)=>{if(running.current)return;running.current=true;setReviewBusy(true);setReviewError('');try{await work();}catch(error){if(alive.current)setReviewError(String(error));}finally{running.current=false;if(alive.current)setReviewBusy(false);}};
  const [reviewNotes, setReviewNotes] = useState<{ title: string; content: string }[]>([]);
  const [reviewReport, setReviewReport] = useState('');
  const [reviewReportBusy, setReviewReportBusy] = useState(false);
 const peerReview=()=>perform(async()=>{
                          if (reviewReportBusy) return;
                          setReviewReportBusy(true);
                          setReviewReport(t('生成中...'));
                          onReport();
                          try {
                            const res = await ask({
                              task: 'peer_review',
                              role: 'paper-reviewer',
                              prompt: t('Read all .tex files in the project (start from the main file and any included sections). Use list_files and read_file tools to inspect content. Write a detailed reviewer-style report. Include: Summary, Strengths, Weaknesses, Questions, Missing Experiments, Writing/Clarity, Suggestions, Score (1-10), and Confidence. Output report text only; do not propose patches or code.'),
                              selection: '',
                              content: '',
                              mode: 'tools',
                              projectId,
                              activePath,
                              compileLog,
                              llmConfig,
                              interaction: 'agent',
                              history: []
                            });
                            setReviewReport(res.reply || t('无结果'));
                          } catch (err) {
                            setReviewReport(t('生成失败: {{error}}', { error: String(err) }));
                          } finally {
                            setReviewReportBusy(false);
                          }

 });
 const consistencyReview=()=>perform(async()=>{
                          const res = await ask({
                            task: 'consistency_check',
                            role: 'paper-reviewer',
                            prompt: `Read all .tex files in the project using list_files and read_file tools. Perform a thorough consistency check across the entire paper. Check the following dimensions:

1. **Terminology consistency**: Identify terms that refer to the same concept but use different wording (e.g., "feature extraction" vs "feature engineering", "model" vs "network" vs "architecture" used interchangeably).

2. **Notation consistency**: Check if mathematical symbols and notation are used consistently (e.g., bold for vectors vs non-bold, x vs X for the same variable, inconsistent subscript/superscript conventions).

3. **Data and results consistency**: Verify that numbers, statistics, and experimental results mentioned in the abstract, introduction, method, and conclusion sections are consistent with those in tables and figures.

4. **Logic and claim consistency**: Check if claims made in the introduction/conclusion are actually supported by the experiments. Flag contradictions between sections.

5. **Reference consistency**: Check for undefined abbreviations, references to figures/tables/sections that don't exist, or mislabeled cross-references.

6. **Tense and style consistency**: Flag inconsistent use of tense (e.g., mixing past and present when describing experiments) or perspective (e.g., "we" vs "the authors" vs passive voice).

For each issue found, report in this format:

---
**[Category]** Terminology / Notation / Data / Logic / Reference / Style
**[Location]** file and approximate line or section
**[Issue]** Describe the inconsistency
**[Suggestion]** How to fix it
---

Here are examples of good findings:

Example 1:
**[Terminology]**
**[Location]** sections/method.tex, Section 3.1 vs sections/experiments.tex, Section 4
**[Issue]** The method section calls the module "Spatial Attention Block" but the experiments section refers to it as "Spatial Attention Module".
**[Suggestion]** Unify to one term throughout the paper, e.g., "Spatial Attention Module".

Example 2:
**[Data]**
**[Location]** sections/abstract.tex vs sections/experiments.tex, Table 2
**[Issue]** The abstract claims "93.2% accuracy on CIFAR-10" but Table 2 reports 92.8%.
**[Suggestion]** Update the abstract to match the actual result in Table 2.

Example 3:
**[Logic]**
**[Location]** sections/introduction.tex, paragraph 3 vs sections/conclusion.tex, paragraph 1
**[Issue]** The introduction states the method "does not require pre-training" but the conclusion mentions "after pre-training on ImageNet".
**[Suggestion]** Clarify whether pre-training is used and make both sections consistent.

Example 4:
**[Notation]**
**[Location]** sections/method.tex, Eq. (3) vs Eq. (7)
**[Issue]** Eq. (3) uses bold lowercase h for hidden states, but Eq. (7) uses non-bold italic h for the same variable.
**[Suggestion]** Use bold h consistently for hidden state vectors.

Be thorough. Read ALL .tex files before reporting. Group findings by category. If no issues are found in a category, state that explicitly.`,
                            selection: '',
                            content: '',
                            mode: 'tools',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: t('一致性检查'), content: res.reply || t('无结果') }, ...prev]);

 });
 const citationReview=()=>perform(async()=>{
                          const res = await ask({
                            task: 'missing_citations',
                            role: 'paper-reviewer',
                            prompt: t('Find claims that likely need citations and list them.'),
                            selection: '',
                            content: '',
                            mode: 'tools',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: t('引用缺失'), content: res.reply || t('无结果') }, ...prev]);

 });
 const compileReview=()=>perform(async()=>{
                          const res = await ask({
                            task: 'compile_summary',
                            prompt: t('Summarize compile log errors and suggested fixes.'),
                            selection: compileLog,
                            content: '',
                            mode: 'direct',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: t('编译日志总结'), content: res.reply || t('无结果') }, ...prev]);

 });
 return {reviewNotes,reviewReport,reviewReportBusy,reviewBusy,reviewError,peerReview,consistencyReview,citationReview,compileReview};
}
