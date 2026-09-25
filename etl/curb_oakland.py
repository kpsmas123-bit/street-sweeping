"""Oakland downtown kerb inventory: what the kerb itself is.

Source: services.arcgis.com/9tC74aDHuml0x5Yz .../Downtown_Parking/FeatureServer/0
2,558 blockface polylines, last edited May 2022. Downtown only.

Sweeping tells you when you must move. This tells you whether you could park
there in the first place -- a red kerb, a bus stop, a two-hour meter. It is the
only kerb-level inventory published anywhere in the East Bay.

`SIDE_1` is North/South/East/West, which lines up with the compass direction
already derived for each side of a block, so a regulation can be attached to the
correct kerb rather than the whole street.

Two fields look useful and are not:
  * REG_CODE / DEFINITION are effectively empty -- two distinct values, both
    blank. The real vocabulary is in SPACE_REG.
  * ENFORCE_BE / ENFORCE_EN are times-of-day stored as epochs on 1900-01-01, and
    every populated row holds the identical value. They carry no information, so
    the enforcement HOURS are unknown even though the days are published.
"""
import json
import math
import os
import sys
import urllib.parse
import urllib.request

BASE = ('https://services.arcgis.com/9tC74aDHuml0x5Yz/arcgis/rest/services'
        '/Downtown_Parking/FeatureServer/0/query')
FIELDS = ('OBJECTID,SPACE_REG,LIMITS,METERED,METER_RATE,ENFORCE_DA,SIDE_1,'
          'STREET_1,TOTAL_SP_1')
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'oakland_curb.json')

MY = 110574.0

# Regulations that mean "you cannot park here at all", as opposed to "you can,
# with a limit". The distinction is the whole point of showing this.
NO_PARK = {
    'No Parking', 'Bus Stop', 'Taxi', 'Truck Loading', 'Paratransit',
    'Handicapped', 'Police', 'Fire Department Only', 'Fire Marshal Only',
    "Mayor's Vehicle Only", 'City Officials', 'City Council Staff',
    'City Vehicles Only', 'Official Cars Only', 'Official Vehicles Only',
    'OCIS Vehicles Only', 'Transportation Vehicles Only',
    'Press and City Vehicles Only', 'Alameda County Placards Only',
    'BART Vehicle Only', 'City Car Share', 'Red Curb',
}

SIDE_TO_COMPASS = {'North': 'N', 'South': 'S', 'East': 'E', 'West': 'W'}


def _mx(lat):
    return 111320.0 * math.cos(math.radians(lat))


def clean(v):
    return '' if v is None else str(v).strip()


def fetch():
    out = []
    offset = 0
    while True:
        q = urllib.parse.urlencode({
            'where': '1=1', 'outFields': FIELDS, 'returnGeometry': 'true',
            'outSR': 4326, 'orderByFields': 'OBJECTID',
            'resultOffset': offset, 'resultRecordCount': 1000, 'f': 'geojson'})
        with urllib.request.urlopen(BASE + '?' + q, timeout=90) as r:
            d = json.load(r)
        feats = d.get('features', [])
        out.extend(feats)
        print('    offset %-5d got %d' % (offset, len(feats)), file=sys.stderr)
        if len(feats) < 1000:
            return out
        offset += 1000


def describe(a):
    """A one-line human reading of the kerb, or None if there is nothing to say."""
    reg = clean(a.get('SPACE_REG'))
    limit = clean(a.get('LIMITS'))
    metered = clean(a.get('METERED')).upper() == 'Y'
    rate = clean(a.get('METER_RATE'))
    days = clean(a.get('ENFORCE_DA'))

    if not reg or reg == 'Unmarked':
        return None

    if reg in NO_PARK:
        return {'kind': 'no_park', 'text': reg, 'days': days or None}

    bits = []
    if metered:
        bits.append('Metered' + (' ' + rate if rate else ''))
    elif reg and reg not in ('Meter', 'No Meter'):
        bits.append(reg)
    if limit:
        bits.append(limit.replace('-', ' ') + ' limit')
    if not bits:
        return None
    return {'kind': 'limited', 'text': ', '.join(bits), 'days': days or None}


def build_index(features):
    rows = []
    for f in features:
        a = f.get('properties') or {}
        geom = f.get('geometry') or {}
        if geom.get('type') != 'LineString':
            continue
        line = geom['coordinates']
        if len(line) < 2:
            continue
        info = describe(a)
        if not info:
            continue
        xs = [p[0] for p in line]
        ys = [p[1] for p in line]
        rows.append({
            'b': [min(xs), min(ys), max(xs), max(ys)],
            'g': line,
            'f': SIDE_TO_COMPASS.get(clean(a.get('SIDE_1'))),
            'k': info['kind'],
            't': info['text'],
            'd': info['days'],
        })
    return rows


def _dist(lon, lat, line):
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


def curb_for(lon, lat, compass, index, tol_m=22.0):
    """Nearest blockface on the same side of the street.

    The compass match is what keeps a regulation on the kerb it belongs to: a
    blockface line sits within a few metres of its opposite number, so distance
    alone would attach a red kerb to the wrong side about half the time.
    """
    best, best_d = None, tol_m
    pad = 0.0004
    for row in index:
        if compass and row['f'] and row['f'] != compass:
            continue
        b = row['b']
        if lon < b[0] - pad or lon > b[2] + pad or lat < b[1] - pad or lat > b[3] + pad:
            continue
        d = _dist(lon, lat, row['g'])
        if d < best_d:
            best_d, best = d, row
    return best


def main():
    print('  fetching Oakland downtown kerbs', file=sys.stderr)
    feats = fetch()
    index = build_index(feats)
    kinds = {}
    for r in index:
        kinds[r['k']] = kinds.get(r['k'], 0) + 1
    print('  %d blockfaces, %d with a regulation worth stating %s'
          % (len(feats), len(index), kinds), file=sys.stderr)
    with open(OUT, 'w') as fh:
        json.dump({'index': index}, fh, separators=(',', ':'))
    print('  wrote %s (%.0f kB)' % (OUT, os.path.getsize(OUT) / 1000.0),
          file=sys.stderr)


if __name__ == '__main__':
    main()
