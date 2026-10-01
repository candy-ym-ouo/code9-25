-- 修复跨库标签绑定：历史上 addTags/removeTags 未校验标签所属库，
-- 可能已写入"本库灵感 ↔ 他库标签"的绑定并改动了他库标签的 usage_count。
-- 1) 删除所有灵感库与标签库不一致的跨库绑定；
-- 2) 按清理后的合法绑定重算全部标签的 usage_count（SQLite 支持 UPDATE 聚合子查询）。

DELETE FROM inspiration_tag
WHERE EXISTS (
  SELECT 1
  FROM inspiration i
  JOIN tag t ON t.id = inspiration_tag.tag_id
  WHERE i.id = inspiration_tag.inspiration_id
    AND i.library_id <> t.library_id
);

UPDATE tag
SET usage_count = (
  SELECT COUNT(*)
  FROM inspiration_tag it
  JOIN inspiration i ON i.id = it.inspiration_id AND i.library_id = tag.library_id
  WHERE it.tag_id = tag.id
);
