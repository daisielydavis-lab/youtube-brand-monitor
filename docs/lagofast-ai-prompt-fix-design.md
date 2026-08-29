# Lagofast AI 归属缺口修复设计(task #4b)

> 触发:用户提「Lagofast 推广常用 lago-fast 在描述里给链接,匹配这个字段去看」。
> 调查发现真正根因不在提取器/规则层,lago-fast 早已被覆盖;**卡点在第 4 品牌 Lagofast 从未加进 AI 分类 prompt**。
> 状态:设计稿,待用户确认后实施(workflow-design-first)。

---

## 1. 根因(已定位)

**AI 分类 prompt 的品牌枚举缺 Lagofast。** `index.ts:106/112/120`(batch 分类主通道,backlog cron 也走这条)只枚举 GearUP/ExitLag/LagZapper:

```ts
// index.ts:106
const prompt = `Classify these ... game booster brand sponsorships (GearUP, ExitLag, LagZapper).
// index.ts:112
- brand ("GearUP"|"ExitLag"|"LagZapper"|null), ...
// index.ts:120
Game boosters (GearUP/ExitLag/LagZapper) are ONLY advertised ...
```

Lagofast(第 4 品牌,2026-08-24 加入 rule/BRANDS/extractor)**从未同步进 AI prompt** → AI 无法输出 Lagofast,只能:
- 纯 Lagofast 视频 → `brand: null`(尽管给 `brand_link + promo_code` + `likely_sponsored`);
- Lagofast 信号混入他牌 → 归给枚举里有的品牌。

连带 `sponsorship-detector.ts:136/146/185` 同样缺(遗留检测器,未接入主链路,一并修)。

**配套写回缺陷**:`retryClassification` 的 rule 写回(`index.ts:709-717`)不写 `raw_brand/canonical_brand` 列(主链路 Phase 4 写);随后 AI 写回整体覆盖 `classification_raw` 丢 rule 层。所以「rule 已判 Lagofast」的信息被 AI 的 `brand:null` 抹掉,`canonical_brand` 列空 → 按列统计低估(报告 §4/§7 已见)。

---

## 2. 影响量化(2026-08-29 全库 13510 行)

含 Lagofast 信号(title/desc 命中 lagofast/lago-fast/lagobooster 等)视频 **72 条**:

| workflow \ placement | 条数 | 说明 |
|---|---|---|
| discovered \ unknown | **36** | AI pending,backlog 消化时用当前 prompt → 不修就继续误归 |
| classified \ likely_sponsored | 19 | 其中 13 条未归 Lagofast(见下) |
| classified \ unknown | 12 | 规则归 Lagofast、无 AI 判定 |
| classified \ organic_mention | 3 | — |
| classified \ confirmed | 2 | — |

**13 条「已分类 + 投放类 placement + 当前非 Lagofast」分类**:

| 类别 | 条数 | 视频 | 处置 |
|---|---|---|---|
| ① 纯 Lagofast,brand=null | 2 | 4FQCC-G1yxo、jby_IYzp1mw(官方模板:lagofast.com/vi/mobile + code gamingmobile;lagobooster.ru ×3) | **确证 Lagofast**,回填必转 |
| ② 纯 Lagofast,误归 LagZapper | 2 | KJ_IVAQ72yk(LOTM #lagofast,同官方模板)、xrUe6yniGxM(dropz,cid=744+DROPZ 码) | **确证 Lagofast**,LZ −2 为修正 |
| ③ 真多品牌 GearUP+Lagofast | 3 | COD MW4 TW ×3(同博主:lagofast cid=616+码「nc」& gearup code ncchfps) | 归属不完整,挂靠冻结的 Multi-brand 任务 |
| ④ 对比/评测,主体是他牌 | 6 | ExitLag vs LagoFast ×5(带 exitlag.com/refer 链接)、GearUP vs LagoFast ×1 | 归 ExitLag/GearUP **合理**,LagoFast 是对比对象 |

---

## 3. 修复方案

### P0 — AI prompt 补 Lagofast(必做,最小改动)
`index.ts:106/112/120` 三处枚举加 Lagofast;`sponsorship-detector.ts:136/146/185` 同步。
另加一句:`matchedBrand` 字段是规则层提示,请确认或修正(brand-config BRANDS 已含 Lagofast,matchedBrand 提示已在传,只是被枚举挡住)。

### P1 — 定向回填(改计数,需确认范围)
用修好的 prompt 重跑 AI。**范围二选一:**
- **A(推荐,保守)**:只跑 ①+② 共 **4 条确证**。预期:Lagofast +4、LagZapper −2(修正)。ExitLag/GearUP 计数不动。③④ 留给冻结的 Multi-brand 任务。
- **B(激进)**:跑全部 13 条。预期:Lagofast +4~+7、LZ −2、GearUP 可能 −3(③ 三条多品牌若 AI 改判 Lagofast)、ExitLag 可能微变。③④ 的归属会被 AI 一次性裁决,但多品牌计数政策未定,结果可能与后续 Multi-brand 任务冲突。

### P2 — lago-fast 字段硬化(可选,用户原意)
- extractor `TRACKED_DOMAINS` 加裸 `'lago-fast'`(当前只有全域名 `lago-fast.com`;防 lago-fast.其他TLD)。
- brand-config `BRANDS` Lagofast keywords 加 `'lago-fast'`(当前只有 lagofast/lago fast/lagobooster/лагофаст;matchedBrand 提示会漏 hyphen 形式)。
- 观察值全被覆盖(lagofast.com/lago-fast.com/lagofastbooster.ru/lagobooster.ru),此为保险项。

### P3 — 写回缺陷小修(可选)
- `retryClassification` rule 写回补 `raw_brand/canonical_brand/brand_confidence` 列(与 Phase 4 对齐)。
- AI 写回在 `aiBrand=null` 时保留 rule 层 brand(防重跑再次抹掉规则判定)。

---

## 4. 决策点
1. P1 范围:A(4 条确证)还是 B(全部 13 条)?
2. P2/P3 是否纳入本轮?
3. 36 条 pending 无需操作 —— prompt 修好部署后,backlog cron 消化时自然用新枚举。

## 5. 部署
commit → push master → Railway 自动部署。AI_BACKLOG_DAILY_LIMIT=300 已在跑,修复后存量 36 条 Lagofast + 其余 backlog 会逐渐修正。

---

## 6. 执行结果(2026-08-29,已上线)

**用户拍板**:P1=A(只重跑 4 条确证)、P2 纳入、P3 不纳入;并按序「暂停旧 prompt → 修 prompt → 部署 → pending 用新 prompt → 回填 4 条 → 对账」。

**代码改动**(commit `9dd9b69`,已 push 上线):
- **P0 架构化**:`buildClassificationPrompt()`(index.ts)品牌列表/枚举由 `COMPETITOR_BRANDS` 统一生成(`brandList`/`brandEnum`/`brandSlash`),新增品牌自动同步,不再硬编码第 4 个字符串;加 `matchedBrand` 规则提示(规则层提示字段,防 AI 漏认)。`sponsorship-detector.ts:136/146/185` 同源枚举。`batchClassifyVideos` 已导出(供回填/复用)。
- **P2**:extractor `TRACKED_DOMAINS` 加裸 `'lago-fast'`(防 lago-fast.其他 TLD);brand-config `BRANDS` Lagofast keywords 加 `'lago-fast'`(修 matchedBrand 漏 hyphen 形式)。
- **回归测试**:`src/regression-lagofast.ts` + `npm run test:lagofast`(7 项,全过)——纯 Lagofast(lagofast.com+cid+promo)/lago-fast.com/纯 LZ 不被抢/多品牌不强制改历史/无品牌 null/prompt 枚举含全品牌。

**执行顺序落实**:
1. `AI_BACKLOG_DAILY_LIMIT=-1` 暂停 backlog cron(10:00 UTC 前,防旧 prompt 消费 36 条 pending)→ 已暂停。
2. 修 prompt(代码)→ tsc 0 错误 + 回归 7/7。
3. push `9dd9b69` → Railway 自动部署 → 服务 Online(新容器)。
4. `AI_BACKLOG_DAILY_LIMIT=300` 恢复 backlog → 今日 10:00 UTC cron 起,36 条 pending 用新 prompt 首析。
5. 回填 4 条(本地 `railway run` 注入环境,不落盘 key):`4FQCC-G1yxo`/`jby_IYzp1mw`(null→Lagofast)、`KJ_IVAQ72yk`/`xrUe6yniGxM`(LagZapper→Lagofast;dropz 那条含 #ad 升级 confirmed 0.95)。AI 一次成功,无错误。
6. 对账(_tmp_compare.ts 90 天 Layer3):

| 品牌 | 回填前 | 回填后 | 预期 | 结果 |
|---|---:|---:|---:|---:|
| Lagofast | 7 | **11** | +4 | ✅ +4 |
| LagZapper | 162 | **160** | −2 | ✅ −2 |
| GearUP | 821 | 820 | 不变 | ⚠️ −1(非本次回填所致,见下) |
| ExitLag | 2541 | **2541** | 不变 | ✅ 不变 |

**GearUP −1 说明**:回填只触碰 4 条(全 Lagofast),不可能影响 GearUP。90 天行数 13257→13256(−1)与「一条视频滑出 90 天窗口」吻合;且 06:09–06:15 UTC 有一次 650 条旧 prompt 大规模重分类(早于部署)。两者其一或叠加导致,属存量噪声,非本次修复副作用。按用户原则「不对就停下来查」已排查:GearUP 信号翻转的 14 条均为 `gear up` 普通词组误匹配、placement=unknown,非 Layer3。

**watchlist 附注**:4 条回填频道的 watchlist 条目显示 Gaming Mobile/keking/dropz 为**真多品牌创作者**(LZ/GearUP/Lagofast 各有 ai_confirmed 条目)。dropz 遗留 LZ 条目为 stale(其视频已改判 Lagofast),不自动删——watchlist 清理并入冻结的 Multi-brand 任务。

**待验证**:backlog 消化后重跑 `_tmp_compare.ts`,Lagofast 应随 36 条 pending 首析进一步上升。

相关:[[production-live-status]] [[b-phase-identity-evidence]] [[boost-affiliate-ecosystem]]
