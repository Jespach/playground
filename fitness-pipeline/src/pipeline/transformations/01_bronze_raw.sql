-- Bronze: every record ever pulled from Garmin, append-only.
-- payload is the untouched API JSON, parsed downstream with `payload:field` paths.
CREATE OR REFRESH STREAMING TABLE bronze_raw (
  CONSTRAINT has_key EXPECT (key IS NOT NULL AND payload IS NOT NULL) ON VIOLATION DROP ROW
)
COMMENT 'Raw Garmin API records, one row per fetch'
AS SELECT
  source, entity, key, fetched_at, payload,
  _metadata.file_path AS _file,
  current_timestamp() AS _ingested_at
FROM STREAM read_files(
  '${raw_landing_path}',
  format => 'json',
  schema => 'source STRING, entity STRING, key STRING, fetched_at TIMESTAMP, payload STRING'
);
