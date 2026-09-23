> 2026-09-23 当前约束：所有后续模型调用严格只用 Gemini 2.5 Flash-Lite（`gemini-2.5-flash-lite`），使用 GOOGLE_API_KEY / ORDER_EXTRACTOR=gemini。下文旧供应商记录仅为历史，不构成继续调用的授权。用户已撤销两次 / $0.05 本地限制，保留历史账本；额度或限流错误停止，不自动重试或切换。自然语言邮件抽取已有真实 Gemini 成功证据；成功 LangSmith 工具轨迹仍待验证。

# 学习项目阶段记录（2026-09-21）

目标：用真实的本地 ERPNext 数据源展示 LangChain 的模型/工具调用、LangGraph 的人工审核与恢复，以及 LangSmith 的轨迹和人工核对评估。CLI 是演示入口；ERPNext 展示业务记录；LangSmith 展示 AI 运行过程。本阶段不开发员工 UI 或真实邮箱接入。

## 已手工核对

- 本地 Frappe API `/api/method/ping` 返回 `pong`。
- `01-clean` 邮件和 PDF 导入后，人工批准并经 `retry` 恢复，ERPNext 中出现 `SAL-ORD-2026-00001`，客户 `Acme Workshop`，状态 `Draft`。首次写入曾返回 `ERP_HTTP_417`，具体原因未取得；不能把后续成功当作该异常已经定位。
- 再次 `retry` 后，ERPNext 列表仍只有一张该客户的 Draft。用户附带的第二次命令输出未被本会话工具读取，因此仅记录已观察到的 ERP 外部结果。
- 完全相同的文件再次导入，得到原 `thread_id` 和已创建状态。这检验的是相同输入的幂等导入。
- 修改邮件附注、保留客户 PO `DEMO-001` 后，产生新 `thread_id`，检出 `DUPLICATE_PO` 并停在 `review`。人工选择 `request-info` 后状态为 `needs-info`，理由写入 `audit`，未返回新订单编号。
- `02-ambiguous` 的草稿商品为空，出现 `UNRESOLVED_ITEM`，停在 `review`；没有擅自选择 `FILTER-A10` 或 `FILTER-A20`。
- `03-quantity-conflict` 已在真实 ERP 查询路径复核：邮件数量 `5`、PDF 数量 `8`，出现 `LINE_CONFLICT` 并停在 `review`。首次运行时 ERP 未启动，检查点停在 `extracted`；启动 ERP 后通过 `retry` 恢复到审核。自动测试同时覆盖该分支。

## 尚未通过或尚未执行

- 真实模型提取、LangChain 库存只读工具调用和 LangSmith 轨迹/离线评估尚未得到运行证据。此前未发生模型 API 调用或费用。用户曾授权在虚构数据上最多两次 Haiku 4.5 测试，总预算 $0.05，并允许追踪到 LangSmith；运行前仍需按此上限控制。
- `npx koma-miko doctor --host codex --strict` 由用户运行并全部通过；Miko 也已在当前会话报告为 active。激活只证明 Hook 已触达，不代表项目行为已由 Miko 验证。

## 下一最小切片

1. 用自然语言样例各跑一次受预算限制的模型提取，检查 LangSmith trace 中的输入、输出、延迟和成本；模型不能直接写 ERP。
2. 增加一个只读 ERPNext 库存查询工具，用一条库存问题演示 LangChain tool calling，并在 LangSmith 核对工具调用轨迹。库存不足只标异常，不自动决定能否接单。
3. 使用未参与调试、由用户核对标准答案的样例做离线评估：字段错误、异常漏检、重复订单、人工修改量、延迟和模型成本。开发样例不计入最终分数。
