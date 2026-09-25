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
var holidays = null;      /* the matched city's rule + dates */
var holidaysAll = null;
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

/* The holiday tables are hand-maintained from the cities' own pages and stop at
   a fixed date. Past that they silently stop suppressing sweeps, which looks
   exactly like a city that stopped taking holidays -- so say it out loud. */
function holidayCoverageEndsSoon() {
  if (!holidays || !holidays.dates || !holidays.dates.length) return false;
  var last = holidays.dates[holidays.dates.length - 1];
  var lastDate = new Date(last + 'T12:00:00');
  return (lastDate - new Date()) < 1000 * 60 * 60 * 24 * 60;
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
  liveHeading = deg;
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

var liveHeading = null;

/* Point the phone the way the car faces, and the side follows.

   This is the one signal a web page can get that does not depend on GPS
   precision: the compass is good to about ten degrees and the two kerbs are 180
   apart. It needs a deliberate gesture, which is the point -- it is the driver
   telling the app which way the car is pointing, not the app guessing.

   Two caveats are real and are said out loud in the UI: the reading is the
   phone's heading, not the car's, and a phone held inside a steel car picks up
   the chassis's own magnetic field. Aiming from outside the car avoids both. */
function useAimedHeading() {
  if (liveHeading === null) {
    setStatus('No compass reading yet — hold the phone flat.', 'error');
    return;
  }
  if (!lastFixDetail) return;
  var guess = inferSide({
    lon: lastFixDetail.lon,
    lat: lastFixDetail.lat,
    accuracy: lastFixDetail.accuracy,
    heading: liveHeading,
    speed: 0,
    headingFromShortcut: true,     /* a deliberate aim, same standing as one */
    aimed: true
  });
  if (!guess) {
    setStatus('That heading does not line up with this street — check the sign.',
              'error');
    return;
  }
  suggestion = guess;
  chosen = guess.index;
  placed = false;
  setStatus(null);
  $('status').hidden = true;
  renderStage();
}

function startCompass() {
  var go = function () {
    window.addEventListener('deviceorientationabsolute', onHeading, true);
    window.addEventListener('deviceorientation', onHeading, true);
    compassOn = true;
    $('compassRose').hidden = false;
    $('facing').hidden = false;
    $('showcompass').hidden = true;
    $('aim').hidden = false;
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

/* ------------------------------------------------------------- native timer */
/* iOS Clock has no public URL scheme -- no web page can start a native timer
   directly. Shortcuts is the only route that reaches the real Clock app, and it
   needs a one-time setup: a shortcut named "Park Timer" whose input is a number
   of minutes and whose action is Start Timer.

   The in-app countdown works with no setup at all and is what the headline
   shows; this is for when the phone is in a pocket. */
/* Apple ships a "Set Timer" shortcut in the Clock section of the Shortcuts
   gallery -- adding it is one tap, so that is the default name. Anyone whose
   copy is named differently can change it; the name is all the URL scheme has
   to go on. */
var TIMER_DEFAULT = 'Set Timer';

function timerShortcutName() {
  try { return localStorage.getItem('timerShortcut') || TIMER_DEFAULT; }
  catch (e) { return TIMER_DEFAULT; }
}

function minutesUntilDeadline() {
  if (!current || !placed) return null;
  var dl = deadlineFor(current.s[chosen], new Date());
  if (!dl || !dl.at) return null;
  var mins = Math.round((dl.at - new Date()) / 60000);
  return mins > 0 ? mins : null;
}

function startNativeTimer() {
  var mins = minutesUntilDeadline();
  if (!mins) { setStatus('Nothing to count down to yet.', 'error'); return; }
  /* Fire the shortcut with the minutes as input. If it is not installed iOS
     shows its own "shortcut not found" sheet, which is clearer than anything
     this page could say. */
  window.location.href = 'shortcuts://x-callback-url/run-shortcut' +
    '?name=' + encodeURIComponent(timerShortcutName()) +
    '&input=text&text=' + encodeURIComponent(String(mins));
}

function renameTimerShortcut() {
  var name = window.prompt(
    'Name of the Shortcut to run for timers.\n\n' +
    'Apple\u2019s built-in one is called "Set Timer" \u2014 add it from the ' +
    'Shortcuts gallery under Clock. The minutes remaining are passed to it as input.',
    timerShortcutName());
  if (name === null) return;
  try {
    localStorage.setItem('timerShortcut', name.trim() || TIMER_DEFAULT);
  } catch (e) {}
  renderTimerButton();
}

/* The Clock app is for hours, not weeks. Offering "Timer - 19d 8h" for a sweep
   three weeks out is noise; past a day the calendar export is the right tool. */
var TIMER_MAX_MINUTES = 12 * 60;

function renderTimerButton() {
  var b = $('timer');
  if (!b) return;
  var mins = minutesUntilDeadline();
  var worthIt = mins && mins <= TIMER_MAX_MINUTES;
  b.hidden = !worthIt;
  if (worthIt) b.textContent = 'Timer · ' + countdownText(mins * 60000);
  /* With no timer on offer the calendar export stops being the quiet fallback
     and becomes the only way to be reminded, so it moves up. */
  var cal = $('remind');
  if (cal) {
    cal.classList.toggle('btn--primary', !worthIt);
    cal.classList.toggle('btn--quiet', !!worthIt);   /* or it stays transparent */
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

function buildIcs(seg, side, deadline) {
  var rule = icsRule(side);
  var first = nextSweep(side, new Date());
  if (!rule || !first) return null;
  /* A manual meter or permit limit lands before the next sweep, and it is the
     one you actually have to act on, so it becomes its own one-off event with
     tighter alarms rather than being lost behind the recurring series. */
  var extra = '';
  if (deadline && deadline.at && deadline.at - new Date() > 0 &&
      deadline.why !== 'sweeping starts' && deadline.why !== 'sweeping now') {
    var d = deadline.at;
    var stampLocal = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
                     'T' + pad(d.getHours()) + pad(d.getMinutes()) + '00';
    extra = [
      'BEGIN:VEVENT',
      'UID:' + seg.i + '-limit-' + d.getTime() + '@street-sweeping',
      'DTSTAMP:' + stampLocal + 'Z',
      'DTSTART;TZID=America/Los_Angeles:' + stampLocal,
      'DURATION:PT15M',
      'SUMMARY:Move car — ' + (deadline.why || 'time limit') + ' on ' +
        (seg.n || 'this block'),
      'DESCRIPTION:Advisory only. Posted signs control.',
      'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY',
      'DESCRIPTION:15 minutes left on your parking', 'END:VALARM',
      'BEGIN:VALARM', 'TRIGGER:-PT2M', 'ACTION:DISPLAY',
      'DESCRIPTION:Move your car now', 'END:VALARM',
      'END:VEVENT', ''
    ].join('\r\n');
  }
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
  return lines.join('\r\n').replace('END:VCALENDAR', extra + 'END:VCALENDAR');
}

function downloadIcs() {
  var side = current.s[chosen];
  var text = buildIcs(current, side, deadlineFor(side, new Date()));
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
  /* k:'?' means the schedule could not be read; k:'x' means the city says this
     block is not swept. Rendering both as "No sweeping listed" turned 83 Oakland
     sides of unreadable data into a confident negative. */
  if (side.k === '?') {
    return { tone: 'muted', headline: 'Unknown — check the sign',
             detail: 'We could not read a schedule for this side.' };
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
  /* Drop it once it is past being useful.
     This is stored on a GitHub Pages origin shared with every other project
     under the same account, so any XSS in a sibling site could read it -- and
     what it holds is where the car is parked, which is usually near home. The
     real fix is a separate origin; until then, hold it for as long as it is
     actually needed and no longer. A sweep is at most a month out, but a car is
     rarely left more than a day, so 36 hours covers the useful life of a
     session and expires the sensitive part quickly. */
  if (session && Date.now() - session.at > 1000 * 60 * 60 * 36) {
    session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
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

/* Explicit control over the one piece of personal data here. */
function forgetSpot() {
  clearSession();
  try {
    localStorage.removeItem('parkedAt');
    if (current) localStorage.removeItem('side:' + current.i);
  } catch (e) {}
  placed = false;
  suggestion = null;
  rememberedSide = null;
  renderStage();
  renderRecall();
  showParkedStamp();
  setStatus('Forgotten.', null);
  $('status').hidden = false;
  setTimeout(function () { $('status').hidden = true; }, 2000);
}

function startTicking() {
  if (tick) clearInterval(tick);
  tick = setInterval(function () {
    if (current && placed) renderVerdict();
  }, 30000);
}

/* ------------------------------------------------------------------- tiles */
var TILE = 0.01;
var tileCache = {};

function tileName(lon, lat) {
  return Math.floor(lon / TILE) + '_' + Math.floor(lat / TILE);
}

function fetchTile(city, tx, ty) {
  var key = city.id + '/' + tx + '_' + ty;
  if (tileCache[key]) return tileCache[key];
  /* Skip cells the manifest says do not exist. Berkeley and Oakland overlap, so
     every Berkeley lookup was also firing nine Oakland requests into cells that
     were never generated -- correct behaviour, but a screenful of 404s and nine
     pointless round trips on a phone. */
  if (city.tiles && city.tiles.indexOf(tx + '_' + ty) === -1) {
    tileCache[key] = Promise.resolve([]);
    return tileCache[key];
  }
  tileCache[key] = fetch('data/tiles/' + city.id + '/' + tx + '_' + ty + '.json')
    .then(function (r) { return r.ok ? r.json() : { segments: [] }; })
    .then(function (d) { return d.segments || []; })
    .catch(function () { return []; });      /* a missing cell is empty, not fatal */
  return tileCache[key];
}

function loadTiles(city, lon, lat, withNeighbours) {
  var tx = Math.floor(lon / TILE), ty = Math.floor(lat / TILE);
  var want = [[tx, ty]];
  if (withNeighbours) {
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (dx || dy) want.push([tx + dx, ty + dy]);
      }
    }
  }
  return Promise.all(want.map(function (t) { return fetchTile(city, t[0], t[1]); }))
    .then(function (lists) {
      var seen = {}, out = [];
      lists.forEach(function (list) {
        list.forEach(function (seg) {
          if (!seen[seg.i]) { seen[seg.i] = 1; out.push(seg); }
        });
      });
      return out;
    });
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
      /* Report the best fix's own accuracy, unimproved.
         Averaging does not earn a better number here: the dominant urban error
         is multipath -- the phone ranging off a signal bounced from the
         buildings around it. That geometry is fixed while the car sits still, so
         the error is a standing bias, not zero-mean noise, and repetition cannot
         cancel it. Dividing by sqrt(n) claimed a precision that was not there,
         and since the side inference gates on this number, overstating it buys
         confident wrong answers. Waiting still helps -- the fix genuinely
         converges as more satellites lock -- so keep the window and keep the
         best sample, but do not invent accuracy from the count. */
      accuracy: best.coords.accuracy,
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
  /* 0.5 m/s caught walking (about 1.4 m/s), so parking, getting out and strolling
     down the block fed the pedestrian's heading in as "the direction you parked".
     Require a speed only a vehicle reaches. A heading handed in by a Shortcut is
     a compass reading taken at the car and is exempt. */
  var drove = fix.headingFromShortcut ||
              (typeof fix.speed === 'number' && fix.speed > 3.5);
  if (typeof fix.heading === 'number' && !isNaN(fix.heading) && drove) {
    var kerbIdx = sideOnHand('right', fix.heading);
    /* On a one-way street you may legally park either side, so the
       park-with-traffic rule stops holding. */
    var oneWay = current.y;
    if (kerbIdx >= 0 && !oneWay) {
      votes.push({
        index: kerbIdx,
        weight: 0.9,
        why: (fix.aimed
                ? 'the car is pointing '
                : 'you were heading ') + FACING[cardinalOf(fix.heading)] +
             (fix.aimed ? '' : ' as you parked')
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
  /* A single weak signal is not a guess worth showing -- with one vote the
     agreement test is trivially satisfied, so the strength has to carry it. */
  if (votes.length === 1 && bestScore < 0.7) return null;

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
    /* maps:// opens the Maps app directly on iOS. If nothing claims the scheme
       (a desktop browser, or Android) the page stays put, so fall back to the
       https form shortly after. */
    var q = '?daddr=' + s.lat + ',' + s.lon + '&dirflg=w';
    var fellBack = false;
    var t = setTimeout(function () {
      if (!fellBack) window.location.href = 'https://maps.apple.com/' + q;
    }, 700);
    window.addEventListener('pagehide', function () {
      fellBack = true;
      clearTimeout(t);
    }, { once: true });
    window.location.href = 'maps://' + q;
  };
  el.appendChild(text);
  el.appendChild(go);
}

/* ------------------------------------------------------------ permit zones */
/* Berkeley's RPP areas: a two-hour limit for anyone without a permit for that
   area, and the commonest citation after sweeping. The block carries its own
   rule, resolved at build time.

   This is a second clock the sweeping schedule knows nothing about, so it feeds
   the same deadline machinery rather than getting its own competing headline. */
function rppStatus(seg, now) {
  var r = seg && seg.r;
  if (!r) return null;
  var dow = now.getDay();
  var mins = now.getHours() * 60 + now.getMinutes();
  var enforcing = (r.w || []).indexOf(dow) !== -1 &&
                  mins >= minutes(r.s) && mins < minutes(r.e);
  return {
    area: r.a,
    limit: r.m,
    enforcing: enforcing,
    note: r.n || null,
    text: 'Permit area ' + r.a + ' · ' + (r.m / 60) + 'h limit without a permit, ' +
          weekdayRange(r.w) + ' ' + fmtTime(r.s) + '–' + fmtTime(r.e)
  };
}

function weekdayRange(w) {
  if (!w || !w.length) return '';
  var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var sorted = w.slice().sort(function (a, b) { return a - b; });
  var contiguous = sorted.every(function (d, i) {
    return i === 0 || d === sorted[i - 1] + 1;
  });
  return contiguous && sorted.length > 1
    ? names[sorted[0]] + '–' + names[sorted[sorted.length - 1]]
    : sorted.map(function (d) { return names[d]; }).join(', ');
}

function renderPermit() {
  var el = $('permit');
  if (!el) return;
  var st = current ? rppStatus(current, new Date()) : null;
  if (!st || !placed) { el.hidden = true; return; }

  el.hidden = false;
  el.innerHTML = '';
  el.setAttribute('data-on', String(st.enforcing));

  var line = document.createElement('span');
  line.textContent = st.text + (st.enforcing ? ' · enforcing now' : ' · not enforcing now');
  el.appendChild(line);
  if (st.note) {
    var n = document.createElement('span');
    n.className = 'permit-note';
    n.textContent = st.note;
    el.appendChild(n);
  }

  /* The permit limit is a timer, so offer it as one rather than making the
     driver work out the arithmetic and set it by hand. */
  var sess = loadSession();
  var hasLimit = sess && sess.limitUntil && sess.segId === current.i &&
                 sess.limitUntil > Date.now();
  if (st.enforcing && !hasLimit) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip chip--on';
    b.textContent = 'Start ' + (st.limit / 60) + 'h';
    b.onclick = function () {
      setLimit(st.limit, 'Area ' + st.area + ' ' + (st.limit / 60) + 'h');
      renderPermit();
    };
    el.appendChild(b);
  }
}

/* --------------------------------------------------------------- the camera */
/* The scene is static geometry; the camera is what moves. A fly-in that starts
   high, banked and wide, then drops and squares up onto the block -- so arriving
   at a spot feels like arriving somewhere, rather than a diagram appearing.
   Runs once per block, and never when the system asks for reduced motion. */
var flyRaf = null;

function easeOutQuint(t) { return 1 - Math.pow(1 - t, 5); }
function easeOutBack(t) {
  var c = 1.3;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

function flyIn() {
  var cam = $('camera');
  var car = $('car');
  if (!cam) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cam.removeAttribute('transform');
    return;
  }
  if (flyRaf) cancelAnimationFrame(flyRaf);

  var DUR = 1150;
  var start = null;
  var cx = VIEW_W / 2, cy = VIEW_H / 2;

  /* Hold the kerb colours back until the camera has almost landed: the colour
     is the answer, and it lands better as an arrival than as part of the swoop. */
  $('kerbA').style.opacity = '0';
  $('kerbB').style.opacity = '0';
  if (car) car.style.opacity = '0';

  function frame(ts) {
    if (start === null) start = ts;
    var t = Math.min(1, (ts - start) / DUR);
    var e = easeOutQuint(t);

    var scale = 2.35 - 1.35 * e;        /* swoop down from high above */
    var bank = -14 * (1 - e);           /* and square up out of the bank */
    var lift = -70 * (1 - e);
    cam.setAttribute('transform',
      'translate(' + cx + ' ' + (cy + lift) + ') ' +
      'rotate(' + bank.toFixed(2) + ') ' +
      'scale(' + scale.toFixed(3) + ') ' +
      'translate(' + (-cx) + ' ' + (-cy) + ')');

    if (t > 0.55 && car) {
      var ct = Math.min(1, (t - 0.55) / 0.45);
      car.style.opacity = String(ct);
      car.style.setProperty('--drop', (1 - easeOutBack(ct)).toFixed(3));
    }
    if (t > 0.7) {
      var kt = Math.min(1, (t - 0.7) / 0.3);
      $('kerbA').style.opacity = String(kt);
      $('kerbB').style.opacity = String(kt);
    }

    if (t < 1) {
      flyRaf = requestAnimationFrame(frame);
    } else {
      cam.removeAttribute('transform');
      $('kerbA').style.opacity = '';
      $('kerbB').style.opacity = '';
      if (car) { car.style.opacity = ''; car.style.removeProperty('--drop'); }
      flyRaf = null;
    }
  }
  flyRaf = requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------- the scene */
/* Drawn from the block's real geometry rather than a stock straight road: a
   curved block curves, a skew junction is skew, and the cross streets are the
   ones actually there. The whole scene is rotated so the block runs up the
   screen, which is how a car display orients -- the world turns, the car does
   not. */
var SCALE = 5;            /* SVG units per metre: ~92 m of street fills the view */
var HALF_ROAD = 4.6;      /* metres from centreline to kerb */
var VIEW_W = 360, VIEW_H = 460;
var scene = null;         /* the projection in force, for placing the car */

function buildScene(lon, lat) {
  var g = current.g;
  /* Centre on the car, not on the middle of the block. Framing the block put the
     car at whichever end it happened to be parked at -- sometimes off screen
     entirely. A car display keeps the vehicle put and moves the world past it. */
  var mid = [lon, lat];
  var mx = MX_AT(mid[1]);
  var seg = segmentBearingNear(lon, lat) || { bearing: 0 };
  /* Rotate BY the bearing, not by its negative.
     A street of bearing b has direction (sin b, cos b) in east/north. Rotating a
     vector by theta gives (sin(b-theta), cos(b-theta)), so theta = b is what
     maps the street onto (0, 1) and stands it upright. Using -b left every
     street skewed across the screen -- Parker St, which runs almost due east,
     was drawn at 162 degrees. */
  var rot = seg.bearing * Math.PI / 180;
  var cos = Math.cos(rot), sin = Math.sin(rot);

  function rotated(pt) {
    var ex = (pt[0] - mid[0]) * mx;
    var ny = (pt[1] - mid[1]) * MY;
    return [ex * cos - ny * sin, ex * sin + ny * cos];
  }

  /* Frame the block itself rather than a fixed zoom. A short block filled a
     sliver of the screen and a long one ran off both ends; scaling to what is
     actually there makes every block read the same way. Clamped so a very short
     stub is not blown up into abstraction, and a very long one still shows the
     kerbs far enough apart to tell apart -- which is the entire job. */
  /* Show enough of the block either side of the car to read as a street, but
     stay zoomed in enough that the two kerbs are plainly separate -- telling
     them apart is the entire job of this picture. */
  var ys = g.map(rotated).map(function (p) { return Math.abs(p[1]); });
  var reach = Math.max(25, Math.min(70, Math.max.apply(null, ys)));
  var scale = Math.max(3.4, Math.min(6.5, (VIEW_H * 0.42) / reach));

  function project(pt) {
    var r = rotated(pt);
    return [VIEW_W / 2 + r[0] * scale, VIEW_H / 2 - r[1] * scale];
  }

  scene = { project: project, mid: mid, bearing: seg.bearing, scale: scale };
  return scene;
}

function pathOf(points) {
  return points.map(function (p, i) {
    return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
  }).join(' ');
}

/* A kerb is the centreline pushed sideways by half the roadway. */
function offsetPath(coords, metres, project) {
  var out = [];
  for (var i = 0; i < coords.length; i++) {
    var a = coords[Math.max(0, i - 1)], b = coords[Math.min(coords.length - 1, i + 1)];
    var pa = project(a), pb = project(b);
    var dx = pb[0] - pa[0], dy = pb[1] - pa[1];
    var len = Math.hypot(dx, dy) || 1;
    var nx = -dy / len, ny = dx / len;          /* left normal in screen space */
    var p = project(coords[i]);
    out.push([p[0] + nx * metres * (scene ? scene.scale : SCALE),
              p[1] + ny * metres * (scene ? scene.scale : SCALE)]);
  }
  return out;
}

/* The block is one centreline segment, and a fix near its end leaves half the
   screen empty. Follow the street through the junctions either way so the road
   runs off both edges of the view, the way a street actually does. */
function continuedRoad(coords) {
  var TOL = 0.00008;                 /* ~7 m: endpoints that are the same corner */
  function near(a, b) {
    return Math.abs(a[0] - b[0]) < TOL && Math.abs(a[1] - b[1]) < TOL;
  }
  var name = (current.n || '').toLowerCase();
  var line = coords.slice();
  var used = {};
  used[current.i] = 1;

  for (var pass = 0; pass < 4; pass++) {
    var grew = false;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (used[seg.i]) continue;
      /* Same street only: continuing into whatever happens to touch the corner
         would draw a road that bends into a different street. */
      if ((seg.n || '').toLowerCase() !== name) continue;
      var g = seg.g;
      if (near(g[0], line[line.length - 1])) { line = line.concat(g.slice(1)); }
      else if (near(g[g.length - 1], line[line.length - 1])) {
        line = line.concat(g.slice(0, -1).reverse());
      } else if (near(g[g.length - 1], line[0])) { line = g.slice(0, -1).concat(line); }
      else if (near(g[0], line[0])) { line = g.slice(1).reverse().concat(line); }
      else continue;
      used[seg.i] = 1;
      grew = true;
    }
    if (!grew) break;
  }
  return line;
}

function drawScene(lon, lat) {
  var sc = buildScene(lon, lat);
  var coords = current.g;
  var through = continuedRoad(coords);

  /* Stroke widths are in SVG units, so they have to track the scale too or a
     zoomed-out block gets a motorway-wide road. */
  $('road').style.strokeWidth = (HALF_ROAD * 2 * sc.scale).toFixed(1);
  $('kerbA').style.strokeWidth = Math.max(3, sc.scale).toFixed(1);
  $('kerbB').style.strokeWidth = Math.max(3, sc.scale).toFixed(1);
  /* Roadway and centreline run the full street; the coloured kerbs stay on this
     block alone, because only this block's schedule is known. */
  $('road').setAttribute('d', pathOf(through.map(sc.project)));
  $('centerline').setAttribute('d', pathOf(through.map(sc.project)));

  /* Which hand of the line each side sits on, so the kerb is drawn where that
     side actually is rather than arbitrarily left or right. */
  current.s.slice(0, 2).forEach(function (side, i) {
    var hand = handOfSide(side, sc.bearing);
    var metres = hand === 'left' ? -HALF_ROAD : HALF_ROAD;
    $(i === 0 ? 'kerbA' : 'kerbB')
      .setAttribute('d', pathOf(offsetPath(coords, metres, sc.project)));
  });

  drawContext(sc);
  return sc;
}

/* 'left' or 'right' of the digitisation direction, from the side's compass tag.
   Without a tag the two sides are simply drawn on opposite hands. */
function handOfSide(side, bearing) {
  if (side.f) {
    return side.f === cardinalOf(bearing - 90) ? 'left' : 'right';
  }
  return current.s.indexOf(side) === 0 ? 'left' : 'right';
}

/* The streets actually around you, so the block reads as a place. */
function drawContext(sc) {
  var g = $('context');
  g.innerHTML = '';
  var drawn = 0;
  for (var i = 0; i < segments.length && drawn < 60; i++) {
    var seg = segments[i];
    if (seg.i === current.i) continue;
    var pts = seg.g.map(sc.project);
    var onScreen = pts.some(function (p) {
      return p[0] > -60 && p[0] < VIEW_W + 60 && p[1] > -60 && p[1] < VIEW_H + 60;
    });
    if (!onScreen) continue;
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathOf(pts));
    path.style.strokeWidth = (HALF_ROAD * 1.6 * sc.scale).toFixed(1);
    g.appendChild(path);
    drawn++;
  }
}

/* --------------------------------------------------------------- the sweeper */
/* A sweeper drives the kerb that is actually being swept. It is the one piece of
   decoration here that is also information: you can see which side is in trouble
   without reading anything. It only appears when a side is genuinely active or
   close to it, so it never implies a sweep that is not coming. */
var sweepRaf = null;

function runSweeper() {
  var el = $('sweeper');
  if (!el || !scene) return;
  if (sweepRaf) { cancelAnimationFrame(sweepRaf); sweepRaf = null; }

  var now = new Date();
  var target = -1;
  for (var i = 0; i < Math.min(2, current.s.length); i++) {
    var tone = verdictFor(current.s[i], now).tone;
    if (tone === 'now') { target = i; break; }
  }
  if (target < 0 || window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.hidden = true;
    return;
  }

  var hand = handOfSide(current.s[target], scene.bearing);
  var lane = offsetPath(current.g, hand === 'left' ? -HALF_ROAD : HALF_ROAD,
                        scene.project);
  if (lane.length < 2) { el.hidden = true; return; }

  /* Total length, so the sweeper moves at a steady speed rather than a steady
     fraction -- a long block should take longer to sweep, which it does. */
  var cum = [0];
  for (var j = 1; j < lane.length; j++) {
    cum.push(cum[j - 1] + Math.hypot(lane[j][0] - lane[j - 1][0],
                                     lane[j][1] - lane[j - 1][1]));
  }
  /* Only sweep the stretch that is actually on screen: the block runs well past
     the viewport and a sweeper trundling around off-screen is just a wasted
     animation frame. */
  var visible = lane.filter(function (p) {
    return p[1] > -30 && p[1] < VIEW_H + 30;
  });
  if (visible.length >= 2) {
    lane = visible;
    cum = [0];
    for (var v = 1; v < lane.length; v++) {
      cum.push(cum[v - 1] + Math.hypot(lane[v][0] - lane[v - 1][0],
                                       lane[v][1] - lane[v - 1][1]));
    }
  }
  var total = cum[cum.length - 1];
  if (!total) { el.hidden = true; return; }

  el.hidden = false;
  var SPEED = 34;                 /* SVG units per second */
  var startTs = null;

  function step(ts) {
    if (startTs === null) startTs = ts;
    var travelled = (((ts - startTs) / 1000) * SPEED) % (total + 60);
    var d = Math.min(travelled, total);
    var k = 1;
    while (k < cum.length && cum[k] < d) k++;
    var a = lane[k - 1], b = lane[Math.min(k, lane.length - 1)];
    var segLen = cum[Math.min(k, cum.length - 1)] - cum[k - 1] || 1;
    var f = (d - cum[k - 1]) / segLen;
    var x = a[0] + (b[0] - a[0]) * f;
    var y = a[1] + (b[1] - a[1]) * f;
    var ang = Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180 / Math.PI;
    var fade = travelled > total ? 0 : 1;
    el.setAttribute('transform',
      'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ') rotate(' + ang.toFixed(1) + ')');
    el.style.opacity = String(fade);
    sweepRaf = requestAnimationFrame(step);
  }
  sweepRaf = requestAnimationFrame(step);
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
var simulated = false;      /* ?at= override in play: never overwrite a real spot */


function toneOf(side, now) { return verdictFor(side, now).tone; }

/* 1,142 Oakland ranges are stored high-to-low ("1056-1030"). The range is the
   thing the driver checks against a door number, so it has to read forwards. */
function tidyRange(a) {
  var m = /^(\d+)-(\d+)$/.exec(String(a || ''));
  if (!m) return a;
  var lo = +m[1], hi = +m[2];
  return lo <= hi ? a : hi + '-' + lo;
}

function renderStage() {
  var now = new Date();
  if (lastFix) drawScene(lastFix[0], lastFix[1]);

  /* More than two sides means the geometric route join matched several routes
     to this centreline and we cannot say which kerb is which. Drawing two of
     them hid the rest: on 17 Berkeley blocks a hidden side sweeps while both
     drawn kerbs read "Clear" in green. Those blocks get a list of every
     schedule instead of a picture that cannot hold them. */
  var tooMany = current.s.length > 2;
  $('overflow').hidden = !tooMany;
  if (tooMany) {
    renderAllSides();
    $('labelA').hidden = true;
    $('labelB').hidden = true;
    $('kerbA').setAttribute('data-tone', 'muted');
    $('kerbB').setAttribute('data-tone', 'muted');
    $('kerbA').setAttribute('data-active', 'false');
    $('kerbB').setAttribute('data-active', 'false');
    moveCar();
    renderVerdict();
    return;
  }

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
    if (side.a) meta.push(tidyRange(side.a));
    if (side.f) meta.push(FACING[side.f]);
    label.innerHTML =
      '<span class="kl-side">' + esc(who) + '</span>' +
      (meta.length ? '<span class="kl-meta">' + esc(meta.join(' · ')) + '</span>' : '') +
      '<span class="kl-state">' + esc(v.headline) + '</span>';
    label.onclick = function () { placeCar(i); };
  });

  /* One kerb recorded. That is NOT the same as one kerb existing: Oakland's
     major streets are digitised as two lines, but 164 Berkeley blocks simply
     have only one side in the data, and 38 of those cannot even name it. Auto
     placing the car there asserted a side the data never established, and wrote
     a parked session the driver never created. Say what is known and let them
     confirm. */
  if (current.s.length < 2) {
    $('labelB').hidden = true;
    $('kerbB').setAttribute('data-tone', 'muted');
    $('kerbB').setAttribute('data-active', 'false');
  }

  moveCar();
  runSweeper();
  renderVerdict();
}

/* Every recorded schedule for a block the two-kerb picture cannot represent. */
function renderAllSides() {
  var wrap = $('overflow');
  var now = new Date();
  wrap.innerHTML = '';

  var head = document.createElement('p');
  head.className = 'overflow-head';
  head.textContent = current.s.length + ' schedules are recorded for this block ' +
    'and the city data does not say which kerb each belongs to. Match yours to ' +
    'the posted sign.';
  wrap.appendChild(head);

  current.s.forEach(function (side, i) {
    var v = verdictFor(side, now);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'overflow-row';
    b.setAttribute('aria-pressed', String(placed && chosen === i));
    b.setAttribute('data-tone', v.tone);
    b.innerHTML =
      '<span class="of-when">' + esc(describe(side)) + '</span>' +
      '<span class="of-state">' + esc(v.headline) + '</span>';
    b.onclick = function () { placeCar(i); };
    wrap.appendChild(b);
  });
}

function moveCar() {
  var car = $('car');
  var onKerb = (placed || suggestion) && current.s.length <= 2;
  var pos = [VIEW_W / 2, VIEW_H / 2];
  var angle = 0;

  if (scene && lastFix) {
    /* Put the car where the driver actually is along the block, pushed out to
       the chosen kerb -- not at a fixed spot on a stock road. */
    var here = scene.project(lastFix);
    var lane = onKerb
      ? offsetPath(current.g,
          handOfSide(current.s[Math.min(chosen, 1)], scene.bearing) === 'left'
            ? -HALF_ROAD * 0.62 : HALF_ROAD * 0.62,
          scene.project)
      : current.g.map(scene.project);
    pos = nearestOnPath(here, lane);
    angle = pos.angle;
  }
  /* Scale lives in the same CSS transform as position: setting it through the
     SVG transform attribute as well just loses to this one. */
  /* Never shrink the car past readability: on a long block the view zooms out
     far enough that a true-to-scale car becomes a speck. */
  var z = scene ? Math.max(0.8, scene.scale / 5) : 1;
  car.style.transform = 'translate(' + pos[0].toFixed(1) + 'px, ' +
                        pos[1].toFixed(1) + 'px) rotate(' + angle.toFixed(1) + 'deg) ' +
                        'scale(' + z.toFixed(3) + ')';
  car.classList.toggle('car--placing', !onKerb);
  car.classList.toggle('car--guess', !placed && !!suggestion);
}

/* Closest point along a drawn path, plus the path's direction there, so the car
   sits parallel to the kerb instead of floating at a fixed angle. */
function nearestOnPath(p, pts) {
  var best = [pts[0][0], pts[0][1]];
  best.angle = 0;
  var bestD = Infinity;
  for (var i = 0; i < pts.length - 1; i++) {
    var a = pts[i], b = pts[i + 1];
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var L = dx * dx + dy * dy;
    var t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    var qx = a[0] + t * dx, qy = a[1] + t * dy;
    var d = Math.hypot(p[0] - qx, p[1] - qy);
    if (d < bestD) {
      bestD = d;
      best = [qx, qy];
      best.angle = Math.atan2(dx, -dy) * 180 / Math.PI;
    }
  }
  return best;
}

function placeCar(i) {
  chosen = i;
  placed = true;
  suggestion = null;
  try { localStorage.setItem('side:' + current.i, String(i)); } catch (e) {}
  /* The tap is the save -- unless the position came from ?at=, which is a
     testing affordance. Overwriting a real saved spot from a crafted link, on
     the one tap the whole app invites, would lose it unrecoverably. */
  if (simulated) {
    renderStage();
    paintSides();
    return;
  }
  saveSession({
    segId: current.i, side: i, at: Date.now(),
    lon: lastFix && lastFix[0], lat: lastFix && lastFix[1],
    street: current.n, city: cityId
  });
  renderStage();
  paintSides();
  startTicking();
}


function renderVerdict() {
  $('street').textContent = current.n || 'This block';
  var v = $('verdict');
  if (!placed && !suggestion) {
    v.hidden = true;
    $('limits').hidden = true;
    $('confirm').hidden = true;
    $('permit').hidden = true;
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
    (side.a ? ' · ' + tidyRange(side.a) : '') +
    (side.f ? ' · faces ' + FACING[side.f] : '');

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
  $('forget').hidden = !loadSession();
  renderTimerButton();
  $('showcompass').hidden = compassOn || !current.s.some(function (x) { return x.f; });
  renderLimitRow();
  renderPermit();
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
/* Every city whose box contains the point -- not the first one.

   Berkeley and Oakland overlap by about 8 x 4 km and the two street grids
   genuinely interleave along Alcatraz, Woolsey and 63rd. Returning the first
   match made 419 Oakland blocks resolve as Berkeley streets: standing on
   Telegraph Ave in Oakland produced "Woolsey St" 32 m away, with Woolsey's
   schedule printed as fact. Bounding boxes cannot separate these cities, so
   candidates are all searched and the nearest actual block decides. */
function citiesFor(lon, lat) {
  return CITIES.filter(function (c) {
    var b = c.bbox;
    return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
  });
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
  simulated = !!at;
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
  var candidates = citiesFor(lon, lat);
  if (!candidates.length) {
    setStatus('No data for where you are. Covered so far: ' + coverageNames() + '.',
              'error');
    return;
  }
  setStatus('Loading ' + candidates.map(function (c) { return c.name; }).join(' / ') + '…');

  /* Load the grid cell you are standing in, not the whole city. Oakland's full
     file is 2.6 MB, which is a slow parse on a phone, and an NFC tap should
     answer immediately. One cell is ~30 kB. Neighbours are fetched only if the
     nearest block in this cell is far enough away that the real answer is
     probably across a boundary. */
  /* Search every candidate, then let the nearest real block pick the city. */
  var MAX_SNAP_M = 60;

  function searchAll(withNeighbours) {
    return Promise.all(candidates.map(function (c) {
      return loadTiles(c, lon, lat, withNeighbours).then(function (segs) {
        return { city: c, segs: segs };
      });
    })).then(function (sets) {
      var best = null;
      sets.forEach(function (set) {
        segments = set.segs;
        var hit = nearestSegment(lon, lat);
        if (hit && (!best || hit.distance < best.distance)) {
          best = { segment: hit.segment, distance: hit.distance,
                   city: set.city, segs: set.segs };
        }
      });
      return best;
    });
  }

  Promise.all([
    searchAll(false),
    fetch('data/holidays.json').then(function (r) { return r.json(); })
                               .catch(function () { return null; })
  ])
    .then(function (both) {
      holidaysAll = both[1];
      var best = both[0];
      if (best && best.distance <= MAX_SNAP_M) return best;
      /* Nothing close: widen once, and apply the same distance rule -- the cap
         exists precisely for this case, so skipping it here would defeat it. */
      return searchAll(true).then(function (wider) {
        return wider && wider.distance <= MAX_SNAP_M ? wider : null;
      });
    })
    .then(function (hit) {
      if (!hit) {
        setStatus('No street we have data for within ' + 60 + ' m of you. ' +
                  'Go by the posted sign.', 'error');
        return;
      }
      var city = hit.city;
      cityId = city.id;
      segments = hit.segs;
      holidays = holidaysAll ? holidaysAll[city.id] : null;
      current = hit.segment;
      chosen = 0;
      placed = false;
      suggestion = null;
      rememberedSide = null;

      /* A remembered side is history, not evidence. Parking on the other side
         next time is normal, so restoring it as confirmed would quietly assert
         a stale answer -- the shape of the bug that put someone on the wrong
         kerb. Only a live session (same block, placed in the last 12 hours) is
         the same car still sitting where it was put. */
      var live = loadSession();
      if (live && live.segId === current.i && current.s[live.side] &&
          Date.now() - live.at < 1000 * 60 * 60 * 12) {
        chosen = live.side;
        placed = true;
      } else {
        try {
          var saved = localStorage.getItem('side:' + current.i);
          if (saved !== null && current.s[+saved]) rememberedSide = +saved;
        } catch (e) {}
      }

      /* Guess the side, but only ever as a question. */
      if (!placed && lastFixDetail) suggestion = inferSide(lastFixDetail);
      if (!placed && !suggestion && rememberedSide !== null) {
        suggestion = {
          index: rememberedSide,
          confidence: 0.5,
          why: 'you parked on this side here last time'
        };
      }
      if (suggestion) chosen = suggestion.index;

      setStatus(null);
      $('status').hidden = true;
      $('detail').hidden = false;
      $('vintage').textContent = city.vintage +
        ' Schedules can change without the data changing.' +
        (holidayCoverageEndsSoon()
          ? ' Holiday dates in this app run out soon — after that, sweeps on ' +
            'city holidays will not be excluded.'
          : '');
      renderStage();
      flyIn();
      showParkedStamp();
      renderRecall();
      startTicking();
      if (simulated) {
        setStatus('Simulated location — your saved spot is untouched.', 'error');
        $('status').hidden = false;
      }
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
  /* A bare link with ?nfc=1 should not be able to wipe an existing reading, so
     only stamp when there is not already a recent one. Tapping the sticker
     again within the hour is the same parking event, not a new one. */
  try {
    var prev = +localStorage.getItem('parkedAt');
    if (prev && Date.now() - prev < 1000 * 60 * 60) return;
    localStorage.setItem('parkedAt', String(Date.now()));
  } catch (e) {}
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

$('timer').onclick = startNativeTimer;
$('timername').onclick = renameTimerShortcut;
$('forget').onclick = forgetSpot;
$('remind').onclick = downloadIcs;
$('showmap').onclick = showMap;
$('closemap').onclick = function () { $('mapwrap').hidden = true; };
$('showcompass').onclick = startCompass;
$('aim').onclick = useAimedHeading;

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
/* Always revalidate the manifest. It decides which cities exist, which files to
   fetch and which grid cells are real, so a stale copy quietly breaks all three
   -- a cached one without the tile index sent nine 404s per lookup. It is under
   a kilobyte, so there is nothing to save by caching it. */
fetch('data/cities.json', { cache: 'no-cache' })
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
