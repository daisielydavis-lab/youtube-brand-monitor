---
name: youtube-monitor-issues
description: Known issues, debugging status, pending fixes
type: project
modified: 2026-08-01T14:15:00Z
---

# 已知问题与待修复

## ✅ 已修复

### 视频不持久化（brand_id NOT NULL）
- 修复：Supabase SQL `alter column brand_id drop not null`
- 验证：persisted=342 dbConfirmed=342

### AI 分类全部失败
- 根因：deepseek-v4-flash 未显式关闭 thinking + JSON mode 偶发空 content
- 修复：统一客户端 `thinking: { type: "disabled" }` + JSON mode 空内容降级重试
- 验证：5 批全成功，reasoning=0r，已分类 50 条

### Dashboard 接口超时
- 根因：getDashboardData() 重型函数卡住
- 修复：改为内联 handler，单次 Supabase 查询 + Node.js 内存聚合
- 状态：已推送，待 Railway 部署后验证

## 🔴 待处理

### Dashboard 页面验证
- Railway 部署 8b8b06f 后刷新首页，验证数据展示
- 如仍空白，查 Railway Logs 中 `[Dashboard:xxxxx]` 行

### 前端 shell 状态
- 加了 AbortController 10s 超时 + Retry 按钮
- 需验证：超时后是否正确显示 Retry

## 🟡 低优先级

### 搜索配额
- 今天已用完，明天 15:00 北京时间重置
- 不影响频道直监

### 292 条视频待分类
- `POST /api/monitor/retry-classification?limit=50` 可继续处理

### DB 索引
- `supabase-migration-indexes.sql` 待执行
