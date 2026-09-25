"""Oakland Residential Permit Parking zones.

Source: Socrata su5x-2u99, 842 curb-line segments carrying a zone letter, which
is the same data as the RPP_Curbs feature services but exported cleanly as
GeoJSON. Zones A-R with no H.

Unlike Berkeley, Oakland does not publish the enforcement hours or the time
limit anywhere machine-readable -- not on the RPP pages, not in the feature
service, and they vary by zone. So this carries the zone only, and the app says
the hours are unpublished rather than borrowing Berkeley's two-hour rule and
presenting a guess as a rule. Knowing you are in a permit zone at all is most of
the value; the sign carries the rest.
"""
import json
import math
import os
import sys
import urllib.request

SOURCE = 'https://data.oaklandca.gov/resource/su5x-2u99.geojson'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'oakland_rpp.json')

MY = 110574.0


def _mx(lat):
    return 111320.0 * math.cos(math.radians(lat))


def fetch():
    with urllib.request.urlopen(SOURCE, timeout=90) as r:
        return json.load(r)


def build_index(geo):
    """Zone curb lines as flat segment lists with a bbox, for proximity match."""
    out = []
    for f in geo.get('features', []):
        zone = (f['properties'].get('rpp_zone') or '').strip().upper()
        geom = f.get('geometry') or {}
        if not zone or geom.get('type') != 'MultiLineString':
            continue
        for line in geom['coordinates']:
            if len(line) < 2:
                continue
            xs = [p[0] for p in line]
            ys = [p[1] for p in line]
            out.append({'z': zone,
                        'b': [min(xs), min(ys), max(xs), max(ys)],
                        'g': line})
    return out


def _dist_to_line(lon, lat, line):
    mx = _mx(lat)
    px, py = lon * mx, lat * MY
    best = float('inf')
    for a, b in zip(line, line[1:]):
        ax, ay = a[0] * mx, a[1] * MY
        bx, by = b[0] * mx, b[1] * MY
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
        d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
        if d < best:
            best = d
    return best


def zone_for(lon, lat, index, tol_m=25.0):
    """Nearest zone curb within tolerance. 25 m is about a street width plus
    slack -- wide enough to catch the kerb line for the block you are on, tight
    enough not to borrow the zone from the next street over."""
    pad = 0.0005
    best_z, best_d = None, tol_m
    for row in index:
        b = row['b']
        if lon < b[0] - pad or lon > b[2] + pad or lat < b[1] - pad or lat > b[3] + pad:
            continue
        d = _dist_to_line(lon, lat, row['g'])
        if d < best_d:
            best_d, best_z = d, row['z']
    return best_z


def main():
    print('  fetching Oakland RPP curbs', file=sys.stderr)
    geo = fetch()
    index = build_index(geo)
    zones = sorted(set(r['z'] for r in index))
    print('  %d zone curb lines, zones %s' % (len(index), ','.join(zones)),
          file=sys.stderr)
    with open(OUT, 'w') as fh:
        json.dump({'index': index}, fh, separators=(',', ':'))
    print('  wrote %s (%.0f kB)' % (OUT, os.path.getsize(OUT) / 1000.0),
          file=sys.stderr)


if __name__ == '__main__':
    main()
