-- Gold: weekly volume per sport (weeks start Monday).
CREATE OR REFRESH MATERIALIZED VIEW weekly_training
COMMENT 'Weekly training volume by sport'
AS SELECT
  CAST(date_trunc('WEEK', activity_date) AS DATE) AS week_start,
  sport,
  count(*)                           AS sessions,
  round(sum(distance_km), 1)         AS distance_km,
  round(sum(moving_minutes) / 60, 2) AS hours,
  round(sum(elevation_gain_m))       AS elevation_gain_m,
  round(avg(avg_hr))                 AS avg_hr,
  round(sum(training_load))          AS training_load
FROM activities
GROUP BY ALL;
