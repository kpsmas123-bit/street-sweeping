/* Street sweeping checker — Berkeley & Oakland.
   No backend: the data is baked into data/*.json by the ETL. */
'use strict';

/* `vintage` is when the CITY last changed its data, not when we last fetched it.
   Oakland's layer reports dataLastEditDate = 2021-06-21 and Berkeley's schedule
   PDFs are dated 2022-03, so both are years old. Saying so is more honest than a
   "last updated today" that only reflects our own build. */
var CITIES = [
  { id: 'berkeley', file: 'data/berkeley.json',
    bbox: [-122.328, 37.845, -122.234, 37.906],
    vintage: 'City schedule published March 2022.' },
  { id: 'oakland',  file: 'data/oakland.json',
    bbox: [-122.355, 37.632, -122.114, 37.885],
    vintage: 'City data last edited June 2021.' }
];

var DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
var ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
var SIDE_COLOR = ['#007aff', '#ff9500'];   /* two lines, two colours, user picks */

var segments = [];
var holidays = null;      /* { city: {rule, dates:Set} } */
var cityId = null;
var current = null;     /* the block we matched */
var chosen = 0;         /* which side the user tapped */
var map = null;

/* ---------------------------------------------------------------- geometry */
/* nearestPointOnLine, hand-rolled: turf's full bundle is far more than this
   needs, and keeping it local keeps the app working offline. */
var MX_AT = function (lat) { return 111320 * Math.cos(lat * Math.PI / 180); };
var MY = 110574;

function distToSegment(p, a, b, mx) {
  var px = p[0] * mx, py = p[1] * MY;
  var ax = a[0] * mx, ay = a[1] * MY;
  var bx = b[0] * mx, by = b[1] * MY;
  var dx = bx - ax, dy = by - ay;
  var denom = dx * dx + dy * dy;
  var t = denom === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / denom));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function nearestSegment(lon, lat) {
  var mx = MX_AT(lat);
  var best = null, bestDist = Infinity;
  for (var i = 0; i < segments.length; i++) {
    var g = segments[i].g;
    /* cheap bbox reject before the per-vertex math */
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var k = 0; k < g.length; k++) {
      if (g[k][0] < minX) minX = g[k][0];
      if (g[k][0] > maxX) maxX = g[k][0];
      if (g[k][1] < minY) minY = g[k][1];
      if (g[k][1] > maxY) maxY = g[k][1];
    }
    var pad = 0.0012;   /* ~130 m */
    if (lon < minX - pad || lon > maxX + pad || lat < minY - pad || lat > maxY + pad) continue;
    for (var j = 0; j < g.length - 1; j++) {
      var d = distToSegment([lon, lat], g[j], g[j + 1], mx);
      if (d < bestDist) { bestDist = d; best = segments[i]; }
    }
  }
  return best ? { segment: best, distance: bestDist } : null;
}

/* ---------------------------------------------------------------- schedule */
/* Mirrors etl/schedule.py. "2nd Monday" is the 2nd Monday on the calendar page,
   not the Monday of the 2nd week — the misreading people get ticketed over. */
function occursOn(side, date) {
  if (side.k !== 'w' && side.k !== 'n') return false;
  var weekdays = side.w || [];
  if (weekdays.indexOf(date.getDay()) === -1) return false;
  if (side.k === 'w') return true;
  var nth = Math.floor((date.getDate() - 1) / 7) + 1;
  return (side.o || []).indexOf(nth) !== -1;
}

function isoDate(d) {
  return d.getFullYear() + '-' +
         ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

/* Both cities cancel the sweep on a city holiday. Berkeley says so outright:
   "streets are no longer swept on holidays ... swept on their next regularly
   scheduled day" -- skipped, not made up. Oakland publishes the dates but not
   whether it makes the sweep up, so we suppress the sweep either way (both
   readings agree it does not happen that day) and say so in the UI. */
function isHoliday(d) {
  return !!(holidays && holidays.dates && holidays.dates.indexOf(isoDate(d)) !== -1);
}

function nextSweep(side, from) {
  var d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (var i = 0; i < 70; i++) {
    d.setDate(d.getDate() + 1);
    if (occursOn(side, d) && !isHoliday(d)) return new Date(d);
  }
  return null;
}

function minutes(hhmm) {
  var p = hhmm.split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

/* Is the sweeper here right now, and if not, when? */
function evaluate(side, now) {
  var hasWindow = !!side.t;
  var todayIsSweep = occursOn(side, now) && !isHoliday(now);
  if (occursOn(side, now) && isHoliday(now)) {
    return { state: 'holiday', next: nextSweep(side, now) };
  }
  var nowMin = now.getHours() * 60 + now.getMinutes();

  if (todayIsSweep && hasWindow) {
    var start = minutes(side.t[0]), end = minutes(side.t[1]);
    if (nowMin >= start && nowMin < end) return { state: 'active', end: side.t[1] };
    if (nowMin < start) return { state: 'today', start: side.t[0], end: side.t[1],
                                 minsAway: start - nowMin };
    return { state: 'passed', next: nextSweep(side, now) };
  }
  if (todayIsSweep && !hasWindow) return { state: 'today_no_time' };
  return { state: 'clear', next: nextSweep(side, now) };
}

/* ------------------------------------------------------------------- words */
function describe(side) {
  var days = (side.w || []).map(function (d) { return DAY[d]; });
  var when;
  if (side.k === 'w') {
    when = days.length === 7 ? 'Every day'
         : days.length > 2 ? days.map(function (d) { return d.slice(0, 3); }).join(', ')
         : 'Every ' + days.join(' & ');
  } else if (side.k === 'n') {
    var ords = (side.o || []).map(function (o) { return ORD[o]; }).join(' & ');
    when = ords + ' ' + days.join(' & ');
  } else {
    return 'Schedule unknown';
  }
  return side.t ? when + ', ' + fmtTime(side.t[0]) + '–' + fmtTime(side.t[1]) : when;
}

function fmtTime(hhmm) {
  var p = hhmm.split(':'), h = parseInt(p[0], 10), m = p[1];
  var ampm = h < 12 ? 'AM' : 'PM';
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + (m === '00' ? '' : ':' + m) + ' ' + ampm;
}

function fmtDate(d, now) {
  var days = Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  if (days === 1) return 'tomorrow';
  /* Never a bare weekday name: "Monday" for a sweep six days out reads like the
     Monday coming up in a day or two, which is how people get ticketed. */
  return DAY[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate();
}




/* Does the map have a transform that can be panned? Not "is the style loaded":
   painting the block calls setData first, which puts the geojson sources back
   into a loading state. */
function mapReady() {
  if (!map) return false;
  try {
    var c = map.getCenter();
    var canvas = map.getCanvas();
    return !!c && isFinite(c.lat) && isFinite(c.lng) &&
           canvas.width > 0 && canvas.height > 0;
  } catch (err) {
    return false;
  }
}

/* --------------------------------------------------------------- compass */
/* "East side" only helps if you know which way east is. iOS needs an explicit
   permission request from inside a user gesture, so this is a button rather
   than something that starts on its own. */
var compassOn = false;

function headingFrom(e) {
  if (typeof e.webkitCompassHeading === 'number') return e.webkitCompassHeading;
  if (e.absolute && typeof e.alpha === 'number') return 360 - e.alpha;
  return null;
}

var needleAngle = 0;      /* unwrapped, so the needle never spins the long way */

function onHeading(e) {
  var deg = headingFrom(e);
  if (deg === null) return;
  var needle = $('needle');
  if (needle) {
    /* Rotate by the shortest delta and accumulate. Setting the raw angle makes
       the needle whip 350 degrees backwards every time it crosses north. */
    var delta = ((-deg - needleAngle) % 360 + 540) % 360 - 180;
    needleAngle += delta;
    needle.style.transform = 'rotate(' + needleAngle + 'deg)';
  }
  var side = current && current.s[chosen];
  var hint = $('facing');
  if (!hint) return;
  hint.hidden = false;
  var names = ['north', 'north-east', 'east', 'south-east',
               'south', 'south-west', 'west', 'north-west'];
  /* "your side faces north" was read as "you are on the north side". Name the
     side explicitly and say where to look for it. */
  hint.textContent = 'You are facing ' + names[Math.round(deg / 45) % 8] +
    (side && side.f
      ? '. The ' + side.d + ' side (' + (side.a || '') + ') is the ' +
        FACING[side.f] + ' kerb.'
      : '');
}

function startCompass() {
  var go = function () {
    window.addEventListener('deviceorientationabsolute', onHeading, true);
    window.addEventListener('deviceorientation', onHeading, true);
    compassOn = true;
    $('compassRose').hidden = false;
    $('facing').hidden = false;
    $('showcompass').hidden = true;
  };
  var DOE = window.DeviceOrientationEvent;
  if (DOE && typeof DOE.requestPermission === 'function') {
    DOE.requestPermission().then(function (state) {
      if (state === 'granted') go();
      else setStatus('Compass permission denied.', 'error');
    }).catch(function () { setStatus('Compass unavailable.', 'error'); });
  } else if (DOE) {
    go();
  } else {
    setStatus('This device has no compass.', 'error');
  }
}

/* ------------------------------------------------------------- calendar */
/* A static site cannot schedule a push notification: the Notification Triggers
   API was abandoned and Web Push needs a server holding VAPID keys. A recurring
   calendar event with an alarm covers the same need with no backend, and it is
   what people already do by hand -- so it is the reminder mechanism, not a
   consolation prize. */
var VDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function pad(n) { return ('0' + n).slice(-2); }

function icsRule(side) {
  var days = (side.w || []).map(function (d) { return VDAY[d]; });
  if (!days.length) return null;
  if (side.k === 'w') return 'FREQ=WEEKLY;BYDAY=' + days.join(',');
  if (side.k === 'n') {
    /* "1st and 3rd Monday" -> BYDAY=1MO,3MO */
    var parts = [];
    (side.o || []).forEach(function (o) {
      days.forEach(function (d) { parts.push(o + d); });
    });
    return parts.length ? 'FREQ=MONTHLY;BYDAY=' + parts.join(',') : null;
  }
  return null;
}

function buildIcs(seg, side) {
  var rule = icsRule(side);
  var first = nextSweep(side, new Date());
  if (!rule || !first) return null;
  var start = side.t ? side.t[0].split(':') : ['09', '00'];
  var end = side.t ? side.t[1].split(':') : ['12', '00'];
  function stamp(d, hm) {
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
           'T' + hm[0] + hm[1] + '00';
  }
  var label = (seg.n || 'Street') + ' sweeping (' +
              (side.d === 'odd' || side.d === 'even' ? side.d + ' side' : 'your side') + ')';
  var lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//street-sweeping//EN',
    'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    'UID:' + seg.i + '-' + side.d + '@street-sweeping',
    'DTSTAMP:' + stamp(new Date(), ['00', '00']) + 'Z',
    'DTSTART;TZID=America/Los_Angeles:' + stamp(first, start),
    'DTEND;TZID=America/Los_Angeles:' + stamp(first, end),
    'RRULE:' + rule,
    'SUMMARY:Move car — ' + label,
    'DESCRIPTION:Advisory only. Posted signs control.' +
      (side.t ? '' : ' The city lists no sweep time for this side.') +
      ' City holidays are not excluded from this repeating event.',
    'LOCATION:' + (seg.n || ''),
    'BEGIN:VALARM', 'TRIGGER:-PT12H', 'ACTION:DISPLAY',
    'DESCRIPTION:Street sweeping tomorrow — move your car', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ];
  return lines.join('\r\n');
}

function downloadIcs() {
  var side = current.s[chosen];
  var text = buildIcs(current, side);
  if (!text) { setStatus('No repeating schedule to add.', 'error'); return; }
  var blob = new Blob([text], { type: 'text/calendar' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (current.n || 'sweeping').replace(/\W+/g, '-').toLowerCase() + '.ics';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}

/* ------------------------------------------------------------------ render */
function $(id) { return document.getElementById(id); }

function setStatus(text, tone) {
  var el = $('status');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = text;
  if (tone) el.setAttribute('data-tone', tone); else el.removeAttribute('data-tone');
}

var FACING = { N: 'north', E: 'east', S: 'south', W: 'west' };


function verdictFor(side, now) {
  /* One side's answer as {tone, headline, detail} -- no pre-selection anywhere,
     because the app cannot know which side the car is on. */
  var r = evaluate(side, now);
  if (r.state === 'active') {
    return { tone: 'now', headline: 'Move now',
             detail: 'Sweeping until ' + fmtTime(r.end) + ' today.' };
  }
  if (r.state === 'today') {
    var hrs = Math.floor(r.minsAway / 60), mins = r.minsAway % 60;
    return { tone: r.minsAway <= 120 ? 'now' : 'soon',
             headline: hrs >= 1 ? 'Move within ' + hrs + 'h ' + mins + 'm'
                                : 'Move within ' + mins + ' min',
             detail: 'Sweeping today, ' + fmtTime(side.t[0]) + '–' + fmtTime(side.t[1]) + '.' };
  }
  if (r.state === 'holiday') {
    return { tone: 'ok', headline: 'Clear — city holiday',
             detail: 'No sweeping today. Next sweep ' +
                     (r.next ? fmtDate(r.next, now) : 'not scheduled') + '.' };
  }
  if (r.state === 'today_no_time') {
    return { tone: 'soon', headline: 'Sweeps today',
             detail: 'The city lists a sweep day but no time for this side.' };
  }
  if (r.next) {
    if (!side.t) {
      return { tone: 'muted', headline: 'Sweeps ' + fmtDate(r.next, now),
               detail: 'No sweep time is listed for this side.' };
    }
    return { tone: 'ok', headline: 'Clear',
             detail: 'Next sweep ' + fmtDate(r.next, now) + ', ' +
                     fmtTime(side.t[0]) + '–' + fmtTime(side.t[1]) + '.' };
  }
  return { tone: 'muted', headline: 'No sweeping listed', detail: describe(side) };
}

var NOTES = {
  no_time:    'The city lists a sweep day for this side but no time window. Check the sign.',
  no_signage: 'The city records no posted signage here. The sign you see is the only authority.',
  flagged:    'The city flagged this block for re-checking in its own data.',
  unknown:    'We could not read a schedule for this side. Go by the sign.'
};

/* Both sides, always, side by side. The previous build pre-selected one and
   printed a single confident verdict for it -- which is a coin flip on any
   street whose two sides sweep on different days, and Parker St's do: odd on
   the 2nd Wednesday, even on the 2nd Tuesday. Showing one answer for an
   unconfirmed side is how you end up on the wrong curb. */
/* ------------------------------------------------------------------ stage */
/* An overhead view of the block with your car on it. GPS puts the car on the
   street -- that much it can do. Which kerb it sits on is still a tap, because
   the two kerbs are 8-10 m apart and a phone fix is 3-30 m, and guessing that is
   what once sent someone to the wrong side. Here the guess is not even
   available: the car waits in the middle of the road until you place it. */
var placed = false;

/* Screen x of each kerb, matching the SVG. */
var KERB_X = [124, 236];

function toneOf(side, now) { return verdictFor(side, now).tone; }

function renderStage() {
  var now = new Date();
  var scene = $('scene');
  drawCrossStreets();

  current.s.forEach(function (side, i) {
    if (i > 1) return;
    var v = verdictFor(side, now);
    var kerb = $(i === 0 ? 'kerbA' : 'kerbB');
    kerb.setAttribute('data-tone', v.tone);
    kerb.setAttribute('data-active', String(placed && chosen === i));

    var label = $(i === 0 ? 'labelA' : 'labelB');
    label.hidden = false;
    label.setAttribute('data-tone', v.tone);
    label.setAttribute('aria-pressed', String(placed && chosen === i));
    var who = side.d === 'odd' ? 'Odd' : side.d === 'even' ? 'Even'
            : side.d === 'both' ? 'This block' : 'Side ' + (i === 0 ? 'A' : 'B');
    var meta = [];
    if (side.a) meta.push(side.a);
    if (side.f) meta.push(FACING[side.f]);
    label.innerHTML =
      '<span class="kl-side">' + who + '</span>' +
      (meta.length ? '<span class="kl-meta">' + meta.join(' · ') + '</span>' : '') +
      '<span class="kl-state">' + v.headline + '</span>';
    label.onclick = function () { placeCar(i); };
  });

  /* One kerb only (a major street digitised as two lines): nothing to choose. */
  if (current.s.length < 2) {
    $('labelB').hidden = true;
    $('kerbB').setAttribute('data-tone', 'muted');
    $('kerbB').setAttribute('data-active', 'false');
    if (!placed) placeCar(0);
  }

  moveCar();
  renderVerdict();
}

function moveCar() {
  var car = $('car');
  var x = placed ? KERB_X[Math.min(chosen, 1)] : 180;
  car.style.transform = 'translate(' + x + 'px, 250px)';
  car.classList.toggle('car--placing', !placed);
}

function placeCar(i) {
  chosen = i;
  placed = true;
  try { localStorage.setItem('side:' + current.i, String(i)); } catch (e) {}
  renderStage();
  paintSides();
}

/* Faint cross streets, purely to make the block read as a block. */
function drawCrossStreets() {
  var g = $('cross');
  if (g.childNodes.length) return;
  [40, 150, 330, 440].forEach(function (y) {
    var l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', '-20'); l.setAttribute('x2', '380');
    l.setAttribute('y1', y); l.setAttribute('y2', y);
    g.appendChild(l);
  });
}

function renderVerdict() {
  $('street').textContent = current.n || 'This block';
  var v = $('verdict');
  if (!placed) {
    v.hidden = true;
    $('prompt').textContent = current.s.length > 1
      ? 'Tap the kerb your car is on. Check the nearest house number.'
      : 'One kerb on this block.';
    $('remind').hidden = true;
    return;
  }
  var side = current.s[chosen];
  var r = verdictFor(side, new Date());
  v.hidden = false;
  $('prompt').textContent = (side.d === 'odd' || side.d === 'even'
      ? side.d.charAt(0).toUpperCase() + side.d.slice(1) + ' side'
      : 'This kerb') +
    (side.a ? ' · ' + side.a : '') + (side.f ? ' · faces ' + FACING[side.f] : '');
  $('headline').textContent = r.headline;
  $('headline').dataset.tone = r.tone;
  $('sub').textContent = r.detail + ' ' + describe(side) + '.';
  var note = NOTES[side.c];
  $('note').hidden = !note;
  if (note) $('note').textContent = note;
  $('remind').hidden = !icsRule(side);
  $('showcompass').hidden = compassOn || !current.s.some(function (x) { return x.f; });
}

/* --------------------------------------------------------------------- map */
function baseStyle() {
  /* No external tiles: the app's own street lines are the basemap. That keeps
     it working with no signal and needs no tile-provider key. */
  return {
    version: 8,
    sources: {
      streets: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      picked:  { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e9e9ee' } },
      { id: 'streets', type: 'line', source: 'streets',
        paint: { 'line-color': '#b9b9c0', 'line-width': 3 } },
      { id: 'picked', type: 'line', source: 'picked',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 6,
          'line-offset': ['get', 'offset'],
          'line-opacity': ['case', ['get', 'active'], 1, 0.45]
        } }
    ]
  };
}

function paintSides() {
  if (!map || !current) return;
  var feats = current.s.map(function (side, i) {
    return {
      type: 'Feature',
      properties: { color: SIDE_COLOR[i], offset: i === 0 ? -5 : 5, active: i === chosen },
      geometry: { type: 'LineString', coordinates: current.g }
    };
  });
  map.getSource('picked').setData({ type: 'FeatureCollection', features: feats });
}

function paintContext(lon, lat) {
  var pad = 0.004;
  var near = segments.filter(function (s) {
    return s.g.some(function (p) {
      return Math.abs(p[0] - lon) < pad && Math.abs(p[1] - lat) < pad;
    });
  }).slice(0, 400);
  map.getSource('streets').setData({
    type: 'FeatureCollection',
    features: near.map(function (s) {
      return { type: 'Feature', properties: {},
               geometry: { type: 'LineString', coordinates: s.g } };
    })
  });
}

/* -------------------------------------------------------------------- boot */
function cityFor(lon, lat) {
  for (var i = 0; i < CITIES.length; i++) {
    var b = CITIES[i].bbox;
    if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) return CITIES[i];
  }
  return null;
}

function locate() {
  /* An NFC sticker on the car opens this URL. ?nfc=1 means "I just parked":
     stamp the time and go straight to locating, no taps. */
  var params = new URLSearchParams(location.search);
  if (params.get('nfc') === '1') stampParked();
  setStatus('Finding your spot…');
  /* ?at=lon,lat overrides GPS — for testing a block you are not standing on. */
  var at = new URLSearchParams(location.search).get('at');
  if (at) {
    var p = at.split(',').map(Number);
    if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) {
      onPosition({ coords: { longitude: p[0], latitude: p[1] } });
      return;
    }
  }
  if (!navigator.geolocation) {
    setStatus('This browser has no location access.', 'error');
    return;
  }
  navigator.geolocation.getCurrentPosition(onPosition, onGeoError, {
    enableHighAccuracy: true, timeout: 15000, maximumAge: 30000
  });
}

function onGeoError(err) {
  var msg = err.code === 1 ? 'Location permission denied — enable it to check your block.'
          : err.code === 3 ? 'Location timed out. Try again with a clearer view of the sky.'
          : 'Could not get your location.';
  setStatus(msg, 'error');
}

function onPosition(pos) {
  var lon = pos.coords.longitude, lat = pos.coords.latitude;
  lastFix = [lon, lat];
  var city = cityFor(lon, lat);
  if (!city) {
    setStatus('You are outside Berkeley and Oakland.', 'error');
    return;
  }
  setStatus('Loading ' + city.id + '…');
  cityId = city.id;
  Promise.all([
    fetch(city.file).then(function (r) { return r.json(); }),
    fetch('data/holidays.json').then(function (r) { return r.json(); })
                               .catch(function () { return null; })
  ])
    .then(function (both) {
      var payload = both[0];
      holidays = both[1] ? both[1][city.id] : null;
      segments = payload.segments;
      var hit = nearestSegment(lon, lat);
      if (!hit) { setStatus('No sweeping data near you.', 'error'); return; }
      current = hit.segment;
      chosen = 0;
      placed = false;
      /* If this block was answered before, start the car where it was left --
         but only for this exact block, and the tap is still what set it. */
      try {
        var saved = localStorage.getItem('side:' + current.i);
        if (saved !== null && current.s[+saved]) { chosen = +saved; placed = true; }
      } catch (e) {}
      setStatus(null);
      $('status').hidden = true;
      $('detail').hidden = false;
      $('vintage').textContent = city.vintage + ' Schedules can change without the data changing.';
      renderStage();
      showParkedStamp();
    })
    .catch(function () { setStatus('Could not load sweeping data.', 'error'); });
}

/* The real map is no longer the main view -- the overhead scene is. It opens on
   demand to confirm the block, and is built lazily the first time. */
var lastFix = null;

function showMap() {
  $('mapwrap').hidden = false;
  if (map) { map.resize(); return; }
  var g = current.g;
  var mid = g[Math.floor(g.length / 2)];
  map = new maplibregl.Map({
    container: 'map',
    style: baseStyle(),
    center: mid,
    zoom: 17.6,
    attributionControl: false
  });
  map.on('load', function () {
    if (lastFix) {
      paintContext(lastFix[0], lastFix[1]);
      new maplibregl.Marker({ color: '#0a84ff' }).setLngLat(lastFix).addTo(map);
    }
    paintSides();
  });
}

/* Tapping the NFC sticker stamps the time, so the app can say how long the car
   has been there -- the thing you actually forget. */
function stampParked() {
  try { localStorage.setItem('parkedAt', String(Date.now())); } catch (e) {}
}

function showParkedStamp() {
  var el = $('parked');
  var at;
  try { at = +localStorage.getItem('parkedAt'); } catch (e) { at = 0; }
  if (!at || Date.now() - at > 1000 * 60 * 60 * 72) { el.hidden = true; return; }
  var mins = Math.round((Date.now() - at) / 60000);
  var when = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  el.hidden = false;
  el.textContent = mins < 60 ? 'Parked ' + mins + 'm ago'
                 : 'Parked ' + when;
}

$('remind').onclick = downloadIcs;
$('showmap').onclick = showMap;
$('closemap').onclick = function () { $('mapwrap').hidden = true; };
$('showcompass').onclick = startCompass;

$('report').onclick = function () {
  var side = current ? current.s[chosen] : null;
  var v = side ? verdictFor(side, new Date()) : null;
  var body = encodeURIComponent(
    'Block: ' + (current ? current.n : '?') + '\n' +
    'Segment: ' + (current ? current.i : '?') + '\n' +
    'Side: ' + (side ? side.d + ' ' + (side.a || '') + ' ' + (side.f || '') : '?') + '\n' +
    'App said: ' + (v ? v.headline + ' — ' + v.detail : '?') + '\n\n' +
    'The posted sign says: ');
  window.location.href = 'mailto:?subject=' +
    encodeURIComponent('Street sweeping mismatch') + '&body=' + body;
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function () {});
}

locate();
