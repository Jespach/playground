---
name: workout-analysis
description: Analyse one of the user's Garmin workouts (run, ride, intervals, long run, race, trail) from their Databricks fitness pipeline and show it as interactive charts in chat. Use whenever the user asks about a specific workout or session ("how was my run today", "analyse Tuesday's intervals", "my long run last Sunday", "compare my last two 6x4min sessions", "show me workout 22661355753"), or clicks a widget button that asks to analyse or compare a workout.
---

# Workout analysis

The `fitness-workouts` MCP server (fitness-pipeline/mcp/workout_server.py, registered in the
Playground `.mcp.json`) reads `workspace.fitness` on Databricks. Its tools are read-only:

| Tool | Use |
|---|---|
| `find_workouts(date_from, date_to, sport, text, min_km, max_km, limit)` | Locate candidates. Returns `total_matches` and `has_streams` |
| `get_workout(activity_id, points=160, max_hr=None)` | Full analysis plus `widget_data` for the chart template |
| `compare_workouts(activity_ids)` | 2–5 sessions on a shared distance axis, plus km splits |
| `query_fitness(sql)` | Ad-hoc read-only SELECT for follow-ups (`{S}` = `workspace.fitness`) |

If the tools are missing, tell the user the server needs approving or restarting (the
Code tab asks to approve project MCP servers in `.mcp.json`). Don't fall back to guessing.

## 1. Pin down the workout

Today's date is in your context; the user is in South Africa (SAST, UTC+2). Turn
relative phrases into ISO dates yourself ("Tuesday" = the most recent Tuesday, "last
weekend" = Sat–Sun) and call `find_workouts` with the tightest filters the request
supports: sport words map to `sport` ("run", "ride", "trail", "indoor", "swim"), and
named sessions map to `text` ("intervals", "parkrun", "Workout").

- **Exactly one plausible match** → go straight to step 2. Don't ask for confirmation.
- **Several plausible matches** → ask with `AskUserQuestion`: up to 4 options, label like
  `Tue 24 Nov · Trail run 8.8 km`, with the pace/HR/elevation in the description. If
  more than 4 match, ask a narrowing question (which day or which type) instead.
- **None** → widen once (±3 days, drop the sport filter), then say what you searched.
- `has_streams: false` (strength, golf, hikes, swims) → only the summary exists. Say so
  and give the summary from `find_workouts`; there's no chart.

## 2. Fetch and render

1. `get_workout(id)`. Pass `max_hr` only if the user has told you theirs.
2. If you haven't this conversation, call `mcp__visualize__read_me` (modules `chart`,
   `interactive`) before your first widget. That's required by the widget tool.
3. Read `workout.html` from this skill folder. Replace the token `__DATA__` with the
   tool's `widget_data` object serialised as compact JSON, **unchanged**. Don't edit,
   round or drop fields, and don't change the rest of the template. Call
   `mcp__visualize__show_widget` with that HTML and a title like
   `workout_2026_11_24_trail_run`.
4. For comparisons, do the same with `compare.html` and the full `compare_workouts` result.

The template already handles missing data (no GPS, no HR, rides vs runs, no reps,
no similar sessions). Never hand-build a replacement chart for these cases.

## 3. Write the analysis (as text, after the widget)

Lead with a two-line verdict, then cover only what matters for the workout type
(`analysis.workout_type_guess`; override it if the name says otherwise):

- **Intervals** (`analysis.reps`, `rep_summary`): hit rate and consistency (`pace_cv_pct`,
  spread), fade (`fade_last_vs_first_pct`, positive = slower), HR creep at that pace,
  60 s HR drop (`drop_60s`, higher = better recovery; a falling trend across reps
  means accumulated fatigue), and whether the recoveries were truly easy.
- **Long / easy / steady**: zone distribution (easy should be mostly Z1–Z2),
  `decoupling` (<5% good, 5–10% okay, >10% fade). Respect `reliable: false`: on hilly
  or trail runs, discuss effort on climbs instead.
- **Race / hard steady**: pacing (laps, best efforts), HR profile, and best efforts vs
  past ones (`query_fitness` on similar sessions if needed).
- **Context** (`context.going_in`, `context.morning_of`): form (TSB), ACWR, HRV z-score,
  resting HR, and sleep. Use them to explain a good or bad day, not to restate them.
- **Progress** (`similar`): compare with the most recent comparable sessions: rep pace or
  avg pace at what HR, and EF (higher = fitter). Mention `similar.basis` once.

Finish with 1–3 concrete takeaways for the next sessions (relate them to the user's
goals: the Cape Town Marathon 2027-05-23 target 2:55, read from `{S}.goals` if needed).
Keep it tight. Use a markdown table only when it's genuinely tabular (for example
rep-by-rep).

Caveats to apply quietly, only when relevant: wrist HR lags and spikes in the first
minutes and in short reps; Garmin "training load" is EPOC-based, not TSS; max HR for
zones is estimated (`max_hr_source`), so offer to set it if the zones look off; trail
running pace isn't comparable to road pace.

## 4. Follow-ups

Widget buttons send prompts like "Analyse workout <id> from <date>" or "Compare workout
A with workout B". Handle them with the same flow and skip step 1. For questions the
tools don't answer directly (for example "all my 4×1 km sessions this year", "fastest
5 km in 2026"), use `query_fitness`. Key tables: `activities`, `activity_laps`,
`activity_samples` (always filter by `garmin_activity_id`), `fitness_daily`,
`training_weeks`, `goals`, `race_predictions`.

Data freshness: the pipeline syncs daily at 06:00 SAST. A workout from the last few
hours may not be there yet; say so if it's missing.
