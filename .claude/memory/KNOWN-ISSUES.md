---
name: youtube-monitor-issues
description: Known issues, debugging status, pending fixes
type: project
---

# 已知问题与待修复

## 🔴 当前阻塞：视频未持久化

**状态**: 已定位，等 SQL 修复 + 部署

**根因**:
1. `youtube_competitor_videos.brand_id` 有 NOT NULL 约束，保存时 brand_id=null 导致插入失败
2. 代码未检查 Supabase upsert 返回的 error
3. 内存计数 ≠ 数据库实际数量，UI 误导

**修复**（已推送 bb6901c）:
1. ~~每条 upsert 加 try/catch + error logging~~
2. ~~保存后从 DB count 验证实际数量~~
3. ~~persistedCount=0 → scan FAILED，停止 AI~~
4. ~~添加 persistedCount 到 scanState~~

**待用户操作**:
在 Supabase SQL Editor 执行:
```sql
alter table public.youtube_competitor_videos alter column brand_id drop not null;
```

## 🟡 AI 分类无结果（已修复，待验证）

**历史**: 早期扫描中 AI 全部返回 no valid result
**原因**: deepseek-v4-flash 未显式关闭 thinking + JSON mode 偶发空 content
**修复**: 
- 统一客户端 thinking.type=disabled
- JSON mode 空 content 自动降级重试
- 模型名统一为 deepseek-v4-flash（不再混用 deepseek-chat）

## 🟡 YouTube 搜索 429（配额限制）

**现象**: 6 个搜索全部 429
**原因**: 100 次/天配额用完（早期测试消耗）
**修复**: 第一个 429 后电路熔断，后续搜索跳过
**恢复**: 每天太平洋时间午夜重置

## 下一步

1. 用户在 Supabase 修 brand_id 约束
2. Railway 部署 bb6901c
3. 重新 Run First Scan — 验证视频持久化 + AI 分类
4. 第一次成功后建立基础数据
