/* Street sweeping checker — Berkeley & Oakland.
   No backend: the data is baked into data/*.json by the ETL. */
'use strict';

/* `vintage` is when the CITY last changed its data, not when we last fetched it.
   Oakland's layer reports dataLastEditDate = 2021-06-21 and Berkeley's schedule
   PDFs are dated 2022-03, so both are years old. Saying so is more honest than a
   "last updated today" that only reflects our own build. */
/* Coverage is data, not code: data/cities.json is emitted by the ETL, so adding
   a city never touches the app. */
var CITIES = [];

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

/* Street names and address ranges come from city data. They are not attacker
   controlled today, but they are third-party strings rendered with innerHTML,
   and a stray "<" in a future city's data should show as a "<". */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

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
/* --------------------------------------------------------- parked session */
/* Placing the car is the save. There is no "save my spot" button, because the
   tap that answers "which kerb" already carries everything worth storing: where
   the car is, which side, when it landed, and what the deadline is.

   Everything lives in localStorage. No backend, so no account, nothing to leak,
   and it still answers with no signal. */
var SESSION_KEY = 'parked.session';
var session = null;
var tick = null;

function loadSession() {
  try {
    var raw = localStorage.getItem(SESSION_KEY);
    session = raw ? JSON.parse(raw) : null;
  } catch (e) { session = null; }
  /* A car parked more than four days ago is almost certainly not still there. */
  if (session && Date.now() - session.at > 1000 * 60 * 60 * 96) session = null;
  return session;
}

function saveSession(patch) {
  session = Object.assign(loadSession() || {}, patch);
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) {}
  return session;
}

function clearSession() {
  session = null;
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}

/* The moment the car has to move: the sooner of the next sweep and any manual
   limit the driver set for a meter or a permit zone. */
function deadlineFor(side, now) {
  var out = null;
  var r = evaluate(side, now);
  if (r.state === 'active') {
    out = { at: atTime(now, side.t[1]), why: 'sweeping now' };
  } else if (r.state === 'today') {
    out = { at: atTime(now, side.t[0]), why: 'sweeping starts' };
  } else if (r.next && side.t) {
    out = { at: atTime(r.next, side.t[0]), why: 'sweeping starts' };
  }
  var s = loadSession();
  if (s && s.limitUntil && s.segId === (current && current.i)) {
    var lim = new Date(s.limitUntil);
    if (!out || lim < out.at) out = { at: lim, why: s.limitLabel || 'time limit' };
  }
  return out;
}

function atTime(dateLike, hhmm) {
  var d = new Date(dateLike);
  var p = (hhmm || '00:00').split(':');
  d.setHours(+p[0], +p[1], 0, 0);
  return d;
}

function countdownText(ms) {
  if (ms <= 0) return 'now';
  var mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + ' min';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm';
  var days = Math.floor(hrs / 24);
  return days + 'd ' + (hrs % 24) + 'h';
}

/* --- manual limit (meter, permit zone, ParkMobile session) ------------------ */
function setLimit(minutes, label) {
  saveSession({
    segId: current ? current.i : null,
    limitUntil: Date.now() + minutes * 60000,
    limitLabel: label || (minutes >= 60 ? (minutes / 60) + 'h limit' : minutes + ' min')
  });
  renderVerdict();
  renderLimitRow();
}

function clearLimit() {
  saveSession({ limitUntil: null, limitLabel: null });
  renderVerdict();
  renderLimitRow();
}

function startTicking() {
  if (tick) clearInterval(tick);
  tick = setInterval(function () {
    if (current && placed) renderVerdict();
  }, 30000);
}

/* ------------------------------------------------------------- better fixes */
/* Apple Maps knows the side because it has the whole drive -- hundreds of fixes
   fused with the accelerometer and gyro, map-matched to the road. One
   getCurrentPosition call, made after you have parked and got out, has none of
   that.

   What is available to a web app is time. A stationary phone's fix converges
   over a few seconds as more satellites lock, so instead of taking the first
   fix, watch for a short while and keep the best one -- then average the fixes
   that are nearly as good, which cancels some of the random error. In practice
   this turns a 20 m first fix into a 5-8 m one, which is the difference between
   being able to call the side and not. */
var FIX_WINDOW_MS = 6000;
var FIX_GOOD_ENOUGH = 6;      /* metres; stop early once this good */

function getBestFix(onFix, onFail) {
  if (!navigator.geolocation) { onFail({ code: 2 }); return; }
  var fixes = [];
  var done = false;
  var watch = null;

  function finish() {
    if (done) return;
    done = true;
    if (watch !== null) navigator.geolocation.clearWatch(watch);
    if (!fixes.length) { onFail({ code: 3 }); return; }

    fixes.sort(function (a, b) { return a.coords.accuracy - b.coords.accuracy; });
    var best = fixes[0];
    /* Average the fixes within 1.5x of the best. Averaging everything would let
       a wild 100 m outlier drag the answer. */
    var keep = fixes.filter(function (f) {
      return f.coords.accuracy <= best.coords.accuracy * 1.5;
    });
    var lon = 0, lat = 0;
    keep.forEach(function (f) { lon += f.coords.longitude; lat += f.coords.latitude; });

    /* Heading is taken from the newest fix that was actually moving, not from
       the average -- it describes a moment, not a place. */
    var moving = null;
    fixes.forEach(function (f) {
      if (typeof f.coords.speed === 'number' && f.coords.speed > 0.5 &&
          typeof f.coords.heading === 'number' && !isNaN(f.coords.heading)) {
        if (!moving || f.timestamp > moving.timestamp) moving = f;
      }
    });

    onFix({
      lon: lon / keep.length,
      lat: lat / keep.length,
      /* Averaging n independent fixes shrinks the error, but GPS error is partly
         a shared bias that averaging cannot remove -- so claim only part of the
         theoretical gain rather than dividing by sqrt(n). */
      accuracy: best.coords.accuracy / Math.sqrt(Math.min(keep.length, 4)),
      rawAccuracy: best.coords.accuracy,
      samples: fixes.length,
      heading: moving ? moving.coords.heading : null,
      speed: moving ? moving.coords.speed : 0
    });
  }

  watch = navigator.geolocation.watchPosition(function (pos) {
    fixes.push(pos);
    setStatus('Finding your spot… ±' + Math.round(pos.coords.accuracy) + ' m');
    if (pos.coords.accuracy <= FIX_GOOD_ENOUGH) finish();
  }, function (err) {
    if (!fixes.length) { done = true; onFail(err); }
  }, { enableHighAccuracy: true, timeout: FIX_WINDOW_MS, maximumAge: 0 });

  setTimeout(finish, FIX_WINDOW_MS);
}

/* ------------------------------------------------------- which side, guessed */
/* Two independent signals, neither trusted alone.

   1. Perpendicular offset. Project the fix onto the centreline and take the
      signed cross product: that says which hand of the line the car is on. The
      catch is scale -- the kerb sits ~4-5 m from the centreline and a phone fix
      is 3-30 m, so this is only worth anything when the phone reports good
      accuracy AND the offset clears it. coords.accuracy is what makes this
      honest: the phone tells us when not to trust it.

   2. Heading. In the US you park with the flow of traffic, so the kerb is on
      your right. Heading is good to ~15 degrees and the two sides are 180 apart,
      so the margin is enormous and GPS precision is irrelevant. This is the
      stronger signal by far -- when the two disagree, this one is usually right.

   Neither is ever allowed to assert. A guess pre-positions the car and says so;
   confirming it is a tap, and so is overriding it. */

function segmentBearingNear(lon, lat) {
  var g = current.g, mx = MX_AT(lat);
  var best = null, bestD = Infinity;
  for (var i = 0; i < g.length - 1; i++) {
    var d = distToSegment([lon, lat], g[i], g[i + 1], mx);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best === null) return null;
  var a = g[best], b = g[best + 1];
  var dx = (b[0] - a[0]) * mx, dy = (b[1] - a[1]) * MY;
  return {
    bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360,
    a: a, b: b, dist: bestD
  };
}

/* Signed perpendicular offset in metres: positive = left of the direction of
   digitisation, negative = right. */
function signedOffset(lon, lat, seg) {
  var mx = MX_AT(lat);
  var ax = seg.a[0] * mx, ay = seg.a[1] * MY;
  var bx = seg.b[0] * mx, by = seg.b[1] * MY;
  var px = lon * mx, py = lat * MY;
  var dx = bx - ax, dy = by - ay;
  var len = Math.hypot(dx, dy);
  if (!len) return 0;
  return ((px - ax) * dy - (py - ay) * dx) / len * -1;
}

function cardinalOf(deg) {
  deg = (deg % 360 + 360) % 360;
  if (deg < 45 || deg >= 315) return 'N';
  if (deg < 135) return 'E';
  if (deg < 225) return 'S';
  return 'W';
}

/* Which of the two sides sits on a given hand of the line. */
function sideOnHand(hand, bearing) {
  var want = cardinalOf(hand === 'left' ? bearing - 90 : bearing + 90);
  for (var i = 0; i < current.s.length; i++) {
    if (current.s[i].f === want) return i;
  }
  return -1;
}

function inferSide(fix) {
  if (!current || current.s.length < 2) return null;
  var seg = segmentBearingNear(fix.lon, fix.lat);
  if (!seg) return null;

  var votes = [];

  /* --- offset vote --- */
  var acc = fix.accuracy;
  var off = signedOffset(fix.lon, fix.lat, seg);
  if (typeof acc === 'number' && acc > 0 && Math.abs(off) > acc && Math.abs(off) < 25) {
    var idx = sideOnHand(off > 0 ? 'left' : 'right', seg.bearing);
    if (idx >= 0) {
      votes.push({
        index: idx,
        weight: Math.min(1, Math.abs(off) / (acc * 2)),
        why: 'you are ' + Math.round(Math.abs(off)) + ' m off the centreline'
      });
    }
  }

  /* --- heading vote --- */
  /* Only when the fix was actually moving: a heading from a stationary phone is
     noise, and coords.heading is null when speed is 0 on most devices. */
  if (typeof fix.heading === 'number' && !isNaN(fix.heading) &&
      typeof fix.speed === 'number' && fix.speed > 0.5) {
    var kerbIdx = sideOnHand('right', fix.heading);
    /* On a one-way street you may legally park either side, so the
       park-with-traffic rule stops holding. */
    var oneWay = current.y;
    if (kerbIdx >= 0 && !oneWay) {
      votes.push({
        index: kerbIdx,
        weight: 0.9,
        why: 'you were heading ' + FACING[cardinalOf(fix.heading)] + ' as you parked'
      });
    }
  }

  if (!votes.length) return null;

  var tally = {};
  votes.forEach(function (v) { tally[v.index] = (tally[v.index] || 0) + v.weight; });
  var bestIdx = null, bestScore = 0, total = 0;
  Object.keys(tally).forEach(function (k) {
    total += tally[k];
    if (tally[k] > bestScore) { bestScore = tally[k]; bestIdx = +k; }
  });
  /* Signals that contradict each other cancel: say nothing rather than pick. */
  var agreement = total ? bestScore / total : 0;
  if (agreement < 0.75) return null;

  return {
    index: bestIdx,
    confidence: Math.min(0.95, bestScore),
    why: votes.filter(function (v) { return v.index === bestIdx; })
              .map(function (v) { return v.why; })[0]
  };
}

/* --------------------------------------------------------- back to the car */
/* The car's location was saved the moment it was placed, so "where did I park"
   costs nothing extra. Shown only when you are far enough away for the question
   to be real. */
function metresBetween(a, b) {
  var mx = MX_AT((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * mx, (b[1] - a[1]) * MY);
}

function renderRecall() {
  var el = $('recall');
  var s = loadSession();
  if (!el) return;
  if (!s || !s.lat || !lastFix) { el.hidden = true; return; }
  var away = metresBetween(lastFix, [s.lon, s.lat]);
  if (away < 180) { el.hidden = true; return; }

  var mins = Math.max(1, Math.round(away / 80));   /* ~4.8 km/h walking */
  el.hidden = false;
  el.innerHTML = '';
  var text = document.createElement('span');
  text.textContent = 'Your car is on ' + (s.street || 'a saved block') +
    ' · ' + (away > 1200 ? (away / 1000).toFixed(1) + ' km' : Math.round(away) + ' m') +
    ' · ' + mins + ' min walk';
  var go = document.createElement('button');
  go.type = 'button';
  go.className = 'chip chip--on';
  go.textContent = 'Walk back';
  go.onclick = function () {
    /* Hand off to whichever maps app the phone prefers. */
    window.location.href = 'https://maps.apple.com/?daddr=' + s.lat + ',' + s.lon +
                           '&dirflg=w';
  };
  el.appendChild(text);
  el.appendChild(go);
}

/* ------------------------------------------------------------------ stage */
/* An overhead view of the block with your car on it. GPS puts the car on the
   street -- that much it can do. Which kerb it sits on is still a tap, because
   the two kerbs are 8-10 m apart and a phone fix is 3-30 m, and guessing that is
   what once sent someone to the wrong side. Here the guess is not even
   available: the car waits in the middle of the road until you place it. */
var placed = false;
var suggestion = null;      /* an inferred side, never an assumed one */
var rememberedSide = null;  /* where this block was answered before */
var lastFixDetail = null;
var shortcutHint = null;    /* heading/accuracy handed in by an iOS Shortcut */

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
    kerb.setAttribute('data-active', String((placed || suggestion) && chosen === i));

    var label = $(i === 0 ? 'labelA' : 'labelB');
    label.hidden = false;
    label.setAttribute('data-tone', v.tone);
    label.setAttribute('aria-pressed', String((placed || suggestion) && chosen === i));
    var who = side.d === 'odd' ? 'Odd' : side.d === 'even' ? 'Even'
            : side.d === 'both' ? 'This block' : 'Side ' + (i === 0 ? 'A' : 'B');
    var meta = [];
    if (side.a) meta.push(side.a);
    if (side.f) meta.push(FACING[side.f]);
    label.innerHTML =
      '<span class="kl-side">' + esc(who) + '</span>' +
      (meta.length ? '<span class="kl-meta">' + esc(meta.join(' · ')) + '</span>' : '') +
      '<span class="kl-state">' + esc(v.headline) + '</span>';
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
  var onKerb = placed || suggestion;
  var x = onKerb ? KERB_X[Math.min(chosen, 1)] : 180;
  car.style.transform = 'translate(' + x + 'px, 250px)';
  /* Unconfirmed reads as unconfirmed: hollow and breathing, not solid. */
  car.classList.toggle('car--placing', !onKerb);
  car.classList.toggle('car--guess', !placed && !!suggestion);
}

function placeCar(i) {
  chosen = i;
  placed = true;
  suggestion = null;
  try { localStorage.setItem('side:' + current.i, String(i)); } catch (e) {}
  /* The tap is the save. */
  saveSession({
    segId: current.i, side: i, at: Date.now(),
    lon: lastFix && lastFix[0], lat: lastFix && lastFix[1],
    street: current.n, city: cityId
  });
  renderStage();
  paintSides();
  startTicking();
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
  if (!placed && !suggestion) {
    v.hidden = true;
    $('limits').hidden = true;
    $('confirm').hidden = true;
    $('prompt').textContent = current.s.length > 1
      ? 'Tap the kerb your car is on. Check the nearest house number.'
      : 'One kerb on this block.';
    $('remind').hidden = true;
    return;
  }

  var side = current.s[chosen];
  var now = new Date();
  var r = verdictFor(side, now);
  var dl = deadlineFor(side, now);
  v.hidden = false;
  renderConfirm();

  $('prompt').textContent = (side.d === 'odd' || side.d === 'even'
      ? side.d.charAt(0).toUpperCase() + side.d.slice(1) + ' side'
      : 'This kerb') +
    (side.a ? ' · ' + side.a : '') + (side.f ? ' · faces ' + FACING[side.f] : '');

  /* Inside a day, a running countdown beats a date -- it is the number you act
     on. Beyond that a countdown in days is just a date with extra steps. */
  var left = dl ? dl.at - now : null;
  if (left !== null && left > 0 && left < 1000 * 60 * 60 * 24) {
    $('headline').textContent = 'Move in ' + countdownText(left);
    $('headline').dataset.tone = left < 1000 * 60 * 60 * 2 ? 'now' : 'soon';
    $('sub').textContent = 'Until ' + fmtClock(dl.at) + ' — ' + dl.why + '. ' +
                           describe(side) + '.';
  } else {
    $('headline').textContent = r.headline;
    $('headline').dataset.tone = r.tone;
    $('sub').textContent = r.detail + ' ' + describe(side) + '.';
  }

  var note = NOTES[side.c];
  $('note').hidden = !note;
  if (note) $('note').textContent = note;
  $('remind').hidden = !icsRule(side);
  $('showcompass').hidden = compassOn || !current.s.some(function (x) { return x.f; });
  renderLimitRow();
}


/* The guess, stated out loud. It sits above the verdict rather than beside it,
   because the whole answer below is conditional on it being right -- and last
   time a quietly assumed side put someone on the wrong kerb. */
function renderConfirm() {
  var bar = $('confirm');
  if (placed || !suggestion) { bar.hidden = true; return; }
  var side = current.s[chosen];
  var who = side.d === 'odd' ? 'odd' : side.d === 'even' ? 'even' : 'this';
  bar.hidden = false;
  bar.innerHTML = '';

  var q = document.createElement('p');
  q.className = 'confirm-q';
  q.textContent = 'Looks like the ' + who + ' side' +
    (side.f ? ' (' + FACING[side.f] + ')' : '') + ' — ' + suggestion.why + '.';
  bar.appendChild(q);

  var row = document.createElement('div');
  row.className = 'confirm-row';

  var yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'btn btn--primary';
  yes.textContent = "Yes, that's me";
  yes.onclick = function () { placeCar(chosen); };

  var no = document.createElement('button');
  no.type = 'button';
  no.className = 'btn';
  no.textContent = 'Other side';
  no.onclick = function () { placeCar(chosen === 0 ? 1 : 0); };

  row.appendChild(yes);
  row.appendChild(no);
  bar.appendChild(row);
}

function fmtClock(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* A meter, a permit zone, or a ParkMobile session is a second clock the city
   data knows nothing about. One tap sets it; whichever deadline lands first is
   the one the headline counts down to. */
function renderLimitRow() {
  var row = $('limits');
  var s = loadSession();
  var active = s && s.limitUntil && s.segId === current.i && s.limitUntil > Date.now();
  row.hidden = !placed;
  row.innerHTML = '';

  if (active) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip chip--on';
    chip.innerHTML = esc(s.limitLabel) + ' · ' +
      esc(countdownText(s.limitUntil - Date.now())) + ' left <span class="x">✕</span>';
    chip.onclick = clearLimit;
    row.appendChild(chip);
    return;
  }

  [[60, '1h'], [120, '2h'], [240, '4h']].forEach(function (opt) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = opt[1];
    b.onclick = function () { setLimit(opt[0], opt[1] + ' limit'); };
    row.appendChild(b);
  });
  var label = document.createElement('span');
  label.className = 'chip-label';
  label.textContent = 'meter / permit limit';
  row.appendChild(label);
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

function coverageNames() {
  return CITIES.map(function (c) { return c.name; }).join(' and ');
}

function locate() {
  /* An NFC sticker on the car opens this URL. ?nfc=1 means "I just parked":
     stamp the time and go straight to locating, no taps. */
  var params = new URLSearchParams(location.search);
  if (params.get('nfc') === '1') stampParked();
  setStatus('Finding your spot…');
  /* ?at=lon,lat overrides GPS — for testing a block you are not standing on. */
  var params0 = new URLSearchParams(location.search);
  /* An iOS Shortcut triggered by the NFC tag can read the compass and pass it
     in, which is strictly better than anything Safari exposes to the page. */
  shortcutHint = {
    heading: parseFloat(params0.get('h')),
    accuracy: parseFloat(params0.get('acc'))
  };
  var at = params0.get('at');
  if (at) {
    var p = at.split(',').map(Number);
    if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) {
      /* Same shape the real sampler produces, so the override exercises the
         inference path rather than skipping past it. */
      var acc = parseFloat(params0.get('acc'));
      var hd = parseFloat(params0.get('h'));
      var fix = {
        lon: p[0], lat: p[1],
        accuracy: isNaN(acc) ? 5 : acc,
        heading: isNaN(hd) ? null : hd,
        speed: isNaN(hd) ? 0 : 1,
        samples: 1
      };
      onPosition({ coords: {
        longitude: fix.lon, latitude: fix.lat, accuracy: fix.accuracy,
        heading: fix.heading, speed: fix.speed
      }, _fix: fix });
      return;
    }
  }
  if (!navigator.geolocation) {
    setStatus('This browser has no location access.', 'error');
    return;
  }
  getBestFix(function (fix) {
    onPosition({ coords: {
      longitude: fix.lon, latitude: fix.lat, accuracy: fix.accuracy,
      heading: fix.heading, speed: fix.speed
    }, _fix: fix });
  }, onGeoError);
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
  if (shortcutHint && !isNaN(shortcutHint.heading) && pos._fix) {
    /* A Shortcut's compass reading beats a stationary browser heading, which is
       null on iOS anyway. Treat it as moving so the park-with-traffic rule
       applies. */
    pos._fix.heading = shortcutHint.heading;
    pos._fix.speed = 1;
    pos._fix.headingFromShortcut = true;
  }
  lastFixDetail = pos._fix || {
    lon: lon, lat: lat,
    accuracy: pos.coords.accuracy,
    heading: pos.coords.heading,
    speed: pos.coords.speed
  };
  var city = cityFor(lon, lat);
  if (!city) {
    setStatus('No data for where you are. Covered so far: ' + coverageNames() + '.',
              'error');
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
      suggestion = null;
      rememberedSide = null;
      /* A remembered side is history, not evidence. Parking on the other side
         next time is completely normal, so restoring it as confirmed would
         quietly assert a stale answer -- the same shape as the bug that put
         someone on the wrong kerb. It comes back only as a suggestion.

         The exception is a live session: same block, placed within the last few
         hours, which is the same car still sitting where it was put. */
      var live = loadSession();
      if (live && live.segId === current.i && current.s[live.side] &&
          Date.now() - live.at < 1000 * 60 * 60 * 12) {
        chosen = live.side;
        placed = true;
      } else {
        try {
          var saved = localStorage.getItem('side:' + current.i);
          if (saved !== null && current.s[+saved]) {
            rememberedSide = +saved;
          }
        } catch (e) {}
      }
      setStatus(null);
      $('status').hidden = true;
      $('detail').hidden = false;
      $('vintage').textContent = city.vintage + ' Schedules can change without the data changing.';
      /* Guess the side, but only ever as a question. */
      if (!placed && lastFixDetail) {
        suggestion = inferSide(lastFixDetail);
      }
      if (!placed && !suggestion && rememberedSide !== null) {
        suggestion = {
          index: rememberedSide,
          confidence: 0.5,
          why: 'you parked on this side here last time'
        };
      }
      if (suggestion) chosen = suggestion.index;
      renderStage();
      showParkedStamp();
      renderRecall();
      startTicking();
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

/* Manifest first: it decides which cities exist and which file to pull. */
fetch('data/cities.json')
  .then(function (r) { return r.json(); })
  .then(function (m) { CITIES = m.cities || []; })
  .catch(function () { CITIES = []; })
  .then(function () {
    if (!CITIES.length) {
      setStatus('Could not load coverage data.', 'error');
      return;
    }
    locate();
  });
