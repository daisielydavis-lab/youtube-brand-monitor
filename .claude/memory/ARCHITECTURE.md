---
name: youtube-monitor-architecture
description: Architecture decisions, module map, pipeline flow
type: reference
---

# 架构决策

## AI 调用架构（2026-08-01 重构）

**统一客户端**: `src/services/ai/deepseek-client.ts`
- 三种模式: `fast` / `reasoning` / `max_reasoning`
- 全部使用 `deepseek-v4-flash`，通过 `thinking.type` 控制
- 模型配置唯一来源: `src/config/deepseek-models.ts`

**JSON 空内容处理**:
1. JSON mode 请求 → 空 content → 去掉 response_format 重试
2. 仍然空 → AI_EMPTY_RESPONSE，进入待处理队列
3. 禁止无限重试

## 两阶段发现管道

```
Phase 1: YouTube 发现（search.list 1次 + playlistItems N次）
    ↓
Phase 2: 全部去重后写入 DB（先入库，再 AI）
    ↓ 验证 persistedCount > 0
Phase 3: 规则打分（无 LLM）→ Top 50 进 AI
    ↓ 10条/批，deepseek-v4-flash + thinking=disabled
Phase 4: 仅 confirmed/likely 进深度分析（评论）
    ↓
Phase 5: Snapshots + Reports
```

## 模块清单

| 文件 | 职责 |
|------|------|
| `src/config/deepseek-models.ts` | AI 模型配置唯一来源 |
| `src/services/ai/deepseek-client.ts` | 统一 DeepSeek 客户端 |
| `src/services/competitor-monitor/index.ts` | 主编排器 |
| `src/services/competitor-monitor/brand-config.ts` | 品牌/搜索词配置 |
| `src/services/competitor-monitor/youtube-discovery.ts` | YouTube API 调用 |
| `src/services/competitor-monitor/video-enrichment.ts` | 评论抓取 |
| `src/services/competitor-monitor/campaign-detector.ts` | 投放活动聚合 |
| `src/services/competitor-monitor/creator-profiler.ts` | 博主画像/分类 |
| `src/services/competitor-monitor/performance-snapshot.ts` | 效果评分引擎 |
| `src/services/competitor-monitor/competitor-report.ts` | 日报/周报 |
| `src/ui/dashboard.ts` | Web 仪表盘（浅色主题） |
| `src/app.ts` | Express 服务入口 |

## 数据库表（Supabase）

- `competitor_brands` — 品牌定义
- `competitor_queries` — 搜索查询词
- `youtube_creator_profiles` — 博主画像
- `youtube_competitor_videos` — 竞品视频（核心表）
- `youtube_video_snapshots` — 指标时间快照
- `youtube_comment_insights` — 评论分析
- `campaigns` — 投放活动聚合
- `scan_logs` — 扫描运行日志
- `monitor_config` — 监控配置
