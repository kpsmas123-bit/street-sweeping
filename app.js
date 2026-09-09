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
  return DAY[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate() +
         (days <= 14 ? ' (' + days + ' days)' : '');
}




/* ----------------------------------------------------------- bottom sheet */
/* The grabber looked draggable and did nothing. Now it is: drag or tap it to
   slide the sheet down to a peek -- street, side and verdict stay on screen --
   which uncovers the full-bleed map underneath so you can see the whole block
   and the surrounding streets. */
var sheetY = 0;          /* current translateY, px */
var detents = [0];       /* stops, ascending: 0 is fully open */
var mapOffset = 0;       /* px already panned to compensate for the sheet */

function sheetEl() { return $('sheet'); }
function peekLimit() { return detents[detents.length - 1]; }

function measureDetents() {
  var sheet = sheetEl();
  var verdict = document.querySelector('.verdict');
  var head = document.querySelector('.sheet-head');
  if (!sheet || !verdict || !head) return;
  var h = sheet.offsetHeight;
  /* Three stops, the way an iOS sheet does it:
       open    everything
       peek    down to the end of the verdict -- the answer, still readable
       minimal just the handle and the street name, so the map is effectively full
     Minimal is the point of dragging down at all: it uncovers the whole block
     and the streets around it. */
  var peek = Math.max(0, h - (verdict.offsetTop + verdict.offsetHeight + 12));
  var minimal = Math.max(0, h - (head.offsetTop + head.offsetHeight + 14));
  detents = [0, peek, minimal].filter(function (v, i, a) {
    return i === 0 || v - a[i - 1] > 24;      /* drop stops too close to be distinct */
  });
}

function setSheetY(y, animate) {
  var sheet = sheetEl();
  sheetY = Math.max(0, Math.min(peekLimit(), y));
  sheet.classList.toggle('snapping', !!animate);
  sheet.style.setProperty('--y', sheetY + 'px');
  var open = sheetY < 1;
  $('handle').setAttribute('aria-expanded', String(open));
  $('handle').setAttribute('aria-label',
    open ? 'Collapse details to see the map' : 'Expand details');
  syncMapToSheet();
}

/* Does the map have a transform that can be panned? Not "is the style loaded":
   painting the block calls setData first, which puts the geojson sources back
   into a loading state, so isStyleLoaded() is false for the rest of the load
   handler -- and gating on it silently skipped the pan, leaving the block
   centred in the full-bleed map and therefore hidden behind the sheet. What
   panBy actually needs is a sized canvas and a finite centre. */
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

/* Keep the block centred in whatever map area the sheet is not covering. */
function syncMapToSheet() {
  if (!mapReady()) return;
  var want = (sheetEl().offsetHeight - sheetY) / 2;
  var delta = want - mapOffset;
  if (Math.abs(delta) < 1) return;
  try {
    map.panBy([0, delta], { duration: 0 });
    mapOffset = want;
  } catch (err) {
    /* Transform not ready yet; the load handler will re-apply. */
  }
}

function snap(velocity) {
  var i = nearestDetent(sheetY);
  /* A deliberate flick carries to the next stop even if the finger barely moved,
     which is how these are expected to feel. */
  if (velocity > 0.5) i = Math.min(detents.length - 1, i + 1);
  else if (velocity < -0.5) i = Math.max(0, i - 1);
  setSheetY(detents[i], true);
}

function nearestDetent(y) {
  var best = 0;
  for (var i = 1; i < detents.length; i++) {
    if (Math.abs(detents[i] - y) < Math.abs(detents[best] - y)) best = i;
  }
  return best;
}

/* Tap and keyboard cycle open -> peek -> minimal -> open. */
function cycleDetent() {
  measureDetents();
  var next = (nearestDetent(sheetY) + 1) % detents.length;
  setSheetY(detents[next], true);
}

function initSheetDrag() {
  var handle = $('handle');
  var startY = 0, startSheetY = 0, lastY = 0, lastT = 0, velocity = 0, dragging = false;

  handle.addEventListener('pointerdown', function (e) {
    measureDetents();
    dragging = true;
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    startSheetY = sheetY;
    velocity = 0;
    sheetEl().classList.remove('snapping');
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    e.preventDefault();
    var dt = e.timeStamp - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = e.timeStamp;
    setSheetY(startSheetY + (e.clientY - startY), false);
  });

  function end(e) {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch (err) {}
    /* A tap (barely moved) toggles, which is what people try before dragging. */
    if (Math.abs(lastY - startY) < 4) {
      cycleDetent();
    } else {
      snap(velocity);
    }
  }
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  handle.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      cycleDetent();
    }
  });

  function relayout() {
    var i = nearestDetent(sheetY);
    measureDetents();
    setSheetY(detents[Math.min(i, detents.length - 1)], false);
    /* A map built while the page had no size keeps a zero-sized canvas and
       never draws -- which happens when the PWA is launched into the background
       or the tab is restored. Re-measuring it is what brings it back. */
    if (map) {
      map.resize();
      syncMapToSheet();
    }
  }
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', relayout);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') relayout();
  });
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
  var names = ['north', 'north-east', 'east', 'south-east',
               'south', 'south-west', 'west', 'north-west'];
  hint.textContent = 'You are facing ' + names[Math.round(deg / 45) % 8] +
    (side && side.f ? ' · your side faces ' + FACING[side.f] : '');
}

function startCompass() {
  var go = function () {
    window.addEventListener('deviceorientationabsolute', onHeading, true);
    window.addEventListener('deviceorientation', onHeading, true);
    compassOn = true;
    $('compass').hidden = false;
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

function sideLabel(side, index) {
  /* The house number is the reliable check -- you read it off the nearest door.
     The compass is the parenthetical, for when no number is in sight. */
  var facing = side.f ? ' (' + FACING[side.f] + ')' : '';
  if (side.d === 'odd')  return 'Odd' + (side.a ? ' · ' + side.a : '') + facing;
  if (side.d === 'even') return 'Even' + (side.a ? ' · ' + side.a : '') + facing;
  if (side.d === 'both') return 'This block' + facing;
  return 'Side ' + (index === 0 ? 'A' : 'B') + facing;
}

function renderSidePicker() {
  var wrap = $('sidepick');
  wrap.innerHTML = '';
  if (current.s.length < 2) return;
  current.s.forEach(function (side, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === chosen));
    b.innerHTML = '<span class="swatch" style="background:' + SIDE_COLOR[i] + '"></span>' +
                  sideLabel(side, i);
    b.onclick = function () {
      chosen = i;
      renderSidePicker();
      renderVerdict();
      paintSides();
      measureDetents();          /* the caveat can appear and change the height */
    };
    wrap.appendChild(b);
  });
}

function renderVerdict() {
  var side = current.s[chosen];
  var now = new Date();
  var r = evaluate(side, now);
  var head = $('headline'), detail = $('detail'), caveat = $('caveat');

  if (r.state === 'active') {
    head.textContent = 'Move now';
    head.dataset.tone = 'now';
    detail.textContent = 'Sweeping until ' + fmtTime(r.end) + ' today.';
  } else if (r.state === 'today') {
    var hrs = Math.floor(r.minsAway / 60), mins = r.minsAway % 60;
    head.textContent = hrs >= 1 ? 'Move within ' + hrs + 'h ' + mins + 'm'
                                : 'Move within ' + mins + ' min';
    head.dataset.tone = r.minsAway <= 120 ? 'now' : 'soon';
    detail.textContent = 'Sweeping today, ' + fmtTime(side.t[0]) + '–' + fmtTime(side.t[1]) + '.';
  } else if (r.state === 'holiday') {
    head.textContent = "You're fine — city holiday";
    head.dataset.tone = 'ok';
    detail.textContent = 'No sweeping today. Next sweep ' +
      (r.next ? fmtDate(r.next, now) : 'not scheduled') +
      (side.t && r.next ? ', ' + fmtTime(side.t[0]) + '–' + fmtTime(side.t[1]) : '') + '.';
  } else if (r.state === 'today_no_time') {
    head.textContent = 'Sweeps today';
    head.dataset.tone = 'soon';
    detail.textContent = 'The city lists a sweep day but no time for this block.';
  } else if (r.next) {
    var soon = (r.next - now) < 36e5 * 18;
    if (!side.t) {
      /* No time window on this side, so "move by tonight" would be asserting a
         deadline the city never published. Name the day and stop there. */
      head.textContent = 'Sweeps ' + fmtDate(r.next, now);
      head.dataset.tone = soon ? 'soon' : 'muted';
      detail.textContent = 'No sweep time is listed for this side.';
    } else {
      head.textContent = soon ? 'Move by tonight' : "You're fine";
      head.dataset.tone = soon ? 'soon' : 'ok';
      detail.textContent = 'Next sweep ' + fmtDate(r.next, now) +
                           ', ' + fmtTime(side.t[0]) + '–' + fmtTime(side.t[1]) + '.';
    }
  } else {
    head.textContent = 'No sweeping listed';
    head.dataset.tone = 'muted';
    detail.textContent = describe(side);
  }

  /* Say what we do not know, rather than papering over it. */
  var notes = {
    no_time:    'The city lists a sweep day for this block but no time window, so ' +
                'we cannot tell you when to move. Check the sign.',
    no_signage: 'The city records no posted signage on this block. Treat the sign ' +
                'you see as the only authority.',
    flagged:    'The city flagged this block for re-checking in its own data. ' +
                'Lower confidence than usual.',
    unknown:    'We could not read a schedule for this block. Go by the sign.'
  };
  var note = notes[side.c];
  if (r.state === 'holiday' && holidays && holidays.rule === 'no_sweep_unknown_makeup') {
    note = 'Oakland publishes this as a no-sweeping holiday but does not say ' +
           'whether the missed sweep is made up later. Check the sign.';
  }
  caveat.hidden = !note;
  if (note) caveat.textContent = note;

  $('remind').hidden = !icsRule(side);
  $('showcompass').hidden = compassOn || !side.f;
  $('compass').hidden = !compassOn;
  $('street').textContent = current.n || 'This block';
  $('addr').textContent = describe(side);
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
      setStatus(null);
      $('vintage').textContent = city.vintage + ' Schedules can change without the data changing.';
      showMap(lon, lat);
      $('sheet').hidden = false;
      renderSidePicker();
      renderVerdict();
      measureDetents();
      setSheetY(0, false);
    })
    .catch(function () { setStatus('Could not load sweeping data.', 'error'); });
}

function showMap(lon, lat) {
  /* Centre on the midpoint between the fix and the matched block rather than on
     the fix alone, so the block sits in the visible strip above the sheet
     instead of running off the bottom edge. Set at construction time: changing
     the view from inside the load handler left the map stuck with
     loaded() === false and only the background painted.

     Zoom is fixed and tight because the whole job of this map is telling apart
     two lines about 8 m apart. Zoom out and the offset that distinguishes them
     collapses; a computed fit-the-block zoom fought that and lost. */
  var g = current.g;
  var mid = g[Math.floor(g.length / 2)];
  map = new maplibregl.Map({
    container: 'map',
    style: baseStyle(),
    center: [(mid[0] + lon) / 2, (mid[1] + lat) / 2],
    zoom: 17.8,
    attributionControl: false
  });
  map.on('load', function () {
    paintContext(lon, lat);
    paintSides();
    new maplibregl.Marker({ color: '#007aff' }).setLngLat([lon, lat]).addTo(map);
    /* The map is full-bleed and the sheet floats over its lower half, so the
       block needs lifting clear of it. syncMapToSheet owns that offset and
       re-applies it whenever the sheet is dragged -- doing it here as well
       double-counted and pushed the block off screen. */
    mapOffset = 0;
    syncMapToSheet();
  });
}

initSheetDrag();
$('remind').onclick = downloadIcs;
$('showcompass').onclick = startCompass;

$('report').onclick = function () {
  var side = current ? current.s[chosen] : null;
  var body = encodeURIComponent(
    'Block: ' + (current ? current.n : '?') + '\n' +
    'Segment: ' + (current ? current.i : '?') + '\n' +
    'Side shown: ' + (side ? sideLabel(side, chosen) : '?') + '\n' +
    'App said: ' + $('headline').textContent + ' — ' + $('detail').textContent + '\n\n' +
    'The posted sign says: ');
  window.location.href = 'mailto:?subject=' +
    encodeURIComponent('Street sweeping mismatch') + '&body=' + body;
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function () {});
}

locate();
