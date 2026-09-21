# Miko 状态

安装 koma-miko@0.1.0-alpha.11 (MIT)，来源 https://github.com/swnotmetal/Project-Koma/tree/main/packages/koma-miko 。已读官方 README 后执行 init --host codex --enforce，并配置项目内 order-review Skill，只覆盖 domain、workflow、erp 三个关键文件。

doctor --host codex --strict：配置和 Skill 发现通过，但没有 live runtime heartbeat。**尚未激活**。需要用户在此目录打开 Codex CLI，执行 /hooks，查看并信任五个 Hooks，运行一轮，再运行 doctor。不会自动修改信任。Desktop-only onboarding 不在官方 alpha 支持路径内。此状态不阻止业务开发。
