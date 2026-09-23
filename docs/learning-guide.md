# 从一条订单认识三个组件

## 自然语言邮件（当前入口）

收件箱默认 Gemini 2.5 Flash-Lite 模式，通过共享 `src/model.ts` 入口读取 `.env` 中的 `GOOGLE_API_KEY`。点击“填入自然语言询问”或自行写虚构邮件，再发送。模板模式仍可选且不调用模型。`ORDER_TRACE=true` 且配置 LangSmith 密钥时，记录邮件理解的 LLM trace；页面显示成功 trace ID，完整图节点日志仍在本地。

模型提出 purchase / inquiry / conditional / unclear 意图及原文证据。非明确购买必须由人工获得客户确认、勾选确认并填写依据，才能继续批准；不满足条件会再次 interrupt。未知商品、缺少 PO/单位/地址、中文数量或相对日期由人工核对，不能伪造原文值。引用不唯一或 API 错误会停止，不自动降级或重试。

自然语言理解会把客户公司 `customer`、人类联系人 `sender`、公司或发件人所在地 `location` 与明确的送货地址 `address` 分开保存，并在页面显示各自的原文证据。联系人姓名可用于可编辑回复草稿；只有公司字段参与 ERP 客户匹配，只有明确送货地址才可进入订单。将来接入真实邮箱时，发件邮箱应从 MIME `From` header 确定性读取，而不是让模型从正文猜测。

“interested in placing an order / considering / 想了解 / 考虑购买”等软性购买语言会被确定性保护规则降级为 `conditional`，即使模型误报 `purchase` 也不会直接进入订单严格校验。商品描述含 `A10` 这类型号片段时，只在 ERP 目录恰好唯一匹配时补成商品编码；泛称 `Filter` 仍保持未解决。

最终产出是人工批准后的 Mock Sales Order 草稿与审核记录。没有发信、报价、付款链接、收款或自动 AI 客服；询问由本地审核人员处理。正式 ERP 路径也仅创建 docstatus=0 草稿。下面较早的“仅模板”说明属于先前阶段。

### 两条子流程

- `purchase`：匹配客户、地址和商品，执行订单必填校验，人工 interrupt 审核后才可创建 Mock ERP Sales Order 草稿。
- `inquiry / conditional / unclear`：不运行 PO、地址、日期和单位的订单必填校验；匹配商品后调用 ERP 只读库存查询，整理价格、交期、客户身份等待办，并生成可编辑回复草稿。人工可批准回复草稿、要求补充或关闭工单。批准只记录决定，当前不会发信。

询价回复使用确定性但稍自然的短模板：针对 conditional 明确回应“交期会影响决定”，再承诺核对库存、价格和预计交期。它仍是可编辑草稿，不伪装成自由发挥的 AI 客服，也不自动发信。

Gemini 自然语言模式会在同一次理解调用中标记邮件主要语言并生成同语种的受约束回复草稿，不额外增加一次模型请求。草稿只能说明正在核对库存、适用价格和预计交期，不得确认订单、库存、价格、付款或包含链接；签名使用对应语言的“销售团队”，不保留姓名占位符。模板模式确定性支持中文和英文回复。

Mock ERP 从 `fixtures/erp-spareparts-demo` 加载 30 个商品、12 个客户、客户地址、分仓库存和历史销售订单。FILTER-A10 合计 12 件，FILTER-A20 为 0，NON-STOCK-01 返回库存未跟踪；历史 ACME Customer PO 参与重复检查。价格与交期工具尚未实现，因此仍标为人工待办。这一分流只证明流程机制可运行，不证明模型在真实 300 封邮件上的分类准确率或节省时间；需要由用户提供独立留出样本，记录人工基线后评估。

## 模拟收件箱（2026-09-22）

运行 `npm run learn`，打开 http://127.0.0.1:3210 。选择样例并点击“填入样例”，可编辑邮件正文与模拟 PDF 提取文本，再点击“发送到模拟收件箱”。从收件箱打开邮件，用商品下拉框及数量表单审核，填写理由后批准、要求补充或拒绝。JSON 收在高级选项中。

发送新邮件保留已有邮件和 Mock 订单，可重复发送同 PO 观察防重。刷新收件箱可重新打开已有会话并查看累计节点日志；“清空收件箱与模拟订单”或服务重启才清空本轮数据。新收件箱采用模板提取、真实 LangGraph、Mock ERP，不调用 Gemini 或上传 LangSmith；附件栏是模拟提取文本，不是实际 PDF 上传。旧 `/api/start` 仍保留清空上一轮的兼容行为，页面不再使用它。

以下旧卡片说明供理解底层组件，日常操作以模拟收件箱为准。

## 可操作学习台（推荐先用）

运行 `npm run learn`，打开 http://127.0.0.1:3210 。只绑定本机，使用模拟 ERP、真实 LangChain Tool 与现有 LangGraph，绝不调用模型或上传 trace。无需 .env。每次点击“新建练习”都会清空上一轮 mock ERP 订单；也可点“重置练习数据”。浏览器刷新不会清空服务端状态。SQLite 检查点位于内存，服务重启会清空整个练习会话。正式 CLI 的磁盘持久化不受影响。

1. 工具卡：先查 FILTER-A10，再把 itemCode 改成数字，观察 schema 拒绝；改为 UNKNOWN，观察业务函数报错。
2. 正常订单：新建练习，观察 review 暂停、mockWrites=0；填写理由并批准，观察 write 更新与 END。
3. 冲突订单：比较邮件 5 / PDF 8；空理由批准应继续暂停；明确核对依据后批准。重读 checkpoint 检查 audit。
4. 型号不明：`DEMO-002` 是存在的 PO 编号；问题是原文商品只写 `Filter`，无法在 `FILTER-A10` 与 `FILTER-A20` 中唯一匹配。没有客户补充证据时选择“要求补充”；得到确认后才修改 `lines[0].item`。这里只是开发练习，不是提取准确率评估。

学习台本地事件来自 graph.stream，不是 LangSmith trace。页面没有真实模型或 ERP 写入入口。代码入口：scripts/learn.ts、src/learn.html；业务图仍为 src/workflow.ts。

先跑 `npm run demo`。它使用虚构文件、HTTP mock ERP 和模板解析器，不调用模型。输出会给出 thread id、模拟订单号及 data 下的结果路径。脚本自动批准只用于这个 mock 演示，正式 CLI 仍需人工决定。

| 组件 | 本项目中的位置 | 上手时观察什么 |
| --- | --- | --- |
| LangGraph | src/workflow.ts | extract → match → review；interrupt 暂停，SQLite checkpoint 保存状态；批准后进入 write，校验失败回审核 |
| LangChain | src/model.ts 的 inventoryTool | 模型返回 get_inventory 参数；Zod 校验；工具调用 ERP 只读接口；未跟踪库存返回 null |
| LangSmith | src/model.ts 的 RunTree | 显式记录模型输入输出与工具结果；不是默认自动记录整个 LangGraph |

第二步在真实 ERP 下用 README 的 import/show/review 命令观察 pendingReview、issues、revision。先查看暂停状态，再手工处理冲突；decide approve 会写真实 ERP Draft。中断与跨进程恢复不需要先调用模型。

第三步验证 Gemini 2.5 Flash-Lite 的真实工具调用和 LangSmith trace。用户已撤销两次 / $0.05 本地上限；历史失败记录保留。完整库存问答使用两次 Gemini 请求，遇到额度、限流或其他 API 错误停止，不自动重试或切换。免费额度由 Google 项目控制，账本不保证免费。仍须区分上传了失败 trace 与验证了成功工具轨迹。

当前已实现上述本地练习 UI，复用现有图和人工审核校验；仅连接模拟 ERP。后续可在真实工具轨迹验证后展示对应 trace 链接，真实 ERP 审核仍使用正式 CLI。

Skills 按当前任务读取，不一次加载整个库。Miko 的监督范围由 miko.json 明确声明。superpowers 后续接入时再核对安装方式、许可及与 Ponytail/Miko 的边界。
