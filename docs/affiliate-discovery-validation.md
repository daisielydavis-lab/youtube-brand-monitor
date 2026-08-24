# Affiliate Discovery 验证报告（2026-08-24）

> 竞品投放发现 = **Search + Creator Network + Affiliate Identity**。
> Search 只是 Discovery 的一层（Search Discovery / Domain Discovery / Creator Discovery /
> 未来: similar_creator、comment signal）。本报告记录验证结果与产品化落地。

## 1. 链路验证（小规模，未跑完整扫描）

闭环: `domain_search → affiliate extractor → affiliate_identity → watchlist → channel_scan`
（`npm run validate:chain`，2 次 search 调用，只写新数据，不调 AI）

| 指标 | 结果 |
|---|---|
| ① domain_search 新落库 | 3/3（回查确认 = domain_search） |
| ② 已存在行 discovery_method 漂移 | **0**（修复有效，不再被 channel_scan 覆盖） |
| ③ 新增 affiliate_identity | +2：`dropz`（cid=148, conf=1.0, code=DROPZ）、`Home Of Games`（cid=147, conf=1.0） |
| ④ watchlist 新增 | +2（discovered_via=affiliate_cluster） |
| ④ channel_scan 新增视频 | +37（含 LagZapper 信号 4） |
| ⑤ domain_search → channel_scan 覆盖 | **0**（期望 0） |

**结论**: 链路闭环成立，且发现了已知身份集之外的 **2 个新 cid（147/148）+ 新 promo code DROPZ**，
支持「~198 个 affiliate 槽位」的创作者网络假设。品牌证据必须用 **cid+domain**（promo_code 跨品牌复用，
实测 KEEKING 同时投 LagZapper cid11 和 Lagofast cid891453）。

## 2. Affiliate Discovery 产品化（3 项，已上线）

### ① 联盟身份 Dashboard（`/api/affiliate-identities` + 「联盟身份」tab）
每品牌 Creator | CID | Code | 域名 | 信号 | 置信度 | 视频数。
视频数 = 池内该 creator 的 description 含其 code/cid/domain 信号的视频数。

- **LagZapper: 18 身份**（`keking cid=11 KEKING ×52`、`dropz cid=148 DROPZ ×20`、`Home Of Games cid=147 ×1` 等）
- **Lagofast: 12 身份**（域名为唯一信号 conf=0.7，CID/Code 显示 —，待回溯源补齐）

### ② Creator 来源透明化（`/api/creator-sources` + 投放博主 tab「来源」列）
解析规则: watchlist.discovered_via 优先（affiliate_cluster / video_backtrace / manual_seed / ai_confirmed / similar_creator），
不在 watchlist 的 creator 按最早视频 discovery_method 归 search（keyword/domain）/ watchlist（channel_scan）。

当前分布（验证时快照）:

| 品牌 | total | 分布 |
|---|---|---|
| ExitLag | 357 | search 93 · ai_confirmed 258 · watchlist 6 |
| GearUP | 165 | search 27 · ai_confirmed 137 · watchlist 1 |
| LagZapper | 94 | similar_creator 64 · ai_confirmed 13 · video_backtrace 12 · manual_seed 3 · affiliate_cluster 2 |
| Lagofast | 12 | affiliate_cluster 12 |

> ⚠️ 观察: LagZapper 的来源大头是 similar_creator（64/94），但此前 similar_creator 跨界扫描
> 产出 0 有效投放（0/60）。来源透明化把这个问题直接暴露出来了 —— 可作为 Query Matrix 阶段的
> 质控项：similar_creator 进 watchlist 的通道是否真的有效。

### ③ 置信度过滤（顶部筛选器「置信度:全部/高/中/低」）
`conf` 参数贯穿 dashboard / creators / campaigns / comments。分桶用 brand_confidence 列（P0-1 口径）:

- **高** ≥ 0.9（强信号 / AI 高置信）
- **中** 0.7–0.9（域名规则命中）
- **低** < 0.7 或 null

Lagofast 实测: 52 条全部 0.7–0.9（域名规则）→ 高=0 / 中=52 / 低=0。
**切「高」= 剔除新品牌规则命中的数据膨胀**；切「中」才看得到全部规则命中。

## 3. 数据口径（全库品牌置信度分布）

| 品牌 | 总数 | ≥0.9 | 0.7–0.9 | <0.7 | null |
|---|---|---|---|---|---|
| ExitLag | 3162 | 781 | 1782 | 77 | 522 |
| GearUP | 727 | 281 | 367 | 12 | 67 |
| LagZapper | 29 | 14 | 11 | 0 | 4 |
| Lagofast | 52 | 0 | 52 | 0 | 0 |

## 4. 下一步（Query Matrix 方向，暂不扩大规模）

- **LagZapper**: 保留现有 query，加少量针对「发现新 affiliate 身份」的 query（非全量召回）。
- **GearUP**: 继续 Query Matrix（区域 / 语言 / 品牌词）。
- **ExitLag**: 维持现状。

核心 KPI 仍是 **Recall**（Discovery Coverage 基准），产品化后可通过「来源分布」观察每条 Discovery
通道的真实贡献，决定 Query Matrix 的钱往哪条通道投。
