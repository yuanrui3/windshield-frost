import { DEFAULTS, forecastUrl, getLocalDate, nextLocalDate, predict } from './model.mjs';

const $ = id => document.getElementById(id);
const preferencesKey = 'windshield-frost.preferences.v1';
const historyKey = 'windshield-frost.observations.v1';
const forecastsKey = 'windshield-frost.forecasts.v1';
const weatherKey = 'windshield-frost.weather.v1';
const localZone = 'America/Indiana/Indianapolis';
const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: localZone, hour: 'numeric', minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric',
});
const shortDateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', month: 'short', day: 'numeric',
});
const localHours = new Intl.DateTimeFormat('en-GB', {
  timeZone: localZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const verdict = { low: 'Frost unlikely', possible: 'Frost possible', likely: 'Frost likely' };
const observations = {
  clear: 'Clear', frost: 'Frost outside', ice: 'Ice outside',
  'inside-fog': 'Fog or frost inside', inside: 'Fog or frost inside', wet: 'Wet, no frost',
};
const surfaces = { front: 'Front windshield', rear: 'Rear window', side: 'Side windows', mirrors: 'Mirrors' };
const form = $('settings');
const observationForm = $('observation');
const canvas = $('trace');

let selectedDate;
let weather;
let fetchedAt;
let currentForecast;
let reports = readStorage(historyKey, []);
let savedForecasts = readStorage(forecastsKey, {});
let emailForecast = readEmailForecast();

function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function dateLabel(date, short = false) {
  return (short ? shortDateFormat : dateFormat).format(new Date(date + 'T12:00:00Z'));
}

function dateFromQuery(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return null;
  const parsed = new Date(value + 'T12:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function fromTimestamp(value) {
  const timestamp = /^\d{10,13}$/.test(value ?? '') ? Number(value) : Date.parse(value ?? '');
  if (!Number.isFinite(timestamp)) return null;
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

function readEmailForecast() {
  const query = new URLSearchParams(location.search);
  const date = dateFromQuery(query.get('date'));
  const risk = query.get('risk');
  const issuedAt = fromTimestamp(query.get('issued'));
  const departure = query.get('departure');
  if (!date || !Object.hasOwn(verdict, risk) || !issuedAt || !/^([01]\d|2[0-3]):[0-5]\d$/.test(departure ?? '')) return null;
  const rawGlass = query.get('glass');
  const glass = rawGlass === null ? null : Number(rawGlass);
  const settings = { departure };
  for (const [name, allowed] of Object.entries({
    parking: ['open', 'sheltered', 'covered'], sun: ['shade', 'moderate', 'full'],
    windows: ['closed', 'cracked', 'open'],
  })) {
    const value = query.get(name);
    if (allowed.includes(value)) settings[name] = value;
  }
  const wet = query.get('wet');
  if (wet === 'true' || wet === 'false') settings.wet = wet === 'true';
  return {
    date, risk, issuedAt, source: 'evening email', settings,
    glass: Number.isFinite(glass) && glass > -150 && glass < 180 ? glass : null,
    meltStart: fromTimestamp(query.get('meltStart')), meltEnd: fromTimestamp(query.get('meltEnd')),
  };
}

function readSettings() {
  const data = new FormData(form);
  return {
    departure: data.get('departure') || DEFAULTS.departure,
    parking: data.get('parking') || DEFAULTS.parking,
    sun: data.get('sun') || DEFAULTS.sun,
    windows: data.get('windows') || DEFAULTS.windows,
    wet: ['on', 'true', 'yes', 'wet', '1'].includes(data.get('wet')),
  };
}

function applySettings(settings) {
  for (const [name, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(name);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = typeof value === 'boolean' ? String(value) : value;
  }
}

function deviceForecast(prediction, settings) {
  return {
    date: prediction.date, risk: prediction.risk, issuedAt: fetchedAt, source: 'browser forecast',
    savedAt: Date.now(), settings: { ...settings }, glass: prediction.atDeparture.glass,
    meltStart: prediction.melt?.start ?? null, meltEnd: prediction.melt?.end ?? null,
  };
}

function setupKey(settings) {
  const { departure, parking, sun, windows, wet } = settings;
  return [departure, parking, sun, windows, wet ? 'wet' : 'dry'].join('|');
}

function snapshotsFor(date) {
  const snapshots = savedForecasts[date];
  if (!snapshots) return {};
  return snapshots.source ? { [setupKey(snapshots.settings)]: snapshots } : snapshots;
}

function saveSnapshot(snapshot, key) {
  savedForecasts[snapshot.date] = { ...snapshotsFor(snapshot.date), [key]: snapshot };
  store(forecastsKey, savedForecasts);
}

function preserveForecast(prediction, settings) {
  if (!prediction || !fetchedAt) return;
  const candidate = deviceForecast(prediction, settings);
  const key = setupKey(settings);
  const prior = snapshotsFor(prediction.date)[key];
  const isEvening = candidate.date === nextLocalDate(getLocalDate(new Date(candidate.issuedAt))) &&
    localHours.format(new Date(candidate.issuedAt)) >= '20:00';
  const isCurrentOrFuture = candidate.date >= getLocalDate();
  if (!isCurrentOrFuture) return;
  candidate.source = isEvening ? 'evening on-site forecast' : 'browser forecast';
  if (!prior || (prior.source === 'browser forecast' && isEvening)) {
    saveSnapshot(candidate, key);
  }
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function setStatus(message, state) {
  $('status').textContent = message;
  $('status').dataset.state = state;
}

function upcoming(settings) {
  const now = new Date();
  const today = getLocalDate(now);
  const days = localHours.format(now) < settings.departure ? [today] : [];
  let day = nextLocalDate(today);
  while (days.length < 3) {
    days.push(day);
    day = nextLocalDate(day);
  }
  return days;
}

function getPredictions(settings) {
  return upcoming(settings).map(date => {
    if (!weather) return { date, prediction: null };
    try {
      return { date, prediction: predict(weather, settings, date) };
    } catch {
      return { date, prediction: null };
    }
  });
}

function formatMelt(start, end) {
  if (start && end) {
    const from = timeFormat.format(start);
    const to = timeFormat.format(end);
    return from === to ? `Around ${from}` : `${from} – ${to}`;
  }
  if (start) return `After ${timeFormat.format(start)}`;
  if (end) return `By ${timeFormat.format(end)}`;
  return 'Not estimated';
}

function renderDays(days, settings, unavailableLabel) {
  const target = $('days');
  target.replaceChildren(...days.map(({ date, prediction }) => {
    const day = makeElement('button', 'day-option' + (date === selectedDate ? ' active' : ''));
    day.type = 'button';
    day.dataset.date = date;
    day.setAttribute('aria-pressed', String(date === selectedDate));
    const title = makeElement('span', 'day-label', dateLabel(date));
    const note = makeElement('small', 'day-risk', prediction ? verdict[prediction.risk] : unavailableLabel);
    if (prediction) {
      day.dataset.risk = prediction.risk;
      note.dataset.risk = prediction.risk;
    }
    day.append(title, note);
    day.addEventListener('click', () => selectDate(date, true));
    return day;
  }));

  function selectDate(date, focus) {
    selectedDate = date;
    const prediction = days.find(day => day.date === date)?.prediction;
    renderDays(days, settings, unavailableLabel);
    paintForecast(prediction, settings, unavailableLabel);
    const observationDate = observationForm.elements.namedItem('date');
    if (observationDate && date <= getLocalDate() && !observationDate.value) observationDate.value = date;
    paintObservationLink();
    if (focus) target.querySelector(`[data-date="${date}"]`)?.focus();
  }
}

function render(unavailableLabel = 'Forecast unavailable') {
  const settings = readSettings();
  const days = getPredictions(settings);
  if (!days.some(day => day.date === selectedDate)) selectedDate = days[0].date;
  renderDays(days, settings, unavailableLabel);
  const prediction = days.find(day => day.date === selectedDate)?.prediction;
  paintForecast(prediction, settings, unavailableLabel);
  for (const day of days) preserveForecast(day.prediction, settings);
  paintObservationLink();
}

function paintForecast(prediction, settings, unavailableLabel) {
  currentForecast = prediction;
  $('forecast-date').textContent = dateLabel(selectedDate);
  $('risk').dataset.risk = prediction?.risk ?? 'unknown';
  $('risk').textContent = prediction ? verdict[prediction.risk] : unavailableLabel;
  $('glass').textContent = prediction ? `${Math.round(prediction.atDeparture.glass)}°F` : '—';
  $('air').textContent = prediction ? `${Math.round(prediction.atDeparture.air)}°F` : '—';
  $('melt').textContent = prediction?.melt ? formatMelt(prediction.melt.start, prediction.melt.end)
    : prediction?.hadIce ? 'Not estimated' : prediction ? 'No melt needed' : '—';
  $('melt-note').textContent = prediction?.melt
    ? 'Passive thaw with your selected light exposure. Shade and ice thickness can shift this window.'
    : prediction?.hadIce ? 'Ice may persist past the available forecast hours.'
      : prediction ? 'The model did not estimate a meaningful layer of outside ice for these settings.' : '';

  const departure = toReadableTime(settings.departure);
  const statements = {
    low: `Little or no outside frost is expected at your ${departure} departure.`,
    possible: `Conditions are close enough that exposing the car to more sky or less wind could leave frost at ${departure}.`,
    likely: `The estimated glass temperature and moisture support outside frost or ice at ${departure}.`,
  };
  $('verdict-copy').textContent = prediction ? statements[prediction.risk] : 'The estimate will appear once hourly weather data is available.';
  $('trace-summary').textContent = prediction
    ? `At departure the windshield is estimated at ${Math.round(prediction.atDeparture.glass)}°F and the air at ${Math.round(prediction.atDeparture.air)}°F. ${prediction.melt ? 'Passive melt ' + formatMelt(prediction.melt.start, prediction.melt.end) + '.' : ''}`
    : 'Hourly chart unavailable.';
  paintChart(prediction);
}

function toReadableTime(hourMinute) {
  const [hour, minute] = hourMinute.split(':').map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

function paintChart(prediction) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 1 || height < 1) return;
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const draw = canvas.getContext('2d');
  if (!draw) return;
  draw.scale(ratio, ratio);
  const points = prediction?.points?.filter(point => [point.t, point.air, point.glass, point.frost].every(Number.isFinite));
  if (!points || points.length < 2) return;
  const root = getComputedStyle(canvas);
  const color = (name, fallback) => root.getPropertyValue(name).trim() || fallback;
  const area = { left: 40, right: width - 15, top: 13, bottom: height - 28 };
  if (area.right <= area.left || area.bottom <= area.top) return;
  const min = Math.min(32, ...points.flatMap(point => [point.glass, point.air, point.frost]));
  const max = Math.max(32, ...points.flatMap(point => [point.glass, point.air, point.frost]));
  const step = max - min > 28 ? 10 : max - min > 10 ? 5 : 2;
  const low = Math.floor((min - 0.1) / step) * step;
  const high = Math.ceil((max + 0.1) / step) * step;
  const span = points.at(-1).t - points[0].t;
  if (span <= 0) return;
  const x = t => area.left + (t - points[0].t) / span * (area.right - area.left);
  const y = temp => area.bottom - (temp - low) / (high - low) * (area.bottom - area.top);
  const fontColor = color('--muted', '#4e6973');
  const grid = color('--edge', '#ccdde3');

  function gridline(temp, label, freeze = false) {
    const py = y(temp);
    draw.strokeStyle = freeze ? fontColor : grid;
    draw.setLineDash(freeze ? [3, 5] : []);
    draw.beginPath();
    draw.moveTo(area.left, py);
    draw.lineTo(area.right, py);
    draw.stroke();
    if (!label) return;
    draw.fillStyle = fontColor;
    draw.textAlign = 'right';
    draw.fillText(Math.round(temp) + '°', area.left - 7, py + 4);
  }

  draw.lineWidth = 1;
  draw.font = '12px system-ui';
  for (let temp = low; temp <= high; temp += step) gridline(temp, true);
  if (32 > low && 32 < high) gridline(32, false, true);

  const count = width < 460 ? 4 : 6;
  draw.fillStyle = fontColor;
  for (let i = 0; i < count; i++) {
    const time = points[0].t + span * i / (count - 1);
    draw.textAlign = i === 0 ? 'left' : i === count - 1 ? 'right' : 'center';
    const hours = new Intl.DateTimeFormat('en-US', { timeZone: localZone, hour: 'numeric' }).format(time);
    draw.fillText(hours, x(time), height - 7);
  }

  function series(property, lineColor, pattern, weight) {
    draw.strokeStyle = lineColor;
    draw.lineWidth = weight;
    draw.lineJoin = 'round';
    draw.lineCap = 'round';
    draw.setLineDash(pattern);
    draw.beginPath();
    points.forEach((point, index) => {
      if (index === 0) draw.moveTo(x(point.t), y(point[property]));
      else draw.lineTo(x(point.t), y(point[property]));
    });
    draw.stroke();
  }

  series('frost', '#a15f15', [2, 5], 2);
  series('air', '#55717e', [5, 4], 1.5);
  series('glass', '#08776c', [], 2.6);
}

async function refresh() {
  const button = $('refresh');
  button.disabled = true;
  if (!weather) render('Loading');
  setStatus('Fetching the latest Open-Meteo forecast…', 'loading');
  try {
    const response = await fetch(forecastUrl(), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('The weather service did not respond successfully.');
    const incoming = await response.json();
    if (!incoming?.hourly?.time?.length || incoming.error) throw new Error('The weather response did not include hourly data.');
    weather = incoming;
    fetchedAt = Date.now();
    store(weatherKey, { weather, fetchedAt });
    render();
    setStatus(`Open-Meteo fetched at ${timeFormat.format(fetchedAt)} ET`, 'ready');
  } catch {
    if (!weather) {
      const cache = readStorage(weatherKey, null);
      if (cache && Date.now() - cache.fetchedAt < 24 * 3600_000) {
        weather = cache.weather;
        fetchedAt = cache.fetchedAt;
      }
    }
    render();
    setStatus(weather ? `Couldn’t refresh. Showing weather fetched ${dateLabel(getLocalDate(new Date(fetchedAt)), true)} at ${timeFormat.format(fetchedAt)} ET.`
      : 'The live forecast is unavailable. You can retry or still log an observation.', 'error');
  } finally {
    button.disabled = false;
  }
}

function forecastForObservation(date) {
  return (emailForecast?.date === date ? emailForecast : null) ??
    reports.find(report => report.date === date && (report.surface ?? 'front') === 'front')?.forecast ??
    snapshotsFor(date).email ?? snapshotsFor(date)[setupKey(readSettings())] ?? null;
}

function observationLabel(report) {
  return observations[report.outcome] ?? report.outcome;
}

function paintObservationLink() {
  const label = $('observation-prediction');
  if (!label) return;
  const date = observationForm.elements.namedItem('date')?.value;
  const surface = observationForm.elements.namedItem('surface')?.value ?? 'front';
  if (surface !== 'front') {
    label.textContent = 'Saved as an observation. The prediction covers the front windshield.';
    return;
  }
  const forecast = forecastForObservation(date);
  label.textContent = forecast
    ? `Linked ${forecast.source} from ${dateLabel(getLocalDate(new Date(forecast.issuedAt)), true)} at ${timeFormat.format(forecast.issuedAt)} ET · ${verdict[forecast.risk]} for ${toReadableTime(forecast.settings.departure)}.`
    : 'No earlier forecast is saved for this date and setup.';
}

function comparison(report) {
  if (!timeMatchesDeparture(report) || !['clear', 'wet', 'frost', 'ice'].includes(report.outcome)) return '';
  if (report.forecast.risk === 'low' && ['frost', 'ice'].includes(report.outcome)) return 'Missed frost or ice';
  if (report.forecast.risk === 'likely' && ['clear', 'wet'].includes(report.outcome)) return 'Frost did not appear';
  return '';
}

function timeMatchesDeparture(report) {
  if (!report.forecast || !report.observedTime) return false;
  return Math.abs(minutes(report.observedTime) - minutes(report.forecast.settings.departure)) <= 60;
}

function minutes(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function thawComparison(report) {
  if (!report.meltTime || !report.forecast?.meltStart) return '';
  const forecast = report.forecast;
  const observed = minutes(report.meltTime);
  const start = minutes(localHours.format(forecast.meltStart));
  const end = forecast.meltEnd ? minutes(localHours.format(forecast.meltEnd)) : null;
  if (observed < start) return `${start - observed} min before the estimated clear window`;
  if (end !== null && observed > end) return `${observed - end} min after the estimated clear window`;
  return end !== null ? 'within the estimated clear window' : 'after the earliest clear estimate';
}

function paintScore() {
  const target = $('score-summary');
  if (!target) return;
  const front = reports.filter(report => (report.surface ?? 'front') === 'front');
  const icy = front.filter(report => ['frost', 'ice'].includes(report.outcome)).length;
  const iceFree = front.filter(report => ['clear', 'wet'].includes(report.outcome)).length;
  const unlikely = front.filter(report => report.forecast?.risk === 'low' &&
    timeMatchesDeparture(report) && ['clear', 'wet', 'frost', 'ice'].includes(report.outcome));
  const misses = unlikely.filter(report => ['frost', 'ice'].includes(report.outcome)).length;
  target.textContent = `Front windshield · ${icy} with frost or ice · ${iceFree} without outside ice. ` +
    (unlikely.length ? `${misses} of ${unlikely.length} “unlikely” forecasts missed frost or ice (checked within an hour of departure).`
      : 'Record the check time to compare it with the forecast at departure.');
}

function paintHistory() {
  const history = $('history');
  if (reports.length === 0) {
    history.replaceChildren(makeElement('p', 'history-empty', 'No observations yet.'));
  } else {
    history.replaceChildren(...[...reports].reverse().map(report => {
      const row = makeElement('article', 'history-item');
      const heading = makeElement('h3', '', dateLabel(report.date));
      const result = makeElement('p', 'history-outcome', `${surfaces[report.surface ?? 'front']} · ` + observationLabel(report) +
        (report.observedTime ? ` at ${toReadableTime(report.observedTime)}` : ''));
      const forecast = report.forecast;
      const summary = forecast
        ? `${verdict[forecast.risk]} was forecast${comparison(report) ? ' · ' + comparison(report) : ''}.`
        : (report.surface ?? 'front') === 'front' ? 'No matching forecast saved.' : '';
      row.append(heading, result);
      if (summary) row.append(makeElement('p', 'history-summary', summary));
      if (report.meltTime) {
        const timing = thawComparison(report);
        row.append(makeElement('p', 'history-summary', `Observed clear at ${toReadableTime(report.meltTime)}${timing ? ' · ' + timing : ''}.`));
      }
      if (report.note) row.append(makeElement('p', 'history-note', report.note));
      return row;
    }));
  }
  paintScore();
  $('export').disabled = reports.length === 0;
}

function saveObservation(event) {
  event.preventDefault();
  const data = new FormData(observationForm);
  const date = dateFromQuery(String(data.get('date') ?? ''));
  const outcome = String(data.get('outcome') ?? '');
  const surface = String(data.get('surface') ?? 'front');
  if (!date || date > getLocalDate() || !outcome || !Object.hasOwn(surfaces, surface)) {
    $('log-status').textContent = 'Choose today or an earlier date and record what you saw.';
    return;
  }
  const forecast = surface === 'front' ? forecastForObservation(date) : null;
  const report = {
    date, surface, outcome, observedTime: data.get('observedTime') || null,
    meltTime: data.get('meltTime') || null, note: String(data.get('note') ?? '').trim(),
    forecast, recordedAt: Date.now(),
  };
  reports = [...reports.filter(previous => previous.date !== date || (previous.surface ?? 'front') !== surface), report]
    .sort((a, b) => a.date.localeCompare(b.date) || a.recordedAt - b.recordedAt);
  const saved = store(historyKey, reports);
  $('log-status').textContent = saved ? 'Observation saved in this browser.'
    : 'This browser blocked storage. Export the history before closing the page.';
  const note = observationForm.elements.namedItem('note');
  if (note) note.value = '';
  paintHistory();
  paintObservationLink();
}

function exportHistory() {
  const blob = new Blob([JSON.stringify({ observations: reports }, null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const download = makeElement('a');
  download.href = url;
  download.download = `windshield-frost-observations-${getLocalDate()}.json`;
  document.body.append(download);
  download.click();
  download.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (!Array.isArray(reports)) reports = [];
if (!savedForecasts || typeof savedForecasts !== 'object' || Array.isArray(savedForecasts)) savedForecasts = {};
applySettings({ ...DEFAULTS, ...(readStorage(preferencesKey, {})) });
const observedDate = observationForm.elements.namedItem('date');
if (observedDate) {
  observedDate.max = getLocalDate();
  observedDate.value = emailForecast && emailForecast.date <= getLocalDate() ? emailForecast.date : getLocalDate();
}
if (emailForecast) {
  saveSnapshot(emailForecast, 'email');
  selectedDate = emailForecast.date;
}

form.addEventListener('change', () => {
  store(preferencesKey, readSettings());
  render();
});
form.addEventListener('submit', event => event.preventDefault());
$('refresh').addEventListener('click', refresh);
observationForm.addEventListener('submit', saveObservation);
observationForm.addEventListener('change', paintObservationLink);
$('export').addEventListener('click', exportHistory);
if ('ResizeObserver' in window) new ResizeObserver(() => paintChart(currentForecast)).observe(canvas);

paintHistory();
paintObservationLink();
refresh();
