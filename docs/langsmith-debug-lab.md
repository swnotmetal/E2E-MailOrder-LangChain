# LangSmith 排错与回归练习

这组练习只使用虚构数据。`npm run trace:lab` 会向 `.env` 中的 LangSmith project 写入四条带有 `synthetic`、`training`、`debug-lab` 标签的 trace；它不调用 Gemini、不访问 ERP，也不产生模型费用。它们是教学材料，不是生产运行证据。

## 1. 找到本次练习

打开 EU LangSmith workspace，进入 **Tracing Projects → `lca-LangGraph-Essentials-V1` → Traces**。用界面过滤器选择 tag `debug-lab`，再按 metadata `batchId` 缩小到本轮。当前已验证批次：

`debug-lab-2026-09-24T13-40-55-872Z`

四个根 run 都叫 `order-review-debug-lab`，用 tag `case:*` 区分：

- `case:good-control`
- `case:erp-tool-error`
- `case:wrong-reply-language`
- `case:unresolved-catalog-item`

## 2. 先独立排错，再看答案

逐个打开根 run，比较 Inputs、Outputs 和子树。先回答：错误是根 run 失败、子工具失败、语义质量失败，还是预期的人工分流？

答案：

- `good-control`：`extract → resolveInventory → get_inventory` 全部成功，库存快照为 12。
- `erp-tool-error`：根 run 是成功的，但 `get_inventory` 子 run 为红色 `ERP_HTTP_503`；父流程把它安全转换成 `lookup-failed`，应交人工确认。这说明只看根 run error 会漏掉被安全处理的工具故障。
- `wrong-reply-language`：所有节点都是绿色，但输入 `expectedLanguage=en`，输出却是 `replyLanguage=pt`。这是语义质量问题，单靠异常率监控抓不到。
- `unresolved-catalog-item`：没有 `get_inventory` 子 run，因为目录无法唯一匹配 `Blue Widget Z9`。这是正确的安全行为，不应猜商品编码，也不应标成工具故障。

## 3. 做一次人工抽样标注

在左侧进入 **Annotation Queues**，创建 single-run queue：

- Name：`order-review-debug-review`
- Instructions：检查库存工具是否正确使用、回复语言是否匹配、流程是否安全停在人审。
- Rubrics：`inventory_handling`、`reply_language`、`safe_to_continue`，均使用二元分数。

回到 Traces，勾选四条 `debug-lab` 根 run，选择 **Add to Annotation Queue**。建议评分：

| case | inventory_handling | reply_language | safe_to_continue |
| --- | ---: | ---: | ---: |
| good-control | 1 | 1 | 1 |
| erp-tool-error | 0 | 1 | 1 |
| wrong-reply-language | 1 | 0 | 0 |
| unresolved-catalog-item | 1 | 1 | 1 |

`unresolved` 得 1 是因为它没有猜测商品；“需要人工”不等于“系统错误”。LangSmith 官方说明 annotation queue 用于把 runs 集中分配给人工、记录 rubric feedback，并可把修正后的输入输出加入 Dataset。

## 4. 建一个最小质量监控

进入该 tracing project 的 **Evaluators**，优先使用确定性 code evaluator，不使用额外模型：

- `inventory_lookup_ok`：只要 `outputs.availability` 中出现 `lookup-failed` 就记 0，否则记 1。
- `reply_language_match`：没有回复语言时记 1；否则要求 `outputs.replyLanguage === inputs.expectedLanguage`。

过滤范围先限定 tag `debug-lab`，采样率设为 100%，并对本批次 backfill。预期前者只抓到 `erp-tool-error`，后者只抓到 `wrong-reply-language`。生产环境再按成本和流量降低采样率；监控用于发现候选问题，不替代业务人工批准。

## 5. 从坏 run 建回归 Dataset

在 annotation queue 中打开 `wrong-reply-language`，选择 **Add to Dataset**，新建 `order-review-debug-regression`。保留虚构输入，把 reference output 的 `replyLanguage` 人工修正为 `en`，不要直接把坏 run 的 `pt` 当 gold。

再加入：

- `good-control`，作为正向对照；
- `unresolved-catalog-item`，reference 保持 `unresolved`，用于保护“不猜商品”的边界。

`erp-tool-error` 更适合监控和恢复测试；除非 Dataset 明确测试“503 时必须输出 lookup-failed”，否则不要把偶发基础设施状态混进普通语义回归集。

完成后应能清楚区分：trace 是一次运行证据，feedback 是人的判断，Dataset example 是可重复输入与 reference，experiment 是某个版本批量跑 Dataset 的结果。
