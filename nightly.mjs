import { DEFAULTS, MODEL_VERSION, forecastUrl, getLocalDate, nextLocalDate, predict } from './model.mjs';

const zone = 'America/Indiana/Indianapolis';
const localClock = new Intl.DateTimeFormat('en-US', {
  timeZone: zone, hour: 'numeric', minute: '2-digit',
});
const riskLabels = { low: 'Frost unlikely', possible: 'Frost possible', likely: 'Frost likely' };

const settings = {
  departure: process.env.FROST_DEPARTURE || DEFAULTS.departure,
  parking: process.env.FROST_PARKING || DEFAULTS.parking,
  sun: process.env.FROST_SUN || DEFAULTS.sun,
  windows: process.env.FROST_WINDOWS || DEFAULTS.windows,
  wet: process.env.FROST_WET === 'true',
};
const now = new Date(process.env.FROST_NOW || Date.now());
if (!Number.isFinite(+now)) throw new Error('Invalid alert run time.');
const response = await fetch(forecastUrl(now), { signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}.`);
const issued = new Date().toISOString();
const weather = await response.json();
const days = [];
let date = nextLocalDate(getLocalDate(now));
for (let i = 0; i < 3; i += 1, date = nextLocalDate(date)) {
  try {
    const forecast = predict(weather, settings, date);
    const start = forecast.melt?.start;
    const end = forecast.melt?.end;
    const thaw = !forecast.melt ? 'No outside ice modeled' :
      !start ? 'May persist through the afternoon' :
      !end ? `From ${localClock.format(start)}, later in some scenarios` :
      start === end ? `Around ${localClock.format(start)}` :
      `${localClock.format(start)} to ${localClock.format(end)}`;
    days.push({
      date,
      verdict: riskLabels[forecast.risk],
      risk: forecast.risk,
      glassF: Math.round(forecast.atDeparture.glass),
      airF: Math.round(forecast.atDeparture.air),
      naturalThawET: thaw,
      meltStart: start ? new Date(start).toISOString() : null,
      meltEnd: end ? new Date(end).toISOString() : null,
    });
  } catch (error) {
    days.push({ date, unavailable: error.message });
  }
}

const first = days[0];
let reportUrl = null;
if (process.env.FROST_SITE_URL && !first.unavailable) {
  const url = new URL(process.env.FROST_SITE_URL);
  url.search = new URLSearchParams({
    date: first.date, risk: first.risk, issued, modelVersion: MODEL_VERSION, departure: settings.departure,
    glass: String(first.glassF), parking: settings.parking, sun: settings.sun,
    windows: settings.windows, wet: String(settings.wet),
    ...(first.meltStart ? { meltStart: first.meltStart } : {}),
    ...(first.meltEnd ? { meltEnd: first.meltEnd } : {}),
  });
  url.hash = 'feedback';
  reportUrl = url.href;
}

console.log(JSON.stringify({ issued, modelVersion: MODEL_VERSION, settings, days, reportUrl }, null, 2));
