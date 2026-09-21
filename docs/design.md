# 第一版业务边界

虚构公司 Nordic Parts Demo，经销设备配件。首版：一张 PO、一位客户、一个交货地址、逐行整件采购。无 OCR、复杂 MIME、税务、折扣、库存承诺或正式提交。
字段：客户、PO 编号、商品描述/明确型号、正整数数量、ERP 单位、ISO 交付日期和地址。证据保存 source、page、quote、start/end。冲突不自动选择正文或附件。ERP ID 不由模型创造；单价和最终金额由 ERP 计算。

流程：import → extract → match/check → review（interrupt）→ approve → revalidate → write → created。reject → rejected；request-info → needs-info（可再次审核）。SQLite checkpoint 跨进程恢复。批准含 revision、操作者、修改和冲突解决理由，修改后重新校验。

防重复：SHA-256(客户 ERP ID + 规范化 PO) 写入 Sales Order unique custom_integration_key。内容另有摘要。同键不同内容阻止；同键同内容查回。超时先查询，数据库唯一约束解决并发。ERP 中手工录入的 PO 也检查，但外部手工录入并发不是此唯一键能覆盖的。

CLI 限本机操作者使用，不宣称多用户鉴权。审核 JSON 可编辑。模板解析器只接受标签行，不冒充自由文本理解。模型以 Extractor 函数替换，默认零模型调用。

## 开发样例，预期答案需用户核对

| ID | 变化 | 暂定行为 |
|---|---|---|
|01|全部一致|暂停，批准后 docstatus=0|
|02|仅 Filter 描述|候选保留，不选型号|
|03|数量 5 vs 8|冲突需解释|
|04|重复 PO|同内容复用，变更阻止|
|05|POST 提交后超时|查回，只有一张|
|06|缺日期|禁止批准|
|07|地址不符|修订或补资料|
|08|未知客户|禁止批准|
|09|负数/小数/单位错误|禁止批准|
|10|中断、并发或重复批准|恢复，至多一张|

开发回归不等于独立评估。盲测输入及 gold 由用户另行提供且人工确认，未核验前不输出准确率。记录字段错误、漏检误报、订单新增数、修改量、延迟、token 和费用；无真实用户时不宣称节省工时。
