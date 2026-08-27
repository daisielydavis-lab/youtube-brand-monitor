# Query Matrix 设计稿 — 补充型 Discovery（2026-08-26）

> 状态：**已拍板并随本次部署执行（2026-08-27）。** P0 已落地：similar_creator 暂停（935cc19）＋ GearUP 亚洲 query 入库 ＋ TW experimental ＋ hashtag/stopword 硬化（随本 commit）。audit 证据表已产出 21 条 HIGH 待部署后批量入库。
> 背景：round-1 similar_creator 0/60、b1 crossover 0/9 已验证「普通 creator 相似度」无效；
> domain 搜索突破证明「搜索会索引 description」，但 LZ 关键词搜索仍结构性漏抓（标题无品牌）。

---

## 1. 定位转变：Query Matrix = 补充型 Discovery

之前隐含假设是「一套 Search 方法覆盖所有品牌」。经过 LZ 验证，这个假设不成立：

- **Search 只是四层之一**：Brand Search / Domain Search / Affiliate Network / Regional Query Matrix。
- Query Matrix 只对「搜索能抓到的品牌」负责，不再作为所有品牌的统一主 Discovery。
- 每品牌按 Discovery Strategy 分配资源（见 §3）。

**评估工具已就位（本次 C 阶段落地）**：
- `recall:diag`（cli-recall-diagnostics.ts）—— 改 query 前先量化每条 query 的召回增量，禁止拍脑袋加 query。
- `audit:discovery`（cli-discovery-audit.ts）—— 已知 code/cid 反查隐性投放，量化覆盖缺口。
- `brand:counts`（cli-brand-counts.ts）—— 90 天品牌信号基线。

---

## 2. similar_creator 暂停（experimental → paused）

**依据**：
| 轮次 | 候选 | 扫描 | LZ 命中 | 结论 |
|---|---|---|---|---|
| round-1 | 60 频道 similar_creator | 396 视频 | **0** | 普通 creator 相似度太宽泛 |
| b1 | 9 个 boost-affiliate 候选 | — | **0** | 跨界方向对但池子太薄 |
| LZ 来源分布 | 94 来源里 similar_creator 64 | — | — | 占大头但贡献为 0 |

**落点（拍板后执行，不改实现、只停投入）**：
1. `cli-affiliate-seed.ts:143` `NEW_SOURCES` 移除 `'similar_creator'`（保留 `video_backtrace` / `affiliate_cluster`）。
2. 已入池 similar_creator 频道全部置 `status='paused'`：
   - round-2 已冻结 60 个（可逆，保留）。
   - b1 的 9 个候选 `discovered_via='similar_creator'` → 同步置 paused。
3. 展示层保留：`creator-source.ts` 枚举 / dashboard 标签不删 —— 历史数据照常显示，只是不再新增来源。

**未来重启用条件**：相似度特征从「频道/内容」升级为「商业关系」后才考虑（见 §6），否则保持暂停。

---

## 3. 每品牌 Discovery Strategy

| 品牌 | 主发现方式 | 补充方式 | Query Matrix 角色 | 现状缺口 |
|---|---|---|---|---|
| **ExitLag** | Brand Search（Search-led，2049 确认/疑似） | Regional Query | 维持现状 | — |
| **GearUP** | Regional Query + Creator（646） | Domain / Affiliate | **重点：亚洲市场** | 无亚洲 query |
| **LagZapper** | Affiliate + Domain + Watchlist | 少量 Brand Search | 补充 | 身份池小：~198 槽位只认识 14 cid |
| **Lagofast** | Affiliate + Known Creator | Crossover（暂缓） | 待定 | 刚上线，身份池薄 |

原则：**每条 query 进 NORMAL_QUERIES 前必须过 recall:diag，证明有增量。**

---

## 4. GearUP：重点补亚洲市场

- 现状：NORMAL_QUERIES 只有 en/US、ru/RU、pt/BR 三市场。
- GearUP 主推东南亚（ID/TH/VN/PH），KOL 投放主力在亚洲。
- **方案（先验证后入库）**：用 recall:diag 跑一组 GearUP 亚洲探针
  （`GearUP gear up` / `GearUP promo` × id/th/vi 语言市场），量化命中，
  有证据的 query 才进 NORMAL_QUERIES。不做拍脑袋加 query。

---

## 5. LagZapper：少量新身份发现（不堆 query）

原则：**「少量」= 扩身份发现路径，不是扩 query 量**。LZ 关键词搜索已验证结构性漏抓，继续堆 query 无意义。

方向（全部身份驱动）：
- **a. 反向扫描入身份库**：`audit:discovery` 已能找出「已知 code/cid 出现在非信号视频」的隐性投放候选 → 逐条人工确认后入 `affiliate_identities`。
- **b. 域名变体探测**：确认 lagzapper.gg / .net / .io / .app / .ru 是否真实被使用，决定是否纳入 extractor 的域名规则。
- **c. affiliate_cluster 持续跑**：同 code 跨频道 = 同一 affiliate campaign，身份聚类扩池（已在 NEW_SOURCES，保留）。

---

## 6. Multi-brand Creator Crossover（D 的重定义，暂缓）

**取代 similar_creator 的不是「同领域 creator 跨界」，而是「多品牌投放历史」。**

- 定义：**投过 ≥2 个网络优化器品牌**（Lagofast / GearUP / ExitLag）的 creator → 拿去查 LagZapper。
- 依据（DB 已证实的多品牌 creator）：keking（LZ + Lagofast）、Chixpixx（1 LZ + 11 Lagofast）、ry6ka（12 LZ + 3 Lagofast）、TherionGames（7 LZ + 4 其他）。
- 数据来源：跨品牌 watchlist / affiliate_identities 交叉。
- 与 similar_creator 的本质区别：**用商业行为历史，而非内容/频道相似度**。
- 状态：**暂缓**。等本设计拍板 + Lagofast 身份池再厚一点再立项。

---

## 7. 落地清单（等拍板后执行）

**P0（本设计拍板后）：**
- [x] similar_creator 暂停：NEW_SOURCES 移除 + b1 的 9 个候选置 paused（`935cc19`，2026-08-26）
- [x] recall:diag 跑 GearUP 亚洲探针 → 有证据的 query 进 NORMAL_QUERIES（ID/TH/VI/MY 入库；TW 弱 → EXPERIMENTAL weekly）
- [~] audit:discovery 跑一轮 → 证据表产出 13 creator / 21 条 HIGH；**批量入库待部署成功后执行**

**P1（后续）：**
- [ ] 域名变体收录确认（§5b）
- [ ] Multi-brand Creator Crossover 细化设计（§6）

---

## 需要用户拍板的点（2026-08-27 决议）

1. **similar_creator 暂停落点** → 已认可并落地（`935cc19`，b1 的 9 个候选同步置 paused）。
2. **GearUP 亚洲** → 先探针后入库：探针证实每市场 14-23 新 creator，4 条 query 入 NORMAL_QUERIES；TW 探针弱 → 放 EXPERIMENTAL weekly 观察。
3. **LZ 身份发现** → a（audit 反向扫描）已产出 21 条 HIGH 待拍板入库；b（域名变体）/c（affiliate_cluster）冻结至生产追平后。
4. **Multi-brand Crossover** → 暂缓立项，等生产追平 + Lagofast 身份池更厚。
