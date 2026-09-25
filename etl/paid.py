"""Where paying for parking is actually a thing.

The app used to offer ParkMobile on every block, which is wrong nearly
everywhere: most of Berkeley and Oakland is unmetered residential street, and a
pay-by-phone button there is noise at best. ParkMobile also needs a zone number
off the meter or the sign, so the offer is meaningless where there is no meter.

So the offer is now evidence-led. Two sources, both from the cities themselves:

  * Oakland -- `Oakland_Parking_Meters`, 8,107 rows, last edited 2025-09-13.
    Only 4,405 have real coordinates and status Active; the rest are spares
    sitting at 0,0 (null island) waiting to be installed. A meter point is
    precise, so it is attached to the kerb it stands on.

  * Berkeley -- `goBerkeley_Areas`, 54 polygons, last edited 2026-03-03, with
    the hourly rate and the posted time limit. These are neighbourhood-scale
    areas, not blockfaces: being inside one means "this is a paid-parking
    district", not "this exact kerb has a meter". The wording in the app says
    so.

Emeryville has meters (ParkMobile zones 20001-20042, Triangle and North Hollis)
but publishes no layer for them -- its sign inventory carries 933 signs and not
one of them is a meter sign. So no offer is made there. Absence of evidence is
the safe direction to fail: someone who wants ParkMobile can always open it
themselves, whereas a wrong offer is exactly what was being complained about.
"""
import json
import math
import os
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'paid.json')

OAK_METERS = ('https://services.arcgis.com/9tC74aDHuml0x5Yz/arcgis/rest/services'
              '/Oakland_Parking_Meters/FeatureServer/0/query')
BERK_AREAS = ('https://services1.arcgis.com/IYiCpZoSIq9lAxi8/arcgis/rest/services'
              '/goBerkeley_Areas/FeatureServer/0/query')

MY = 110574.0
METER_TOL_M = 30.0      # a meter stands on the sidewalk, not on the centreline
CELL = 0.002            # ~180 m; the index cell for the meter lookup


def _mx(lat):
    return 111320.0 * math.cos(math.radians(lat))


def clean(v):
    return '' if v is None else str(v).strip()


# --- fetch ------------------------------------------------------------------
def fetch_meters():
    out = []
    offset = 0
    while True:
        q = urllib.parse.urlencode({
            'where': '1=1', 'outFields': 'OBJECTID,POLE_STATU,METER_TYPE',
            'returnGeometry': 'true', 'outSR': 4326, 'orderByFields': 'OBJECTID',
            'resultOffset': offset, 'resultRecordCount': 1000, 'f': 'geojson'})
        with urllib.request.urlopen(OAK_METERS + '?' + q, timeout=90) as r:
            d = json.load(r)
        feats = d.get('features', [])
        out.extend(feats)
        print('    meters offset %-5d got %d' % (offset, len(feats)), file=sys.stderr)
        if len(feats) < 1000:
            break
        offset += 1000

    pts = []
    for f in out:
        a = f.get('properties') or {}
        if clean(a.get('POLE_STATU')) != 'Active':
            continue
        g = f.get('geometry') or {}
        c = g.get('coordinates')
        # Spares are stored at 0,0. Anything outside Oakland's box is a spare or
        # a bad fix, and would otherwise drag a meter onto an unrelated block.
        if not c or not (-122.36 < c[0] < -122.11) or not (37.63 < c[1] < 37.89):
            continue
        pts.append([round(c[0], 5), round(c[1], 5)])
    print('  oakland meters: %d rows -> %d active with real coordinates'
          % (len(out), len(pts)), file=sys.stderr)
    return pts


def fetch_berkeley_areas():
    q = urllib.parse.urlencode({
        'where': '1=1', 'outFields': '*', 'returnGeometry': 'true',
        'outSR': 4326, 'f': 'geojson'})
    with urllib.request.urlopen(BERK_AREAS + '?' + q, timeout=90) as r:
        d = json.load(r)

    areas = []
    for f in d.get('features', []):
        a = f.get('properties') or {}
        g = f.get('geometry') or {}
        if g.get('type') == 'Polygon':
            rings = [g['coordinates'][0]]
        elif g.get('type') == 'MultiPolygon':
            rings = [poly[0] for poly in g['coordinates']]
        else:
            continue
        xs = [p[0] for r_ in rings for p in r_]
        ys = [p[1] for r_ in rings for p in r_]
        rate = clean(a.get('Hourly_rat'))
        if rate and not rate.startswith('$'):
            rate = '$' + rate          # one row stores 1.50 without the sign
        areas.append({
            'n': clean(a.get('Area')) or clean(a.get('Name')),
            'r': rate or None,
            # "2 Hour\n" appears once; a stray newline would break the line.
            'l': ' '.join(clean(a.get('Time_limit')).split()) or None,
            'x': clean(a.get('Notes')) or None,
            'b': [min(xs), min(ys), max(xs), max(ys)],
            'p': [[[round(p[0], 5), round(p[1], 5)] for p in r_] for r_ in rings],
        })
    print('  berkeley paid areas: %d' % len(areas), file=sys.stderr)
    return areas


# --- lookup -----------------------------------------------------------------
def build_meter_index(pts):
    grid = {}
    for p in pts:
        key = '%d,%d' % (math.floor(p[0] / CELL), math.floor(p[1] / CELL))
        grid.setdefault(key, []).append(p)
    return grid


def _near(lon, lat, grid):
    cx, cy = math.floor(lon / CELL), math.floor(lat / CELL)
    out = []
    for i in (-1, 0, 1):
        for j in (-1, 0, 1):
            out.extend(grid.get('%d,%d' % (cx + i, cy + j), ()))
    return out


def _closest(p, pts):
    """Distance from p to the polyline, plus the signed side it falls on.

    Sign is the cross product in metres-east / metres-north, so positive is to
    the left of the direction the line is drawn in -- the same hand convention
    build.py uses to turn a bearing into a compass letter.
    """
    mx = _mx(p[1])
    px, py = p[0] * mx, p[1] * MY
    best, side = float('inf'), 0.0
    for a, b in zip(pts, pts[1:]):
        ax, ay = a[0] * mx, a[1] * MY
        bx, by = b[0] * mx, b[1] * MY
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
        d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
        if d < best:
            best = d
            side = dx * (py - ay) - dy * (px - ax)
    return best, side


def _cardinal(deg):
    deg %= 360
    if deg < 45 or deg >= 315:
        return 'N'
    if deg < 135:
        return 'E'
    if deg < 225:
        return 'S'
    return 'W'


def meters_on_block(pts, grid, bearing, tol=METER_TOL_M):
    """Which compass sides of this block have a meter standing on them.

    Returns (set of compass letters, total meters near the block). The letters
    are empty when the block has no usable bearing, in which case the caller
    only knows the block is metered, not which kerb -- which is still enough to
    decide whether to offer a way to pay.
    """
    hits = set()
    total = 0
    for p in _near(pts[len(pts) // 2][0], pts[len(pts) // 2][1], grid):
        d, side = _closest(p, pts)
        if d > tol:
            continue
        total += 1
        if bearing is None or side == 0:
            continue
        hits.add(_cardinal(bearing - 90 if side > 0 else bearing + 90))
    return hits, total


def _in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            x = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lon < x:
                inside = not inside
        j = i
    return inside


def area_for(lon, lat, areas):
    """The paid-parking area containing this point, or None.

    Where areas overlap -- Berkeley draws a Premium box inside a Value district
    in a few places -- the smaller one wins, because that is the rate posted on
    the block itself.
    """
    best = None
    best_size = None
    for a in areas:
        b = a['b']
        if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
            continue
        if not any(_in_ring(lon, lat, r) for r in a['p']):
            continue
        size = (b[2] - b[0]) * (b[3] - b[1])
        if best_size is None or size < best_size:
            best, best_size = a, size
    return best


def main():
    payload = {
        'oakland': {'meters': fetch_meters()},
        'berkeley': {'areas': fetch_berkeley_areas()},
    }
    with open(OUT, 'w') as fh:
        json.dump(payload, fh, separators=(',', ':'))
    print('  wrote %s (%.0f kB)' % (OUT, os.path.getsize(OUT) / 1024), file=sys.stderr)


if __name__ == '__main__':
    main()
