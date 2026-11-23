CREATE OR REFRESH MATERIALIZED VIEW garmin_activities
COMMENT 'Garmin Connect activities, typed. Distances in metres, times in seconds.'
AS SELECT
  CAST(key AS BIGINT)                                   AS garmin_activity_id,
  payload:activityName::string                          AS name,
  payload:activityType.typeKey::string                  AS activity_type,
  to_timestamp(payload:startTimeGMT::string)            AS start_time_utc,
  to_timestamp(payload:startTimeLocal::string)          AS start_time_local,
  payload:distance::double                              AS distance_m,
  payload:movingDuration::double                        AS moving_time_s,
  payload:duration::double                              AS duration_s,
  payload:elevationGain::double                         AS elevation_gain_m,
  payload:averageSpeed::double                          AS avg_speed_mps,
  payload:averageHR::double                             AS avg_hr,
  payload:maxHR::double                                 AS max_hr,
  payload:avgPower::double                              AS avg_watts,
  payload:calories::double                              AS calories,
  payload:aerobicTrainingEffect::double                 AS aerobic_te,
  payload:anaerobicTrainingEffect::double               AS anaerobic_te,
  payload:activityTrainingLoad::double                  AS training_load,
  payload:vO2MaxValue::double                           AS vo2max,
  payload:steps::int                                    AS steps,
  fetched_at
FROM raw_latest
WHERE source = 'garmin' AND entity = 'activities';
