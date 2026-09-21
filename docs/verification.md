> 2026-09-22 当前约束：所有后续模型调用严格只用 Gemini 2.5 Flash-Lite（`gemini-2.5-flash-lite`），使用 GOOGLE_API_KEY / ORDER_EXTRACTOR=gemini。下文旧供应商记录仅为历史，不构成继续调用的授权。保留两次 / $0.05 预算账本；已发生一次旧供应商 401 请求，真实 Gemini 成功验证尚未完成。

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
