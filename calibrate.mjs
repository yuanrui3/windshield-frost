// Offline evaluation of a browser log or a normalized private feedback sheet.
import { readFileSync } from 'node:fs';

const risks = ['low', 'possible', 'likely'];
const surfaces = ['front', 'side', 'mirror'];
const frost = new Set(['frost', 'ice']);
const clear = new Set(['clear', 'wet']);
const sheetHeaders = [
  'Source event ID', 'Forecast date', 'Surface', 'Explicit observation', 'Classification',
  'Issued verdict', 'Issued at UTC', 'Recorded at UTC', 'Channel', 'Checked at local',
  'Cleared at local', 'Model version', 'Reported assessment', 'Departure local',
  'Parking cover', 'Sun exposure', 'Initially wet',
];
const localTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Indiana/Indianapolis', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function localStamp(timestamp) {
  if (typeof timestamp !== 'number' && typeof timestamp !== 'string') return null;
  const date = new Date(timestamp);
  return Number.isFinite(+date) ? localTime.format(date) : null;
}

function minutes(clock) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) return NaN;
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
}

function canonical(surface) {
  return surface === 'mirrors' ? 'mirror' : surface ?? 'front';
}

function matchSample(row, source) {
  if (!row || !surfaces.includes(canonical(row.surface))) return 'outside forecast scope';
  if (!frost.has(row.outcome) && !clear.has(row.outcome)) return 'no outside frost/clear outcome';
  const forecast = row.forecast;
  if (!forecast || !risks.includes(forecast.risk) || row.date !== forecast.date ||
      canonical(row.surface) !== canonical(forecast.surface)) return 'missing or mismatched forecast';
  if (source === 'poll' && !['consistent', 'uncertain'].includes(row.match)) {
    return 'poll answer differs from or lacks the saved forecast';
  }
  const departure = forecast.settings?.departure;
  const offset = Math.abs(minutes(row.observedTime) - minutes(departure));
  if (!Number.isFinite(offset) || offset > 60) return 'missing check time or over one hour from departure';
  const date = new Date(row.date + 'T12:00:00Z');
  if (!Number.isFinite(+date) || date.toISOString().slice(0, 10) !== row.date) return 'invalid date';
  const cutoff = row.date + ' ' + (row.observedTime < departure ? row.observedTime : departure);
  const issued = localStamp(forecast.issuedAt);
  const saved = localStamp(forecast.savedAt);
  if (!issued || issued >= cutoff || (saved && saved >= cutoff) ||
      (!saved && forecast.source !== 'evening email' && !['website', 'gmail'].includes(source))) {
    return 'forecast unavailable before check and departure';
  }
  return {
    date: row.date, surface: canonical(row.surface), risk: forecast.risk, icy: Number(frost.has(row.outcome)),
    source, version: forecast.modelVersion || 'unversioned', recordedAt: Number(row.recordedAt) || 0,
  };
}

function counts(rows) {
  const result = Object.fromEntries(risks.map(risk => [risk, { icy: 0, clear: 0 }]));
  for (const row of rows) result[row.risk][row.icy ? 'icy' : 'clear']++;
  return result;
}

function evaluate(rows, commonHoldout) {
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const summary = {
    matchedMornings: rows.length, first: rows[0]?.date ?? null, last: rows.at(-1)?.date ?? null,
    outcomesByIssuedRisk: counts(rows),
  };
  if (!commonHoldout) summary.fromPoll = rows.filter(row => row.source === 'poll').length;
  if (rows.length) summary.calendarDaysSpanned = 1 + (Date.parse(summary.last) - Date.parse(summary.first)) / 86_400_000;
  if (rows.length < 30) return { ...summary, status: 'Need 30 distinct matched mornings.' };
  const split = commonHoldout ? rows.filter(row => row.date < commonHoldout).length : Math.floor(rows.length * 2 / 3);
  const train = rows.slice(0, split);
  const test = rows.slice(split);
  Object.assign(summary, { trainingMornings: train.length, holdoutMornings: test.length, holdoutStarts: commonHoldout ?? test[0]?.date });
  if (train.length < 20 || test.length < 10) {
    return { ...summary, status: 'Need 20 training mornings and ten later holdout mornings in this group.' };
  }
  const bins = counts(train);
  const positives = train.reduce((sum, row) => sum + row.icy, 0);
  if (positives < 3 || train.length - positives < 3 || bins.low.clear + bins.likely.icy === 0) {
    return { ...summary, status: 'Need both outcomes and correctly forecast mornings in the training period.' };
  }
  const supported = risks.filter(risk => bins[risk].icy + bins[risk].clear >= 5);
  const scored = test.filter(row => supported.includes(row.risk));
  summary.scorableHoldoutMornings = scored.length;
  if (supported.length < 2 || scored.length < 10) {
    return { ...summary, status: 'Need two trained risk labels with five mornings each and ten supported holdout mornings.' };
  }
  // Laplace smoothing gives one frost and one clear pseudo-observation per estimate.
  const baseRate = (positives + 1) / (train.length + 2);
  const rates = Object.fromEntries(supported.map(risk => [risk,
    (bins[risk].icy + 1) / (bins[risk].icy + bins[risk].clear + 2)]));
  const score = probability => scored.reduce((sum, row) => sum + (probability(row) - row.icy) ** 2, 0) / scored.length;
  const round = value => Number(value.toFixed(3));
  return {
    ...summary, status: 'Exploratory holdout evaluation', trainingCounts: bins,
    fittedFrostFrequency: Object.fromEntries(supported.map(risk => [risk, round(rates[risk])])),
    holdoutCounts: counts(scored), holdoutBrierScore: round(score(row => rates[row.risk])),
    constantRateBrierScore: round(score(() => baseRate)),
  };
}

function browserSamples(log) {
  if (!log || (!Array.isArray(log.observations) && !Array.isArray(log.feedback))) {
    throw new Error('Expected a site log containing observations or feedback.');
  }
  const paired = new Map();
  const excluded = {};
  const skip = reason => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
  for (const [source, rows] of [['poll', log.feedback ?? []], ['observation', log.observations ?? []]]) {
    if (!Array.isArray(rows)) throw new Error('Invalid log array.');
    for (const row of rows) {
      const sample = matchSample(row, source);
      if (typeof sample === 'string') { skip(sample); continue; }
      const key = sample.date + '/' + sample.surface;
      const prior = paired.get(key);
      if (prior) {
        skip('duplicate date and surface');
        if (prior.source === source && prior.recordedAt > sample.recordedAt) continue;
      }
      paired.set(key, sample); // A timed detailed observation takes precedence over its poll response.
    }
  }
  return { samples: [...paired.values()], details: {
    observations: log.observations?.length ?? 0, pollResponses: log.feedback?.length ?? 0, excluded,
  } };
}

// Google Sheets CSV uses doubled quotes, quoted newlines and CRLF or LF record boundaries.
function csvRows(input) {
  const rows = [];
  let row = [], field = '', quoted = false, closed = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (input[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (c === ',' || c === '\r' || c === '\n') {
      row.push(field);
      field = ''; closed = false;
      if (c !== ',') {
        rows.push(row); row = [];
        if (c === '\r' && input[i + 1] === '\n') i++;
      }
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (c === '"' || closed) throw new Error('Invalid quoted field in CSV.');
    else field += c;
  }
  if (quoted) throw new Error('Unterminated quoted field in CSV.');
  if (row.length || field || closed) rows.push([...row, field]);
  return rows;
}

function privateSample(fields) {
  if (fields.length > sheetHeaders.length) return 'too many sheet columns';
  const [id, date, surface, outcome, classification, risk, issued, recorded, channel, time, ,
    version, assessment, departure, parking, sun, wet] = fields.map(value => String(value ?? '').trim());
  if (!id || !surfaces.includes(surface) || !['gmail', 'website'].includes(channel)) return 'missing event, surface or channel';
  if (!['frost', 'ice', 'clear'].includes(outcome)) return 'no explicit outside frost/clear outcome';
  if (!risks.includes(risk) || classification === 'unverified') return 'missing or unverified issued verdict';
  const actual = outcome === 'clear' ? 'clear' : 'icy';
  const expected = risk === 'possible' ? 'uncertain' :
    (risk === 'likely' ? {clear: 'false-positive', icy: 'true-positive'} : {clear: 'true-negative', icy: 'false-negative'})[actual];
  const assessedIcy = { 'true-positive': true, 'false-negative': true, 'false-positive': false, 'true-negative': false };
  if (classification !== expected || (assessment && risk !== 'possible' && assessment !== expected)) {
    return 'classification or reported assessment contradicts issued verdict and observation';
  }
  if (Object.hasOwn(assessedIcy, assessment) && assessedIcy[assessment] !== (actual === 'icy')) {
    return 'reported assessment contradicts the explicit observation';
  }
  const timestamp = /T.+(?:Z|[+-]\d{2}:\d{2})$/i;
  if (!timestamp.test(issued) || !timestamp.test(recorded) || !localStamp(recorded)) return 'invalid sheet timestamps';
  if (time && localStamp(recorded) < date + ' ' + time) return 'observation reported before its check time';
  const forecast = { date, surface, risk, issuedAt: issued, modelVersion: version, settings: {departure} };
  const sample = matchSample({ date, surface, outcome, observedTime: time, forecast }, channel);
  if (typeof sample === 'string') return sample;
  // If one date has conflicting outcomes or setups, no private observer is chosen as representative.
  return { ...sample, setup: [departure, parking || '', sun || '', wet || ''].join('|') };
}

function sheetSamples(rows) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0]) || rows[0].length !== sheetHeaders.length ||
      !sheetHeaders.every((header, i) => rows[0][i] === header)) {
    throw new Error('Expected the normalized private feedback sheet with its 17-column header.');
  }
  const groups = new Map(), excluded = {}, eligibleByChannel = { gmail: 0, website: 0 };
  const skip = (reason, n = 1) => { excluded[reason] = (excluded[reason] ?? 0) + n; };
  let inputRows = 0;
  for (const fields of rows.slice(1)) {
    if (!Array.isArray(fields)) throw new Error('Expected an array of cells for each sheet row.');
    if (fields.every(cell => cell === '' || cell == null)) continue;
    inputRows++;
    const sample = privateSample(fields);
    if (typeof sample === 'string') { skip(sample); continue; }
    eligibleByChannel[sample.source]++;
    const key = sample.date + '/' + sample.surface;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sample);
  }
  const samples = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (group.some(row => row.risk !== first.risk || row.icy !== first.icy ||
        row.version !== first.version || row.setup !== first.setup)) {
      skip('reports disagree on the same morning and surface', group.length);
    } else {
      if (group.length > 1) skip('agreeing same-morning reports collapsed', group.length - 1);
      samples.push(first);
    }
  }
  const dates = [...new Set(samples.map(row => row.date))].sort();
  const commonHoldout = dates[Math.floor(dates.length * 2 / 3)];
  return { samples, commonHoldout, details: {
    sheetRows: inputRows, eligibleByChannel, distinctMornings: dates.length, commonHoldoutStarts: commonHoldout ?? null, excluded,
    grouping: 'One example per surface and date. Agreeing reports count once. Groups with conflicting setups, versions, verdicts or outcomes are excluded. This can favor mornings with more uniform conditions. All surfaces and versions share the same holdout dates.',
  } };
}

function report(input) {
  const content = input.trimStart();
  const parsed = /^[\[{]/.test(content) ? JSON.parse(content) : csvRows(content);
  const table = Array.isArray(parsed) ? parsed : parsed?.values;
  const { samples, details, commonHoldout } = table ? sheetSamples(table) : browserSamples(parsed);
  const results = surfaces.map(surface => {
    const subset = samples.filter(row => row.surface === surface);
    const versions = [...new Set(subset.map(row => row.version))];
    return { surface, matchedMornings: subset.length, byModelVersion: versions.map(modelVersion => ({
      modelVersion, ...evaluate(subset.filter(row => row.version === modelVersion), commonHoldout),
    })) };
  });
  return {
    ...details, results,
    method: 'Train on the earliest two thirds of matched dates. Within each surface and version, estimate an icy fraction for each supported risk label using one extra icy and one extra clear observation for smoothing. Test against the training-period overall icy fraction on later dates.',
    interpretation: 'Voluntary reports can favor errors. Counts and estimated frequencies describe the reported mornings and parking conditions. Lower Brier scores indicate smaller probability errors on the same later mornings. Unreported mornings have unknown outcomes.',
  };
}

try {
  if (process.argv.length !== 3) throw new Error('Usage: node calibrate.mjs EXPORTED-LOG.json or PRIVATE-FEEDBACK.csv');
  console.log(JSON.stringify(report(readFileSync(process.argv[2], 'utf8')), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
