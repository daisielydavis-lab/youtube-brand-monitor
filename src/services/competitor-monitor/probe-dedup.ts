/**
 * Search Probe 的 DB 去重唯一键（2026-08-30 固化，防 id vs video_id 假 DB-new）
 *
 * 背景：Probe 首轮去重误用表主键 `id`（uuid）与 YouTube 返回的 video id 比较
 * → `.in()` 全 0 命中 → 假「54 条全新」假增量，误判 P1-P4 边际贡献。
 * 规则：YouTube video id 只存在 `youtube_competitor_videos.video_id` 列，
 * 禁止与 uuid 主键 `id` 比较。行缺 video_id（如误拿 `id` 列）一律忽略。
 */
export const VIDEO_DEDUP_COLUMN = 'video_id' as const;

/** 从 DB 行构建已存在 video_id 集合；行缺 video_id（uuid `id` 行）一律忽略 → 防假 DB-new。 */
export function buildExistingSet(rows: Array<{ video_id?: string }>): Set<string> {
  const s = new Set<string>();
  for (const r of rows) {
    if (r && typeof r.video_id === 'string') s.add(r.video_id);
  }
  return s;
}
