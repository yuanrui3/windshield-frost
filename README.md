# West Lafayette windshield forecast

A small browser app for West Lafayette, Indiana. Using Open-Meteo weather, it estimates outside frost at departure and when ice may clear naturally over the next three mornings. Compare the front windshield, a typical raised side window and an unheated side mirror. The website assumes closed windows. The side-window and mirror estimates each represent either side of the car. One side may get more shelter or earlier sun.

## Run locally

Serve the repository root with a static server.

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. Settings, original predictions and observations are stored in that browser. Choose the surface when logging frost or a clear morning. Rear glass is available for observations only. Export observations as JSON from the page.

## Feedback and calibration

The forecast poll records false alarms, missed frost and correct calls for the chosen surface and morning. The local log keeps the visitor's assessment alongside the original forecast when available. The optional Google Form lets visitors review and submit a poll report to the project owner without providing a name or email address. The response collection is private. Detailed notes stay in the browser.

Run an offline check on an exported browser log with Node 20 or newer.

```sh
node calibrate.mjs EXPORTED-LOG.json
```

The report counts clear and icy observations by surface, model version and original risk label. It checks the forecast existed before the glass was checked and requires the observation time to be within an hour of departure. A detailed observation takes precedence over a duplicate poll response for the same morning and surface. With enough matched mornings and examples of both outcomes, the tool fits frost frequencies on earlier dates and scores them against later dates. Voluntary reports may overrepresent errors. The command writes its evaluation to standard output. Changes to the live model require a separate review and update.

For the project owner, export the private `Email feedback` or `Website feedback` tab as a CSV with its 17-column header. The same command also accepts Sheets values as a JSON array of rows or a JSON object with a `values` array.

```sh
node calibrate.mjs PRIVATE-FEEDBACK.csv
```

These exports contain normalized observations. For each surface and date, agreeing reports count once. The report lists conflicting groups among the exclusions and uses the same dates for testing across all surfaces. Run this analysis locally and keep the private exports outside the public repository.

## Publish on GitHub Pages

The files are ready for GitHub Pages publishing from the root of the `main` branch. The repository contains no email address, credentials, observations or private settings. Visitors use Open-Meteo directly under its noncommercial hosted API terms.

## Evening alerts

A separate scheduled Gmail task can run `node nightly.mjs` with Node 20 or newer, then use the JSON output to send the front-windshield forecast. No Gmail credentials are needed by this site. Defaults are 8 a.m. departure, open sky, indirect light, closed windows, and initially dry glass. Set `FROST_DEPARTURE`, `FROST_PARKING`, `FROST_SUN`, `FROST_WINDOWS`, and `FROST_WET` in the task to change them. `FROST_SITE_URL` enables a link that imports the emailed prediction for later verification. Browser settings are local to each browser and cannot update a remote scheduled task.

The connected Gmail task processes replies once each evening. A reply can report the observed surface, whether it was clear or frosty, and the check time. The private feedback sheet keeps the explicit observation and the issued verdict when available. A stable message ID lets the task recognize the same reply on a later run.

The model page describes assumptions and links the sources. This is a sensitivity estimate for an uncovered or sheltered surface, with no measured probability attached.
