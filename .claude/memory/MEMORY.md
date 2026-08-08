---
name: youtube-monitor-state
description: YouTube Competitor Monitor 当前状态——2026-08-08 会话结束时的完整快照 (v3.1)
metadata:
  type: project
  modified: 2026-08-08T16:00:00Z
---

# YouTube Competitor Monitor — Current State (v3.1)

## 项目位置与地址

| 项目 | 地址 |
|------|------|
| **本地** | `E:\youtube-report-test` |
| **GitHub** | `https://github.com/daisielydavis-lab/youtube-brand-monitor` |
| **Railway** | `https://youtube-brand-monitor-production.up.railway.app` |
| **Supabase** | `https://supabase.com/dashboard/project/cnzctiicglcgccszeuxb` |

## v3.1 本轮改动 (2026-08-08)

### P0 Bug 修复
1. ✅ **时间筛选不生效** — `queryDashboardData` 添加调试日志 + `vidErr` 错误检查
2. ✅ **Coverage 口径错误** — 从全表 count 改为 `gte('published_at', since)` 时间窗口内计算
3. ✅ **Brand 解析链不统一** — `app.ts` + `dashboard-data.ts` 全部 10+ 处统一为 `final → rule → ai → unknown`
4. ✅ **Unknown brand 50%** — 规则引擎 v2：扩展 30+ 关键词、hashtag 检测、频道名信号、交叉信号增强

### P1 功能修复
5. ✅ **Market 全显示 Unknown** — SELECT 添加 `market,language` 列 + `resolveMarket` 链 + brandComparison 显示 topMarket
6. ✅ **Creators 口径不一致** — Overview `activeCreators` 仅计 confirmed/likely，与 Creators Tab 对齐
7. ✅ **周报品牌路径** — `competitor-report.ts` 全部 12 处旧 `detectedBrand` 路径修复 + `computeScore` 替代 `public_performance_score`

### 新功能
8. ✅ **季度竞品情报报告** — `QuarterlyReport` 接口 + `generateQuarterlyReport()` + `/report/quarterly` API
   - 6 大板块：Executive Summary / Brand Analysis / Game Penetration / Creator Ecosystem / Market Expansion / Strategic Insights
   - QoQ 对比（自动识别 rising/stable/declining/new 趋势）
   - Cron: 每季度第 2 天 08:00 UTC
9. ✅ **Comments 聚合摘要** — `/api/comments/summary` 返回购买意图率、品牌关联率、情感分布、热榜视频
10. ✅ **AI 队列自动消化** — 每日 10:00 UTC cron，默认 20 条（可通过 `AI_BACKLOG_DAILY_LIMIT=0` 关闭）

### 体验优化
11. ✅ **ContentType 标签补全** — 新增 comparison/tutorial/gameplay 映射
12. ✅ **Video actions 局部刷新** — 操作后更新当前行 DOM，不再整页 reload
13. ✅ **DB 索引 SQL 重写** — 新 brand 路径 + 新增 4 个索引（需在 Supabase SQL Editor 手动执行）
14. ✅ **默认时间范围** — `/api/dashboard` 和 `/api/creators` 从 30d 改为 7d

### 改动文件
```
src/app.ts                                         — +124 行
src/ui/dashboard.ts                                — +8 行
src/services/competitor-monitor/rule-classifier.ts — +91 行
src/services/competitor-monitor/dashboard-data.ts  — +12 行
src/services/competitor-monitor/competitor-report.ts — +476 行（季度报告 ~280 行）
supabase-migration-indexes.sql                     — 重写
```

## 架构：四层 Pipeline（不变）

```
Layer 1: 全量采集（YouTube API + 频道监控）
Layer 2: 规则引擎 v2（rule-classifier.ts，关键词+hashtag+频道名+交叉信号）
Layer 3: AI 队列（仅规则无法判断的进 priority queue + 每日 backlog cron）
Layer 4: 日报/周报/季度报告
```

## 品牌解析链（所有页面必须使用）

```
classification_raw.final.brand → classification_raw.rule.brand → classification_raw.ai.brand → 'unknown'
```

Market 解析链：
```
classification_raw.rule.market → classification_raw.ai.market → market → 'Unknown'
```

## Cron 任务

| 时间 | 任务 | AI 费用 |
|------|------|---------|
| 每日 06:00 UTC | Normal 扫描 + Campaign 检测 | 有（top 50） |
| 每 4h | Hotspot 扫描 | 按需 |
| 每日 10:00 UTC | AI 队列消化（20 条） | 有（可控） |
| 每周一 08:00 UTC | 周报生成 | 无 |
| 每季度第 2 天 08:00 | 季度报告 | 无 |

## 待手动操作

- **DB 索引执行**：在 [Supabase SQL Editor](https://supabase.com/dashboard/project/cnzctiicglcgccszeuxb) 运行 `supabase-migration-indexes.sql`
- **Push to GitHub**：本地修改待 commit + push → Railway 自动部署
- **控制 AI 费用**：在 Railway 环境变量设置 `AI_BACKLOG_DAILY_LIMIT=0` 关闭自动消化

## 本地运行

```bash
cd E:\youtube-report-test
npx ts-node src/app.ts
# http://localhost:3001
```

## 关键约束

- 本地 .env 是占位符，真实 API key 在 Railway 环境变量
- 不要随便 push → Railway 自动部署 → cron 可能触发 AI 费用
- 先本地验证，确认无误再 push
