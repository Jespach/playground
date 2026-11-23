-- Silver: latest version of each record. Activities get edited and sleep gets
-- finalised later, so re-fetches overwrite instead of duplicating.
CREATE OR REFRESH STREAMING TABLE raw_latest
COMMENT 'Latest fetched version of each (source, entity, key)';

CREATE FLOW raw_latest_flow AS AUTO CDC INTO raw_latest
FROM STREAM(bronze_raw)
KEYS (source, entity, key)
SEQUENCE BY fetched_at
COLUMNS * EXCEPT (_file, _ingested_at)
STORED AS SCD TYPE 1;
