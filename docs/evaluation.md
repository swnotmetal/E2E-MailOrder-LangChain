# 评估与验收

## LangSmith 多语言回归集（2026-09-24）

`fixtures/evaluation/multilingual-inquiries.json` 保存用户此前提供并在 2026-09-24 明确要求组成数据集的四封虚构邮件：英语、德语、爱沙尼亚语和芬兰语。reference outputs 只覆盖可由原文人工核对的语言、意图、公司、发件人、日期、商品描述和数量；不包含 ERP 匹配、价格、库存或回复文案。原文与 reference outputs 一同提交，metadata 明确记录 `humanVerified`、核验来源与日期。

运行方式：

```powershell
npm run eval:langsmith -- seed
npm run eval:langsmith -- demo
npm run eval:langsmith -- compare <baseline-experiment> <candidate-experiment>
```

`seed` 幂等创建或更新 LangSmith dataset。`demo` 先把 2026-09-23 已观察到的历史结果作为无模型 baseline，再让当前 `geminiMailExtractor` 对每个样例调用一次固定的 `gemini-2.5-flash-lite`。没有并发、自动重试或 provider fallback。它运行七个确定性字段 evaluator、一个严格 `regression_pass`，以及 dataset-level pass-rate summary evaluator；最后建立 pairwise version comparison。所有输入都是虚构数据，整个评测不初始化 ERP、更不写 ERP。

历史 baseline 不是重新模拟旧代码：英语、德语和爱沙尼亚语的 `MODEL_QUOTE_NOT_UNIQUE`，以及芬兰语的已保存结构化结果，均来自用户实际观察或保存的旧 trace。它用于展示版本差异，不用于证明生产准确率。当前四例同样只是小型人工回归集，不是统计显著的盲测。

首轮真实实验发现：旧版英/德/爱三例为 0/8 evaluator keys；当前版三例均为 6/8，已消除 quote 错误并正确保留语言、身份、日期、行项目和 grounded evidence，但意图仍输出 `conditional`，不同于人工 `inquiry` 标签。芬兰语历史为 6/8，当前为 5/8：当前模型除意图外还漏掉正文中第二种公司写法。严格 dataset pass rate 因此仍为 0；这是真实回归信号，不应通过改 gold 隐藏。

LangSmith 官方将这种离线 dataset + evaluator + experiment comparison 定义为 regression testing；比较视图用于查看相对 baseline 的改善与退化：https://docs.langchain.com/langsmith/evaluation-types 。

### 未标注候选邮件

新邮件不直接进入上述 gold dataset。`fixtures/evaluation/english-candidates.json` 只保存用户提供的虚构原文，并固定为 `humanVerified: false`。运行 `npm run eval:langsmith -- candidates` 会建立独立 input-only dataset、每封调用一次固定模型，并生成 `data/english-candidate-review.json`。该文件中的 `proposedExpected` 来自模型，包含 language、intent、customer、sender、location、PO、date、address，以及商品 description / quantity / unit；它不是 reference output，必须由人逐项核对后才能晋升。

候选实验只有不依赖 gold 的结构 evaluator：调用完成、evidence grounding、语言字段存在、至少一个商品行。全部为 1 只证明数据管道和结构有效，不证明语义正确。实际人工检查仍要发现诸如公司漏提、混合语言误判、不同业务日期混在同一字段等问题。

开发集在 fixtures/，10 对邮件/PDF，开发期预期在 design.md。预期由实现者草拟，尚未由用户核验，不是独立准确率证据。

最终盲测：用户提供新邮件/PDF（不进入开发调试集），复制 gold-template.json 并填写每个 case 的 id、email、pdf、fields、issueCodes。
fields 使用 draft 路径，例如 customer、po、date、address、lines.0.item、lines.0.quantity。值全部为字符串；客户、地址、商品使用实际 ERP ID。
issueCodes 使用 MISSING、INVALID_DATE、UNRESOLVED_ITEM、INVALID_QUANTITY、MISSING_UNIT、UNKNOWN_CUSTOMER、ADDRESS_MISMATCH、ITEM_OR_UNIT、SOURCE_CONFLICT、LINE_CONFLICT、DUPLICATE_PO 等。

只有用户核对后才能把 humanVerified 设为 true，并填写 verifiedBy。运行 npm run evaluate -- <gold.json>。工具只读 ERP，不批准订单；记录字段错误、漏检/误报、每例延迟和零模型调用费用。minimumFieldCorrections 是相对 gold 的字段差异，不是实际人工操作次数。实际人工修改量和重复订单数保留 null，不能用未测量的 0 代替。

真实 ERP 写入验收另跑：先 import/review/decide，通过 Desk 检查 docstatus=0、客户、商品、数量、地址、单价与金额，再重复同一批准，查看只存在一张订单。注入响应断线和并发的开发测试不能替代真实 ERP 唯一索引和权限验收。

旧 `npm run evaluate -- <gold.json>` 仍评估 templateExtractor 和真实 ERP 的只读目录校验；它与上述 LangSmith 自由文本实验用途不同。模型适配器必须验证 evidence offset/quote，并报告 provider、model、token 与费用。


所有涉及模型的评估/烟测严格固定 Gemini 2.5 Flash-Lite（gemini-2.5-flash-lite），不得新增其他模型适配器或 fallback；模板评估保持零模型调用。配置与预算见 model.md。
