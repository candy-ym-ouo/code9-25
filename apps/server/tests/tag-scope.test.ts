import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

/**
 * 回归：跨资料库标签隔离
 *
 * 历史缺陷：addTags/removeTags 不校验标签归属，库 A 的灵感卡可以绑库 B 的标签，
 *  1. 写入会改动库 B 标签的 usage_count；
 *  2. 库 A 的共现补全可能经由外部标签受影响；
 *  3. 历史脏绑定会泄露进卡片详情、状态机计数与 FTS。
 * 修复后：跨库写入必须 403 拒绝，本库补全只由本库共现决定。
 */
let app: Express;
let tmpDir = '';
let db: typeof import('../src/db.js');

async function register(email: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: 'password123', displayName: email });
  expect(res.status).toBe(201);
  return res.body.token as string;
}

function auth(token: string) {
  return (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown) => {
    let req = request(app)[method](url).set('authorization', `Bearer ${token}`);
    if (body !== undefined) req = req.send(body as object);
    return req;
  };
}

function firstTagId(items: { children?: { id: string; name: string }[] }[], name: string): string {
  for (const g of items) {
    const hit = (g.children ?? []).find((t) => t.name === name);
    if (hit) return hit.id;
  }
  throw new Error(`基线标签缺失：${name}`);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flil-scope-test-'));
  process.env.DATABASE_URL = path.join(tmpDir, 'app.db');
  process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
  process.env.THUMB_DIR = path.join(tmpDir, 'thumbs');
  process.env.SHARE_DIR = path.join(tmpDir, 'share');
  process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
  process.env.JWT_SECRET = 'test-secret';
  process.env.WEATHER_PROVIDER = 'off';
  process.env.ENABLE_CLIMATE_BASELINE = 'false';

  const { createApp } = await import('../src/app.js');
  db = await import('../src/db.js');
  db.migrate();
  app = createApp();
});

afterAll(() => {
  db.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('跨库标签写入必须拒绝', () => {
  it('本库卡绑外库标签 → 403，外库标签 usage_count 不变，绑定不落库', async () => {
    const tokenA = await register('a@scope.test');
    const tokenB = await register('b@scope.test');
    const apiA = auth(tokenA);
    const apiB = auth(tokenB);

    // 库 A：建一张卡
    const cardA = (await apiA('post', '/api/inspirations', { title: 'A库的灵感' })).body.id as string;
    // 库 B：取一个基线标签 id 并记录其 usage_count
    const tagsB = (await apiB('get', '/api/tags')).body.items as {
      children?: { id: string; name: string; usageCount?: number }[];
    }[];
    const foreignTag = firstTagId(tagsB, '逆光');
    const foreignBefore = tagsB
      .flatMap((g) => g.children ?? [])
      .find((t) => t.id === foreignTag)!.usageCount ?? 0;

    // 攻击：A 库卡尝试绑 B 库标签（单绑 + 批量两个入口都必须拒）
    const bulk = await apiA('post', '/api/inspirations/bulk-tag', {
      ids: [cardA],
      addTagIds: [foreignTag],
    });
    expect(bulk.status).toBe(403);
    expect(bulk.body.error.code).toBe('LIBRARY_SCOPE_DENIED');

    // 绑定行不得存在
    const rows = db
      .getDb()
      .prepare('SELECT COUNT(*) AS n FROM inspiration_tag WHERE inspiration_id = ? AND tag_id = ?')
      .get(cardA, foreignTag) as { n: number };
    expect(rows.n).toBe(0);

    // 外库标签计数不被改动
    const countAfter = (
      db.getDb().prepare('SELECT usage_count AS n FROM tag WHERE id = ?').get(foreignTag) as { n: number }
    ).n;
    expect(countAfter).toBe(foreignBefore);

    // A 库卡片状态不能被外库标签推进（仍为 draft，而不是 timing_missing）
    const detail = await apiA('get', `/api/inspirations/${cardA}`);
    expect(detail.body.item.status).toBe('draft');
    expect(detail.body.item.tags).toHaveLength(0);

    // 离线补录入口同样拒绝
    const offline = await apiA('post', '/api/offline/apply', {
      clientOpId: 'scope-attack-1',
      opType: 'tag',
      payload: { inspirationId: cardA, addTagIds: [foreignTag] },
    });
    expect(offline.status).toBe(403);
  });

  it('解绑外库标签同样 403，不能借解绑通道改动外库计数', async () => {
    const tokenA = await register('a2@scope.test');
    const tokenB = await register('b2@scope.test');
    const apiA = auth(tokenA);
    const apiB = auth(tokenB);

    const cardA = (await apiA('post', '/api/inspirations', { title: 'A库第二张' })).body.id as string;
    const tagsB = (await apiB('get', '/api/tags')).body.items as {
      children?: { id: string; name: string }[];
    }[];
    const foreignTag = firstTagId(tagsB, '逆光');

    const res = await apiA('post', '/api/inspirations/bulk-tag', {
      ids: [cardA],
      addTagIds: [],
      removeTagIds: [foreignTag],
    });
    expect(res.status).toBe(403);
  });
});

describe('本库补全结果不受外部标签影响', () => {
  it('共现补全只遍历本库灵感卡：手工植入跨库脏行后，本库建议得分仍为 0', async () => {
    const tokenA = await register('a3@scope.test');
    const tokenB = await register('b3@scope.test');
    const apiA = auth(tokenA);
    const apiB = auth(tokenB);

    const tagsA = (await apiA('get', '/api/tags')).body.items as {
      children?: { id: string; name: string }[];
    }[];
    const tagsB = (await apiB('get', '/api/tags')).body.items as {
      children?: { id: string; name: string }[];
    }[];
    const aLight = firstTagId(tagsA, '逆光');
    const aScene = firstTagId(tagsA, '连廊');
    const bLight = firstTagId(tagsB, '逆光');

    // 库 B：正常共现——B 的"逆光"与 B 的其他标签在同一张卡上（本测试里手工造一条本库共现）
    const cardB = (await apiB('post', '/api/inspirations', { title: 'B库的卡' })).body.id as string;
    await apiB('post', '/api/inspirations/bulk-tag', {
      ids: [cardB],
      addTagIds: [bLight],
    });

    // 攻击注入：把 A 库卡绑到 B 库"逆光"，并在 A 库卡上再放 A 库"连廊"
    // （addTags 已堵死，这里直接写库模拟历史脏数据，验证补全查询本身的隔离性）
    const cardA = (await apiA('post', '/api/inspirations', { title: 'A库受害卡' })).body.id as string;
    const now = new Date().toISOString();
    db.getDb()
      .prepare('INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?,?,?)')
      .run(cardA, bLight, 'manual', now);
    db.getDb()
      .prepare('INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?,?,?)')
      .run(cardA, aScene, 'manual', now);

    // 用 A 库"逆光"种子求补全：脏行制造的跨库共现不得把"连廊"推上来
    const sug = await apiA('get', `/api/tags/suggest?tagIds=${aLight}`);
    expect(sug.status).toBe(200);
    const hit = (sug.body.items as { id: string; score: number }[]).find((t) => t.id === aScene);
    expect(hit?.score ?? 0).toBe(0);

    // 外部标签 id 作为种子也必须被忽略：结果应与"无种子热门兜底"完全一致，
    // 且"连廊"在其中的得分只来自它自己那条本库绑定（1），不是脏行制造的共现（否则会是共现分）
    const sugForeign = await apiA('get', `/api/tags/suggest?tagIds=${bLight}`);
    expect(sugForeign.status).toBe(200);
    const sugPopular = await apiA('get', '/api/tags/suggest');
    expect(sugForeign.body.items).toEqual(sugPopular.body.items);
    const sceneInFallback = (sugForeign.body.items as { id: string; score: number }[]).find(
      (t) => t.id === aScene,
    );
    if (sceneInFallback) expect(sceneInFallback.score).toBe(1);
  });

  it('同库真实共现仍能正常推荐（隔离不误伤正常路径）', async () => {
    const token = await register('normal@scope.test');
    const api = auth(token);
    const tags = (await api('get', '/api/tags')).body.items as {
      children?: { id: string; name: string }[];
    }[];
    const light = firstTagId(tags, '逆光');
    const scene = firstTagId(tags, '连廊');

    const c1 = (await api('post', '/api/inspirations', { title: '正常卡1' })).body.id as string;
    const c2 = (await api('post', '/api/inspirations', { title: '正常卡2' })).body.id as string;
    await api('post', '/api/inspirations/bulk-tag', { ids: [c1, c2], addTagIds: [light, scene] });

    const sug = await api('get', `/api/tags/suggest?tagIds=${light}`);
    const hit = (sug.body.items as { id: string; score: number }[]).find((t) => t.id === scene);
    expect(hit).toBeTruthy();
    expect(hit!.score).toBeGreaterThanOrEqual(2);
  });
});

describe('存量脏数据迁移清理', () => {
  it('迁移脚本删除跨库绑定并重算 usage_count', async () => {
    const tokenA = await register('a4@scope.test');
    const tokenB = await register('b4@scope.test');
    const apiA = auth(tokenA);
    const apiB = auth(tokenB);

    const tagsB = (await apiB('get', '/api/tags')).body.items as {
      children?: { id: string; name: string }[];
    }[];
    const bLight = firstTagId(tagsB, '逆光');

    const cardA = (await apiA('post', '/api/inspirations', { title: '待清理卡' })).body.id as string;
    const now = new Date().toISOString();
    // 植入脏绑定 + 抬高外库计数
    db.getDb()
      .prepare('INSERT INTO inspiration_tag (inspiration_id, tag_id, source, created_at) VALUES (?,?,?,?)')
      .run(cardA, bLight, 'manual', now);
    db.getDb().prepare('UPDATE tag SET usage_count = usage_count + 50 WHERE id = ?').run(bLight);

    // 直接执行迁移文件中的清理语句（与 0002 SQL 等价的同一段逻辑）
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'sql', '0002_purge_cross_library_tags.sql'),
      'utf8',
    );
    db.getDb().exec(sql);

    const left = db
      .getDb()
      .prepare('SELECT COUNT(*) AS n FROM inspiration_tag WHERE inspiration_id = ? AND tag_id = ?')
      .get(cardA, bLight) as { n: number };
    expect(left.n).toBe(0);
    const recounted = (
      db.getDb().prepare('SELECT usage_count AS n FROM tag WHERE id = ?').get(bLight) as { n: number }
    ).n;
    expect(recounted).toBe(0);
  });
});
