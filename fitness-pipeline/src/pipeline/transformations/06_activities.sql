-- Gold: one row per workout with friendly units and a normalised sport.
CREATE OR REFRESH MATERIALIZED VIEW activities
COMMENT 'Garmin activities with normalised sport, km, minutes and pace'
AS SELECT
  CAST(start_time_local AS DATE) AS activity_date,
  CASE
    WHEN lower(activity_type) RLIKE 'run'                       THEN 'run'
    WHEN lower(activity_type) RLIKE 'ride|cycl|bik|spin'        THEN 'ride'
    WHEN lower(activity_type) RLIKE 'swim'                      THEN 'swim'
    WHEN lower(activity_type) RLIKE 'walk|hik'                  THEN 'walk_hike'
    WHEN lower(activity_type) RLIKE 'strength|weight|crossfit'  THEN 'strength'
    WHEN lower(activity_type) RLIKE 'golf'                      THEN 'golf'
    WHEN lower(activity_type) RLIKE 'tennis|padel|paddel|squash|pickleball|badminton' THEN 'racket'
    WHEN lower(activity_type) RLIKE 'paddleboard|kayak|canoe|rowing_v2|surf' THEN 'paddle'
    WHEN lower(activity_type) RLIKE 'cardio|hiit|rowing|elliptical|stair|fitness_equipment' THEN 'gym_cardio'
    ELSE 'other'
  END AS sport,
  activity_type,
  name,
  start_time_utc,
  start_time_local,
  round(distance_m / 1000, 2)                                 AS distance_km,
  round(coalesce(moving_time_s, duration_s) / 60, 1)          AS moving_minutes,
  CASE WHEN distance_m > 0 AND lower(activity_type) RLIKE 'run|walk|hik'
       THEN round((coalesce(moving_time_s, duration_s) / 60) / (distance_m / 1000), 2) END AS pace_min_per_km,
  elevation_gain_m, avg_hr, max_hr, avg_watts,
  round(calories)                                             AS calories,
  training_load, aerobic_te, anaerobic_te, vo2max,
  garmin_activity_id
FROM garmin_activities;
