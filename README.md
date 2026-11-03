# Historic Rainfall Explorer

A small, static website that lets you pick a location on a map and pull historic rainfall data from the Open-Meteo historical weather API.

## Features

- Interactive map selector
- Search by place name using OpenStreetMap Nominatim
- Historical rainfall data from Open-Meteo
- Date range controls
- Chart and daily table summary
- Easy deployment to GitHub Pages

## Local development

From the project folder:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## GitHub Pages deployment

1. Push this project to a GitHub repository.
2. In GitHub, open the repository settings.
3. Navigate to Pages.
4. Set the source to `Deploy from a branch`.
5. Choose the `main` branch and the root folder.
6. Save.

Your website will be available at:

```text
https://<your-username>.github.io/<repository-name>/
```

## API used

- Open-Meteo Archive API: https://open-meteo.com/en/docs/historical-weather-api

## Notes

This app uses client-side JavaScript and can be hosted as a static website on GitHub Pages without any backend.
