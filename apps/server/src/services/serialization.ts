import type {
  AlbumDto,
  AlbumGapDto,
  AnnotationDto,
  AssetDto,
  FuzzLevel,
  HitLevel,
  InspirationDto,
  MissReason,
  PlanDto,
  ReminderDto,
  SpotDto,
  TagDto,
  TagSource,
  TimingDto,
  TagDomain,
} from '@flil/shared';
import { TAG_DOMAINS } from '@flil/shared';
import { getDb, parseJson, rowToBool } from '../db.js';
import { config } from '../config.js';
import { fuzzSpotCached, type PlaceRow, type SpotRow } from './fuzzing.js';
import { loadTiming, timingRowToDto, windowSummary } from './windowEngine.js';
import type { AssetRow } from './assets.js';

export interface SerializeContext {
  libraryId: string;
  role: 'owner' | 'member';
  defaultFuzzLevel: FuzzLevel;
  /** 仅 owner 且在"编辑机位"场景为 true */
  includePrecise?: boolean;
}

export function toAssetDto(row: AssetRow): AssetDto {
  return {
    id: row.id,
    inspirationId: row.inspiration_id,
    role: row.role,
    width: row.width,
    height: row.height,
    shotAt: row.shot_at,
    cameraModel: row.camera_model,
    lens: row.lens,
    iso: row.iso,
    aperture: row.aperture,
    shutter: row.shutter,
    hasGpsExif: rowToBool(row.has_gps_exif),
    palette: parseJson(row.palette, []),
    sunElevation: row.sun_elevation,
    sunAzimuth: row.sun_azimuth,
    weatherSnapshot: row.weather_snapshot ? parseJson(row.weather_snapshot, null) : null,
    fileUrl: `/api/assets/${row.id}/file`,
    thumbUrl: `/api/assets/${row.id}/thumb`,
    createdAt: row.created_at,
  };
}

/**
 * 机位序列化 —— 精确坐标的唯一出口（文档 13.3）。
 * 只有 owner 且显式传入 includePrecise 时才会返回 precise 字段。
 */
export function toSpotDto(spot: SpotRow, place: PlaceRow | null, ctx: SerializeContext): SpotDto {
  const canSeePrecise = ctx.role === 'owner' && ctx.includePrecise === true;
  const level: FuzzLevel = canSeePrecise ? 'exact' : ctx.defaultFuzzLevel;
  const fuzz = fuzzSpotCached(spot, place, level === 'exact' ? 'g500' : level);

  return {
    id: spot.id,
    placeId: spot.place_id,
    placeName: place?.name ?? '未命名地点',
    city: place?.city ?? null,
    district: place?.district ?? null,
    tz: spot.tz,
    cameraBearing: spot.camera_bearing,
    elevationM: spot.elevation_m,
    accessNote: spot.access_note,
    bestTimeNote: spot.best_time_note,
    visibility: spot.visibility,
    precise: canSeePrecise ? { lat: spot.lat, lng: spot.lng } : null,
    fuzz,
  };
}

export function toTagDto(row: Record<string, unknown>): TagDto {
  return {
    id: row.id as string,
    domain: row.domain as TagDomain,
    parentId: (row.parent_id as string | null) ?? null,
    name: row.name as string,
    slug: row.slug as string,
    isBuiltin: rowToBool(row.is_builtin),
    disabled: rowToBool(row.disabled),
    sortOrder: (row.sort_order as number) ?? 0,
    usageCount: (row.usage_count as number) ?? 0,
  };
}

export function buildTagTree(rows: Record<string, unknown>[]): TagDto[] {
  const all = rows.map(toTagDto);
  const byId = new Map(all.map((t) => [t.id, t]));
  const roots: TagDto[] = [];
  for (const tag of all) {
    const parent = tag.parentId ? byId.get(tag.parentId) : undefined;
    if (parent) {
      parent.children = parent.children ?? [];
      parent.children.push(tag);
    } else {
      roots.push(tag);
    }
  }
  const order = new Map(TAG_DOMAINS.map((d, i) => [d, i]));
  roots.sort(
    (a, b) => (order.get(a.domain) ?? 9) - (order.get(b.domain) ?? 9) || a.sortOrder - b.sortOrder,
  );
  for (const r of roots) r.children?.sort((a, b) => a.sortOrder - b.sortOrder);
  return roots;
}

export function toAnnotationDto(row: Record<string, unknown>): AnnotationDto {
  return {
    id: row.id as string,
    assetId: row.asset_id as string,
    kind: row.kind as AnnotationDto['kind'],
    geometry: parseJson<Record<string, unknown>>(row.geometry, {}),
    label: (row.label as string | null) ?? null,
  };
}

export interface InspirationRow {
  id: string;
  library_id: string;
  title: string;
  note: string | null;
  status: InspirationDto['status'];
  season_tags: string;
  spot_id: string | null;
  hit_count: number;
  partial_count: number;
  miss_count: number;
  hit_rate: number;
  archived_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function toInspirationDto(
  row: InspirationRow,
  ctx: SerializeContext,
  options: { withWindowSummary?: boolean } = {},
): InspirationDto {
  const db = getDb();

  const tagRows = db
    .prepare(
      `SELECT t.id, t.domain, t.name, t.slug, it.source
       FROM inspiration_tag it JOIN tag t ON t.id = it.tag_id
       WHERE it.inspiration_id = ? AND t.library_id = ?
       ORDER BY t.domain, t.sort_order`,
    )
    .all(row.id, row.library_id) as { id: string; domain: TagDomain; name: string; slug: string; source: TagSource }[];

  const assetRows = db
    .prepare('SELECT * FROM asset WHERE inspiration_id = ? ORDER BY created_at ASC')
    .all(row.id) as AssetRow[];

  let spot: SpotDto | null = null;
  if (row.spot_id) {
    const spotRow = db.prepare('SELECT * FROM spot WHERE id = ?').get(row.spot_id) as SpotRow | undefined;
    if (spotRow) {
      const placeRow = db.prepare('SELECT * FROM place WHERE id = ?').get(spotRow.place_id) as
        | PlaceRow
        | undefined;
      spot = toSpotDto(spotRow, placeRow ?? null, ctx);
    }
  }

  const timingRow = loadTiming(row.id);
  const timing: TimingDto | null = timingRow ? timingRowToDto(timingRow) : null;

  return {
    id: row.id,
    title: row.title,
    note: row.note,
    status: row.status,
    seasonTags: parseJson<number[]>(row.season_tags, []),
    hitCount: row.hit_count,
    partialCount: row.partial_count,
    missCount: row.miss_count,
    hitRate: row.hit_rate,
    archivedReason: row.archived_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: tagRows,
    assets: assetRows.map(toAssetDto),
    spot,
    timing,
    windowSummary: options.withWindowSummary === false ? null : windowSummary(row.id),
  };
}

export function toReminderDto(row: Record<string, unknown>): ReminderDto {
  return {
    id: row.id as string,
    subjectType: row.subject_type as string,
    subjectId: row.subject_id as string,
    ruleCode: (row.rule_code as string | null) ?? null,
    title: row.title as string,
    body: (row.body as string | null) ?? null,
    actionKind: row.action_kind as ReminderDto['actionKind'],
    actionPayload: row.action_payload ? parseJson(row.action_payload, null) : null,
    status: row.status as ReminderDto['status'],
    dueAt: row.due_at as string,
    expireAt: (row.expire_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export function toPlanDto(row: Record<string, unknown>): PlanDto {
  const result = getDb()
    .prepare('SELECT id, hit_level, miss_reasons, note, filled_at FROM shoot_result WHERE plan_id = ?')
    .get(row.id as string) as
    | { id: string; hit_level: HitLevel; miss_reasons: string; note: string | null; filled_at: string }
    | undefined;

  return {
    id: row.id as string,
    inspirationId: row.inspiration_id as string,
    inspirationTitle: (row.inspiration_title as string) ?? '',
    windowId: (row.window_id as string | null) ?? null,
    plannedAt: row.planned_at as string,
    leaveAt: (row.leave_at as string | null) ?? null,
    commuteMin: (row.commute_min as number) ?? 30,
    companions: (row.companions as string | null) ?? null,
    gearNote: (row.gear_note as string | null) ?? null,
    status: row.status as PlanDto['status'],
    cancelReason: (row.cancel_reason as string | null) ?? null,
    result: result
      ? {
          id: result.id,
          hitLevel: result.hit_level,
          missReasons: parseJson<MissReason[]>(result.miss_reasons, []),
          note: result.note,
          filledAt: result.filled_at,
        }
      : null,
  };
}

export function toAlbumDto(row: Record<string, unknown>): AlbumDto {
  const db = getDb();
  const albumId = row.id as string;
  const item = db.prepare('SELECT COUNT(*) AS n FROM album_item WHERE album_id = ?').get(albumId) as {
    n: number;
  };
  const gaps = db
    .prepare(
      "SELECT COUNT(*) AS n FROM album_gap WHERE album_id = ? AND is_required = 1 AND status = 'open'",
    )
    .get(albumId) as { n: number };

  return {
    id: albumId,
    title: row.title as string,
    themeNote: (row.theme_note as string | null) ?? null,
    status: row.status as AlbumDto['status'],
    rules: parseJson(row.rules, {}),
    itemCount: item.n,
    openRequiredGaps: gaps.n,
    coverThumbUrl: item.n > 0 ? `/api/albums/${albumId}/cover` : null,
    publishedAt: (row.published_at as string | null) ?? null,
    updatedAt: row.updated_at as string,
  };
}

export function toGapDto(row: Record<string, unknown>): AlbumGapDto {
  const kind = row.kind as AlbumGapDto['kind'];
  const requirement = parseJson<Record<string, unknown>>(row.requirement, {});
  const albumId = (row.album_id as string) ?? '';
  const tagIds = (requirement.tagIds as string[] | undefined)?.join(',') ?? '';
  const actionMap: Record<AlbumGapDto['kind'], { label: string; href: string }> = {
    tag: { label: '去检索补齐这类标签的卡', href: `/search?tagIds=${tagIds}&excludeAlbum=${albumId}` },
    anchor: { label: '去找这个时段的卡', href: `/search?anchors=${String(requirement.anchor ?? '')}` },
    weather: { label: '去找这种天气的卡', href: `/search?phenomena=${String(requirement.phenomenon ?? '')}` },
    count: { label: '去看最接近主题但未入册的卡', href: `/albums/${albumId}?tab=recommend` },
    result: { label: '去看已接单但未回填的计划', href: '/plans?filter=pending_result' },
  };
  const action = actionMap[kind];

  return {
    id: row.id as string,
    kind,
    requirement,
    currentCount: (row.current_count as number) ?? 0,
    requiredCount: (row.required_count as number) ?? 1,
    isRequired: rowToBool(row.is_required),
    status: row.status as AlbumGapDto['status'],
    waiveReason: (row.waive_reason as string | null) ?? null,
    actionLabel: action.label,
    actionHref: action.href,
  };
}

export function defaultFuzzLevelOf(libraryId: string): FuzzLevel {
  const row = getDb()
    .prepare('SELECT default_fuzz_level FROM library WHERE id = ?')
    .get(libraryId) as { default_fuzz_level: string } | undefined;
  return (row?.default_fuzz_level as FuzzLevel) ?? config.defaultFuzzLevel;
}
