# Historic Rainfall Explorer

A small static website: pick a location on a map and explore its historic rainfall and temperature from Open-Meteo (ERA5 reanalysis, 1940 onwards).

## Features

- Interactive map (street or satellite). Click anywhere to choose a location; the data reloads automatically.
- Saved places (Grootkoppe, Patrysvlei, Hermanus) for one-click navigation. Edit `SAVED_PLACES` in `script.js` to change them.
- Place search and reverse lookup using OpenStreetMap Nominatim (rate-limited to 1 request per second).
- Group results by day, week, month, quarter or year.
- Charts: rainfall per period, cumulative rainfall, rolling 7-day total, rainfall vs temperature, and a month × year seasonal heatmap.
- Summary of total, daily average, rain days (≥1 mm), data coverage and the wettest day.
- Missing days show as gaps. They are not counted as zero rainfall.
- The URL keeps the location, dates, grouping and chart view, so you can bookmark or share a view.
- Download the daily data as CSV.
- Light and dark themes follow your system setting.

## Local development

From the project folder:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

## GitHub Pages deployment

1. Push this project to a GitHub repository.
2. In the repository settings, open **Pages**.
3. Set the source to **Deploy from a branch**.
4. Choose your default branch (for example `master`) and the root folder, then save.

The site will be available at `https://<your-username>.github.io/<repository-name>/`.

## APIs used

- [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api)
- [Nominatim](https://nominatim.org/release-docs/latest/api/Overview/) for geocoding

All requests are made from the browser; there is no backend.
