# Lagofast Discovery 专项修复设计(task #4c)

> 触发:用户判断 Lagofast 90 天只有 11 条 Layer3 **不是 AI 分类问题,是 Discovery 层召回缺口**——
> LagoFast 是四品牌里文本最易发现的(品牌名/域名直接进标题描述),系统却只找到十几条,
> 说明搜索层根本没在跑。策略:把 LagoFast 当整个监控系统的**校准品牌**——
> 它是唯一真实投放量可知的品牌(文本易发现 + 品牌名自描述),等它 Recall 到 90%+,
> 再谈信任 GearUP/LagZapper 的数字。
> 状态:Phase A(只读审计 + probe)已完成,增量已确认;Phase B 待用户确认后实施。

---

## 1. Phase A 审计结果(2026-08-29,0 写库)

**现状基线(90 天 Layer3 = confirmed/likely + resolveBrand):**

| 品牌 | 90天 Layer3 | 说明 |
|---|---:|---|
| ExitLag | 2541 | 文本易发现 + query 多年积累 |
| GearUP | 820 | 多市场 query(含亚洲 4 国) |
| LagZapper | 160 | domain query 突破后 |
| **Lagofast** | **11** | **无任何专属 query** |

**Lagofast 信号视频怎么进来的(全库 58 条):**
- `channel_scan` 49 / `keyword_search` 5 —— **91% 靠 watchlist 频道扫描**,搜索层几乎零贡献
- **50/58 是 description-only 命中**(只有 8 条 title 含品牌词)——正是 lago-fast 描述链接形态,
  只有域名/全局搜索能捞到
- Layer3 的 11 条来自 **5 个 creator,全部已在 watchlist** → watchlist 机制对已知 creator 有效,
  问题是搜索层从不发现新 creator

**NORMAL_QUERIES 现状:18 条 query 全属 GearUP/ExitLag/LagZapper,Lagofast 0 条**
(branded / sponsored / domain / regional 全无)。这是漏抓的直接根因。

## 2. Phase A 只读 probe(4 条全局 query,52 次 search 调用,0 写库)

查询不带 `regionCode`/`relevanceLanguage`(全局召回),90 天按 7 天窗口扫描:

| query | unique | 库内已有 | 库外新候选 | title 含信号 | 满页窗口 |
|---|---:|---:|---:|---:|---:|
| `LagoFast` | 564 | 8 | 556 | 315 | **9/13 饱和** |
| `"Lago Fast"` | 29 | 0 | 29 | 6 | 0 |
| `lagofast.com` | 429 | 10 | 419 | 208 | 0 |
| `lago-fast.com` | 197 | 3 | 194 | 126 | 0 |
| **去重合计** | — | — | **726** | **371** | — |

- **726 条库外新候选 / 292 个新 creator**。当前库内 Lagofast 信号视频仅 54 条 → 覆盖约 7%。
- `LagoFast` 品牌 query **9/13 窗口满 50 还有下一页** → 7 天粒度都扫不穿,真实 90 天量保守 **1000+**。
- 多国证据:RU(ИГРАЙ С LAGOFAST)/ TH(ทำ Pokemon Champions ด้วย LagoFast)/ TR(ลagofast indirim kodu "uskolous")/
  VN/PL/DE/BR 均出现大批库外投放频道,单 creator 4-6 条。**全球投放规模真实存在,系统完全没抓到。**

**结论:Discovery Recall ≈ 5-7%(54/1000+)**,远低于可信任阈值。作为校准品牌的 Lagofast 验证了
系统的搜索层对文本易发现品牌都严重漏抓 → **GearUP/LagZapper 的数字同样被系统性低估**。

## 3. Phase B 修复设计

### B1 — `searchVideosPaged` 支持全局 query(无 regionCode/relevanceLanguage)
`youtube-discovery.ts:83` 现写死 `params.regionCode = query.targetMarket; params.relevanceLanguage = query.targetLanguage`。
改:`BrandQuery` 加 `global?: boolean`;`targetLanguage/targetMarket` 改可选;`global` 时跳过这两个参数。
现有 18 条 query 不受影响(仍传 region/language)。

### B2 — 4 条全局 query 进 NORMAL_QUERIES(长期日常)
```
{ brandName: 'Lagofast', queryText: 'LagoFast', queryType: 'branded', global: true },
{ brandName: 'Lagofast', queryText: '"Lago Fast"', queryType: 'branded', global: true },
{ brandName: 'Lagofast', queryText: 'lagofast.com', queryType: 'domain', global: true },
{ brandName: 'Lagofast', queryText: 'lago-fast.com', queryType: 'domain', global: true },
```
日常扫描(backfillDays=1,maxPages=2)成本极低(~4 calls/天),持续抓新视频。
历史 90 天由 B4 一次回填。**暂不加 regional query**(全局先跑,看结果再定 RU 补充)。

### B3 — hostname 规范化(已满足,补回归测试)
现有识别链路已满足你的要求:
- extractor `lower.includes(bd)` 子串匹配 → `www.`/protocol/path/query 天然不影响识别
- `canonicalBrand` 变体表(lagofast.com / lago-fast.com / lago fast / lagofastbooster → Lagofast)
- rule-classifier BRAND_RULES 已含 4 域 + lago-fast keywords
**动作**:回归测试锁死——`www.lagofast.com/?cid=x`、`https://lago-fast.com/path?q=y`、`www.lago-fast.com`
均归 Lagofast;`my-lago-fast.xyz` 不误报。

### B4 — Lagofast-only 90 天 backfill(不重跑其他品牌)
- `cli-discover.ts` 加 `--brands Lagofast` 过滤 → `runDiscoveryPipeline({ mode:'backfill', backfillDays:90, queries:[4条] })`
- 断点续跑机制天然适配:backfill_windows 按 query_text 记录,4 条新 query 全 pending,
  其他品牌窗口 completed 不动 → **只回填 Lagofast**
- `LagoFast` 饱和 query 走动态分窗(7→3→1 天),预算按剩余窗口均分(日预算 70 内),
  预计摊 2-3 天完成
- 新候选插入为 `discovered` → 规则层先判(明确信号免 AI)→ 少数 needsAI 进 AI 队列(300/天)

### B5 — watchlist 自动入列(免费获得,无需新机制)
`index.ts:204-206` 已有:AI 确认 confirmed/likely + 品牌 → `upsertWatchlistCreator(brand, 'ai_confirmed')`。
backfill 的视频经规则/AI 确认后,creator **自动**进 Lagofast watchlist;
日常 channel_scan 随后扫其 uploads playlist 覆盖历史 → 第 6 点闭环。

### B6 — 回归测试扩展
- 全局 query 构造:BrandQuery.global=true → search params 不含 regionCode/relevanceLanguage
- 域名规范化断言(见 B3)
- `npm run test:lagofast` 保持全绿

## 4. 决策记录(用户 2026-08-29 拍板)

1. **Ground Truth**:无内部名单 → Recall 用代理估算(probe saturation + 域名 query 完整性,≈5-7%)。
2. **backfill 范围**:**全量 726 条**。按"全量候选入库 + 分批 enrichment/classification"执行:
   726 → 去重 → 补全 title/description/channel/published_at → 以 Candidate 身份入库
   (discovery_method = global_brand_search / domain_search)→ rule classifier → 高置信直接判
   → 模糊项进 AI → confirmed/likely/organic/unknown。**726 不得直接计入 placements**,必须走正式分类流程。
3. **query 归属**:进 NORMAL_QUERIES(日常持续抓新 + 一次 90 天 backfill)。
4. **regional 补充**:全局跑完再看 RU 缺口决定,本轮不加。
5. **保护条件**:title 信号与 description-only 均保留来源标签(discovery_query_id + 内容信号位置);
   分批处理(250-300/天,失败可重试);已存在 video_id 只补内容,不覆盖 first_seen_at/discovery_method/classification;
   AI 日限;规则能确定的送 AI。
6. **漏斗对账**:726 → enriched → rule confirmed → AI reviewed → confirmed/likely → unique creators
   → watchlist additions,并分别统计 title-signal 与 description-only 转化率。

## 5. 执行顺序(遵循"暂停新增其它功能")

1. 代码:B1(global 支持) + B2(NORMAL_QUERIES 4 条) + cli `--brands` + B6 测试
2. 本地验证:tsc 0 错误 + test:lagofast 全绿
3. push → Railway 自动部署 → Online 确认
4. `--brands Lagofast --days 90` 正式 backfill(断点续跑,2-3 天摊完)
5. 回填视频走规则/AI → creator 自动进 watchlist → channel_scan 扫 uploads
6. 重跑 Audit:confirmed+likely 数、discovery_method 分布、unique creator、与 watchlist 对比

## 6. 实施状态(2026-08-29 已部署)

**代码改动**(已提交 c8794a7 + 9387180):
- `brand-config.ts`:BrandQuery 加 `global?: boolean`,targetLanguage/targetMarket 改可选;
  NORMAL_QUERIES 加 4 条 Lagofast 全局 query(LagoFast / "Lago Fast" / lagofast.com / lago-fast.com)。
- `youtube-discovery.ts`:新增 `global_brand_search` discovery_method;抽 `buildSearchParams` 纯函数
  (global → 不带 regionCode/relevanceLanguage);域名/全局/关键词三分归因。
- `creator-source.ts`:METHOD_TO_SOURCE 加 `global_brand_search: 'search'`。
- `index.ts` insert:workflow_status 移入新行分支(已存在行不重置 workflow/classification,防重命中覆盖)。
- `cli-discover.ts`:`--brands` 过滤(Lagofast-only backfill 入口)+ `--mode backfill` 解析
  (此前只认 --hotspot/--manual,导致 backfill 实际跑成 normal 1-day 扫描)。
- `app.ts`:bySearch 搜索系含 global_brand_search/domain_search;
  07:30 auto-backfill cron 加 `BACKFILL_BRANDS=Lagofast` env 门控(回填窗口内只续跑 Lagofast,
  不动其他品牌 pending 窗口;解除变量即恢复全品牌续跑)。
- 回归测试 16 项全绿(hostname 规范化 6 项 + typosquat 误报有界 + 全局 query 参数 + NORMAL_QUERIES 4 条)。

**backfill 现状(2026-08-29):**
- 4 条 Lagofast query 窗口已创建,各 14 pending(共 56,90 天按 7 天切片)。
- Railway 已设 `BACKFILL_BRANDS=Lagofast`,07:30 auto-backfill cron 只续跑 Lagofast。
- 今日 YT quota 被 probe 耗尽的教训:06:00 normal(全品牌 ~44 calls)占用后剩 ~26 calls 给 07:30,
  56 窗口按剩余预算均分 → 预计 2-3 天摊完(与"按 2-3 天 batch 自然摊开"一致)。

## 8. 429 可靠性修复 + completion-gate 漏斗(用户 2026-08-29 追加重申)

**429 修复(最小 infra,已随本次部署):**
- `youtube-discovery.ts`:HTTP 429 + reason=rateLimitExceeded/quotaExceeded(或 403)统一映射为
  `YT_QUOTA_EXHAUSTED`,立即熔断、不重试。此前 429 rateLimitExceeded 被当瞬时 QPS 重试 3 次后
  抛 `YT_RATE_LIMITED`(不打熔断)→ 窗口 mark failed + ~14 分钟重试风暴,次日不自动 resume。
  非配额类 429(瞬时 QPS)保留短退避(坑 #23 兜底)。
- `index.ts`:backfill 窗口 catch 中 `YT_QUOTA_EXHAUSTED` → 窗口 mark `quota_paused`(非 failed),
  quota reset 后由现有 resume 机制次日续跑。其余错误仍 mark failed。
- 不改其他 discovery 逻辑。

**completion-gate + 漏斗对账(不用固定日期):**
- 门槛:56 窗口全部离开 pending/running,且 failed/quota_paused/partial = 0 才跑漏斗。
  门槛未满足只输出窗口状态,不产出"看似完整实则没收完"的结果。
- `src/audit-lagofast-funnel.ts`(提交版):`--gate` 只查门槛 / 默认全量漏斗:
  candidates → enriched → rule classified → AI reviewed → confirmed/likely
  → unique creators → watchlist additions;title-signal / description-only 两组转化率;
  验收加项 = Discovery source contribution(global_brand_search/domain_search/channel_scan…)
  + 90 天最终 unique placements + unique creators。
- 精确归属:insert 新行新增 `discovery_query_id` 落库(按 query_text 查 competitor_queries.id),
  漏斗按 discovery_query_id 区分 global_brand_search/domain_search 归属,避免与 LagZapper
  domain_search 混淆。
- PostgREST 坑:`in()` 对含引号的 query_text("Lago Fast")解析少行 → 全量拉取 + JS 过滤。

## 7. 预期对账(backfill 后 90 天)

| 指标 | 现在 | 预期 |
|---|---:|---:|
| Lagofast Layer3 | 11 | 数百级(按 probe 371 title 含信号 + description-only) |
| Lagofast unique creator | 5 | 100+ |
| discovery_method 分布 | channel_scan 91% | keyword_search/domain_search 占多数 |
| 其他品牌 | 不变 | 不变(未触碰) |

相关:[[production-live-status]] [[lagzapper-affiliate-creator-network]] [[domain-search-breakthrough]] [[boost-affiliate-ecosystem]]
