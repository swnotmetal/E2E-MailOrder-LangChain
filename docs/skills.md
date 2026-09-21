# Skill 选择与来源

2026-09-21 检查了当前技能目录、内置 skill-installer 脚本说明和 openai/skills 的官方 curated API 目录。
官方目录主要是平台集成、部署、文档和安全工作流，没有专门适合此切片的 AI 工作流评估技能；未安装整套库。

选用两项工程指导：
- 已安装 Ponytail 4.10.0，来源 https://github.com/DietrichGebert/ponytail ，已读 SKILL.md、插件 manifest 和 MIT LICENSE。只使用其简化工程原则，不省略用户要求的校验。
- 项目内 `.agents/skills/order-review/SKILL.md`，本项目编写，MIT。按已安装 Skill Creator 的规范写入；下一轮可由 Codex 发现，本轮显式读取使用。

skill-installer 是安装工具，skill-creator 是编写工具，不是另外引入的业务技能。官方第三方技能需逐个查看目录内 LICENSE.txt；本次没有安装第三方代码。

项目 Skill 已通过官方 quick_validate.py；所需 PyYAML 仅在忽略的 data 工具目录，不是应用依赖。
