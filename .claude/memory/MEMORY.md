# YouTube Competitor Monitor — Memory Index

- [项目概览](PROJECT.md) — 项目位置、技术栈、API 配额
- [架构设计](ARCHITECTURE.md) — AI 客户端、管道、模块清单、数据库
- [已知问题](KNOWN-ISSUES.md) — 阻塞问题、修复状态、待办

## 会话摘要 (2026-08-01)

### 完成的
- ✅ 项目从零搭建，含 Express + Supabase + YouTube API + DeepSeek
- ✅ DB 6 表迁移完成，342 条视频成功持久化
- ✅ DeepSeek V4 Flash 统一客户端，thinking disabled 确认生效
- ✅ 50 条 AI 分类成功，ExitLag 大规模 #exitlagaffiliate 投放已被识别
- ✅ 空状态 UI 迭代 4 版，最终采用清爽科技蓝风格

### 进行中
- 🔄 Dashboard /api/dashboard 接口优化中（已推送内联版本，待验证）
- 🔄 前端 shell + AbortController 超时机制

### 下一步
1. Railway 部署 8b8b06f 后打开首页验证数据
2. 执行 supabase-migration-indexes.sql
3. 搜索配额明天重置后跑完整扫描
4. retry-classification 处理剩余 292 条
