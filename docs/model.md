# 模型调用约束

本项目所有真实模型测试、订单提取、库存工具选择和问答严格只用 Gemini 2.5 Flash-Lite，模型 ID 固定为 `gemini-2.5-flash-lite`。禁止其他模型或失败后切换供应商。共享请求函数固定 Google generateContent URL，不提供模型覆盖参数。

设置 `GOOGLE_API_KEY`；订单提取设置 `ORDER_EXTRACTOR=gemini`；库存入口为 `npm run cli -- inventory "<虚构问题>"`。默认模板解析不调用模型；其他 ORDER_EXTRACTOR 值会报错。ERP 凭据仍由 ERP_ENV_FILE 指向的文件加载。ORDER_TRACE=true 才启用显式 LangSmith trace，只发送虚构数据。

2026-09-22 用户确认撤销两次请求 / $0.05 本地上限。沿用 `data/model-budget.sqlite` 保留历史记录，新请求（包括失败）继续记账，不再预留预算或按累计次数阻止调用。遇到额度、限流或其他 API 错误立即停止，不自动重试或切换供应商。免费额度与计费由 Google 项目控制，本地账本不能保证仅使用免费额度。库存完整问答需要两次请求。单次请求 JSON 上限 16 KB，提取源文本上限 8 KB，输出上限 2500 tokens，关闭 thinking。预算预留不等于供应商硬额度。

文本标准估价为输入 $0.10 / 百万 tokens、输出 $0.40 / 百万 tokens，按返回 usage 保守向上取整到微美元；没有 usage 时费用未知。参考：https://ai.google.dev/gemini-api/docs/pricing 。

模型提取仍须通过原文 quote、唯一性、offset 校验。库存 LangChain Tool 只读；模型不能写 ERP。非库存跟踪商品返回未知数量，不冒充零库存。

2026-09-23：真实 Gemini 自然语言邮件抽取已验证，包括公司、联系人、明确送货地址和条件购买路由；询价流程还会在只读 ERP 查询后用一次独立请求生成同语种回复。该请求只接收结构化虚构结果，必须保留商品、数量及原文交付日期，并停在人工审核。抽取与回复的成功 LangSmith trace 已验证；独立库存工具轨迹仍未验证。此前旧供应商一次请求返回 401，保留预算记录，不将未知费用写成已证实的零。
