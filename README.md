# West Lafayette windshield forecast

A small browser app for West Lafayette, Indiana. Using Open-Meteo weather, it estimates outside frost at departure and when ice may clear naturally over the next three mornings. Compare the front windshield, a typical raised side window and an unheated side mirror. The website assumes closed windows. The side-window and mirror estimates each represent either side of the car. One side may get more shelter or earlier sun.

## Run locally

Serve the repository root with a static server.

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. Settings, original predictions and observations are stored in that browser. Choose the surface when logging frost or a clear morning. Rear glass is available for observations only. Export observations as JSON from the page.

## Publish on GitHub Pages

The files are ready for GitHub Pages publishing from the root of the `main` branch. The repository contains no email address, credentials, observations or private settings. Visitors use Open-Meteo directly under its noncommercial hosted API terms.

## Evening alerts

A separate scheduled Gmail task can run `node nightly.mjs` with Node 20 or newer, then use the JSON output to send the front-windshield forecast. No Gmail credentials are needed by this site. Defaults are 8 a.m. departure, open sky, indirect light, closed windows, and initially dry glass. Set `FROST_DEPARTURE`, `FROST_PARKING`, `FROST_SUN`, `FROST_WINDOWS`, and `FROST_WET` in the task to change them. `FROST_SITE_URL` enables a link that imports the emailed prediction for later verification. Browser settings are local to each browser and cannot update a remote scheduled task.

The model page describes assumptions and links the sources. This is a sensitivity estimate for an uncovered or sheltered surface, with no measured probability attached.
