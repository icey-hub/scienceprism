# 有证据与无证据时，写作门禁如何改变结构化输出：一次32次生成试点

<!-- scienceprism-writing-brief: generatedAt=2026-09-25T15:26:43.732Z -->

## Outline
- 摘要：本文报告一次小规模工程试点，考察在结构化写作阶段加入证据门禁后，模型输出的结构化程度、被接受比例与引用有效性如何变化。试点在同一研究问题、同一模型（global:deepseek-v4.1-flash）上比较四臂各 8 次生成：A 为 no-gate（移除提示规则、事后测量），B 为 prompt-only（有规则但不拦截），C 为 enforced（有规则、校验、最多一次修复），D 为 enforced-no-evidence（不给 Evidence 上下文）。A/B/C 三臂有效 JSON 与接受率均为 8/8、覆盖率 1.00、未知 id 为 0；模型自报 unsupportedClaims 平均为 0.38/2.50/2.25，B-A=+2.12（约 6.6 倍），C-B=-0.25。D 臂有效 JSON 5/8、接受 1/8，6 个引用全部不在 Ledger 中；唯一被接受的 rep5 引用了不存在的“none”，但因该 claim 被显式登记为 unsupported 而按披露路径放行。上述数字均来自尚未独立核验的实验记录，且自报字段没有人工真值；本文结论只限于本次工具行为。
- 背景：研究问题是如何让检索增强生成把每条生成的主张追溯到可核验来源。本项目已有的写作门禁由两个代码机制组成：validateStageEvidence 会把 Paper Claim 的 Evidence id 解析到项目 Ledger，通常拒绝缺失或未核验的证据，但允许已在 unsupportedClaims 中显式披露的写作 claim 继续流转；runResearchHarnessStage 在解析或 Evidence 校验失败时，对已成功传输的响应重试一次，并把校验错误与不得虚构 id 的指令传给修复尝试。本试点要问的是：把这两类机制组合进写作阶段后，结构化输出的有效性与引用行为会怎样改变，以及在没有 Evidence 上下文时会发生什么。
- 实验设计：四臂消融，每臂 8 次生成，同一研究问题，模型固定为 global:deepseek-v4.1-flash。A 为 no-gate：移除提示中的证据规则，只在事后测量；B 为 prompt-only：提示中包含规则但不做拦截；C 为 enforced：提示含规则、进行校验，并最多触发一次修复；D 为 enforced-no-evidence：保留 enforced 机制但不向模型提供 Evidence 上下文。共 32 次初始生成，D 臂另发生 7 次修复，总 attempts 为 39。观测指标为：有效 JSON 次数、被接受次数、claim-evidence 覆盖率、未知引用 id 数、模型自报 unsupportedClaims 数。需要强调，本试点没有独立重复与随机种子设计，分析单位是单次生成，比较只描述本次工具运行。
- 结果：A/B/C 三臂的有效 JSON 均为 8/8，接受率均为 8/8，覆盖率均为 1.00，未知 id 均为 0。模型自报 unsupportedClaims 平均每次为 0.38（A）、2.50（B）、2.25（C）；B 相对 A 上升 +2.12（约 6.6 倍），C 相对 B 下降 -0.25。这些自报字段反映模型在文本中声明的未支持主张数量，不是人工核验后的真值，不能解读为真实 unsupported assertions 的减少或增加。D 臂有效 JSON 为 5/8，接受率为 1/8，6 个引用全部在 Ledger 中不存在。唯一被接受的 D 输出 rep5 引用了不存在的“none”，但由于对应 claim 被显式登记为 unsupported，代码按披露路径允许其继续流转；D 臂 7 次重试后没有任何失败结果转为接受，rep5 是首轮通过。D 臂覆盖率 1.00 只表示输出里出现了 ID，不代表 ID 有效。
- 讨论：两个代码机制解释了观察到的行为。其一，校验器对缺失或未核验证据通常拒绝，但对显式披露的不支持 claim 放行，因此门禁不是零容忍的伪引用拦截；D 臂 rep5 的放行正是这一披露路径的体现，而不是对不存在 id 的通过。其二，修复重试只对已成功传输的响应生效，它携带校验错误与不得虚构 id 的指令，但无法给模型提供可引用的证据，因此对无证据可引用的 D 臂没有产生任何把失败转为接受的效果。A/B/C 三臂的高覆盖率与零未知 id 说明在证据上下文存在时，本次运行没有观察到引用成本；但这不等于真实世界的引用正确性，因为这里的覆盖率只检查 ID 是否出现，接受也只检查门禁是否放行。
- 局限：每臂仅 8 次生成、只有一个研究问题、只有一个模型，样本量与场景覆盖面都极小；原始回复未留存，无法做二次判读或独立复评；自报字段没有人工真值，unsupportedClaims 的均值不能当作真实未支持主张率；A-C 上下文中提供的 3 个已确认 paper id 与研究问题相关性有限，可能影响模型引用行为；结果仅反映本次工具行为，不可推广到其他模型、任务或门禁实现；据此不能声称真实 unsupported assertions 减少，也不能声称门禁可阻止伪造引用。
- 结论：在本次 32 次初始生成、D 臂 7 次修复的试点中，证据门禁在证据上下文存在时保持了 8/8 的有效 JSON、8/8 的接受率与 1.00 的覆盖率，并伴随模型自报未支持主张的增加；在无 Evidence 上下文时，接受率降至 1/8，全部引用均不在 Ledger 中，且唯一被接受项是经显式披露后放行的。该门禁的设计目标是披露与拦截并行，而不是零容忍伪引用拦截；上述全部实验数字仍待独立核验。
- 复现信息：运行命令为 node scripts/experiment-evidence-gate.mjs 8；数据文件为 aidoc/experiment-evidence-gate.json。本写作简报未执行该命令，也未读取该数据文件，所有实验数值均转述自尚未独立核验的实验记录。

## Claims And Evidence
- 代码门禁由两个已静态核验的机制构成：validateStageEvidence 会把每条 Paper Claim 的 Evidence id 解析到项目 Ledger，通常拒绝缺失或未核验的证据，但对已在 unsupportedClaims 中显式披露的写作 claim 予以放行；runResearchHarnessStage 在解析或 Evidence 校验失败时，对已成功传输的响应重试一次，并把校验错误与不得虚构 id 的指令传给修复尝试。
  - Claim ID: `claim-gate-code-design`
  - Evidence IDs: `code-writing-evidence-validator`, `code-writing-repair-retry`
  - Confidence: 0.8
- 本次试点为四臂消融，每臂 8 次生成、同一研究问题、模型为 global:deepseek-v4.1-flash：A 为 no-gate（移除提示规则、事后测量），B 为 prompt-only（有规则但不拦截），C 为 enforced（有规则、校验、最多一次修复），D 为 enforced-no-evidence（不给 Evidence 上下文）。该实验记录尚未独立核验。
  - Claim ID: `claim-pilot-arm-design`
  - Evidence IDs: `evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50`
  - Confidence: 0.3
- 试点共产生 32 次初始生成，D 臂另发生 7 次修复，总 attempts 为 39。该实验记录尚未独立核验。
  - Claim ID: `claim-pilot-attempts`
  - Evidence IDs: `evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50`
  - Confidence: 0.3
- 在 A/B/C 三臂中，有效 JSON 均为 8/8，接受率均为 8/8，claim-evidence 覆盖率均为 1.00，未知 id 均为 0。该实验记录尚未独立核验。
  - Claim ID: `claim-abc-validity`
  - Evidence IDs: `evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50`
  - Confidence: 0.3
- A/B/C 三臂自报 unsupportedClaims 平均每次为 0.38 / 2.50 / 2.25，B-A=+2.12（约 6.6 倍），C-B=-0.25；这些数字是模型自报字段，而非人工核验的真值。该实验记录尚未独立核验。
  - Claim ID: `claim-selfreport-delta`
  - Evidence IDs: `evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50`
  - Confidence: 0.3
- D 臂有效 JSON 为 5/8，接受率为 1/8，其 6 个引用全部在 Ledger 中不存在。该实验记录尚未独立核验。
  - Claim ID: `claim-d-validity`
  - Evidence IDs: `evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50`
  - Confidence: 0.3
- D 臂 rep5 是唯一被接受的输出，它引用了不存在的“none”，但因该 claim 被显式登记为 unsupported，代码按披露路径允许其继续流转。该实验记录尚未独立核验。
  - Claim ID: `claim-d-rep5-disclosure`
  - Evidence IDs: `evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50`, `code-writing-evidence-validator`
  - Confidence: 0.35
- 因此该门禁不是零容忍的伪引用拦截：它允许被显式披露的不支持主张继续流转；这是对本次代码行为的描述，不是对真实伪引用率的估计。该实验记录尚未独立核验。
  - Claim ID: `claim-not-zero-tolerance`
  - Evidence IDs: `code-writing-evidence-validator`, `evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50`
  - Confidence: 0.35
- D 臂 7 次重试后没有任何失败结果转为接受，rep5 是首轮通过；这与修复重试对无证据可引用的模型没有修复能力的机制描述方向一致，但该实验记录尚未独立核验。
  - Claim ID: `claim-retry-no-repair`
  - Evidence IDs: `code-writing-repair-retry`, `evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50`
  - Confidence: 0.35
- D 臂覆盖率 1.00 只表示输出中出现了 ID，不代表 ID 有效；覆盖率与接受率是不同量纲的指标，不能相互替代。该实验记录尚未独立核验。
  - Claim ID: `claim-coverage-caveat`
  - Evidence IDs: `evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50`
  - Confidence: 0.3

## Limitations
- 每臂仅 8 次生成，样本量很小，无法支撑统计推断。
- 只覆盖一个研究问题，无法评估跨问题稳定性。
- 只使用一个模型 global:deepseek-v4.1-flash，不能推广到其他模型。
- 原始回复未留存，无法进行二次判读、错误归类或独立复评。
- unsupportedClaims 为模型自报字段，没有人工真值，不能作为真实未支持主张率。
- A-C 上下文中的 3 个已确认 paper id 与研究问题相关性有限，可能影响引用行为。
- 结果仅反映本次工具行为，不能推广到其他任务、门禁实现或真实 RAG 系统。
- 不能据此声称真实 unsupported assertions 减少，也不能声称门禁可阻止伪造引用。
- 实验记录 evidence-19e177ec-9a6c-4bac-b897-03c7a6f61b50 仍为 pending，本简报中引用它的每条 claim 都只是转述未核验记录。
- 未报告随机种子、置信区间或显著性检验，且这些设计事实在本次试点中并未提供。

## Unverified Claims
- [claim-pilot-arm-design] 实验记录待独立核验
- [claim-pilot-attempts] 实验记录待独立核验
- [claim-abc-validity] 实验记录待独立核验
- [claim-selfreport-delta] 实验记录待独立核验
- [claim-d-validity] 实验记录待独立核验
- [claim-d-rep5-disclosure] 实验记录待独立核验
- [claim-not-zero-tolerance] 实验记录待独立核验
- [claim-retry-no-repair] 实验记录待独立核验
- [claim-coverage-caveat] 实验记录待独立核验
