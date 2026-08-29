# 受控 Discovery 前后对比报告(task #11)

> 基线采集:2026-08-27(`production-live-status.md` 记录)。后测采集:2026-08-29,复用 `_tmp_compare.ts`(只读,与 `cli-brand-counts` / dashboard Layer3 口径一致:90 天窗口 + placement 分类)。
> 对比对象:Query Matrix P0 落地前后 —— GearUP 亚洲 4 query + LZ domain 3 query + 21 条 HIGH 身份批量入库 + similar_creator 暂停。

---

## 1. 前后对比

| 指标(90 天) | 基线 08-27 | 后测 08-29 | Δ |
|---|---|---|---|
| rows 全量 / 90 天 | — / — | 13510 / 13257 | — |
| **Layer3 投放**(校正后,见 §7) | | | |
| LagZapper | 24(校正 ≈116) | **162** | **+46**(校正后真实增量) |
| GearUP | 608(校正 ≈644) | **821** | **+177** |
| ExitLag | 1994(校正 ≈2024) | **2541** | **+517** |
| Lagofast | 11 | **7** | **−4** ⚠️ |
| **watchlist(总 / paused)** | | | |
| LagZapper | 113 | 117 / 68 | +4 |
| GearUP | 199 | 207 / 0 | +8 |
| ExitLag | 312 | 315 / 0 | +3 |
| Lagofast | 12 | 12 / 0 | 0 |
| **identities(总 / high)** | | | |
| LagZapper | 32 | 32 / 29 | 0 |
| Lagofast | 12 | 12 / 0 | 0 |
| **discovery_method** | | | |
| channel_scan | 9375 | 10602 | **+1227** |
| keyword_search | 2496 | 2581 | +85 |
| regional_query | 64 | 64 | 0 |
| domain_search | 5 | 10 | **+5** |
| **AI pending** | 1334 | **1932**(全量 1959) | **+598** |

---

## 2. 逐品牌归因

### LagZapper ≈116 → 162(+46,校正后)—— 主线奏效
最大增量来自 **08-27 批量入库的 21 条 HIGH 身份**(LZ 身份库 24→32)配合每日 channel_scan 从扩大后的 watchlist 频道反查投放。domain_search 只 +5(5→10),说明域名 query **有增量但量小**——它承担的是「补充召回」角色,符合 Query Matrix §5 定位(不堆 query,扩身份路径)。⚠️ 原始列口径「24→65」高估了增长,校正后真实增量 ≈46(见 §7)。

### GearUP 608 → 760(+152)—— 亚洲 query 已进 cron
GearUP 亚洲 4 query(ID/TH/VI/MY)已入 NORMAL_QUERIES,每日 cron 持续跑 → keyword_search 增量(85)主体来自此。regional_query 未动(64),符合预期。

### ExitLag 1994 → 2431(+437)—— 非受控轮贡献
ExitLag 没有新 query,增量全部来自每日 cron 的 channel_scan 回填。**它揭示了本对比的根本局限:数据在 cron 全量运行之下持续滚动,受控轮(一次性 7 query)的效果与 cron 叠加,事后无法隔离。**

### Lagofast 11 → 7(−4)—— 不是真实收缩,是口径问题(专项见 §4)

### discovery_method 结构
- channel_scan +1227:每日 07:30 回填是绝对主力。
- keyword_search +85、domain_search +5:受控轮 + cron 的新 query 增量,符合「补充型 Discovery」定位。

---

## 3. 受控轮的效果评估(诚实口径)

**结论:受控轮的边际增量无法从本对比中单独剥离。** 原因:
1. GearUP 亚洲 query 与 LZ domain query 在受控轮跑之前已按设计**进入 NORMAL_QUERIES**,cron 每轮都在跑同样的 query;
2. 因此本对比的 Δ 是「新 query + 身份批量入库 + cron 全量回填」的**合效应**,其中 cron 占绝对大头(LZ +41 里 domain_search 只占 +5)。

**可确认的结论:**
- ✅ domain_search 5→10、keyword_search +85 → 新 query 确有增量,不是零。
- ✅ LZ +41 证明「身份驱动 Discovery」主线正确(记忆 ground truth:90 天 200+ 已从 24 追到 65)。
- ⚠️ 若要严格评估「单次受控轮」的边际,需在 cron 冻结窗口内跑且隔离对比——本次不满足,已如实标注。

---

## 4. Lagofast 专项:11 → 7 归因

**48 条 Lagofast 品牌视频,workflow|placement 分布:**

| workflow \ placement | 条数 | 含义 |
|---|---|---|
| discovered \ unknown | **36** | AI pending(08-23 channel_scan 批次,未分类)|
| classified \ likely_sponsored | 7 | 当前 Layer3 计数的全部 |
| classified \ unknown | 4 | 规则归 Lagofast、无 AI 判定 |
| classified \ confirmed | 1 | 05-19,已滑出 90 天窗口 |

**结论:Lagofast 的 Layer3 = 7 是严重低估值,不是投放收缩。**
1. **36/48 条卡在 AI pending** → 未分类不计入 Layer3。基线 11→7 的 4 条缺口:窗口滑出 1 条(05-19 confirmed,且基线时已在窗口外)+ 4 条已分类|unknown(07-09/07-16/07-23/07-30,均无 AI 判定,疑似基线时 counted 后被重分类)→ 无历史表无法逐条对账,但方向明确:是「分类积压 + 重分类」,非真实下降。
2. **品牌归属噪音**:已分类 8 条(7 likely + 1 confirmed)里,`classification_raw.ai.brand` 为 **LagZapper ×5、GearUP ×2**,仅 1 条 AI 认 Lagofast。即这些是 **rule(域名 lagofastbooster.ru)归 Lagofast、AI 归其他品牌** 的多品牌共现视频(印证 [[boost-affiliate-ecosystem]] 多品牌联合投放)。**双向影响:既虚增 Lagofast,也可能从 LagZapper 抢走归属。**

**建议(不阻塞):** Lagofast 数字在 AI 队列消化前不可用作投放结论;品牌归属冲突(rule vs AI)列入 Query Matrix 质控项,后续可做「多品牌视频二次归属」。

---

## 5. AI backlog 积压(需决策)—— 比表面数字严重

**三层口径(2026-08-29 实测 + Railway 日志):**

| 口径 | 数量 | 说明 |
|---|---|---|
| workflow-pending(discovered+enriched) | 1383–1932 | 从未被 AI 处理;数值随扫描实时波动 |
| 其中 08-16 + 08-23 两批老视频 | **1327(96%)** | 卡了近一周,rule 都没跑过 |
| **真实 AI 队列(discovered + classified\|needsAI)** | **≈4000** | Railway 日志 `[Retry] remaining=4001` |

**确诊**:每日 10:00 UTC backlog cron **在运行**,但每次只消化 **100 条**(`AI_BACKLOG_DAILY_LIMIT` 默认值,prod 未覆盖)。按 4000 存量计,**仅靠 cron 需 ~40 天清空**,且新视频持续涌入 → 净积压。

**后果**:新投放视频的 Layer3 计数长期滞后——Lagofast 36/48 条 pending 直接把 Layer3 压到 7,就是直接证据。

**选项**(需用户拍板,见任务 #3):
- A. **调大 `AI_BACKLOG_DAILY_LIMIT`**(如 100→300),~2 周追平。DeepSeek flash 单价低,4000 条 ≈ 数千次 flash 调用,成本可控。
- B. 一次性批量消化(手动跑一轮大 limit)。
- C. 维持现状(成本不变,Layer3 失真持续扩大,尤其新品牌)。

---

## 6. 结论

1. **Discovery 方向正确**:LZ 校正后 116→162(+46)继续逼近 ground truth;domain/亚洲 query 有增量但小,cron 是主力。
2. **生产验证稳定,可解除部分冻结**:LZ 域名变体(§5b,已确认无需改动)、Multi-brand Crossover(§6)可考虑重启设计——但先处理 AI 积压,否则任何投放结论都建立在滞后的 Layer3 上。
3. **Lagofast 数据不可用**,需先消化 pending + 定归属规则。

---

## 7. 校正:canonical_brand 回填缺口(2026-08-29)

**发现**:158 条 confirmed/likely 投放视频(LZ 92 / GearUP 36 / ExitLag 30)`canonical_brand` 列为空(有 `classification_raw.ai.brand`,但 `raw_brand`/`canonical_brand` 两列未回填)——历史 AI 写回路径未落列。`data-scope.resolveBrand` 有 ai 回退兜底所以 **dashboard 一直是对的,只有按列统计的脚本低估**。

**处置(用户已拍板「定向回填」)**:只补 null、不碰已有归属(含 8 条 Lagofast/LagZapper 冲突行)。已执行 158 条全部写库成功,残差 0。

**口径修正**(列口径 → resolveBrand 等效口径):
| 品牌 | 基线列口径 | 基线校正 | 后测(回填后) | 真实增量 |
|---|---|---|---|---|
| LagZapper | 24 | ≈116 | **162** | **+46** |
| GearUP | 608 | ≈644 | **821** | **+177** |
| ExitLag | 1994 | ≈2024 | **2541** | **+517** |
| Lagofast | 11 | 11 | **7** | −4 |

> 基线校正 = 08-27 列口径 + 回填的存量行(全在更宽的基线窗口内)。LZ 原始「24→65」是高估口径的假增量,真实增量 ≈46。

**§5b 结论(顺带)**:lagzapper.gg/.net/.io/.app/.ru 全库 0 命中,只有 lagzapper.com 真实使用 → extractor 已内置变体,无需改动。

**遗留**:16 条 confirmed/likely 但 AI 无品牌(真正 unresolved,非回填范围)。

相关:`_tmp_compare.ts`(采集脚本,保留)、[[production-live-status]] [[affiliate-discovery-validation]] [[b-phase-identity-evidence]]
