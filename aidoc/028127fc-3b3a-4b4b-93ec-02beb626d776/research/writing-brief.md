# 属性图节点异常检测的效能与局部解释忠实度：基于GADBench Reddit的两层GCN探索性研究

<!-- scienceprism-writing-brief: generatedAt=2026-09-26T10:47:22.258Z -->

## Outline
- 引言：提出通用属性图节点异常检测中的检测效能与局部预测忠实度问题，并区分检测标签、模型忠实度和解释真值。
- 相关工作：介绍GADBench关于GNN与非GNN基线比较的背景，以及GNNExplainer的局部子图解释方法。
- 研究问题与假设：比较两层GCN与仅节点特征逻辑回归的AUPRC和AUROC，并比较解释边与等量随机边的删边扰动效应；不预设方向。
- 数据与可复现性：报告GADBench Reddit数据、官方划分、文件哈希、标签和图变换；尚未确认的来源、许可、语义和元数据必须显式标为未验证。
- 检测方法：描述训练集标准化、两层GCN、类别加权、验证集AUPRC早停及逻辑回归基线。
- 局部解释方法：描述trial 0分层测试节点样本、GNNExplainer风格边掩码、固定top-k预算和随机删边对照。
- 结果：分别报告三个相关划分的AUPRC和AUROC，并单独报告解释样本数、跳过节点、删边效应及不确定性；在实验运行确认前使用“指标产物记录”而非“模型显著优于”。
- 统计与稳健性：不将三个划分视为独立数据集；报告逐节点配对比较、随机删边分布、解释优化成功率和归一化策略敏感性。
- 讨论：说明扰动忠实度只反映解释与模型预测的关系，不能替代边级或子图级解释真值；讨论离分布扰动、固定度归一化和解释随机性。
- 结论：将结论限定为单图、单一GCN架构和有限解释样本的探索性观察，不向通用属性图或其他GNN架构外推。

## Claims And Evidence
- GADBench针对静态图监督式异常节点检测比较了10个真实数据集上的29种模型，并报告采用简单邻域聚合的树集成模型可以优于面向图异常检测设计的近期GNN；因此，本研究不预设两层GCN必然优于非GNN基线。
  - Claim ID: `claim.gadbench-context`
  - Evidence IDs: `paper-93a5912257e52e4b7e27`
  - Confidence: 0.96
- GNNExplainer是一种面向GNN预测的通用模型无关解释方法，旨在识别对单个预测重要的紧凑子图和节点特征，并将解释学习表述为最大化预测与候选子图结构分布之间互信息的优化问题。
  - Claim ID: `claim.gnnexplainer-method`
  - Evidence IDs: `paper-e354e924c2fcf2b75f3d`
  - Confidence: 0.96
- 已有文献支持将检测性能比较与局部预测解释评价设置为两个并列研究问题，但不支持预先断言GCN在检测效能或解释忠实度上优于基线。
  - Claim ID: `claim.study-rationale`
  - Evidence IDs: `paper-93a5912257e52e4b7e27`, `paper-e354e924c2fcf2b75f3d`
  - Confidence: 0.9
- 已验证的指标产物记录了三个划分上的均值：GCN的AUPRC为0.0620，特征逻辑回归的AUPRC为0.0605；GCN的AUROC为0.6695，特征逻辑回归的AUROC为0.6594。由于实验运行证据本身仍为pending，这些数值应作为已记录结果而非最终确认的模型优胜结论。
  - Claim ID: `claim.recorded-detection-metrics`
  - Evidence IDs: `experiment-artifact-experiment-run-bca97a65-c447-4e18-87d0-e267623c78ec-4985edf3febdd92d`
  - Confidence: 0.65
- 已验证的指标产物记录了9个被解释节点，以及平均0.4585的解释删边后预测类logit下降，标准差为0.6891；该记录不能单独证明解释边具有更高忠实度，也不能证明其对应真实异常机制。
  - Claim ID: `claim.recorded-explanation-metric`
  - Evidence IDs: `experiment-artifact-experiment-run-bca97a65-c447-4e18-87d0-e267623c78ec-4985edf3febdd92d`
  - Confidence: 0.6

## Limitations
- 当前证据账本中的实验运行记录仍为pending；指标表和输出文件虽已标记为verified，但最终实验结论仍需人工确认。
- 研究仅使用一张GADBench Reddit图、一个两层GCN架构和一个特征逻辑回归基线，不能支持对通用属性图的普遍化结论。
- 三个官方划分来自同一张图，不能视为三个独立数据集；跨划分均值和标准差不等同于独立重复实验。
- 解释实验仅覆盖少量trial 0测试节点，解释优化的随机性、样本量和代表性有限。
- 不存在已确认的边级或子图级解释真值；删边扰动只能衡量解释对模型预测的影响，不能证明解释符合真实异常机制。
- 删边可能造成离分布输入；固定原图度归一化与删边后重新归一化会产生不同的忠实度定义。
- GADBench Reddit数据的许可、原始来源、节点和边语义、标签生成过程、特征处理和官方划分定义尚未由独立数据证据确认。
- 实验脚本中的有向边二值化、对称化、自环添加和局部两跳截取可能改变原始图语义，需在正文中披露。
- GNNExplainer相关解释指标未与低权重边、度匹配边或双向恢复曲线进行完整验证，因此不能据此形成全面忠实度结论。

## Unverified Claims
- claim.recorded-detection-metrics：指标数值来自已验证指标产物，但对应实验运行仍为pending，因此GCN相对逻辑回归的差异尚不能作为最终确认的模型优胜结论。
- claim.recorded-explanation-metric：解释删边logit下降及其标准差已记录，但缺少充分的配对统计、对照结果和稳定性证据，不能确认解释边比随机边更忠实。
