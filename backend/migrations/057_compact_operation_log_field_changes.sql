-- YaERP 2.0 - shrink oversized operation log metadata
-- History entries used to store the whole sheet config (the entire worksheet)
-- as before/after values in metadata.field_changes, about 1.5MB per edit on a
-- large sheet, which made the history panel download tens of megabytes. Keep
-- the change entries but replace values over 2KB with a short notice, the same
-- way new entries are written. Rows already compacted no longer match.

UPDATE operation_logs AS l
SET metadata = jsonb_set(l.metadata, '{field_changes}', compacted.changes)
FROM (
    SELECT o.id,
           COALESCE(jsonb_agg(
               CASE WHEN length(change::text) > 4096 THEN jsonb_build_object(
                   'field', change->>'field',
                   'old_value', CASE WHEN length(COALESCE(change->'old_value', 'null'::jsonb)::text) > 2048
                       THEN to_jsonb('（内容较大，已省略；可在版本历史中对比）'::text) ELSE change->'old_value' END,
                   'new_value', CASE WHEN length(COALESCE(change->'new_value', 'null'::jsonb)::text) > 2048
                       THEN to_jsonb('（内容较大，已省略；可在版本历史中对比）'::text) ELSE change->'new_value' END
               ) ELSE change END
               ORDER BY ordinality
           ), '[]'::jsonb) AS changes
    FROM operation_logs o
    CROSS JOIN LATERAL jsonb_array_elements(o.metadata->'field_changes') WITH ORDINALITY AS entries(change, ordinality)
    WHERE jsonb_typeof(o.metadata->'field_changes') = 'array'
      AND pg_column_size(o.metadata) > 16384
    GROUP BY o.id
) AS compacted
WHERE l.id = compacted.id
  AND length(compacted.changes::text) < length((l.metadata->'field_changes')::text);
