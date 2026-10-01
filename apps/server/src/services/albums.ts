import { createHash } from 'node:crypto';
import type { AlbumGapDto, InspirationDto, TimeAnchor, WeatherPhenomenon } from '@flil/shared';
import { getDb, newId, nowIso, parseJson, toJson } from '../db.js';
import { errors } from '../http/errors.js';
import { toAlbumDto, toGapDto, toInspirationDto, type SerializeContext } from './serialization.js';
import { loadTiming } from './windowEngine.js';
import { fuzzSpotCached, type PlaceRow, type SpotRow } from './fuzzing.js';
import type { AssetRow } from './assets.js';

export const ALBUM_RULE_DEFAULTS = {
  totalMin: 6,
  autoMatch: { enabled: true, minTagHits: 2 },
};

export interface AlbumRulesShape {
  requireTags: { tagIds: string[]; min: number; required: boolean }[];
  requireAnchors: { anchor: TimeAnchor; min: number; required: boolean }[];
  requireWeather: { phenomenon: WeatherPhenomenon; min: number; required: boolean }[];
  requireResultShots?: { min: number; required: boolean };
  totalMin: number;
  autoMatch: { enabled: boolean; minTagHits: number };
}

export function normalizeRules(raw: unknown): AlbumRulesShape {
  const r = parseJson<Partial<AlbumRulesShape>>(raw, {});
  return {
    requireTags: r.requireTags ?? [],
    requireAnchors: r.requireAnchors ?? [],
    requireWeather: r.requireWeather ?? [],
    requireResultShots: r.requireResultShots,
    totalMin: r.totalMin ?? ALBUM_RULE_DEFAULTS.totalMin,
    autoMatch: r.autoMatch ?? ALBUM_RULE_DEFAULTS.autoMatch,
  };
}

export function createAlbum(params: {
  libraryId: string;
  title: string;
  themeNote?: string | null;
  rules: AlbumRulesShape;
}): string {
  const db = getDb();
  const id = newId();
  const ts = nowIso();
  db.prepare(
    "INSERT INTO album (id, library_id, title, theme_note, status, rules, created_at, updated_at) VALUES (?,?,?,?, 'planning', ?, ?, ?)",
  ).run(id, params.libraryId, params.title, params.themeNote ?? null, toJson(params.rules), ts, ts);
  return id;
}

export function requireAlbum(albumId: string, libraryId: string): Record<string, unknown> {
  const row = getDb()
    .prepare('SELECT * FROM album WHERE id = ? AND deleted_at IS NULL')
    .get(albumId) as Record<string, unknown> | undefined;
  if (!row) throw errors.notFound('画册');
  if (row.library_id !== libraryId) throw errors.scopeDenied();
  return row;
}

export function listAlbums(libraryId: string): ReturnType<typeof toAlbumDto>[] {
  const rows = getDb()
    .prepare('SELECT * FROM album WHERE library_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
    .all(libraryId) as Record<string, unknown>[];
  return rows.map(toAlbumDto);
}

export function albumItemIds(albumId: string): string[] {
  return (
    getDb()
      .prepare('SELECT inspiration_id FROM album_item WHERE album_id = ? ORDER BY sort_order, created_at')
      .all(albumId) as { inspiration_id: string }[]
  ).map((r) => r.inspiration_id);
}

export function listGaps(albumId: string): AlbumGapDto[] {
  const rows = getDb()
    .prepare('SELECT * FROM album_gap WHERE album_id = ? ORDER BY is_required DESC, kind, created_at')
    .all(albumId) as Record<string, unknown>[];
  return rows.map((r) => toGapDto({ ...r, album_id: albumId }));
}

/** 自动匹配打分（文档 14.3）：标签 0.45 + 时机 0.20 + 命中率 0.15 + 质量 0.10 + 新鲜度 0.10 */
export interface ScoredCandidate {
  inspirationId: string;
  score: number;
  reasons: string[];
}

export function scoreCandidates(
  libraryId: string,
  rules: AlbumRulesShape,
  excludeAlbumId?: string,
): ScoredCandidate[] {
  const db = getDb();
  const sql = excludeAlbumId
    ? `SELECT i.* FROM inspiration i
       WHERE i.library_id = ? AND i.deleted_at IS NULL AND i.status NOT IN ('dropped','archived')
         AND NOT EXISTS (SELECT 1 FROM album_item ai WHERE ai.album_id = ? AND ai.inspiration_id = i.id)
       ORDER BY i.updated_at DESC LIMIT 500`
    : `SELECT i.* FROM inspiration i
       WHERE i.library_id = ? AND i.deleted_at IS NULL AND i.status NOT IN ('dropped','archived')
       ORDER BY i.updated_at DESC LIMIT 500`;

  const rows = db.prepare(sql).all(...(excludeAlbumId ? [libraryId, excludeAlbumId] : [libraryId])) as Record<
    string,
    unknown
  >[];

  const requiredTagIds = rules.requireTags.flatMap((r) => r.tagIds);
  const out: ScoredCandidate[] = [];

  for (const row of rows) {
    const id = row.id as string;
    const reasons: string[] = [];
    const tags = db
      .prepare(
        `SELECT t.id, t.name FROM inspiration_tag it
         JOIN tag t ON t.id = it.tag_id
         JOIN inspiration i ON i.id = it.inspiration_id AND i.library_id = t.library_id
         WHERE it.inspiration_id = ?`,
      )
      .all(id) as { id: string; name: string }[];
    const tagIds = new Set(tags.map((t) => t.id));

    const hitTags = requiredTagIds.filter((t) => tagIds.has(t));
    const tagScore = requiredTagIds.length ? hitTags.length / requiredTagIds.length : 0;
    if (hitTags.length) reasons.push(`命中 ${hitTags.length} 个必需标签`);

    const timingRow = loadTiming(id);
    let anchorScore = 0;
    if (rules.requireAnchors.length && timingRow) {
      const matched = rules.requireAnchors.filter((a) => a.anchor === timingRow.time_anchor).length;
      anchorScore = matched / rules.requireAnchors.length;
      if (matched) reasons.push(`时段匹配（${timingRow.time_anchor}）`);
    } else if (!rules.requireAnchors.length) {
      anchorScore = 0.5;
    }

    const hitRate = (row.hit_rate as number) ?? 0;
    const fills =
      ((row.hit_count as number) ?? 0) +
      ((row.partial_count as number) ?? 0) +
      ((row.miss_count as number) ?? 0);
    const confidence = fills / (fills + 2);
    const hitScore = hitRate * confidence;
    if (fills > 0) reasons.push(`历史命中率 ${(hitRate * 100).toFixed(0)}%（回填 ${fills} 次）`);

    const asset = db
      .prepare("SELECT * FROM asset WHERE inspiration_id = ? AND role != 'result' ORDER BY created_at ASC LIMIT 1")
      .get(id) as AssetRow | undefined;
    const qualityScore = asset ? Math.min(1, (asset.width * asset.height) / (1920 * 1080)) : 0;

    const updatedAt = new Date((row.updated_at as string) ?? new Date().toISOString()).getTime();
    const ageDays = (Date.now() - updatedAt) / 86400000;
    const freshness = Math.max(0, 1 - ageDays / 365);

    if (requiredTagIds.length && hitTags.length < rules.autoMatch.minTagHits) continue;

    const score =
      0.45 * tagScore + 0.2 * anchorScore + 0.15 * hitScore + 0.1 * qualityScore + 0.1 * freshness;
    out.push({ inspirationId: id, score: Number(score.toFixed(4)), reasons });
  }

  return out.sort((a, b) => b.score - a.score);
}

export function autoMatch(albumId: string, libraryId: string): { added: number; scanned: number } {
  const album = requireAlbum(albumId, libraryId);
  const rules = normalizeRules(album.rules);
  const currentCount = (
    getDb().prepare('SELECT COUNT(*) AS n FROM album_item WHERE album_id = ?').get(albumId) as { n: number }
  ).n;
  const need = Math.max(0, rules.totalMin - currentCount);
  if (need === 0) return { added: 0, scanned: 0 };

  const candidates = scoreCandidates(libraryId, rules, albumId);
  const db = getDb();
  const ts = nowIso();
  let added = 0;
  const run = db.transaction(() => {
    for (const c of candidates.slice(0, need)) {
      db.prepare(
        "INSERT INTO album_item (id, album_id, inspiration_id, sort_order, added_by, created_at) VALUES (?,?,?,?, 'auto', ?)",
      ).run(newId(), albumId, c.inspirationId, (currentCount + added + 1) * 10, ts);
      added += 1;
    }
    db.prepare('UPDATE album SET updated_at = ? WHERE id = ?').run(ts, albumId);
  });
  run();
  regenerateGaps(albumId, libraryId);
  return { added, scanned: candidates.length };
}

export function addItem(
  albumId: string,
  inspirationId: string,
  libraryId: string,
  caption?: string | null,
): void {
  requireAlbum(albumId, libraryId);
  const db = getDb();
  const maxOrder = (
    db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM album_item WHERE album_id = ?').get(albumId) as {
      m: number;
    }
  ).m;
  db.prepare(
    "INSERT INTO album_item (id, album_id, inspiration_id, sort_order, caption, added_by, created_at) VALUES (?,?,?,?,?, 'manual', ?) ON CONFLICT (album_id, inspiration_id) DO UPDATE SET caption = excluded.caption",
  ).run(newId(), albumId, inspirationId, maxOrder + 10, caption ?? null, nowIso());
  regenerateGaps(albumId, libraryId);
}

export function removeItem(albumId: string, inspirationId: string, libraryId: string): void {
  requireAlbum(albumId, libraryId);
  getDb().prepare('DELETE FROM album_item WHERE album_id = ? AND inspiration_id = ?').run(albumId, inspirationId);
  regenerateGaps(albumId, libraryId);
}

export function reorderItems(albumId: string, libraryId: string, orderedIds: string[]): void {
  requireAlbum(albumId, libraryId);
  const db = getDb();
  const run = db.transaction(() => {
    orderedIds.forEach((id, index) => {
      db.prepare('UPDATE album_item SET sort_order = ? WHERE album_id = ? AND inspiration_id = ?').run(
        (index + 1) * 10,
        albumId,
        id,
      );
    });
  });
  run();
}

/** 缺口清单生成与自动闭合（文档 14.4）—— 画册闭环的核心产物 */
export function regenerateGaps(albumId: string, libraryId: string): AlbumGapDto[] {
  const db = getDb();
  const album = requireAlbum(albumId, libraryId);
  const rules = normalizeRules(album.rules);
  const itemIds = albumItemIds(albumId);

  const countTag = (tagIds: string[]): number => {
    if (!itemIds.length || !tagIds.length) return 0;
    const ph = itemIds.map(() => '?').join(',');
    const tagPh = tagIds.map(() => '?').join(',');
    return (
      db
        .prepare(
          `SELECT COUNT(DISTINCT inspiration_id) AS n FROM inspiration_tag WHERE inspiration_id IN (${ph}) AND tag_id IN (${tagPh})`,
        )
        .get(...itemIds, ...tagIds) as { n: number }
    ).n;
  };

  const countAnchor = (anchor: string): number => {
    if (!itemIds.length) return 0;
    const ph = itemIds.map(() => '?').join(',');
    return (
      db
        .prepare(`SELECT COUNT(*) AS n FROM timing WHERE inspiration_id IN (${ph}) AND time_anchor = ?`)
        .get(...itemIds, anchor) as { n: number }
    ).n;
  };

  const countWeather = (phenomenon: string): number => {
    if (!itemIds.length) return 0;
    const ph = itemIds.map(() => '?').join(',');
    return (
      db
        .prepare(`SELECT COUNT(*) AS n FROM timing WHERE inspiration_id IN (${ph}) AND weather_profile LIKE ?`)
        .get(...itemIds, `%"${phenomenon}"%`) as { n: number }
    ).n;
  };

  const countResults = (): number => {
    if (!itemIds.length) return 0;
    const ph = itemIds.map(() => '?').join(',');
    return (
      db
        .prepare(
          `SELECT COUNT(DISTINCT inspiration_id) AS n FROM asset WHERE inspiration_id IN (${ph}) AND role = 'result'`,
        )
        .get(...itemIds) as { n: number }
    ).n;
  };

  interface Spec {
    kind: AlbumGapDto['kind'];
    requirement: Record<string, unknown>;
    current: number;
    required: number;
    isRequired: boolean;
  }

  const specs: Spec[] = [];
  for (const r of rules.requireTags) {
    specs.push({
      kind: 'tag',
      requirement: { tagIds: r.tagIds },
      current: countTag(r.tagIds),
      required: r.min,
      isRequired: r.required,
    });
  }
  for (const r of rules.requireAnchors) {
    specs.push({
      kind: 'anchor',
      requirement: { anchor: r.anchor },
      current: countAnchor(r.anchor),
      required: r.min,
      isRequired: r.required,
    });
  }
  for (const r of rules.requireWeather) {
    specs.push({
      kind: 'weather',
      requirement: { phenomenon: r.phenomenon },
      current: countWeather(r.phenomenon),
      required: r.min,
      isRequired: r.required,
    });
  }
  specs.push({
    kind: 'count',
    requirement: { totalMin: rules.totalMin },
    current: itemIds.length,
    required: rules.totalMin,
    isRequired: true,
  });
  if (rules.requireResultShots) {
    specs.push({
      kind: 'result',
      requirement: { min: rules.requireResultShots.min },
      current: countResults(),
      required: rules.requireResultShots.min,
      isRequired: rules.requireResultShots.required,
    });
  }

  const ts = nowIso();
  const run = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM album_gap WHERE album_id = ?').all(albumId) as Record<
      string,
      unknown
    >[];
    const byRequirement = new Map(existing.map((g) => [String(g.requirement), g]));

    for (const spec of specs) {
      const keyJson = toJson(spec.requirement);
      const prior = byRequirement.get(keyJson);
      const satisfied = spec.current >= spec.required;
      const status = satisfied ? 'filled' : prior?.status === 'waived' ? 'waived' : 'open';
      if (prior) {
        db.prepare(
          'UPDATE album_gap SET current_count = ?, required_count = ?, is_required = ?, status = ?, updated_at = ? WHERE id = ?',
        ).run(spec.current, spec.required, spec.isRequired ? 1 : 0, status, ts, prior.id as string);
      } else {
        db.prepare(
          `INSERT INTO album_gap (id, album_id, kind, requirement, current_count, required_count, is_required, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          newId(),
          albumId,
          spec.kind,
          keyJson,
          spec.current,
          spec.required,
          spec.isRequired ? 1 : 0,
          status,
          ts,
          ts,
        );
      }
    }

    const validKeys = specs.map((s) => toJson(s.requirement));
    for (const g of existing) {
      if (!validKeys.includes(String(g.requirement))) {
        db.prepare("UPDATE album_gap SET status = 'filled', updated_at = ? WHERE id = ?").run(ts, g.id as string);
      }
    }

    const openRequired = (
      db
        .prepare("SELECT COUNT(*) AS n FROM album_gap WHERE album_id = ? AND is_required = 1 AND status = 'open'")
        .get(albumId) as { n: number }
    ).n;

    const currentStatus = album.status as string;
    if (currentStatus !== 'published' && currentStatus !== 'archived') {
      db.prepare('UPDATE album SET status = ?, updated_at = ? WHERE id = ?').run(
        openRequired > 0 ? 'collecting' : 'ready',
        ts,
        albumId,
      );
    }
  });
  run();
  return listGaps(albumId);
}

export function waiveGap(albumId: string, gapId: string, libraryId: string, reason: string): void {
  requireAlbum(albumId, libraryId);
  const gap = getDb().prepare('SELECT * FROM album_gap WHERE id = ? AND album_id = ?').get(gapId, albumId) as
    | Record<string, unknown>
    | undefined;
  if (!gap) throw errors.notFound('缺口');
  if (gap.is_required === 1) throw errors.badRequest('必需缺口不能豁免，只能补齐或修改画册规则');
  getDb()
    .prepare("UPDATE album_gap SET status = 'waived', waive_reason = ?, updated_at = ? WHERE id = ?")
    .run(reason, nowIso(), gapId);
  regenerateGaps(albumId, libraryId);
}

export interface PublishResult {
  version: number;
  snapshotId: string;
  payloadHash: string;
  shareToken: string | null;
}

/**
 * 发布：生成不可变快照（文档 14.5）。
 * 快照内一律是模糊坐标，原图路径永不进入快照。
 */
export function publishAlbum(
  albumId: string,
  libraryId: string,
  ctx: SerializeContext,
  share: { token: string } | null,
): PublishResult {
  const db = getDb();
  const album = requireAlbum(albumId, libraryId);
  const openRequired = listGaps(albumId).filter((g) => g.isRequired && g.status === 'open');
  if (openRequired.length > 0) throw errors.albumHasRequiredGaps(openRequired.length);

  const items = db
    .prepare('SELECT * FROM album_item WHERE album_id = ? ORDER BY sort_order, created_at')
    .all(albumId) as { inspiration_id: string; sort_order: number; caption: string | null }[];

  const payloadItems = items.map((item) => {
    const row = db.prepare('SELECT * FROM inspiration WHERE id = ?').get(item.inspiration_id) as
      | Record<string, unknown>
      | undefined;
    const tags = db
      .prepare(
        `SELECT t.domain, t.name FROM inspiration_tag it
         JOIN tag t ON t.id = it.tag_id
         JOIN inspiration i ON i.id = it.inspiration_id AND i.library_id = t.library_id
         WHERE it.inspiration_id = ?`,
      )
      .all(item.inspiration_id) as { domain: string; name: string }[];
    const assets = db
      .prepare("SELECT * FROM asset WHERE inspiration_id = ? AND role != 'result' ORDER BY created_at LIMIT 3")
      .all(item.inspiration_id) as AssetRow[];

    let fuzz = null;
    if (row?.spot_id) {
      const spotRow = db.prepare('SELECT * FROM spot WHERE id = ?').get(row.spot_id as string) as
        | SpotRow
        | undefined;
      const placeRow = spotRow
        ? ((db.prepare('SELECT * FROM place WHERE id = ?').get(spotRow.place_id) as PlaceRow | undefined) ?? null)
        : null;
      if (spotRow) fuzz = fuzzSpotCached(spotRow, placeRow, ctx.defaultFuzzLevel);
    }
    const timingRow = loadTiming(item.inspiration_id);

    return {
      inspirationId: item.inspiration_id,
      title: (row?.title as string) ?? '',
      caption: item.caption,
      sortOrder: item.sort_order,
      tags: tags.map((t) => `${t.domain}:${t.name}`),
      fuzz,
      anchor: timingRow?.time_anchor ?? null,
      weatherProfile: timingRow ? parseJson<Record<string, unknown>>(timingRow.weather_profile, {}) : null,
      assets: assets.map((a) => ({ id: a.id, width: a.width, height: a.height })),
    };
  });

  const payload = {
    albumId,
    title: album.title as string,
    themeNote: (album.theme_note as string | null) ?? null,
    conditionSummary: summarizeConditions(payloadItems),
    items: payloadItems,
    publishedAt: nowIso(),
    fuzzLevel: ctx.defaultFuzzLevel,
    shareToken: share?.token ?? null,
  };

  const version =
    (
      db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM album_snapshot WHERE album_id = ?').get(albumId) as {
        v: number;
      }
    ).v + 1;

  const payloadJson = toJson(payload);
  const hash = createHash('sha256').update(payloadJson).digest('hex');
  const snapshotId = newId();
  const ts = nowIso();

  db.prepare(
    'INSERT INTO album_snapshot (id, album_id, version, payload, payload_hash, share_link_id, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(snapshotId, albumId, version, payloadJson, hash, null, ts);
  db.prepare("UPDATE album SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?").run(
    ts,
    ts,
    albumId,
  );

  return { version, snapshotId, payloadHash: hash, shareToken: share?.token ?? null };
}

/** 把整册的共性条件提炼成"照着做"的说明（画册最高价值的部分） */
export function summarizeConditions(
  items: { anchor: string | null; weatherProfile: Record<string, unknown> | null }[],
): string {
  const anchors = items.map((i) => i.anchor).filter((a): a is string => Boolean(a));
  const uniqAnchors = [...new Set(anchors)];
  const cloud = items
    .map((i) => (i.weatherProfile?.cloudCoverPct as { min: number; max: number } | undefined) ?? null)
    .filter((c): c is { min: number; max: number } => Boolean(c));
  const precip = items
    .map((i) => i.weatherProfile?.precipProbPctMax as number | undefined)
    .filter((p): p is number => typeof p === 'number');
  const phenomena = [
    ...new Set(items.flatMap((i) => ((i.weatherProfile?.phenomena as string[] | undefined) ?? []) as string[])),
  ];

  const parts: string[] = [];
  if (uniqAnchors.length) parts.push(`时段以「${uniqAnchors.join('、')}」为主`);
  if (cloud.length) {
    const min = Math.min(...cloud.map((c) => c.min));
    const max = Math.max(...cloud.map((c) => c.max));
    parts.push(`云量大致 ${min}%–${max}%`);
  }
  if (precip.length) parts.push(`降水概率建议 ≤ ${Math.min(...precip)}%`);
  if (phenomena.length) parts.push(`常见天气特征：${phenomena.join('、')}`);
  return parts.length ? `${parts.join('；')}。` : '本册暂未形成统一的条件描述。';
}

export function getSnapshot(albumId: string, version?: number): Record<string, unknown> | null {
  const db = getDb();
  const row = version
    ? (db.prepare('SELECT * FROM album_snapshot WHERE album_id = ? AND version = ?').get(albumId, version) as
        | Record<string, unknown>
        | undefined)
    : (db.prepare('SELECT * FROM album_snapshot WHERE album_id = ? ORDER BY version DESC LIMIT 1').get(albumId) as
        | Record<string, unknown>
        | undefined);
  if (!row) return null;
  return {
    version: row.version as number,
    payloadHash: row.payload_hash as string,
    createdAt: row.created_at as string,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
  };
}

export function albumItemsDetailed(albumId: string, ctx: SerializeContext): InspirationDto[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT i.* FROM album_item ai JOIN inspiration i ON i.id = ai.inspiration_id
       WHERE ai.album_id = ? ORDER BY ai.sort_order, ai.created_at`,
    )
    .all(albumId) as Record<string, unknown>[];
  return rows.map((r) =>
    toInspirationDto(r as unknown as Parameters<typeof toInspirationDto>[0], ctx, { withWindowSummary: false }),
  );
}

export function coverAsset(albumId: string): AssetRow | null {
  const row = getDb()
    .prepare(
      `SELECT a.* FROM album_item ai JOIN asset a ON a.inspiration_id = ai.inspiration_id
       WHERE ai.album_id = ? ORDER BY ai.sort_order LIMIT 1`,
    )
    .get(albumId) as AssetRow | undefined;
  return row ?? null;
}
