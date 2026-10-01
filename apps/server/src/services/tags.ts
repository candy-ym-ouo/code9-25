import { getDb, newId, nowIso } from '../db.js';
import { errors } from '../http/errors.js';
import { slugify } from './inspirations.js';

export function createTag(params: {
  libraryId: string;
  domain: string;
  name: string;
  parentId?: string | null;
}): string {
  const db = getDb();
  const slug = slugify(params.name);
  const existing = db
    .prepare('SELECT id FROM tag WHERE library_id = ? AND domain = ? AND slug = ?')
    .get(params.libraryId, params.domain, slug) as { id: string } | undefined;
  if (existing) throw errors.badRequest('同域下已存在同名标签', { tagId: existing.id });

  if (params.parentId) {
    const parent = db.prepare('SELECT domain, library_id FROM tag WHERE id = ?').get(params.parentId) as
      | { domain: string; library_id: string }
      | undefined;
    if (!parent) throw errors.notFound('父标签');
    if (parent.library_id !== params.libraryId) throw errors.scopeDenied();
    if (parent.domain !== params.domain) throw errors.badRequest('父标签必须属于同一标签域');
  }

  const maxOrder = (
    db
      .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tag WHERE library_id = ? AND domain = ?')
      .get(params.libraryId, params.domain) as { m: number }
  ).m;

  const id = newId();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO tag (id, library_id, domain, parent_id, name, slug, is_builtin, disabled, sort_order,
       usage_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,0,0,?,0,?,?)`,
  ).run(
    id,
    params.libraryId,
    params.domain,
    params.parentId ?? null,
    params.name,
    slug,
    maxOrder + 10,
    ts,
    ts,
  );
  return id;
}

export function updateTag(
  id: string,
  libraryId: string,
  patch: { name?: string; parentId?: string | null; sortOrder?: number; disabled?: boolean },
): void {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tag WHERE id = ?').get(id) as
    | { id: string; library_id: string; domain: string; is_builtin: number }
    | undefined;
  if (!row) throw errors.notFound('标签');
  if (row.library_id !== libraryId) throw errors.scopeDenied();

  if (patch.name !== undefined) {
    if (row.is_builtin) throw errors.forbiddenRole('内置标签不可改名，可停用或新增自定义标签');
    db.prepare('UPDATE tag SET name = ?, slug = ?, updated_at = ? WHERE id = ?').run(
      patch.name,
      slugify(patch.name),
      nowIso(),
      id,
    );
  }
  if (patch.parentId !== undefined) {
    db.prepare('UPDATE tag SET parent_id = ?, updated_at = ? WHERE id = ?').run(patch.parentId, nowIso(), id);
  }
  if (patch.sortOrder !== undefined) {
    db.prepare('UPDATE tag SET sort_order = ?, updated_at = ? WHERE id = ?').run(patch.sortOrder, nowIso(), id);
  }
  if (patch.disabled !== undefined) {
    db.prepare('UPDATE tag SET disabled = ?, updated_at = ? WHERE id = ?').run(
      patch.disabled ? 1 : 0,
      nowIso(),
      id,
    );
  }
}

/** 合并标签：绑定关系迁移 + 去重 + usage_count 重算（文档 11.2） */
export function mergeTags(sourceId: string, targetId: string, libraryId: string): void {
  const db = getDb();
  const src = db.prepare('SELECT * FROM tag WHERE id = ?').get(sourceId) as
    | { id: string; library_id: string; domain: string }
    | undefined;
  const tgt = db.prepare('SELECT * FROM tag WHERE id = ?').get(targetId) as
    | { id: string; library_id: string; domain: string }
    | undefined;
  if (!src || !tgt) throw errors.notFound('标签');
  if (src.library_id !== libraryId || tgt.library_id !== libraryId) throw errors.scopeDenied();
  if (src.domain !== tgt.domain) throw errors.badRequest('只能合并同一标签域内的标签');
  if (sourceId === targetId) throw errors.badRequest('源标签与目标标签不能相同');

  const run = db.transaction(() => {
    const bindings = db
      .prepare(
        `SELECT it.inspiration_id
         FROM inspiration_tag it
         JOIN inspiration i ON i.id = it.inspiration_id AND i.library_id = ?
         WHERE it.tag_id = ?`,
      )
      .all(libraryId, sourceId) as { inspiration_id: string }[];
    for (const b of bindings) {
      db.prepare(
        `INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?, 'bulk', ?)
         ON CONFLICT (inspiration_id, tag_id) DO NOTHING`,
      ).run(b.inspiration_id, targetId, nowIso());
    }
    db.prepare('DELETE FROM tag WHERE id = ?').run(sourceId);
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM inspiration_tag it
           JOIN inspiration i ON i.id = it.inspiration_id AND i.library_id = ?
           WHERE it.tag_id = ?`,
        )
        .get(libraryId, targetId) as { n: number }
    ).n;
    db.prepare('UPDATE tag SET usage_count = ? WHERE id = ?').run(n, targetId);
  });
  run();
}

export function listTags(libraryId: string, includeDisabled = false): Record<string, unknown>[] {
  const where = includeDisabled ? '' : 'AND disabled = 0';
  return getDb()
    .prepare(`SELECT * FROM tag WHERE library_id = ? ${where} ORDER BY domain, sort_order, name`)
    .all(libraryId) as Record<string, unknown>[];
}

/** 标签补全建议：基于同库共现频次（只建议、不自动写入，文档 11.2） */
export function suggestTags(
  libraryId: string,
  tagIds: string[],
  limit = 8,
): { id: string; name: string; domain: string; score: number }[] {
  const db = getDb();
  if (!tagIds.length) {
    return (
      db
        .prepare(
          'SELECT id, name, domain, usage_count FROM tag WHERE library_id = ? AND disabled = 0 ORDER BY usage_count DESC LIMIT ?',
        )
        .all(libraryId, limit) as { id: string; name: string; domain: string; usage_count: number }[]
    ).map((t) => ({ id: t.id, name: t.name, domain: t.domain, score: t.usage_count }));
  }

  const placeholders = tagIds.map(() => '?').join(',');
  // 共现的两端（种子标签 a 与候选标签 t）以及承载共现的灵感都必须属于本库，
  // 外部库标签或历史遗留的跨库绑定都不能影响本库补全结果。
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.domain, COUNT(*) AS co
       FROM inspiration i
       JOIN inspiration_tag a ON a.inspiration_id = i.id
       JOIN inspiration_tag b ON b.inspiration_id = i.id
       JOIN tag at ON at.id = a.tag_id AND at.library_id = i.library_id
       JOIN tag t ON t.id = b.tag_id AND t.library_id = i.library_id
       WHERE at.id IN (${placeholders})
         AND t.id NOT IN (${placeholders})
         AND i.library_id = ? AND t.disabled = 0
       GROUP BY t.id
       ORDER BY co DESC
       LIMIT ?`,
    )
    .all(...tagIds, ...tagIds, libraryId, limit) as {
    id: string;
    name: string;
    domain: string;
    co: number;
  }[];
  return rows.map((r) => ({ id: r.id, name: r.name, domain: r.domain, score: r.co }));
}
