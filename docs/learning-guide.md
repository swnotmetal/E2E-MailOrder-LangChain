# 从一条订单认识三个组件

先跑 `npm run demo`。它使用虚构文件、HTTP mock ERP 和模板解析器，不调用模型。输出会给出 thread id、模拟订单号及 data 下的结果路径。脚本自动批准只用于这个 mock 演示，正式 CLI 仍需人工决定。

| 组件 | 本项目中的位置 | 上手时观察什么 |
| --- | --- | --- |
| LangGraph | src/workflow.ts | extract → match → review；interrupt 暂停，SQLite checkpoint 保存状态；批准后进入 write，校验失败回审核 |
| LangChain | src/model.ts 的 inventoryTool | 模型返回 get_inventory 参数；Zod 校验；工具调用 ERP 只读接口；未跟踪库存返回 null |
| LangSmith | src/model.ts 的 RunTree | 显式记录模型输入输出与工具结果；不是默认自动记录整个 LangGraph |

第二步在真实 ERP 下用 README 的 import/show/review 命令观察 pendingReview、issues、revision。先查看暂停状态，再手工处理冲突；decide approve 会写真实 ERP Draft。中断与跨进程恢复不需要先调用模型。

第三步验证 Gemini 2.5 Flash-Lite 的真实工具调用和 LangSmith trace。先核对共享预算：旧供应商一次 401 已消耗一个请求名额，切换模型不清空账本。当前完整库存问答需要两次请求，不能在仅余一次时直接运行。下一切片可收敛为一次模型调用选择工具，再由代码显示工具结果；不额外生成自然语言答案。仍须区分上传了失败 trace 与验证了成功工具轨迹。

当 CLI 流程已理解，可做一个最小本地 UI：左侧原文，中间草稿和冲突，右侧审核动作与当前图节点，附 trace 链接。它复用现有图和人工审核校验，不另建工作流。当前尚未实现 UI。

Skills 按当前任务读取，不一次加载整个库。Miko 的监督范围由 miko.json 明确声明。superpowers 后续接入时再核对安装方式、许可及与 Ponytail/Miko 的边界。
