# B2B 订单邮件与采购单审核助手

学习 / 工程作品集；所有示例资料虚构。TypeScript + LangGraph + SQLite + ERPNext REST API，无向量库、多 agent；默认零模型调用。所有模型测试严格只用 Gemini 2.5 Flash-Lite（gemini-2.5-flash-lite）。

**当前状态：真实本地 ERPNext 的人工批准、Draft 写入与重复订单检查已有阶段记录；只读库存查询已实测。Gemini 模型调用与成功 LangSmith 工具轨迹仍待验证。详见 docs/learning-handoff-2026-09-21.md 和 docs/model.md。**

## 快速运行

Node >=22.18。当前电脑 PATH 内 npm 损坏，可用 `& 'C:/Program Files/nodejs/npm.cmd'` 替代下面的 npm。只影响命令入口，未修改全局安装。

```powershell
npm ci
npm run check
npm test
npm run demo
```

`demo` 是明确标识的 HTTP MOCK：读取真实邮件/PDF → LangGraph 提取和匹配 → SQLite 保存审核中断 → 新 CLI 进程导出审核 JSON → 开发脚本批准 → 再次批准验证只有一张模拟订单。结果在 data/mock-demo-*/result.json。正式 CLI 不会自动批准。

## 真正 ERPNext

先解决 WSL2 的 HCS_E_HYPERV_NOT_INSTALLED，启用虚拟化 / Virtual Machine Platform 并重启。详见 infra/README.md。项目不会自动改变系统功能或重启电脑。

```powershell
powershell -ExecutionPolicy Bypass -File infra/start-wsl.ps1
$env:ERP_ENV_FILE='.env.erp'
npm run cli -- import fixtures/01-clean.eml fixtures/01-clean.pdf
# 从上一步输出复制 id
npm run cli -- show <id>
npm run cli -- review <id> data/review.json
# 查看 sources/extracted/issues，编辑 review.json 中 draft；明确设 action=approve 并填写 reason
npm run cli -- decide <id> data/review.json
npm run cli -- show <id>
```

action 也可为 reject 或 request-info。request-info 保持中断等待下一次审核。ERP 网络失败后修复连接，再执行 `npm run cli -- retry <id>`。再次启动同样 data 目录即可恢复，不需要长期运行服务。原始邮件/PDF、提取文本、审核历史和 checkpoints 均保存在 data/（不提交）。删除 data 会丢失本地审计/恢复状态，ERP 唯一键仍用于防重复。

审核是本机 CLI + 可编辑 JSON，尚无网页界面、多用户认证或邮件 MIME/OCR。默认模板解析器接受 Customer/PO/Delivery/Address 和 Item: 型号 | 数量 | 单位。可选 Gemini 2.5 Flash-Lite 适配器在 src/model.ts，设置 GOOGLE_API_KEY 与 ORDER_EXTRACTOR=gemini；库存入口 inventory 同样固定此模型。LangSmith 需 ORDER_TRACE=true，仅使用虚构资料。最多两次请求、总预算 $0.05，沿用原账本；真实 Gemini 验证尚未完成，见 docs/model.md。

## 关键设计

- `src/input.ts`：PDF 文本与邮件解析，精确引用原文；Extractor 可替换。
- `src/domain.ts`：必填、日期、正整数数量和稳定订单身份。
- `src/workflow.ts`：LangGraph 分支、中断与重审；人工修订后重新校验。
- `src/erp.ts`：官方 Frappe resource API；ERP unique integration key + 超时查回防重复，不盲目重发 POST。
- `src/cli.ts`：本地审核命令与跨进程锁。SQLite OS 锁在进程退出后释放，checkpoint 使用另一数据库独立落盘。

只支持 ERP stock_uom 整数数量，不在助手中计算税价；ERP 负责 EUR 单价和金额。未知型号保持空 item，候选目录给人工选择；来源冲突须说明解决原因。现在地址必须选 ERP 已关联地址，不自动新建地址。

10 个开发样例与业务状态见 docs/design.md。用户核对金标准和盲测方法见 docs/evaluation.md；开发回归不等于提取准确率。

## Skills / Miko

使用 Ponytail 的最小实现原则和项目内 `.agents/skills/order-review/SKILL.md`。用户另行导入的技能库保留在本地、按任务选择读取；当前只提交 Miko 必需的 order-review。superpowers 计划后续接入，尚未安装。

Miko 当前会话已报告 active / 绿色证据检查点。当前 miko.json 仅对 workflow.ts、erp.ts、domain.ts 的指定编辑动作要求读取 order-review，不代表监督全部 skills 或证明业务正确。新环境仍需验证 Hook 是否实际触达。

## 官方参考

- https://docs.langchain.com/oss/javascript/langgraph/interrupts
- https://docs.frappe.io/framework/user/en/guides/integration/rest_api
- https://github.com/frappe/frappe_docker
- https://github.com/swnotmetal/Project-Koma/tree/main/packages/koma-miko

接下来从 [学习入口](docs/learning-guide.md) 上手 LangGraph、LangChain 和 LangSmith，再考虑简易本地 UI。仍缺真实 Gemini / LangSmith 联调与用户确认 gold 后的独立评估；未宣称节约工时或市场需求。



