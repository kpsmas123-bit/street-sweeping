"""Berkeley: regex on layer-7 route codes + a spatial join to layer-6 centerlines.

The handoff assumed layer 6's `Route` field carried the schedule. It does not --
it is null on 3012 of 3101 records and the remainder is prose. The machine
readable codes live in layer 7 (62 features, 42 codes), which has no attribute
join key to layer 6. So we match geometrically: a centerline belongs to a route
when the route's paths run alongside most of its length.

Empirically ~57% of enforced centerlines match exactly two routes, in pairs like
4thTHUR1230330 + 4thFRI1230330 -- one per side of the street. Neither layer says
which route is the odd side, so sides stay labelled 'unknown' and the UI asks.
"""
import math
import re
import schedule as S

_ORDINAL = {'1ST': 1, '2ND': 2, '3RD': 3, '4TH': 4}
_WEEKDAY = {'MON': S.MON, 'TUE': S.TUE, 'WED': S.WED, 'THUR': S.THU, 'FRI': S.FRI}
_TIME = {'912': ('09:00', '12:00'), '1230330': ('12:30', '15:30')}

# Casing is inconsistent in the source ('4thTue912' vs '4thWED912') -- match
# case-insensitively. The time suffix is absent on a couple of codes.
_ROUTE_RE = re.compile(
    r'^(1st|2nd|3rd|4th)(MON|TUE|WED|THUR|FRI)(912|1230330)?$', re.IGNORECASE)

# Non-residential route values carry no ordinal/weekday pattern.
_COMMERCIAL = {
    'Comm7days': [S.SUN, S.MON, S.TUE, S.WED, S.THU, S.FRI, S.SAT],
    'CommMon': [S.MON], 'CommTu': [S.TUE], 'CommWed': [S.WED],
    'CommThur': [S.THU], 'CommFri': [S.FRI],
    'CommMWF': [S.MON, S.WED, S.FRI],
    'CommTuTh': [S.TUE, S.THU],
    'CommMWFSS': [S.SUN, S.MON, S.WED, S.FRI, S.SAT],
    'CommTuThSS': [S.SUN, S.TUE, S.THU, S.SAT],
}
_OPTIONAL = {'CommOptional', 'ResidentOptional'}
_IRREGULAR = {'Ind2monthly', 'Ind2weekly', 'Medians2monthly'}

# mech_sweep -> confidence for blocks that are not enforced
_STATUS = {
    'enforced': None,        # parse the route normally
    'exempt': 'exempt',      # opted out
    'excluded': 'exempt',    # no curbs / too narrow to sweep
    'Commercial': None,
    'industry': None,
}


def parse_route(code):
    """Layer-7 route string -> (schedule, confidence)."""
    code = (code or '').strip()
    if not code:
        return S.UNKNOWN, 'unknown'
    m = _ROUTE_RE.match(code)
    if m:
        ordinal = _ORDINAL[m.group(1).upper()]
        weekday = _WEEKDAY[m.group(2).upper()]
        start, end = _TIME.get(m.group(3) or '', (None, None))
        sched = S.make('nth_weekday', [ordinal], [weekday], start, end)
        return sched, ('ok' if start else 'no_time')
    for key, weekdays in _COMMERCIAL.items():
        if key.lower() == code.lower():
            return S.make('weekly', [], weekdays, None, None), 'no_time'
    if code in _OPTIONAL:
        return S.NONE, 'exempt'
    if code in _IRREGULAR:
        return S.UNKNOWN, 'unknown'
    return S.UNKNOWN, 'unknown'


# --- geometry helpers (local equirectangular metres; fine at Berkeley's scale) --
_LAT0 = 37.87
_MX = 111320.0 * math.cos(math.radians(_LAT0))
_MY = 110574.0


def _to_m(pt):
    return (pt[0] * _MX, pt[1] * _MY)


def _point_seg_dist(p, a, b):
    px, py = p
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / denom))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _sample_points(path, n=5):
    """n points spread along a path, skipping the endpoints so that shared
    intersections do not dominate the match."""
    pts = [_to_m(p) for p in path]
    if len(pts) < 2:
        return pts
    # cumulative length
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = cum[-1]
    if total == 0:
        return [pts[0]]
    out = []
    for i in range(n):
        target = total * (i + 1) / (n + 1)
        for j in range(1, len(cum)):
            if cum[j] >= target:
                seg = cum[j] - cum[j - 1]
                f = 0.0 if seg == 0 else (target - cum[j - 1]) / seg
                a, b = pts[j - 1], pts[j]
                out.append((a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])))
                break
    return out


_CELL = 60.0   # metres; a little wider than the match tolerance


def build_route_index(layer7_features):
    """Grid-bucketed route segments: (cx, cy) -> [(code, a, b), ...].

    Without the grid this is 1397 centerlines x 5 samples x ~3700 segments of
    pure-Python distance math. The grid drops it to a handful of cells per probe.
    """
    grid = {}
    for f in layer7_features:
        code = (f['attributes'].get('Route') or '').strip()
        if not code:
            continue
        for path in f.get('geometry', {}).get('paths', []):
            pts = [_to_m(p) for p in path]
            for a, b in zip(pts, pts[1:]):
                lo_x, hi_x = sorted((a[0], b[0]))
                lo_y, hi_y = sorted((a[1], b[1]))
                for cx in range(int(lo_x // _CELL), int(hi_x // _CELL) + 1):
                    for cy in range(int(lo_y // _CELL), int(hi_y // _CELL) + 1):
                        grid.setdefault((cx, cy), []).append((code, a, b))
    return grid


def _codes_near(grid, p, tol_m):
    cx, cy = int(p[0] // _CELL), int(p[1] // _CELL)
    found = set()
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for code, a, b in grid.get((cx + dx, cy + dy), ()):
                if code not in found and _point_seg_dist(p, a, b) < tol_m:
                    found.add(code)
    return found


def match_routes(centerline_path, route_index, tol_m=18.0, min_hit_frac=0.8):
    """Route codes whose geometry runs alongside this centerline.

    Requires the route to be near most sampled points, not just one -- a single
    midpoint test lets a merely crossing street score a false match.
    """
    samples = _sample_points(centerline_path)
    if not samples:
        return []
    need = max(1, int(math.ceil(len(samples) * min_hit_frac)))
    tally = {}
    for p in samples:
        for code in _codes_near(route_index, p, tol_m):
            tally[code] = tally.get(code, 0) + 1
    return sorted(c for c, n in tally.items() if n >= need)


# --- opt-in program: layer 6 carries prose, not codes ------------------------
# Opt_In_Stage is set on exactly 89 records and those are exactly the ones with a
# non-null layer-6 Route. None of them are `enforced` yet, and their layer-7 route
# geometry is barely digitized, so the spatial join cannot see them. The prose is
# authoritative for these blocks -- parse it instead of joining.
#   "3rd Friday and 4th Monday PM"  -> 3rd Fri + 4th Mon, 12:30-15:30
#   "1st Monday and Tuesday AM"     -> 1st Mon + 1st Tue, 09:00-12:00  (ordinal carries over)
_PROSE_DAY = {'monday': S.MON, 'tuesday': S.TUE, 'wednesday': S.WED,
              'thursday': S.THU, 'friday': S.FRI}
_PROSE_RE = re.compile(r'(1st|2nd|3rd|4th)?\s*(monday|tuesday|wednesday|thursday|friday)',
                       re.IGNORECASE)


def parse_prose(text):
    """Layer-6 prose Route -> list of (schedule, confidence), one per side."""
    text = (text or '').strip()
    if not text:
        return []
    upper = text.upper()
    if upper.endswith('AM'):
        start, end = '09:00', '12:00'
    elif upper.endswith('PM'):
        start, end = '12:30', '15:30'
    else:
        start, end = None, None
    out = []
    carried = None
    for ord_txt, day_txt in _PROSE_RE.findall(text):
        # "1st Monday and Tuesday" omits the second ordinal -- it carries over.
        if ord_txt:
            carried = _ORDINAL[ord_txt.upper()]
        if carried is None:
            continue
        sched = S.make('nth_weekday', [carried], [_PROSE_DAY[day_txt.lower()]], start, end)
        out.append((sched, 'ok' if start else 'no_time'))
    return out


def street_name(a):
    parts = [(a.get('STR_NAM') or '').strip(), (a.get('STR_TYP') or '').strip()]
    return ' '.join(p for p in parts if p).title()


def normalize(attrs, geometry, route_codes):
    """One layer-6 centerline + its matched route codes -> a segment."""
    status = (attrs.get('mech_sweep') or '').strip()
    forced = _STATUS.get(status, 'unknown') if status else 'unknown'

    sides = []
    prose = parse_prose(attrs.get('Route'))
    if prose:
        # Opt-in block: layer 6 states both sides' schedules outright.
        for sched, confidence in prose:
            sides.append({
                'side': 'unknown',
                'addr_from': None, 'addr_to': None,
                'schedule': sched,
                'confidence': confidence,
                'raw': {'mech_sweep': status, 'prose': (attrs.get('Route') or '').strip()},
            })
        return _segment(attrs, geometry, sides, route_codes)

    if forced in ('exempt', 'unknown') and status not in ('enforced', 'Commercial', 'industry'):
        sides.append({
            'side': 'both',
            'addr_from': None, 'addr_to': None,
            'schedule': S.NONE if forced == 'exempt' else S.UNKNOWN,
            'confidence': forced,
            'raw': {'mech_sweep': status, 'routes': route_codes},
        })
    else:
        for code in (route_codes or [None]):
            sched, confidence = parse_route(code)
            sides.append({
                'side': 'unknown',   # neither layer states which side is odd
                'addr_from': None, 'addr_to': None,
                'schedule': sched,
                'confidence': confidence,
                'raw': {'mech_sweep': status, 'route': code},
            })

    return _segment(attrs, geometry, sides, route_codes)


def _segment(attrs, geometry, sides, route_codes):
    return {
        'city': 'berkeley',
        'segment_id': 'bk-%s' % attrs.get('OBJECTID'),
        'street': street_name(attrs),
        'sides': sides,
        'one_way': None,
        'route': ','.join(route_codes) if route_codes else None,
        'addr_odd': [attrs.get('F_ADDL'), attrs.get('T_ADDL')],
        'addr_even': [attrs.get('F_ADDR'), attrs.get('T_ADDR')],
        'geometry': geometry,
    }


def normalize_street(name):
    """Match GIS STR_NAM to PDF street names.

    The GIS field is uppercase, drops the suffix into STR_TYP, splits "McGee"
    as "MC GEE", and truncates at 20 characters ("MARTIN LUTHER KING J").
    """
    s = (name or '').upper().strip()
    s = re.sub(r'[.,]', '', s)
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'^MC\s+', 'MC', s)          # MC GEE -> MCGEE
    for suffix in (' STREET', ' AVENUE', ' BOULEVARD', ' DRIVE', ' COURT', ' PLACE',
                   ' TERRACE', ' CIRCLE', ' CRESCENT', ' PATH', ' WALK', ' LANE',
                   ' ROAD', ' WAY', ' ST', ' AVE', ' AV', ' BLVD', ' BL', ' DR',
                   ' CT', ' PL', ' TER', ' CIR', ' LN', ' RD'):
        if s.endswith(suffix):
            s = s[:-len(suffix)].strip()
            break
    s = s.replace(' ', '')
    # The GIS field truncates at 20 characters, so "Martin Luther King Jr" arrives
    # as "MARTIN LUTHER KING J" -- a bare trailing J is that cut, not a name.
    s = re.sub(r'JR$|J$', '', s)
    return s


# --- PDF schedule join (primary source) -------------------------------------
# Berkeley's own residential schedule PDFs beat both GIS layers: they carry side,
# address range, ordinal weekday and AM/PM per block face. Joined on normalized
# street name + address-range overlap, so no geometry guessing and -- unlike the
# spatial join -- a real odd/even answer.
def load_pdf_index(rows):
    index = {}
    for r in rows:
        index.setdefault(r['key'], []).append(r)
    return index


def _overlap(lo_a, hi_a, lo_b, hi_b):
    if lo_a is None or hi_a is None:
        return False
    return min(lo_a, hi_a) <= hi_b and max(lo_a, hi_a) >= lo_b


def match_pdf(attrs, index):
    """Rows covering this centerline, one per side where available."""
    key = normalize_street(attrs.get('STR_NAM'))
    rows = index.get(key)
    if not rows:
        return []
    odd = (attrs.get('F_ADDL'), attrs.get('T_ADDL'))    # left range is the odd side
    even = (attrs.get('F_ADDR'), attrs.get('T_ADDR'))
    out = {}
    for r in rows:
        span = odd if r['side'] == 'odd' else even
        if _overlap(span[0], span[1], r['lo'], r['hi']) and r['side'] not in out:
            out[r['side']] = r
    return [out[k] for k in ('odd', 'even') if k in out]


def _hand_for(row, attrs):
    """Which hand of the centreline this PDF row's addresses sit on.

    F_ADDL/T_ADDL is the left of the digitisation direction and F_ADDR/T_ADDR
    the right, the same TIGER convention Oakland uses. Match on parity, not on
    range overlap: a PDF row spans many blocks, so its range overlaps both GIS
    ranges and resolves nothing, but the parities separate cleanly.
    """
    def parity(a, b):
        for v in (a, b):
            if isinstance(v, int):
                return 'odd' if v % 2 else 'even'
        return None

    left = parity(attrs.get('F_ADDL'), attrs.get('T_ADDL'))
    right = parity(attrs.get('F_ADDR'), attrs.get('T_ADDR'))
    if left == row['side'] and right != row['side']:
        return 'left'
    if right == row['side'] and left != row['side']:
        return 'right'
    return None


def side_from_pdf(row, attrs=None):
    return {
        'side': row['side'],
        'hand': _hand_for(row, attrs) if attrs else None,
        'addr_from': str(row['lo']),
        'addr_to': str(row['hi']),
        'schedule': S.make('nth_weekday', [row['ordinal']], [row['weekday']],
                           row['start'], row['end']),
        'confidence': 'ok',
        'raw': {'source': 'pdf', 'route': row['route'], 'compass': row['compass']},
    }
