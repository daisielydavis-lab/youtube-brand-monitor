# LagZapper KOL Tracking Matcher — 设计（2026-08-29 v1）

> 状态：设计稿，待确认。今天的 Search 锁死到 08-30 07:00 UTC，本轮全部工作只读 / 不消费 quota。

## 1. 语义：不是 "affiliate"，是 KOL tracking identifier

用户口径：**参考 LagoFast backfill 范式，但不复制 "affiliate" 语义**。

- LagoFast 范式 = 全库扫描 → 域名归属 → 写一条 `domain` 单信号身份（0.7）。它的语义是"域名归品牌"。
- LagZapper 的语义 = 视频描述里携带的 **cid / promo code / ref / utm_campaign 都是同一个创作者/KOL 的身份观测**，四种形态可能指向**同一个 KOL**。匹配器要做的不是"找 affiliate 商家"，而是 **识别并统一"这个 KOL 是谁"**。

核心产物 = 一个归一化的 **KOL 身份标识**：`{brand, domain, cid, promoCode, refId, utmCampaign, handle}`，以及"多个信号形态 → 同一个 KOL"的解析逻辑。

## 2. 信号形态与 DB 实测（cli-lz-tracking-audit，2026-08-29）

| 形态 | 提取位置 | 去重计数 | 品牌证据强度（B 阶段口径） |
|---|---|---|---|
| `domain` lagzapper.com | URL host | 192 视频全为 lagzapper.com（.gg/.net/.io/.app/.ru **零命中**） | 弱（单独只能 0.7 兜底） |
| `cid` | URL 参数 | 32 种 | **必须 cid + lagzapper 域名**才算 HIGH（cid 非品牌专用，见 [[boost-affiliate-ecosystem]]） |
| `promo code` | URL `code=` 参数 + 正文 prose | 13 种 | **必须 code + lagzapper 域名**才确认（KEEKING 跨品牌 case） |
| `ref` / tracking URL | URL `ref`/`refid`/`clickid` 参数 | 2 | 弱（当前全库 ref_id=0 条，从未落身份表） |
| `utm_campaign` | URL 参数 | **12 个博主 handle**：Wolfy, ry6kaGOP, ForitYT, mvp, makarbusalkin, EveryDay, Sn1p3rrr, nightfv, Scathe, dropz, bandz, THESIMON | **新信号形态**，强（handle = KOL 名，多数能对上已知 creator） |

**DB 现状**：affiliate_identities brand=LagZapper = 32 条（cid=29 / promo_code=2 / domain=1），`ref_id` 列 **0 条**。identities 里 25 条有 promo_code、29 条有 affiliate_cid → 表明大多数已知 KOL 已用 cid+code 双信号入库，但**没有任何 utm_campaign 证据**。

**audit 交叉核对发现的新候选**：
- **3 个未映射 cid**：`121, 179, 207`（不在 identities → 新 KOL slot 候选）
- **11 个未映射 promo code**：game, TGNUTSU26, EUTOPIA35, 00, NUTSURU, SWIMAG, nutsuru, Dropz, rhver, TIMBA-X, ted（部分疑似字典词/误报：game/00/ted；部分疑似已映射 creator 的别名大小写差异：nutsuru=NutsuruSama(152)、rhver 已知 → dry-run 需逐条判定）
- **12 个 utm_campaign handle**：多数疑似已知 creator（Wolfy/29、ForitYT=Форит/16、mvp、EveryDay/38、nightfv=itsNightfv…）→ 正好把"未映射 handle"与"已知身份"的对应关系作为 dry-run 的关键输出

## 3. 统一提取器 `extractKOLTrackingSignals(desc)`

新纯函数（不碰 DB），扩展 `extractAffiliateSignals` 但语义独立：

```
输入：视频 description 文本
输出：KOLTrackingSignal[] { brand, domain, cid, promoCode, refId, utmCampaign, handle, signalForm }
```

改动点（全部落在 `src/services/competitor-monitor/affiliate-extractor.ts` 或新文件 `kol-tracking.ts`）：

1. **URL 参数集扩展**：现正则 `[?&](?:cid|ref|refid|aff_id|aff|partner)=` 只有 6 个参数名。新增：`code`, `promo`, `ref_id`(兼容), `clickid`, `subid`, `trackid`, `utm_campaign`, `utm_source`, `utm_medium`。分类：cid→cid；code/promo→promoCode；ref/ref_id/refid/clickid/subid/trackid→refId；utm_campaign→utmCampaign（handle）。
2. **域名变体对齐**：extractor `TRACKED_DOMAINS`(6 域) vs rule-classifier(2 域) vs brand-config(1 域) 三处不一致。audit 实测全为 lagzapper.com，但保持变体正则（.com/.gg/.net/.io/.app/.ru），把 rule-classifier 的 domainPatterns 和 brand-config 的 trackedDomains 补全对齐。
3. **正文 prose code 提取**：沿用既有 `(?<!#)` 前瞻 + STOP_CODES 硬化（B 阶段已修复的路径），不新开。
4. **输出归一化**：`handle` 字段 = utm_campaign 归一化（小写、去 `@`/空格）后的 KOL 名。

## 4. KOL 身份解析 `resolveKOLIdentity(signals, knownIdentities)`

把多个信号形态**统一到同一个 KOL**。解析规则（沿用 B 阶段证据口径）：

| 观测 | 判定 | 置信度 |
|---|---|---|
| cid + lagzapper.com | 命中 identities[affiliate_cid] | HIGH（0.9+） |
| promo code + lagzapper.com | 命中 identities[promo_code] | HIGH（0.9） |
| utm_campaign handle + lagzapper.com | 命中 identities 对应 channel 名/handle | MEDIUM（0.7）——需排除字典词（mvp/everyday 类，Rule+AI 二次判定） |
| ref + lagzapper.com | 命中 identities[ref_id] | MEDIUM（0.7） |
| 仅 cid / 仅 code（无域名绑定） | 不构成品牌证据，不确认 | — |

**统一逻辑**：同一视频/同一频道出现多个形态（如 cid=24 + code=mvp + utm_campaign=mvp）→ 指向同一 KOL，取最高置信度、合并证据。跨品牌共享 code（KEEKING 案例）由"必须带 lagzapper 域名"约束挡住，与 B 阶段一致。

## 5. 本轮交付物 ①：只读 dry-run CLI `cli-lz-tracking-matcher.ts`

`npm run lz-matcher` —— **只读**（不写库、不消费 Search），对历史 202 条 LagZapper 视频跑 提取→解析，输出：

1. **True Positive**：信号命中已知 identities（cid/code/utm_campaign handle → 已知 creator），列出 视频ID→KOL→信号形态→置信度。
2. **False Positive / 待复核**：字典词 code（game/00/ted）、无域名绑定的裸 code、跨品牌共享 code、以及"信号能提但 channel 不是该 KOL"的 utm_campaign 情况。
3. **新 KOL 候选**：3 个未映射 cid（121/179/207）+ 未映射 utm_campaign handle（12 个中未对上的）+ 未映射 code（排除字典词后），每个候选附其出现的视频 channel_id → 可追踪到具体创作者。
4. **逐视频分类汇总**：TP / FP / NEW 计数 + 示例，作为设计确认后的写库清单。

这个 CLI 本身就是"audit/dry-run"的交付，不写库 → 属于只读审计，按既有约定可直接跑。

## 5b. dry-run 实证结果（2026-08-29 已跑，只读）

`npm run lz-matcher` 对 202 条历史 LagZapper 视频（31 个频道）按 channel 聚合解析：

**① True Positive — 31 个频道命中已知身份**（cid 为主，2 条仅 code：MAJOR→MAJOR76™、NIGHTFV→itsNightfv）。`utm_campaign` 把 Wolfy / ry6kaGOP / ForitYT / mvp / EveryDay 等 handle 归到已知 creator（模糊+转写别名匹配）。

**② 已知身份补充证据 — 27 条**（同频道未映射信号，应并入已知身份，**不是**新 KOL）：
- `cid=207 → 并入 MAJOR76™`（同一频道 UClzzmNBQWl8suLJzSq_Hqyg 上 code=MAJOR 已命中）—— 验证了多信号统一的核心语义。
- 大量已知 creator 的补码：MVP/KEKING/THERION/FORIT/DROPZ/RHVER/LEKAROK 等 code 补进对应身份。
- ⚠️ 发现 **cid=155 与 code=VAUGHN35 同时出现在 rhver 和 vaughnfn 两个频道** → 跨频道共享 link（rhver 分享 vaughnfn 的链接）。这是"被分享链接"现象，归属需按「信号→频道归属 + KOL 身份」双层区分，别把 rhver 误并进 vaughnfn。

**③ 新 KOL 候选 — 8 个**：
- **双信号 HIGH（cid+code 同频道）**：EUTOPIA（cid=121+code=EUTOPIA35）、swiMa（cid=179+code=SWIMAG）。
- **handle-only（utm_campaign，现有 extractor 100% 漏抓）**：Makar Busalkin / More Sn1p3rrr / Bandz（自身 handle，频道=KOL）；Scathe / THESIMON（被分享链接，KOL=handle，频道=转分享者）。
- **code-only**：TIMBA-X（频道 UCQ0p8laY0ROqegUWlxRjAPw）。

**结论**：matcher 语义成立 —— 四个信号形态统一解析到同一 KOL；utm_campaign 是现有 pipeline 完全缺失的新 KOL 发现源（5 个 handle-only 候选全凭它）。

### 5c. 最小验证集已写库（2026-08-29，guard 先行）

用户拍板选「最小验证集」，且**写库前先实现 shared-link ownership guard**（`kol-tracking.ts: guardOwnership`）。已落地：

- **负向回归** `npm run test:lz-ownership`：rhver 频道观察到 cid=155/VAUGHN35 → 判 sharedForeign(owner=vaughnfn)，mergeable 仅含自身 cid=176/RHVER。全绿。
- **schema**：`supabase-migration-lz-kol-tracking.sql` 备好（utm_campaign 列+索引+signal_type 注释扩展），本轮写入用不到，未应用。
- **已写库 3 条**（`npm run lz-backfill -- --apply`）：
  - 新身份 EUTOPIA：cid=121 + code=EUTOPIA35（conf 0.95, type cid）
  - 新身份 swiMa：cid=179 + code=SWIMAG（conf 0.95, type cid）
  - 合并 cid=207 → MAJOR76™（原 code=MAJOR，补 cid，conf 0.9）
- **不写**：5 个 handle-only 候选、TIMBA-X code-only、6 个无信号频道、sharedForeign 2 条。
- **写入后重跑 matcher 验证通过**：EUTOPIA/swiMa 经 cid 命中；MAJOR76™ 改经 cid=207 命中（多信号合并成功）；rhver 仍经 cid=176 命中且 cid=155/VAUGHN35 仍在 shared-link；已知 31→33 频道；identities 32→34；0 Search 调用。
- **回归全绿**：test:market 19/0 · test:lagofast 16/0 · test:inline-json 8/8 · test:lz-ownership 11/0 · build 通过。

## 6. 本轮交付物 ②（下一轮）：写库与线上接线

写库路径沿用现有三处 CLI 范式（cli-affiliate-seed / cli-validate-chain / cli-lagofast-backfill），设计确认后新增一处全库回填 CLI `cli-lz-kol-backfill.ts`：

1. **schema 变更**（Supabase SQL Editor 手动）：`ALTER TABLE affiliate_identities ADD COLUMN IF NOT EXISTS utm_campaign text;` + 可选索引 `(brand, utm_campaign)`。signal_type 枚举扩展（若需要）：`cid | ref | promo_code | domain | discount | utm_campaign`。
2. **回填**：对 dry-run 输出中 HIGH 的候选按 `onConflict (brand, channel_id) do update set ...` 幂等 upsert（沿用 cli-affiliate-seed:74-79 范式），新 KOL 同时进 watchlist `discovered_via:'kol_tracking'`。
3. **线上自动建身份**（当前完全缺失的最大接入点）：`src/services/competitor-monitor/index.ts` 视频入库段（~index.ts:551）在落库后调 `extractKOLTrackingSignals(v.description)` → `resolveKOLIdentity` → 未命中且 HIGH 时 upsert。**这一步是后续迭代**，本轮设计先确认语义，不并入本次 CLI。
4. **展示层**：`TrackingSignal`（creator-profiler.ts:16-23）加可选 `utmCampaign` 字段透出；dashboard 无需改即显示（跟踪签名页会多一行 handle 证据）。

## 7. 误报防护（沿用已固化口径）

- **字典词 code/handle**：mvp / everyday / game / 00 / ted → 只报 NEW 候选，不直接建身份，标记需 Rule+AI 二次判定。
- **cid 非品牌专用**：cid 单独命中不算，必须 `cid + lagzapper.com` 才 HIGH（[[boost-affiliate-ecosystem]] 修正口径）。
- **跨品牌共享 code**：KEEKING 已证实 → code 命中必须伴随 lagzapper 域名。
- **utm_campaign ≠ 频道**：当 utm_campaign handle 与视频 channel 无关时，handle 视为"被分享的 KOL 链接"，KOL 身份归 handle 而非该频道 → 归入候选而非直接确认为该频道身份。

## 8. 验证 / 回归

1. `npm run build` 通过。
2. `npm run lz-matcher` 输出：TP 能对上已知 creator（如 utm_campaign=Wolfy → cid=29）；FP 排除字典词；NEW 含 3 个未映射 cid。
3. 不消费任何 Search quota（纯 DB 读 + 正则）。
4. 不改现有 affiliate-extractor 对 Lagofast 的行为（域名回填走 LagoFast 既有路径）。

## 9. 本轮不做

- 任何 LagZapper search.list / global query / backfill（明天 LagoFast backfill 优先）。
- 线上 index.ts 自动建身份接线（§6.3，下一迭代）。
- 改 Lagofast backfill / BACKFILL_BRANDS。

## 10. 文件改动清单（确认后）

| 文件 | 改动 |
|---|---|
| `src/cli-lz-tracking-matcher.ts` | ✅ **已完成**：只读 dry-run CLI（提取+解析+TP/合并/新候选） |
| `package.json` | ✅ + `lz-matcher` script |
| `docs/lz-kol-tracking-matcher-design.md` | ✅ 本设计（含 dry-run 实证 §5b） |
| `src/services/competitor-monitor/kol-tracking.ts` | **待实施**：把 matcher 逻辑抽成纯函数 `extractKOLTrackingSignals` + `resolveKOLIdentity`（当前逻辑内联在 CLI） |
| `src/services/competitor-monitor/affiliate-extractor.ts` | **待实施**：urlParams 参数集扩展（code/promo/utm_*/clickid/subid）+ 域名变体对齐 |
| `src/services/competitor-monitor/rule-classifier.ts` | **待实施**：LagZapper domainPatterns 补全（2→6 域） |
| `src/services/competitor-monitor/brand-config.ts` | **待实施**：LagZapper trackedDomains 补全（1→6 域） |
| `src/cli-lz-kol-backfill.ts` | **待实施**：写库回填 CLI（本轮交付②，确认后） |
| `supabase-migration-lz-kol-tracking.sql` | **待实施**：`utm_campaign` 列 + 索引（确认后） |
