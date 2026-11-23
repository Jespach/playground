-- Gold: training and recovery side by side, one row per day.
CREATE OR REFRESH MATERIALIZED VIEW daily_overview
COMMENT 'Per-day training totals joined to Garmin wellness (sleep, HRV, RHR, Body Battery)'
AS WITH t AS (
  SELECT
    activity_date AS day,
    count(*)                        AS sessions,
    round(sum(distance_km), 2)      AS distance_km,
    round(sum(moving_minutes), 1)   AS moving_minutes,
    sum(elevation_gain_m)           AS elevation_gain_m,
    sum(training_load)              AS training_load,
    concat_ws(',', array_sort(collect_set(sport))) AS sports
  FROM activities
  GROUP BY activity_date
)
SELECT
  coalesce(w.day, t.day) AS day,
  coalesce(t.sessions, 0) AS sessions,
  t.sports, t.distance_km, t.moving_minutes, t.elevation_gain_m, t.training_load,
  w.steps, w.resting_hr, w.avg_stress, w.body_battery_high, w.body_battery_low,
  w.sleep_hours, w.deep_sleep_hours, w.rem_sleep_hours, w.sleep_score,
  w.hrv_last_night, w.hrv_weekly_avg, w.hrv_status
FROM garmin_daily w
FULL OUTER JOIN t ON w.day = t.day;
