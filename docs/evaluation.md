# 评估与验收

开发集在 fixtures/，10 对邮件/PDF，开发期预期在 design.md。预期由实现者草拟，尚未由用户核验，不是独立准确率证据。

最终盲测：用户提供新邮件/PDF（不进入开发调试集），复制 gold-template.json 并填写每个 case 的 id、email、pdf、fields、issueCodes。
fields 使用 draft 路径，例如 customer、po、date、address、lines.0.item、lines.0.quantity。值全部为字符串；客户、地址、商品使用实际 ERP ID。
issueCodes 使用 MISSING、INVALID_DATE、UNRESOLVED_ITEM、INVALID_QUANTITY、MISSING_UNIT、UNKNOWN_CUSTOMER、ADDRESS_MISMATCH、ITEM_OR_UNIT、SOURCE_CONFLICT、LINE_CONFLICT、DUPLICATE_PO 等。

只有用户核对后才能把 humanVerified 设为 true，并填写 verifiedBy。运行 npm run evaluate -- <gold.json>。工具只读 ERP，不批准订单；记录字段错误、漏检/误报、每例延迟和零模型调用费用。minimumFieldCorrections 是相对 gold 的字段差异，不是实际人工操作次数。实际人工修改量和重复订单数保留 null，不能用未测量的 0 代替。

真实 ERP 写入验收另跑：先 import/review/decide，通过 Desk 检查 docstatus=0、客户、商品、数量、地址、单价与金额，再重复同一批准，查看只存在一张订单。注入响应断线和并发的开发测试不能替代真实 ERP 唯一索引和权限验收。

默认 templateExtractor 仅识别固定标签；自由文本尚未接模型。模型替换点为 Extractor，新增适配器必须验证证据 offset/quote 并报告 provider/model/token/费用。接付费模型前解释单次预算与数据传输范围，用户同意后才使用密钥。


所有涉及模型的评估/烟测严格固定 Gemini 2.5 Flash-Lite（gemini-2.5-flash-lite），不得新增其他模型适配器或 fallback；模板评估保持零模型调用。配置与预算见 model.md。
