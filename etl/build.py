"""raw/ -> data/*.geojson  (the files the frontend actually ships)."""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import normalize_berkeley as BK        # noqa: E402
import rpp as RPP                      # noqa: E402
import rpp_oakland as OAKRPP           # noqa: E402
import normalize_emeryville as EM      # noqa: E402
import normalize_oakland as OAK        # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, '..', 'raw')
DATA = os.path.join(HERE, '..', 'data')

SIMPLIFY_M = 2.0        # metres; well under the GPS error we are fighting
MERGE_RADIUS_M = 45.0   # how close two halves of a major street may sit
_MX = 111320.0 * math.cos(math.radians(37.85))
_MY = 110574.0


# --- geometry ---------------------------------------------------------------
def _perp(p, a, b):
    px, py = p[0] * _MX, p[1] * _MY
    ax, ay = a[0] * _MX, a[1] * _MY
    bx, by = b[0] * _MX, b[1] * _MY
    dx, dy = bx - ax, by - ay
    denom = math.hypot(dx, dy)
    if denom == 0:
        return math.hypot(px - ax, py - ay)
    return abs(dy * px - dx * py + bx * ay - by * ax) / denom


def simplify(pts, tol=SIMPLIFY_M):
    """Douglas-Peucker, iterative so a long path cannot blow the stack."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        lo, hi = stack.pop()
        worst, idx = 0.0, None
        for i in range(lo + 1, hi):
            d = _perp(pts[i], pts[lo], pts[hi])
            if d > worst:
                worst, idx = d, i
        if idx is not None and worst > tol:
            keep[idx] = True
            stack.append((lo, idx))
            stack.append((idx, hi))
    return [p for p, k in zip(pts, keep) if k]


def _round(pts, nd=5):
    """5 decimal places is ~1.1 m -- finer than anything here needs."""
    return [[round(x, nd), round(y, nd)] for x, y in pts]


def _midpoint(pts):
    return pts[len(pts) // 2]


def longest_path(geom):
    paths = (geom or {}).get('paths') or []
    return max(paths, key=len) if paths else None


# --- Oakland: fold the two-line major streets back together -----------------
def merge_major_street_pairs(segments):
    """A block marked MS is digitized as two near-coincident lines, one per
    parity. Drawn as-is they overlap and neither is tappable, so fold each pair
    into a single segment carrying both sides."""
    singles = [s for s in segments if len(s['sides']) == 1 and s.get('_ms')]
    others = [s for s in segments if not (len(s['sides']) == 1 and s.get('_ms'))]

    buckets = {}
    for s in singles:
        mid = _midpoint(s['geometry']['coordinates'])
        key = (s['street'].lower(),
               int(mid[0] * _MX // MERGE_RADIUS_M),
               int(mid[1] * _MY // MERGE_RADIUS_M))
        buckets.setdefault(key, []).append(s)

    merged, used = [], set()
    for group in buckets.values():
        for i, a in enumerate(group):
            if id(a) in used:
                continue
            partner = None
            for b in group[i + 1:]:
                if id(b) in used:
                    continue
                if b['sides'][0]['side'] != a['sides'][0]['side']:
                    partner = b
                    break
            if partner is None:
                merged.append(a)
                used.add(id(a))
                continue
            keep = a if len(a['geometry']['coordinates']) >= len(partner['geometry']['coordinates']) else partner
            keep = dict(keep)
            keep['sides'] = sorted(a['sides'] + partner['sides'], key=lambda s: s['side'])
            keep['merged_from'] = [a['segment_id'], partner['segment_id']]
            merged.append(keep)
            used.add(id(a))
            used.add(id(partner))
    return others + merged


# --- compass ---------------------------------------------------------------
# Which way a side faces, derived from the centreline's bearing plus which hand
# of the line that side's addresses sit on. The compass letter is a hint for
# orienting yourself; the address range beside it stays the reliable check,
# because a street that curves through a block has no single true bearing.
def _bearing(pts):
    """Digitisation bearing in degrees clockwise from north."""
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    mx = 111320.0 * math.cos(math.radians((y1 + y2) / 2))
    return (math.degrees(math.atan2((x2 - x1) * mx, (y2 - y1) * 110574.0)) + 360) % 360


def _cardinal(deg):
    deg %= 360
    if deg < 45 or deg >= 315:
        return 'N'
    if deg < 135:
        return 'E'
    if deg < 225:
        return 'S'
    return 'W'


def _straightness(pts):
    """End-to-end distance over path length. A block that bends has no one facing."""
    if len(pts) < 2:
        return 0.0
    total = 0.0
    for a, b in zip(pts, pts[1:]):
        mx = 111320.0 * math.cos(math.radians((a[1] + b[1]) / 2))
        total += math.hypot((b[0] - a[0]) * mx, (b[1] - a[1]) * 110574.0)
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    mx = 111320.0 * math.cos(math.radians((y1 + y2) / 2))
    direct = math.hypot((x2 - x1) * mx, (y2 - y1) * 110574.0)
    return 0.0 if total == 0 else direct / total


def add_compass(seg):
    """Tag each side with the compass direction it faces, where that is meaningful."""
    pts = seg['geometry']['coordinates']
    if len(pts) < 2 or _straightness(pts) < 0.9:
        return seg                      # too curved for one bearing to describe
    b = _bearing(pts)
    for side in seg['sides']:
        hand = side.get('hand')
        if hand == 'left':
            side['compass'] = _cardinal(b - 90)
        elif hand == 'right':
            side['compass'] = _cardinal(b + 90)

    return drop_inconsistent_compass(seg)


def drop_inconsistent_compass(seg):
    """Two sides of one street must face opposite ways. If they do not, the hands
    or the bearing are wrong for this block, so say nothing rather than point
    someone at the wrong curb."""
    tagged = [x for x in seg['sides'] if x.get('compass')]
    if len(tagged) == 2 and {tagged[0]['compass'], tagged[1]['compass']} not in (
            {'N', 'S'}, {'E', 'W'}):
        for x in tagged:
            x.pop('compass', None)
    return seg


# --- compact output ---------------------------------------------------------
# The app parses this on a phone, so the wire format is terse: short keys, no
# debug payload, and no GeoJSON-inside-a-string double escaping (which alone
# doubled the byte count by turning every quote into \").
#   i segment id   n street name   g coordinates   s sides   y one-way flag
#   d side ("odd" | "even" | "both" | "unknown")   a address range
#   k kind ("w" weekly | "n" nth-weekday | "x" none | "?" unknown)
#   w weekdays (0=Sun)   o ordinals   t [start, end]   c confidence
_KIND = {'weekly': 'w', 'nth_weekday': 'n', 'none': 'x', 'unknown': '?'}


def pack_side(side):
    out = {'d': side['side'], 'k': _KIND[side['schedule']['kind']], 'c': side['confidence']}
    sched = side['schedule']
    if sched['weekdays']:
        out['w'] = sched['weekdays']
    if sched['ordinals']:
        out['o'] = sched['ordinals']
    if sched['start']:
        out['t'] = [sched['start'], sched['end']]
    lo, hi = side.get('addr_from'), side.get('addr_to')
    if lo and hi:
        out['a'] = '%s-%s' % (lo, hi)
    if side.get('compass'):
        out['f'] = side['compass']      # facing: N/E/S/W
    if side.get('note'):
        out['x'] = side['note']         # what the city would not commit to
    return out


def pack(seg):
    out = {'i': seg['segment_id'], 'n': seg['street'],
           's': [pack_side(x) for x in seg['sides']],
           'g': seg['geometry']['coordinates']}
    if seg.get('one_way'):
        out['y'] = seg['one_way']
    if seg.get('rpp'):
        r = seg['rpp'].get('rule')
        out['r'] = {'a': seg['rpp']['area']}
        if r:
            out['r']['m'] = r['limit_minutes']
            out['r']['w'] = r['weekdays']
            out['r']['s'] = r['start']
            out['r']['e'] = r['end']
            if r.get('note'):
                out['r']['n'] = r['note']
    return out


def has_any_schedule(seg):
    """Worth shipping if any side either has a real schedule, or has something
    specific to say about why it hasn't one. Dropping the latter would report
    "no data" for a street that is definitely swept."""
    return any(s['schedule']['kind'] in ('weekly', 'nth_weekday') or s.get('note')
               for s in seg['sides'])


def load_oakland_rpp():
    path = os.path.join(HERE, 'oakland_rpp.json')
    if not os.path.exists(path):
        print('  no oakland_rpp.json; run etl/rpp_oakland.py', file=sys.stderr)
        return None
    return json.load(open(path))['index']


def build_oakland():
    raw = json.load(open(os.path.join(RAW, 'oakland.json')))
    rpp_index = load_oakland_rpp()
    rpp_hits = 0
    segs = []
    for f in raw:
        path = longest_path(f.get('geometry'))
        if not path:
            continue
        seg = OAK.normalize(f['attributes'],
                            {'type': 'LineString',
                             'coordinates': _round(simplify(path))})
        if not seg:
            continue
        day_odd = OAK.clean(f['attributes'].get('DAY_ODD'))
        day_even = OAK.clean(f['attributes'].get('DAY_EVEN'))
        seg['_ms'] = OAK.SIDE_POINTER in (day_odd, day_even)
        if rpp_index:
            mid = seg['geometry']['coordinates'][len(seg['geometry']['coordinates']) // 2]
            zone = OAKRPP.zone_for(mid[0], mid[1], rpp_index)
            if zone:
                # Zone only: Oakland publishes no hours or limit for these.
                seg['rpp'] = {'area': zone, 'rule': None}
                rpp_hits += 1
        segs.append(add_compass(seg))
    before = len(segs)
    segs = merge_major_street_pairs(segs)
    # A folded pair's two sides came from two separate features, each tagged
    # before the merge, so re-check them together.
    for seg in segs:
        drop_inconsistent_compass(seg)
    print('  oakland: %d features -> %d segments (%d major-street pairs folded), '
          '%d in a permit zone'
          % (len(raw), len(segs), before - len(segs), rpp_hits), file=sys.stderr)
    return segs


def load_rpp():
    """Permit-area rules, resolved at build time so the client never downloads
    the 480 kB of polygons -- each block just carries its own rule."""
    path = os.path.join(HERE, 'berkeley_rpp.json')
    if not os.path.exists(path):
        print('  no berkeley_rpp.json; run etl/rpp.py', file=sys.stderr)
        return None, None
    d = json.load(open(path))
    index = [(a['letters'], tuple(a['bbox']), a['polygons']) for a in d['areas']]
    return index, d['schedule']


def attach_rpp(seg, index, rules):
    """Tag a block with its permit area, using the midpoint of its geometry."""
    if not index or not rules:
        return False
    pts = seg['geometry']['coordinates']
    mid = pts[len(pts) // 2]
    letters = RPP.area_for(mid[0], mid[1], index)
    if not letters:
        return False
    rule = rules.get(letters)
    if not rule:
        return False
    seg['rpp'] = {'area': letters, 'rule': rule}
    return True


def build_berkeley():
    l6 = json.load(open(os.path.join(RAW, 'berkeley_l6.json')))
    l7 = json.load(open(os.path.join(RAW, 'berkeley_l7.json')))
    pdf_rows = json.load(open(os.path.join(HERE, 'berkeley_schedule.json')))['rows']
    pdf_index = BK.load_pdf_index(pdf_rows)
    route_index = BK.build_route_index(l7)

    rpp_index, rpp_rules = load_rpp()
    segs = []
    from_pdf = from_join = 0
    rpp_hits = 0
    for f in l6:
        path = longest_path(f.get('geometry'))
        if not path:
            continue
        attrs = f['attributes']
        geom = {'type': 'LineString', 'coordinates': _round(simplify(path))}

        # 1. The city's own schedule table, which knows which side is which.
        rows = BK.match_pdf(attrs, pdf_index)
        if rows:
            from_pdf += 1
            seg = add_compass(BK._segment(
                attrs, geom,
                [BK.side_from_pdf(r, attrs) for r in rows],
                [r['route'] for r in rows]))
            if attach_rpp(seg, rpp_index, rpp_rules):
                rpp_hits += 1
            segs.append(seg)
            continue

        # 2. Otherwise fall back to the geometric route join, which gives the two
        #    schedules but cannot say which belongs to which side.
        codes = []
        if (attrs.get('mech_sweep') or '').strip() == 'enforced':
            codes = BK.match_routes(path, route_index)
            if len(codes) == 2:
                from_join += 1
        seg = add_compass(BK.normalize(attrs, geom, codes))
        if attach_rpp(seg, rpp_index, rpp_rules):
            rpp_hits += 1
        segs.append(seg)

    print('  berkeley: %d centerlines -- %d from the city schedule table '
          '(true odd/even), %d from the geometric route join (side unknown), '
          '%d in a permit area'
          % (len(segs), from_pdf, from_join, rpp_hits), file=sys.stderr)
    return segs


# One entry per city. Adding a city is a row here plus a builder -- the frontend
# reads this and never hardcodes a place name, so coverage grows without
# touching the app.
CITIES = {
    'berkeley': {
        'name': 'Berkeley',
        'bbox': [-122.328, 37.845, -122.234, 37.906],
        'vintage': 'City schedule published March 2022.',
    },
    'oakland': {
        'name': 'Oakland',
        'bbox': [-122.355, 37.632, -122.114, 37.885],
        'vintage': 'City data last edited June 2021.',
    },
    'emeryville': {
        'name': 'Emeryville',
        'bbox': [-122.312, 37.826, -122.276, 37.853],
        'vintage': 'City data last edited August 2024.',
    },
}


# --- spatial tiles ----------------------------------------------------------
# Oakland is 2.6 MB, which is a slow parse on a phone and the whole point is to
# answer instantly on an NFC tap. The app only ever needs the blocks within a
# few hundred metres, so ship a grid: one file per cell, loaded with its eight
# neighbours. That turns a 2.6 MB parse into roughly 40 kB.
#
# The full city file stays for offline use -- the service worker can still cache
# everything, but the common path no longer pays for it.
TILE = 0.01      # degrees; ~1.1 km north-south, ~0.9 km east-west at this latitude


def tile_key(lon, lat):
    return (int(math.floor(lon / TILE)), int(math.floor(lat / TILE)))


def write_tiles(city, packed):
    """Returns the list of cell keys written, so the manifest can tell the app
    which cells exist -- otherwise every lookup in an overlapping city fires
    404s for cells that were never going to be there."""
    out = os.path.join(DATA, 'tiles', city)
    if os.path.isdir(out):
        for name in os.listdir(out):
            os.remove(os.path.join(out, name))
    os.makedirs(out, exist_ok=True)

    buckets = {}
    for seg in packed:
        # A block can straddle a cell boundary, so file it under every cell any
        # of its vertices falls in -- a segment missing from the cell you are
        # standing in is a block the app cannot answer for.
        for lon, lat in seg['g']:
            buckets.setdefault(tile_key(lon, lat), {})[seg['i']] = seg

    for (tx, ty), segs in buckets.items():
        name = '%d_%d.json' % (tx, ty)
        with open(os.path.join(out, name), 'w') as fh:
            json.dump({'segments': list(segs.values())}, fh, separators=(',', ':'))

    sizes = [os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)]
    print('  %s tiles: %d files, median %.0f kB, max %.0f kB'
          % (city, len(sizes), sorted(sizes)[len(sizes) // 2] / 1000.0,
             max(sizes) / 1000.0), file=sys.stderr)
    return sorted('%d_%d' % k for k in buckets)


def build_emeryville():
    raw = json.load(open(os.path.join(RAW, 'emeryville.json')))
    segs = []
    for f in raw:
        path = longest_path(f.get('geometry'))
        if not path:
            continue
        seg = EM.normalize(f['attributes'],
                           {'type': 'LineString',
                            'coordinates': _round(simplify(path))})
        if seg:
            segs.append(add_compass(seg))
    told = sum(1 for s in segs if s['sides'][0].get('note'))
    print('  emeryville: %d features -> %d segments (%d with an unstated week)'
          % (len(raw), len(segs), told), file=sys.stderr)
    return segs


def main():
    os.makedirs(DATA, exist_ok=True)
    summary = {}
    tile_keys = {}
    for city, segs in (('oakland', build_oakland()),
                       ('berkeley', build_berkeley()),
                       ('emeryville', build_emeryville())):
        active = [s for s in segs if has_any_schedule(s)]
        payload = {'city': city, 'segments': [pack(s) for s in active]}
        path = os.path.join(DATA, '%s.json' % city)
        with open(path, 'w') as fh:
            json.dump(payload, fh, separators=(',', ':'))
        size = os.path.getsize(path)
        tile_keys[city] = write_tiles(city, payload['segments'])
        summary[city] = {'segments': len(active),
                         'dropped_no_schedule': len(segs) - len(active),
                         'bytes': size}
        print('  wrote %s: %d segments, %.2f MB'
              % (path, len(active), size / 1e6), file=sys.stderr)
    with open(os.path.join(DATA, 'meta.json'), 'w') as fh:
        json.dump(summary, fh, indent=1, sort_keys=True)

    manifest = []
    # Tell the app the grid size so it can compute the cell itself.
    for city, info in sorted(CITIES.items()):
        entry = dict(info)
        entry['id'] = city
        entry['file'] = 'data/%s.json' % city
        entry['segments'] = summary.get(city, {}).get('segments', 0)
        entry['tiles'] = tile_keys.get(city, [])
        manifest.append(entry)
    with open(os.path.join(DATA, 'cities.json'), 'w') as fh:
        json.dump({'cities': manifest, 'tile': TILE}, fh, indent=1, sort_keys=True)
    print('  wrote cities.json: %d cities' % len(manifest), file=sys.stderr)


if __name__ == '__main__':
    main()
