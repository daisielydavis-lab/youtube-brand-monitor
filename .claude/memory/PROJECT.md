---
name: youtube-monitor-project
description: YouTube Competitor Brand Monitor — project identity, URLs, tech stack
type: project
---

# YouTube Competitor Brand Monitor

监控 GearUP / ExitLag / LagZapper 三个游戏加速器竞品在 YouTube 上的 KOL 投放活动。

## 项目位置
- **本地目录**: `E:\youtube-report-test`
- **GitHub**: `https://github.com/daisielydavis-lab/youtube-brand-monitor`
- **Railway 项目**: `https://railway.com/project/abc6ef3e-de34-454d-ad2f-515a62dc64fb`
- **Railway 服务**: `https://railway.com/project/abc6ef3e-de34-454d-ad2f-515a62dc64fb/service/8e48f1d6-56f4-4071-8f9a-cdb5755be05d`
- **Railway Variables**: `https://railway.com/project/abc6ef3e-de34-454d-ad2f-515a62dc64fb/service/8e48f1d6-56f4-4071-8f9a-cdb5755be05d/variables`
- **Railway URL**: `https://youtube-brand-monitor-production.up.railway.app`
- **Supabase**: `https://supabase.com/dashboard/project/cnzctiicglcgccszeuxb`

## 技术栈
- TypeScript + Express + node-cron（Railway 部署）
- Supabase（PostgreSQL，6 张核心表）
- YouTube Data API v3（search.list + videos.list + channels.list + playlistItems.list + commentThreads.list）
- DeepSeek V4 Flash（通过 thinking.type=disabled 控制推理模式）

## API 配额
- search.list: 100 次/天（独立配额桶），每次调用 100 units
- 常规读取（videos/channels/playlistItems/commentThreads）: 10,000 units/天
- 配额在太平洋时间午夜重置（北京时间约 15:00）

## 关键约束
- search.list 配额极度紧缺，只能用作"发现入口"
- 已知博主通过 playlistItems.list 监控（不消耗搜索配额）
- 每次 search.list 只取第一页（maxResults=50），不翻页
- 429 错误立即熔断，不继续消耗配额
- AI 输出不能表述为 ROI / CPA / 转化率 — 只能叫 Public Performance Score
