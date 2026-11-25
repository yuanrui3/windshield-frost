const ZONE = 'America/Indiana/Indianapolis';
const SITE = { latitude: 40.4259, longitude: -86.9081 };
const HOUR = 3_600_000;
const STEP_SECONDS = 120;
const STEP = STEP_SECONDS * 1000;
const SIGMA = 5.670374419e-8;
const GLASS_EMISSIVITY = 0.84;
const GLASS_CAPACITY = 9_400;
const CABIN_CAPACITY = 25_000;
const HEAT_OF_FUSION = 333_500;
const HEAT_OF_SUBLIMATION = 2_834_000;
const HEAT_OF_VAPORIZATION = 2_500_000;
const VISIBLE_ICE = 0.005;
const WATER_CAPACITY = 0.25;
const WET_GLASS = 0.06;

export const DEFAULTS = Object.freeze({
  departure: '08:00',
  parking: 'open',
  sun: 'moderate',
  windows: 'closed',
  wet: false,
});

const weatherVariables = [
  'temperature_2m',
  'dew_point_2m',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'wind_speed_10m',
  'direct_radiation_instant',
  'diffuse_radiation_instant',
  'rain',
  'showers',
];

const parkingProfiles = {
  open: { skyView: 0.84, windScale: 1, lightScale: 1, wetting: 1 },
  sheltered: { skyView: 0.50, windScale: 0.65, lightScale: 0.82, wetting: 0.65 },
  covered: { skyView: 0.12, windScale: 0.45, lightScale: 0.38, wetting: 0.05 },
};

const sunlightProfiles = {
  full: { direct: 1.12, diffuse: 0.86 },
  moderate: { direct: 0.50, diffuse: 0.72 },
  shade: { direct: 0.04, diffuse: 0.28 },
};

const windowProfiles = {
  closed: { glassCoupling: 3.7, ambientCoupling: 2, windCoupling: 0.16 },
  cracked: { glassCoupling: 4.1, ambientCoupling: 4.8, windCoupling: 0.38 },
  open: { glassCoupling: 5, ambientCoupling: 9, windCoupling: 0.75 },
};

const scenarios = {
  central: { skyBias: 0, wind: 1, sun: 1 },
  colder: { skyBias: -12, wind: 0.82, sun: 0.68 },
  warmer: { skyBias: 15, wind: 1.18, sun: 1.20 },
};

const localFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function localParts(date) {
  return Object.fromEntries(
    localFormatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
}

export function getLocalDate(date = new Date()) {
  const { year, month, day } = localParts(date);
  return `${year}-${month}-${day}`;
}

function dateAtUtcMidnight(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid forecast date.');
  const midnight = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(midnight.getTime()) || !midnight.toISOString().startsWith(date)) {
    throw new Error('Invalid forecast date.');
  }
  return midnight.getTime();
}

function dateByOffset(date, days) {
  return new Date(dateAtUtcMidnight(date) + days * 24 * HOUR).toISOString().slice(0, 10);
}

export function nextLocalDate(date = getLocalDate()) {
  return dateByOffset(date, 1);
}

function localTime(date, clock) {
  const [hour, minute] = clock.split(':').map(Number);
  const targetAsUtc = dateAtUtcMidnight(date) + (hour * 60 + minute) * 60_000;
  let result = targetAsUtc;
  for (let i = 0; i < 4; i += 1) {
    const local = localParts(result);
    const displayedAsUtc = Date.UTC(+local.year, +local.month - 1, +local.day, +local.hour, +local.minute);
    if (displayedAsUtc === targetAsUtc) return result;
    result += targetAsUtc - displayedAsUtc;
  }
  throw new Error('Departure time is unavailable on this date due to the local clock change.');
}

export function forecastUrl() {
  const params = new URLSearchParams({
    latitude: String(SITE.latitude),
    longitude: String(SITE.longitude),
    hourly: weatherVariables.join(','),
    wind_speed_unit: 'ms',
    timezone: 'UTC',
    timeformat: 'unixtime',
    past_days: '1',
    forecast_days: '5',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

function normalizeSettings(settings) {
  const merged = { ...DEFAULTS, ...settings };
  const parking = { roof: 'covered', carport: 'covered' }[merged.parking] || merged.parking;
  const sun = { direct: 'full', partial: 'moderate' }[merged.sun] || merged.sun;
  if (!Object.hasOwn(parkingProfiles, parking)) throw new Error('Unknown parking exposure.');
  if (!Object.hasOwn(sunlightProfiles, sun)) throw new Error('Unknown morning sunlight setting.');
  if (!Object.hasOwn(windowProfiles, merged.windows)) throw new Error('Unknown window setting.');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(merged.departure)) {
    throw new Error('Choose a valid local departure time.');
  }
  return {
    departure: merged.departure,
    parking,
    sun,
    windows: merged.windows,
    wet: merged.wet === true,
  };
}

function cToF(celsius) {
  return 32 + celsius * 9 / 5;
}

function blackBody(celsius) {
  return SIGMA * (celsius + 273.15) ** 4;
}

function vaporOverIce(celsius) {
  const kelvin = celsius + 273.15;
  return Math.exp(9.550426 - 5723.265 / kelvin + 3.53068 * Math.log(kelvin) - 0.00728332 * kelvin);
}

function vaporOverWater(celsius) {
  const kelvin = celsius + 273.15;
  const e0 = 54.842763 - 6763.22 / kelvin - 4.210 * Math.log(kelvin) + 0.000367 * kelvin;
  const e1 = 53.878 - 1331.22 / kelvin - 9.44523 * Math.log(kelvin) + 0.014025 * kelvin;
  return Math.exp(e0 + Math.tanh(0.0415 * (kelvin - 218.8)) * e1);
}

function frostPoint(vapor) {
  let lower = -95;
  let upper = 0;
  for (let i = 0; i < 18; i += 1) {
    const middle = (lower + upper) / 2;
    if (vaporOverIce(middle) < vapor) lower = middle;
    else upper = middle;
  }
  return (lower + upper) / 2;
}

function cloudFraction(value) {
  return Math.max(0, Math.min(1, value / 100));
}

function skyRadiation(wx, scenario) {
  const kelvin = wx.air + 273.15;
  const vaporHpa = wx.vapor / 100;
  const airFlux = blackBody(wx.air);
  const brutsaert = 1.24 * (vaporHpa / kelvin) ** (1 / 7);
  const precipitableWater = 46.5 * vaporHpa / kelvin;
  const prata = 1 - (1 + precipitableWater) * Math.exp(-Math.sqrt(1.2 + 3 * precipitableWater));
  const clearFlux = Math.min(airFlux, airFlux * (brutsaert + prata) / 2);
  const low = cloudFraction(wx.lowCloud);
  const mid = cloudFraction(wx.midCloud) * (1 - low);
  const high = cloudFraction(wx.highCloud) * (1 - low - mid);
  const cloudWarming = 0.88 * low + 0.55 * mid + 0.17 * high;
  return Math.min(airFlux + 8, clearFlux + (airFlux - clearFlux) * cloudWarming + scenario.skyBias);
}

function weatherReader(weather, start, end) {
  const hourly = weather?.hourly;
  const times = hourly?.time;
  if (!Array.isArray(times) || times.length < 2 || !Number.isFinite(times[0])) {
    throw new Error('No hourly weather was available.');
  }
  const origin = times[0] * 1000;
  const firstIndex = Math.floor((start - origin) / HOUR);
  const endIndex = Math.ceil((end - origin) / HOUR);
  if (firstIndex < 0 || endIndex >= times.length) {
    throw new Error('Weather is missing part of the requested overnight forecast.');
  }
  const data = weatherVariables.map(key => hourly[key]);
  for (let i = firstIndex; i <= endIndex; i += 1) {
    if (times[i] !== times[0] + i * 3600 || data.some(series => !Number.isFinite(series?.[i]))) {
      throw new Error('Open-Meteo returned incomplete hourly weather.');
    }
  }
  return function at(timestamp) {
    const fractionalIndex = (timestamp - origin) / HOUR;
    const left = Math.floor(fractionalIndex);
    const right = Math.ceil(fractionalIndex);
    const part = fractionalIndex - left;
    const [air, dew, lowCloud, midCloud, highCloud, wind, direct, diffuse] = data.map(
      (series, i) => i < 8 ? series[left] * (1 - part) + series[right] * part : series[right],
    );
    const rain = data[8][right] + data[9][right];
    return {
      air, vapor: vaporOverWater(dew), lowCloud, midCloud, highCloud, wind,
      direct: Math.max(0, direct),
      diffuse: Math.max(0, diffuse),
      rain: Math.max(0, rain),
    };
  };
}

function heatExchange(state, wx, profile, scenario) {
  const windAtGlass = Math.max(0.05, 0.68 * wx.wind * profile.parking.windScale * scenario.wind);
  const airDifference = wx.air - state.glass;
  const outerCoupling = Math.max(1.6, Math.hypot(
    0.84 * Math.abs(airDifference) ** (1 / 3),
    3.26 * windAtGlass ** 0.89,
  ));
  const glassToCabin = profile.windows.glassCoupling * (state.glass - state.cabin);
  const outside = outerCoupling * airDifference;
  const skyView = profile.parking.skyView;
  const incoming = skyView * skyRadiation(wx, scenario) + (1 - skyView) * blackBody(wx.air);
  const longwave = GLASS_EMISSIVITY * (incoming - blackBody(state.glass));
  const solar = scenario.sun * profile.parking.lightScale *
    (wx.direct * profile.sun.direct + wx.diffuse * profile.sun.diffuse);
  const cabinExchange = (profile.windows.ambientCoupling + profile.windows.windCoupling * windAtGlass) *
    (wx.air - state.cabin);
  return {
    outerCoupling,
    glassFlux: outside - glassToCabin + longwave + 0.22 * solar,
    cabinFlux: cabinExchange + glassToCabin + 0.13 * solar,
  };
}

function advance(state, wx, profile, scenario, seconds) {
  const { outerCoupling, glassFlux, cabinFlux } = heatExchange(state, wx, profile, scenario);
  let thermalEnergy = glassFlux * seconds;
  state.cabin += cabinFlux * seconds / CABIN_CAPACITY;
  state.water = Math.min(WATER_CAPACITY, state.water + wx.rain * profile.parking.wetting * seconds / 3600);

  const vaporDensityFactor = 1 / (461.5 * (273.15 + (wx.air + state.glass) / 2));
  const massCoupling = outerCoupling / 1_250;
  if (state.glass <= 0 && state.water < 1e-6) {
    const vaporDifference = wx.vapor - vaporOverIce(state.glass);
    const exchange = Math.max(-state.ice, massCoupling * vaporDifference * vaporDensityFactor * seconds);
    state.ice += exchange;
    thermalEnergy += exchange * HEAT_OF_SUBLIMATION;
  } else {
    const vaporDifference = wx.vapor - vaporOverWater(state.glass);
    const exchange = Math.max(-state.water, massCoupling * vaporDifference * vaporDensityFactor * seconds);
    const accepted = Math.min(exchange, WATER_CAPACITY - state.water);
    state.water += accepted;
    thermalEnergy += accepted * HEAT_OF_VAPORIZATION;
  }

  let glassEnergy = state.glass * GLASS_CAPACITY + thermalEnergy;
  // With both phases present, hold the glass at freezing while latent heat is exchanged.
  if (glassEnergy < 0 && state.water > 0) {
    const freeze = Math.min(state.water, -glassEnergy / HEAT_OF_FUSION);
    state.ice += freeze;
    state.water -= freeze;
    glassEnergy += freeze * HEAT_OF_FUSION;
  } else if (glassEnergy > 0 && state.ice > 0) {
    const melt = Math.min(state.ice, glassEnergy / HEAT_OF_FUSION);
    state.ice -= melt;
    state.water = Math.min(WATER_CAPACITY, state.water + melt);
    glassEnergy -= melt * HEAT_OF_FUSION;
  }
  state.glass = glassEnergy / GLASS_CAPACITY;
}

function publicPoint(t, air, glass, moisture, ice) {
  return { t, glass: cToF(glass), air: cToF(air), frost: cToF(frostPoint(moisture)), ice };
}

function simulate(readWeather, timings, profile, scenario, includePoints) {
  const { start, morningStart, morningEnd, departure, end, wetAt } = timings;
  const first = readWeather(start);
  const state = { glass: first.air, cabin: first.air, water: 0, ice: 0 };
  const points = [];
  let atDeparture;
  let lastVisibleIce = null;
  let clearAfterIce = null;
  let wetApplied = false;
  let maxIce = 0;
  let t = start;
  while (t <= end) {
    const wx = readWeather(t);
    if (!wetApplied && profile.wet && t >= wetAt) {
      state.water = Math.min(WATER_CAPACITY, state.water + WET_GLASS);
      wetApplied = true;
    }
    if (t === departure) atDeparture = publicPoint(t, wx.air, state.glass, wx.vapor, state.ice);
    const previousEpisodeIsActive = lastVisibleIce !== null && clearAfterIce === null;
    if (t >= morningStart && (t <= morningEnd || previousEpisodeIsActive)) {
      maxIce = Math.max(maxIce, state.ice);
      if (state.ice >= VISIBLE_ICE) {
        lastVisibleIce = t;
        clearAfterIce = null;
      } else if (lastVisibleIce !== null && clearAfterIce === null) {
        clearAfterIce = t;
      }
    }
    if (includePoints && (t === departure || t % (30 * 60_000) === 0)) {
      points.push(publicPoint(t, wx.air, state.glass, wx.vapor, state.ice));
    }
    if (t === end) break;
    const upcomingDeparture = departure > t ? departure : end;
    const after = Math.min(t + STEP, upcomingDeparture, end);
    advance(state, readWeather((after + t) / 2), profile, scenario, (after - t) / 1000);
    t = after;
  }
  const hadIce = maxIce >= VISIBLE_ICE;
  return { atDeparture, points, hadIce, clears: clearAfterIce };
}

export function predict(weather, settings = DEFAULTS, date = nextLocalDate(getLocalDate())) {
  const ownSettings = normalizeSettings(settings);
  const previous = dateByOffset(date, -1);
  const morningStart = localTime(date, '00:00');
  const departure = localTime(date, ownSettings.departure);
  const start = localTime(previous, '17:00');
  const end = Math.max(localTime(date, '18:00'), departure);
  const morningEnd = Math.max(localTime(date, '12:00'), departure);
  const timings = { start, morningStart, morningEnd, departure, end, wetAt: localTime(previous, '21:00') };
  const readWeather = weatherReader(weather, start, end);
  const profile = {
    parking: parkingProfiles[ownSettings.parking],
    sun: sunlightProfiles[ownSettings.sun],
    windows: windowProfiles[ownSettings.windows],
    wet: ownSettings.wet,
  };
  const nominal = simulate(readWeather, timings, profile, scenarios.central, true);
  const colder = simulate(readWeather, timings, profile, scenarios.colder, false);
  const warmer = simulate(readWeather, timings, profile, scenarios.warmer, false);
  const estimates = [nominal, colder, warmer];
  const visibleAtDeparture = estimates.filter(record => record.atDeparture.ice >= VISIBLE_ICE);
  const nominalAtDeparture = nominal.atDeparture;
  let risk = 'low';
  if (visibleAtDeparture.length === 3 || nominalAtDeparture.ice >= 4 * VISIBLE_ICE) {
    risk = 'likely';
  } else if (visibleAtDeparture.length > 0) {
    risk = 'possible';
  }
  const icy = estimates.filter(record => record.hadIce);
  const clearance = icy.map(record => record.clears).filter(Number.isFinite);
  const melt = icy.length ? {
    start: clearance.length ? Math.min(...clearance) : null,
    end: clearance.length === icy.length ? Math.max(...clearance) : null,
  } : null;
  return {
    date,
    risk,
    atDeparture: { glass: nominalAtDeparture.glass, air: nominalAtDeparture.air, ice: nominalAtDeparture.ice },
    melt,
    hadIce: icy.length > 0,
    points: nominal.points,
    settings: ownSettings,
    glassRange: [Math.min(...estimates.map(r => r.atDeparture.glass)), Math.max(...estimates.map(r => r.atDeparture.glass))],
    departure,
    model: 'one-dimensional glass/cabin heat and moisture balance, three uncalibrated exposure cases',
  };
}
