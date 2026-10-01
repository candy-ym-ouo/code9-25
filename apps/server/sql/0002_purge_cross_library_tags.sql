-- 0002: 修复"灵感可绑定其他资料库标签并改动对方计数"
--
-- 问题：inspiration_tag 没有跨库行级约束，历史版本可把本库灵感卡绑到外库标签，
-- 既污染外库 tag.usage_count，又能借共现路径影响本库补全。
-- 应用层（addTags/removeTags/mergeTags/mergeInspirations/suggestTags）已加硬边界，
-- 本迁移负责一次性清理存量脏数据，使计数与真实本库绑定一致。

-- 1) 删除所有"灵感卡所属库 ≠ 标签所属库"的跨库绑定行
DELETE FROM inspiration_tag
WHERE EXISTS (
  SELECT 1
  FROM inspiration i, tag t
  WHERE i.id = inspiration_tag.inspiration_id
    AND t.id = inspiration_tag.tag_id
    AND i.library_id <> t.library_id
);

-- 2) 按清理后的本库绑定重算每个标签的 usage_count
UPDATE tag
SET usage_count = (
  SELECT COUNT(*)
  FROM inspiration_tag it
  JOIN inspiration i ON i.id = it.inspiration_id AND i.library_id = tag.library_id
  WHERE it.tag_id = tag.id
);
