-- One row per day: Garmin daily summary + sleep + HRV.
CREATE OR REFRESH MATERIALIZED VIEW garmin_daily
COMMENT 'Garmin wellness per calendar day (steps, RHR, stress, Body Battery, sleep, HRV)'
AS WITH
summary AS (
  SELECT CAST(key AS DATE) AS day, payload FROM raw_latest
  WHERE source = 'garmin' AND entity = 'daily_summary'
),
sleep AS (
  SELECT CAST(key AS DATE) AS day, payload:dailySleepDTO AS s FROM raw_latest
  WHERE source = 'garmin' AND entity = 'sleep'
),
hrv AS (
  SELECT CAST(key AS DATE) AS day, payload:hrvSummary AS h FROM raw_latest
  WHERE source = 'garmin' AND entity = 'hrv'
)
SELECT
  coalesce(summary.day, sleep.day, hrv.day)           AS day,
  summary.payload:totalSteps::int                     AS steps,
  summary.payload:totalDistanceMeters::double         AS distance_m,
  summary.payload:totalKilocalories::double           AS total_kcal,
  summary.payload:activeKilocalories::double          AS active_kcal,
  summary.payload:restingHeartRate::int               AS resting_hr,
  summary.payload:averageStressLevel::int             AS avg_stress,
  summary.payload:bodyBatteryHighestValue::int        AS body_battery_high,
  summary.payload:bodyBatteryLowestValue::int         AS body_battery_low,
  summary.payload:bodyBatteryChargedValue::int        AS body_battery_charged,
  summary.payload:moderateIntensityMinutes::int       AS moderate_minutes,
  summary.payload:vigorousIntensityMinutes::int       AS vigorous_minutes,
  summary.payload:floorsAscended::double              AS floors,
  sleep.s:sleepTimeSeconds::int / 3600.0              AS sleep_hours,
  sleep.s:deepSleepSeconds::int / 3600.0              AS deep_sleep_hours,
  sleep.s:remSleepSeconds::int / 3600.0               AS rem_sleep_hours,
  sleep.s:awakeSleepSeconds::int / 3600.0             AS awake_hours,
  sleep.s:sleepScores.overall.value::int              AS sleep_score,
  hrv.h:lastNightAvg::int                             AS hrv_last_night,
  hrv.h:weeklyAvg::int                                AS hrv_weekly_avg,
  hrv.h:status::string                                AS hrv_status
FROM summary
FULL OUTER JOIN sleep ON summary.day = sleep.day
FULL OUTER JOIN hrv   ON coalesce(summary.day, sleep.day) = hrv.day;
