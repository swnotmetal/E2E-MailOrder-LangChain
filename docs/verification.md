> 2026-09-22 当前约束：所有后续模型调用严格只用 Gemini 2.5 Flash-Lite（`gemini-2.5-flash-lite`），使用 GOOGLE_API_KEY / ORDER_EXTRACTOR=gemini。下文旧供应商记录仅为历史，不构成继续调用的授权。用户已于 2026-09-22 撤销两次 / $0.05 本地限制，保留历史账本；额度或限流错误停止，不自动重试或切换。下文预算限制仅为历史记录；已发生一次旧供应商 401 请求。

## 2026-09-24 LangSmith Dataset / Experiment

- 真实创建 dataset `fictional-multilingual-inquiry-regression`（ID `9a917738-ca59-429a-98aa-19a4b516d9c7`），包含用户提供的英、德、爱沙尼亚、芬兰四封虚构邮件。重复同步最终验证为 created 0 / updated 0 / unchanged 4。
- 历史实验：`mail-understanding-historical-2026-09-23-f8a76a61`。当前实验：`mail-understanding-current-b3d84f6a`。当前实验调用固定 Gemini 四次，全部完成；专用 ledger 为 attempts 4 / completed 4，估算合计 USD 0.001855。
- 当前四个根 run 均有 `fictional-mail-understanding` LLM 子 span，无 ERP 调用或写入。英、德、爱三例从历史 quote 错误提升为六项基础 evaluator 通过；四例仍全部与人工 `inquiry` 意图标签不一致。芬兰语当前还遗漏第二种公司写法。
- 修正后的四行版本比较为 `mail-understanding-version-comparison-45d1`。严格 dataset pass rate 为 0；它诚实表示没有任何一例通过全部字段，而不是模型或 LangSmith 运行失败。
- 本地 TypeScript 检查通过；新增 fixture/evaluator 后全量 mock 回归 35/35。四例不能证明生产准确率、跨语言泛化或业务价值。

### 五封英文候选邮件

- 用户新增的五封虚构邮件已保存为 input-only dataset `fictional-english-inbox-candidates`（ID `450fd81b-95f1-4a0b-ab41-651d6ae1be58`）；重复同步验证为 created 0 / updated 0 / unchanged 5。
- 首轮 experiment `english-inbox-candidates-current-826e3415` 调用固定 Gemini 五次，全部完成；专用 ledger 为 attempts 5 / completed 5，估算合计 USD 0.001808。四个无 gold 结构 evaluator 均为 1，不能当准确率。
- 待人工确认的实际信号包括：Outback Builders Pty Ltd 公司漏提；以葡萄牙语称呼开头但主体为英语的 SolarVolt 邮件被标为 `pt`；Berlin 邮件把“明早定稿”和“10 月 12 日交付”同时放入 date。模型建议保存在忽略的 `data/english-candidate-review.json`，未晋升为 gold。
- 首轮根输出没有携带 PO、location、address 和 unit，因此新增 full-v1 输出 schema，并明确作为第二个实验 `english-inbox-candidates-full-v1-01e3d0db` 运行，而非把第一次结果覆盖或伪装成重试。两轮累计 attempts 10 / completed 10，估算合计 USD 0.003616。
- full-v1 还显示 Apex、Berlin 和 SolarVolt 的签名档地址被误作明确送货地址；Apex 漏掉 `late November` 且 `30x` 没有单位；Nippon 的 PO 与三条行项目正确抽出，但 `Yokohama distribution facility` 不是完整邮寄地址。以上为人工检查候选，不是已确认 gold。

## 2026-09-23 完整 LangGraph trace 与人工反馈

- 使用虚构英文询价真实运行固定模型；根 trace `01a0cf70-9d51-7099-9196-a321f7f06f3f` 包含 `extract`、`prepareInquiry`、`draftInquiryReply` 和 `inquiryReview` 图节点。
- `extract` 下包含 Gemini 邮件理解 LLM span；`prepareInquiry` 下包含两个 `get_inventory` Tool span；`draftInquiryReply` 下包含 Gemini 回复 LLM span。FILTER-A20 的库存快照为 0，THERM-S1 为 40。
- 图停在人工 interrupt，Mock ERP 写入为 0。人工批准回复后，LangSmith feedback `01a0cf71-2081-77fa-b8da-a4d976bd46c8` 已通过 API 读回：key 为 `human_review_approved`、score 为 1、value 为 `approve-reply`，并保存被批准的回复草稿 correction。
- interrupt 后的恢复是同一 `thread_id` 下的后续 trace；人工 feedback 关联到原始处理根 run。以上是一次真实集成证据，不代表抽取准确率、生产稳定性或真实客户邮件处理能力。

## 2026-09-23 ERP 后同语种回复节点

- 使用虚构芬兰语询价真实运行固定模型两次：抽取 trace `01a0cf4f-2af2-7000-8000-0014486bc30f`，回复 trace `01a0cf4f-33d6-7000-8000-0365cc84ca3d`。
- 回复节点只收到结构化询价与只读 ERP 结果；芬兰语草稿保留五项请求数量 `25 / 12 / 40 / 8 / 15` 及原文日期 `15. lokakuuta 2026`。五个商品均未匹配当前目录，因此要求确认商品编码；没有把“未匹配”表述成“企业绝不供应”。
- 图停在 `inquiry-review` 等待人工审核，Mock ERP 写入为 `0`。Mock 回归另行证明回复模型 429 时 checkpoint 保留 `inquiry-prepared` 库存结果，不产生待批准草稿或 ERP 写入。该验证不证明芬兰语文案质量或真实业务准确率。

## 2026-09-23 自然语言身份字段切片

- 真实 Gemini 2.5 Flash-Lite 请求，输入仅为虚构文本：成功分别提取公司 `Nieminen Auto Workshop`、联系人 `Mia Example` 与明确送货地址 `99 Fictional Road, Helsinki`；路由到 `conditional` 询价审核；回复称呼为 `Hello Mia Example,`；Mock ERP 写入数为 `0`。
- Mock 回归覆盖字段原文 grounding 和页面状态卡绑定。自编测试不能证明未见过的真实业务邮件抽取准确率。
- 用户提供的虚构 `Messerschmitt & sons` 邮件真实重测：模型原始购买意向经 grounded 保护规则得到 `conditional`，证据为 `interested in placing an order`；公司、联系人、所在地分别保留；所在地未冒充送货地址；`type a10 filters` 唯一匹配 `FILTER-A10`；最终为 `inquiry-review`、issues 为空、Mock ERP 写入 `0`。
- 同语种回复真实验证：虚构中文询价返回 `language=zh` 与全中文草稿；`Messerschmitt & sons` 英文邮件返回 `language=en` 与英文草稿；两者均停在 `inquiry-review` 且 Mock ERP 写入 `0`。Mock 回归另行覆盖中文模板 fallback 与链接拒绝。

# 首轮交付检查记录 — 2026-09-21

- TypeScript `tsc --noEmit`：通过。
- Node/tsx 行为回归：15/15 通过（最后一轮约 4.2 秒，单机开发数据，不是生产延迟指标）。
- 四个独立 CLI 进程演示：导入、审核文件、批准、重复批准；SQLite 恢复，HTTP mock 新增订单数 1。
- 超时测试：模拟服务先提交、延迟响应 1500ms，客户端 1000ms 超时后查回；并发请求只有一张模拟订单。
- Skill Creator 官方 quick_validate：Skill is valid。PyYAML 仅装在忽略的 data/skill-validator 工具目录。
- Miko alpha.11 strict doctor：退出 1，配置/Skill 检查通过，无 live runtime；未激活。
- Compose config --quiet：通过。ERP seed Python 语法：通过。
- npm audit --omit=dev：0 vulnerabilities。
- 金标准入口：未人工确认的 gold-template.json 被拒绝；没有运行独立盲测，没有准确率结果。
- 本轮模型调用 0，模型 API 费用 0；新增的 Haiku 适配器只有本地验证测试，尚未对真实 API 发请求。

真实 ERP 验收：**未完成**。重启后固件虚拟化和 WSL2 均可用，但 Docker Desktop 4.36.0 启动时报 OTel manager 残留 socket 不可访问，然后退出。未重置 Docker 数据，也未创建真实 ERP 订单。infra/start.ps1、权限、初始化、ERP唯一索引和 API 行为必须在可运行的本地实例再验收。

输入限制：UTF-8 纯文本邮件 + 可提取文字 PDF；默认固定英文标签解析器；可选模型适配器尚未经付费 API 验证；无 OCR 或复杂 MIME。审核为 CLI/JSON，尚无网页。ERP 目录读取上限 1000，超过时明确失败。价格由 ERP EUR price list 计算；stock_uom 整数数量。开发数据预期仍需用户人工确认。

测试是开发回归，mock 实现可以与适配器共享错误假设，因此不用于宣称真实 ERP 集成完成。下一步首先解除 ERP 运行阻碍并完成真实写入验收，再接自由文本模型和独立盲测。

## 重启后的真实 ERP 阶段（2026-09-21）

- BIOS 虚拟化与 WSL2 正常。Docker Desktop 4.36.0 原位更新至 4.91.0，但仍因 `userAnalyticsOtlpHttp.sock` 不可访问而退出；未重置 Desktop 数据。
- Ubuntu WSL 中使用发行版 Docker Engine 29.1.3、Compose 2.40.3，并保持一个隐藏 WSL 会话。官方 ERPNext 演示站点成功安装，Frappe /api/method/ping 返回 pong；ERPNext 16.35.0。
- 首次站点安装因 WSL 会话结束导致 MariaDB 正常关闭，留下半成品。只读核对四个 order-review-demo 卷均于本轮创建、仅安装 Frappe、无 ERPNext 订单后，自动审批审查允许清理专用卷并重新初始化。其它卷未触及。
- 种子脚本补齐未执行 Setup Wizard 时缺失的仓库类型、客户组、地域、地址模板、商品组和 UOM；执行失败会返回非零状态。`infra/start-wsl.ps1` 已在现有站点重复运行成功。
- 独立 ERP API 用户凭证保存在 Git 忽略的 `.env.erp`；根目录用户提供的 `.env` 未覆盖。API 用户对 Sales Order 有读、创建权限，但 Item Price 的直接读取被 ERP 权限拒绝。只读 bench 校验商品目录价为 EUR 12/件。
- 真实邮件/PDF 导入线程 `8a2c6d19dab126c3194d4844c1e7c3822a0637ce3b6a1292110555a3de57a294` 已停在人工审核；客户、商品、地址均精确匹配，14 条证据通过，异常和重复 PO 为 0。草稿在忽略的 `data/real-review.json`，尚未批准、尚未创建真实 Sales Order。
- 可选 Haiku 4.5 提取器及 LangSmith 明确开关已实现。模型输出必须通过唯一原文 quote 校验；模型预算本地账本最多两次、预留上限 USD 0.05。用户授权仅用虚构数据。未发出模型调用，成本为 0。17/17 本地测试通过，TypeScript 检查通过。自然语言烟测资料已准备，但不作为独立准确率评估。
## 2026-09-22 自然语言收件箱验证

- 类型检查与 23/23 mock 测试通过。新增测试覆盖询问/条件购买/意图不明的人工确认闸门、缺失字段与原文证据校验。
- 真实 Gemini 使用虚构中文邮件完成条件购买识别：引用“如果下周五之前能到，我们就考虑购买”，进入 review，Mock 写入累计 0。
- 本轮共四次真实请求：前三次返回结果被证据校验拒绝，第四次通过。所有请求保留在既有账本，没有自动重试。一次失败根因为模型将“5 个”引用为“5个”；只允许唯一空白等价匹配恢复到原文。
- 该样例未完整提取所有字段，仍需人工补充；不能据此声称提取准确率合格。未验证本轮 LangSmith 成功上传，未发客户邮件或付款信息。
- 随后将非购买意图拆到独立询价子流程：不再产生缺 PO、地址、订单日期、单位等订单错误；Mock 测试验证只读库存 12、人工回复审核及零 ERP 写入。价格、交期、实际发信仍未实现。
