import { DEFAULTS, MODEL_VERSION, forecastUrl, getLocalDate, nextLocalDate, predict } from './model.mjs?v=20261124-1';

const $ = id => document.getElementById(id);
const preferencesKey = 'windshield-frost.preferences.v1';
const historyKey = 'windshield-frost.observations.v1';
const feedbackKey = 'windshield-frost.feedback.v1';
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
const surfaces = { front: 'Front windshield', rear: 'Rear windshield', side: 'Side windows', mirrors: 'Side mirrors' };
const feedbackKinds = {
  'false-positive': { label: 'False alarm', expectedRisk: 'likely', outcome: 'clear' },
  'false-negative': { label: 'Missed frost', expectedRisk: 'low', outcome: 'frost' },
  'true-positive': { label: 'Correct frost forecast', expectedRisk: 'likely', outcome: 'frost' },
  'true-negative': { label: 'Correct clear forecast', expectedRisk: 'low', outcome: 'clear' },
  'uncertain-frost': { label: 'Uncertain forecast, found frost', expectedRisk: 'possible', outcome: 'frost' },
  'uncertain-clear': { label: 'Uncertain forecast, glass clear', expectedRisk: 'possible', outcome: 'clear' },
};
const surfaceButtons = [...document.querySelectorAll('.surface-options [data-surface]')];
const forecastSurfaces = surfaceButtons.map(button => button.dataset.surface);
// Keep "mirrors" in observations so older exports and entries retain their surface ID.
function observationSurface(surface) {
  return surface === 'mirror' ? 'mirrors' : surface;
}
const form = $('settings');
const observationForm = $('observation');
const feedbackForm = $('feedback-form');
const publicFeedbackForm = $('feedback-share-link').href;
const canvas = $('trace');

let selectedDate;
let selectedSurface = 'front';
let forecastDays = [];
let unavailableText = 'Forecast unavailable';
let weather;
let fetchedAt;
let currentForecast;
let reports = readStorage(historyKey, []);
let feedback = readStorage(feedbackKey, []);
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
  const version = query.get('modelVersion');
  return {
    date, surface: 'front', risk, issuedAt, source: 'evening email', settings,
    ...(/^[a-zA-Z0-9_.-]{1,40}$/.test(version ?? '') ? { modelVersion: version } : {}),
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
    wet: ['on', 'true', 'yes', 'wet', '1'].includes(data.get('wet')),
  };
}

function applySettings(settings) {
  for (const name of ['departure', 'parking', 'sun', 'wet']) {
    const value = settings[name];
    const input = form.elements.namedItem(name);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = typeof value === 'boolean' ? String(value) : value;
  }
}

function deviceForecast(prediction, settings, surface) {
  return {
    date: prediction.date, surface, risk: prediction.risk, issuedAt: fetchedAt, source: 'browser forecast',
    savedAt: Date.now(), modelVersion: MODEL_VERSION, settings: prediction.settings, glass: prediction.atDeparture.glass,
    meltStart: prediction.melt?.start ?? null, meltEnd: prediction.melt?.end ?? null,
  };
}

function setupKey(settings) {
  const { departure, parking, sun, windows = DEFAULTS.windows, wet } = settings;
  return [departure, parking, sun, windows, wet ? 'wet' : 'dry'].join('|');
}

function snapshotsFor(date) {
  const snapshots = savedForecasts[date];
  if (!snapshots) return {};
  return snapshots.source ? { [setupKey(snapshots.settings)]: snapshots } : snapshots;
}

function snapshotKey(settings, surface) {
  const key = setupKey(settings);
  return surface === 'front' ? key : surface + '|' + key;
}

function saveSnapshot(snapshot, key) {
  savedForecasts[snapshot.date] = { ...snapshotsFor(snapshot.date), [key]: snapshot };
}

function preserveForecast(prediction, settings, surface) {
  if (!prediction || !fetchedAt) return false;
  const candidate = deviceForecast(prediction, settings, surface);
  const key = snapshotKey(settings, surface);
  const prior = snapshotsFor(prediction.date)[key];
  const isEvening = candidate.date === nextLocalDate(getLocalDate(new Date(candidate.issuedAt))) &&
    localHours.format(new Date(candidate.issuedAt)) >= '20:00';
  const isCurrentOrFuture = candidate.date >= getLocalDate();
  if (!isCurrentOrFuture) return false;
  candidate.source = isEvening ? 'evening on-site forecast' : 'browser forecast';
  if (!prior || (prior.source === 'browser forecast' && isEvening)) {
    saveSnapshot(candidate, key);
    return true;
  }
  return false;
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
    const predictions = {};
    if (weather) {
      for (const surface of forecastSurfaces) {
        try {
          predictions[surface] = predict(weather, settings, date, surface);
        } catch {
          predictions[surface] = null;
        }
      }
    }
    return { date, predictions };
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

function renderSelection() {
  const target = $('days');
  const name = surfaces[observationSurface(selectedSurface)];
  $('days-title').textContent = name + ' outlook';
  target.replaceChildren(...forecastDays.map(({ date, predictions }) => {
    const prediction = predictions[selectedSurface];
    const day = makeElement('button', 'day-option' + (date === selectedDate ? ' active' : ''));
    day.type = 'button';
    day.dataset.date = date;
    day.setAttribute('aria-pressed', String(date === selectedDate));
    const title = makeElement('span', 'day-label', dateLabel(date));
    const note = makeElement('small', 'day-risk', prediction ? verdict[prediction.risk] : unavailableText);
    if (prediction) {
      day.dataset.risk = prediction.risk;
      note.dataset.risk = prediction.risk;
    }
    day.append(title, note);
    day.addEventListener('click', () => {
      selectedDate = date;
      renderSelection();
      target.querySelector(`[data-date="${date}"]`)?.focus();
    });
    return day;
  }));

  const { predictions } = forecastDays.find(day => day.date === selectedDate);
  for (const button of surfaceButtons) {
    const surface = button.dataset.surface;
    const risk = predictions[surface]?.risk;
    const label = button.querySelector('small');
    label.textContent = verdict[risk] ?? unavailableText;
    label.dataset.risk = risk ?? 'unknown';
    button.setAttribute('aria-pressed', String(surface === selectedSurface));
  }
  paintForecast(predictions[selectedSurface], readSettings());
}

function render(unavailableLabel = 'Forecast unavailable') {
  const settings = readSettings();
  unavailableText = unavailableLabel;
  forecastDays = getPredictions(settings);
  if (!forecastDays.some(day => day.date === selectedDate)) selectedDate = forecastDays[0].date;
  renderSelection();
  let savedNew = false;
  for (const { predictions } of forecastDays) {
    for (const [surface, prediction] of Object.entries(predictions)) {
      if (preserveForecast(prediction, settings, surface)) savedNew = true;
    }
  }
  if (savedNew) store(forecastsKey, savedForecasts);
  paintObservationLink();
  paintFeedbackPrediction();
}

function paintForecast(prediction, settings) {
  currentForecast = prediction;
  $('forecast-date').textContent = dateLabel(selectedDate);
  const label = surfaces[observationSurface(selectedSurface)];
  $('surface-title').textContent = label;
  $('chart-glass').textContent = label;
  canvas.setAttribute('aria-label', label + ' temperature forecast');
  $('surface-note').textContent = selectedSurface === 'side'
    ? 'Estimate for a typical upright side window. Shade and shelter can differ across the four windows.'
    : selectedSurface === 'mirror'
      ? 'Estimate for an unheated exterior mirror. Housing, shade and parking direction can make the two mirrors differ.'
      : '';
  $('glass').textContent = prediction ? `${Math.round(prediction.atDeparture.glass)}°F` : '—';
  $('air').textContent = prediction ? `${Math.round(prediction.atDeparture.air)}°F` : '—';
  let thaw = '—';
  let thawNote = '';
  if (prediction?.melt?.start) {
    thaw = formatMelt(prediction.melt.start, prediction.melt.end);
    thawNote = 'Passive thaw with your selected light exposure. Shade and ice thickness can shift this window.';
  } else if (prediction?.hadIce) {
    thaw = 'May persist past afternoon';
    thawNote = 'Ice may still be present at the end of the modeled period.';
  } else if (prediction) {
    thaw = 'No melt needed';
    thawNote = 'The model estimates little or no outside ice for these settings.';
  }
  $('melt').textContent = thaw;
  $('melt-note').textContent = thawNote;

  const departure = toReadableTime(settings.departure);
  const statements = {
    low: `Little or no outside frost is expected at your ${departure} departure.`,
    possible: `Some of the modeled conditions leave outside frost or ice at ${departure}.`,
    likely: `The estimated glass temperature and moisture support outside frost or ice at ${departure}.`,
  };
  $('verdict-copy').textContent = prediction ? statements[prediction.risk] : 'The estimate will appear once hourly weather data is available.';
  $('trace-summary').textContent = prediction
    ? `Estimated glass temperature at departure is ${Math.round(prediction.atDeparture.glass)}°F for the ${label.toLowerCase()}, with air at ${Math.round(prediction.atDeparture.air)}°F.`
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

function forecastForObservation(date, surface) {
  if (surface === 'rear') return null;
  const saved = snapshotsFor(date);
  const emailed = surface === 'front' ? (emailForecast?.date === date ? emailForecast : saved.email) : null;
  const prior = reports.find(report => report.date === date && (report.surface ?? 'front') === surface);
  // Reports already linked keep their original forecast when the observation is edited.
  const modelSurface = surface === 'mirrors' ? 'mirror' : surface;
  const settings = readSettings();
  const linked = prior?.forecast ?? emailed ?? saved[snapshotKey(settings, modelSurface)];
  if (linked) return linked;
  // Earlier versions let the driver select cabin ventilation. Match a unique
  // historical setup so those snapshots can still be linked to observations.
  const older = ['cracked', 'open'].map(windows =>
    saved[snapshotKey({ ...settings, windows }, modelSurface)]).filter(Boolean);
  return older.length === 1 ? older[0] : null;
}

function snapshotForFeedback(date, surface, time) {
  const forecast = forecastForObservation(date, observationSurface(surface));
  if (!forecast) return null;
  const availableAt = Math.max(forecast.issuedAt, forecast.savedAt ?? 0);
  const issued = getLocalDate(new Date(availableAt));
  const checkTime = time || forecast.settings.departure;
  if (issued > date || (issued === date && localHours.format(availableAt) >= checkTime)) return null;
  return forecast;
}

function paintFeedbackPrediction() {
  const { date, surface, observedTime } = feedbackForm.elements;
  const snapshot = snapshotForFeedback(date.value, surface.value, observedTime.value);
  $('feedback-prediction').textContent = snapshot
    ? `Saved forecast for ${toReadableTime(snapshot.settings.departure)} · ${verdict[snapshot.risk]}.`
    : 'You can report the forecast you remember. This browser has no matching earlier prediction.';
  const previous = feedback.find(entry => entry.date === date.value && entry.surface === surface.value);
  const entry = previous && (!observedTime.value || previous.observedTime === observedTime.value)
    ? previous : { date: date.value, surface: surface.value, observedTime: observedTime.value, forecast: snapshot };
  $('feedback-share-link').href = feedbackUrl(entry);
}

function feedbackUrl(entry) {
  const url = new URL(publicFeedbackForm);
  const params = url.searchParams;
  params.set('usp', 'pp_url');
  if (dateFromQuery(entry.date)) params.set('entry.420673815', entry.date);
  if (forecastSurfaces.includes(entry.surface)) params.set('entry.857551643', surfaces[observationSurface(entry.surface)]);
  const snap = entry.forecast;
  const risk = snap?.risk ?? entry.forecastRisk;
  params.set('entry.1264634741', verdict[risk] ?? 'Unknown');
  const kind = feedbackKinds[entry.direction];
  if (kind) {
    const condition = risk === 'possible' || kind.expectedRisk === 'possible' ? 'uncertain' :
      kind.expectedRisk === 'likely' ? 'frost' : 'clear';
    const observed = kind.outcome === 'frost' ? 'glass frosted' : 'glass was clear';
    params.set('entry.796835699', `Forecast ${condition}, ${observed}`);
  }
  if (entry.observedTime) params.set('entry.272590887', entry.observedTime);
  if (snap) {
    const { date, risk, issuedAt, savedAt, modelVersion, source, settings } = snap;
    // Share only the forecast provenance and coarse exposure settings needed
    // to interpret the observation. Older records can lack some of these fields.
    params.set('entry.1271491538', JSON.stringify({
      date, surface: snap.surface ?? 'front', risk,
      issuedAt, savedAt, modelVersion, source, departure: settings.departure,
      parking: settings.parking, sun: settings.sun, wet: settings.wet,
    }));
  }
  return url.href;
}

function feedbackMatch(risk, expected) {
  if (!risk) return 'unavailable';
  if (risk === 'possible') return 'uncertain';
  return risk === expected ? 'consistent' : 'different';
}

function feedbackEvidence(entry) {
  if (entry.match === 'unavailable') return 'User-reported forecast only.';
  if (entry.match === 'uncertain') return 'The saved forecast was “possible”.';
  if (entry.match === 'different') return `The saved forecast was “${verdict[entry.forecastRisk].toLowerCase()}”, which differs from your report.`;
  return `The saved forecast was “${verdict[entry.forecastRisk].toLowerCase()}”.`;
}

function paintFeedbackHistory() {
  $('feedback-saved').hidden = feedback.length === 0;
  $('feedback-count').textContent = `Your feedback (${feedback.length})`;
  $('feedback-history').replaceChildren(...[...feedback].reverse().map(entry => {
    const title = feedbackKinds[entry.direction].label;
    const surface = surfaces[observationSurface(entry.surface)];
    const item = makeElement('li', '', `${dateLabel(entry.date)} · ${surface} · ${title}. ${feedbackEvidence(entry)}`);
    const link = makeElement('a', '', 'Review and share');
    link.href = feedbackUrl(entry);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    item.append(link);
    return item;
  }));
  $('export').disabled = reports.length + feedback.length === 0;
}

function saveFeedback(event) {
  event.preventDefault();
  const data = new FormData(feedbackForm);
  const date = dateFromQuery(data.get('date'));
  const surface = data.get('surface');
  const direction = event.submitter?.value;
  const kind = feedbackKinds[direction];
  if (!date || date > getLocalDate() || !forecastSurfaces.includes(surface) || !kind) {
    $('feedback-status').textContent = 'Choose a morning through today, a surface and what happened.';
    return;
  }
  const observedTime = data.get('observedTime') || null;
  const forecast = snapshotForFeedback(date, surface, observedTime);
  const forecastRisk = forecast?.risk ?? null;
  const summary = { date, surface, direction, outcome: kind.outcome, observedTime, forecastRisk,
    match: feedbackMatch(forecastRisk, kind.expectedRisk), recordedAt: Date.now() };
  const latest = readStorage(feedbackKey, feedback);
  const previous = Array.isArray(latest) ? latest : feedback;
  const updated = previous.some(entry => entry.date === date && entry.surface === surface);
  feedback = previous.filter(entry => entry.date !== date || entry.surface !== surface);
  const entry = { ...summary, forecast };
  feedback.push(entry);
  feedback.sort((a, b) => a.date.localeCompare(b.date) || a.recordedAt - b.recordedAt);
  const saved = store(feedbackKey, feedback);
  let result = updated ? 'Updated' : 'Saved';
  if (!saved) result = 'Kept for this visit';
  $('feedback-status').textContent = `${result} in this browser · ${dateLabel(date)} · ${surfaces[observationSurface(surface)]} · ${kind.label}. ${feedbackEvidence(summary)}` +
    (saved ? '' : ' Export the log to keep it.');
  $('feedback-share-link').href = feedbackUrl(entry);
  paintFeedbackHistory();
  window.dispatchEvent(new CustomEvent('frostfeedbacksaved', { detail: summary }));
}

function observationLabel(report) {
  return observations[report.outcome] ?? report.outcome;
}

function paintObservationLink() {
  const label = $('observation-prediction');
  if (!label) return;
  const date = observationForm.elements.namedItem('date')?.value;
  const surface = observationForm.elements.namedItem('surface')?.value ?? 'front';
  if (surface === 'rear') {
    label.textContent = 'Rear windshield observations are saved in your log.';
    return;
  }
  const forecast = forecastForObservation(date, surface);
  label.textContent = forecast
    ? `${surfaces[surface]} · ${verdict[forecast.risk]} for ${toReadableTime(forecast.settings.departure)}. Linked to the ${forecast.source} from ${dateLabel(getLocalDate(new Date(forecast.issuedAt)), true)} at ${timeFormat.format(forecast.issuedAt)} ET.`
    : 'No earlier forecast is saved for this surface, date and setup.';
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
  const surface = observationForm.elements.namedItem('surface').value;
  const matching = reports.filter(report => (report.surface ?? 'front') === surface);
  const icy = matching.filter(report => ['frost', 'ice'].includes(report.outcome)).length;
  const iceFree = matching.filter(report => ['clear', 'wet'].includes(report.outcome)).length;
  const unlikely = matching.filter(report => report.forecast?.risk === 'low' &&
    timeMatchesDeparture(report) && ['clear', 'wet', 'frost', 'ice'].includes(report.outcome));
  const misses = unlikely.filter(report => ['frost', 'ice'].includes(report.outcome)).length;
  const counts = `${surfaces[surface]} · ${icy} with frost or ice · ${iceFree} without outside ice.`;
  const detail = unlikely.length ? `${misses} of ${unlikely.length} “unlikely” forecasts missed frost or ice (checked within an hour of departure).`
    : 'Record the check time to compare it with the forecast at departure.';
  target.textContent = surface === 'rear' ? counts : counts + ' ' + detail;
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
        : report.surface !== 'rear' ? 'No matching forecast saved.' : '';
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
  $('export').disabled = reports.length + feedback.length === 0;
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
  const forecast = forecastForObservation(date, surface);
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
  const blob = new Blob([JSON.stringify({ observations: reports, feedback }, null, 2) + '\n'], { type: 'application/json' });
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
if (!Array.isArray(feedback)) feedback = [];
if (!savedForecasts || typeof savedForecasts !== 'object' || Array.isArray(savedForecasts)) savedForecasts = {};
applySettings({ ...DEFAULTS, ...(readStorage(preferencesKey, {})) });
const observedDate = observationForm.elements.namedItem('date');
if (observedDate) {
  observedDate.max = getLocalDate();
  observedDate.value = emailForecast && emailForecast.date <= getLocalDate() ? emailForecast.date : getLocalDate();
}
feedbackForm.elements.date.max = getLocalDate();
feedbackForm.elements.date.value = observedDate.value;
if (emailForecast) {
  saveSnapshot(emailForecast, 'email');
  store(forecastsKey, savedForecasts);
  selectedDate = emailForecast.date;
}

let observationStarted = false;
let feedbackStarted = false;
feedbackForm.addEventListener('input', () => { feedbackStarted = true; });
feedbackForm.addEventListener('change', () => {
  $('feedback-status').textContent = '';
  paintFeedbackPrediction();
});
feedbackForm.addEventListener('submit', saveFeedback);
observationForm.addEventListener('input', () => { observationStarted = true; });
for (const button of surfaceButtons) {
  button.addEventListener('click', () => {
    selectedSurface = button.dataset.surface;
    renderSelection();
    if (!feedbackStarted) {
      feedbackForm.elements.surface.value = selectedSurface;
      paintFeedbackPrediction();
    }
    if (!observationStarted) {
      observationForm.elements.namedItem('surface').value = observationSurface(selectedSurface);
      paintObservationLink();
      paintScore();
    }
  });
}
form.addEventListener('change', () => {
  store(preferencesKey, readSettings());
  render();
});
form.addEventListener('submit', event => event.preventDefault());
$('refresh').addEventListener('click', refresh);
observationForm.addEventListener('submit', saveObservation);
observationForm.addEventListener('change', () => {
  paintObservationLink();
  paintScore();
});
$('export').addEventListener('click', exportHistory);
if ('ResizeObserver' in window) new ResizeObserver(() => paintChart(currentForecast)).observe(canvas);

paintHistory();
paintFeedbackHistory();
paintFeedbackPrediction();
paintObservationLink();
refresh();
