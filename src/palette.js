// Value→color and SI→display-unit mapping: the temperature/flow ramps, the
// System loop-function palette, the editable scale domain, and the SI/IP
// display conversions. A leaf module (no app imports) so the views depend
// on it directly instead of cycling back through app.js.

// System loop-function palette: air amber, chilled-water blue, hot-water
// red, condenser-water green, unclassified violet.
export const SYSTEM_PALETTE = {
  air: '#d9a23b', chw: '#5b9bd9', hw: '#d65b4a', cw: '#46b380', other: '#8a7fb8'
};

// display unit system: SI (°C, kg/s) or IP (°F, lb/min) — display layer
// only; all internal state stays SI. Default: IP.
let displayUnits = 'ip';
export const setDisplayUnits = u => { displayUnits = u; };
export const tempUnit = () => (displayUnits === 'ip' ? '°F' : '°C');
export const flowUnit = () => (displayUnits === 'ip' ? 'lb/min' : 'kg/s');
export const dispTemp = c => (displayUnits === 'ip' ? c * 9 / 5 + 32 : c);
export const siTemp = t => (displayUnits === 'ip' ? (t - 32) * 5 / 9 : t);
export const dispFlow = f => (displayUnits === 'ip' ? f * 132.277 : f);
export const siFlow = f => (displayUnits === 'ip' ? f / 132.277 : f);

// user-adjustable scale domains (null = auto from playback stats) + ramp.
// Default temperature domain is 40–120 °F, stored internally in °C.
export const scale = {
  tempMin: (40 - 32) * 5 / 9, tempMax: (120 - 32) * 5 / 9, flowMax: null, ramp: 'thermal'
};
export const RAMPS = {
  thermal: ['#2747c9', '#2fa3c9', '#3fae62', '#c9b53a', '#e0492f'],
  coolwarm: ['#3b4cc0', '#9abbff', '#f1ede9', '#f4987a', '#b40426'],
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  inferno: ['#0d0887', '#6a00a8', '#bc3754', '#f98e09', '#fcffa4']
};

export function rampColor(t) {
  const stops = RAMPS[scale.ramp] || RAMPS.thermal;
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i].match(/\w\w/g).map(h => parseInt(h, 16));
  const b = stops[i + 1].match(/\w\w/g).map(h => parseInt(h, 16));
  const mix = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `#${mix.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

export function colorForTemperature(value, min, max) {
  if (!Number.isFinite(value) || min == null || max == null) return '#56647c';
  const t = max === min ? 0.5 : (value - min) / (max - min);
  return rampColor(t);
}

export function colorForFlow(value, max) {
  if (!Number.isFinite(value) || !max) return '#39455a';
  // clamp inside the sqrt: reverse-flow nodes report negative mass flow,
  // and sqrt(negative) = NaN would poison the color string
  const t = Math.min(1, Math.sqrt(Math.max(0, value) / max));
  return hslToHex(0.52, 0.8, 0.16 + t * 0.42);
}

function hslToHex(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(hue2rgb(p, q, h + 1 / 3))}${toHex(hue2rgb(p, q, h))}${toHex(hue2rgb(p, q, h - 1 / 3))}`;
}
