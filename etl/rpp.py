"""Berkeley Residential Preferential Parking: which permit area a block is in.

RPP is the most common parking citation after sweeping -- a two-hour limit for
anyone without a permit for that area -- and Berkeley publishes it on a separate
ArcGIS org from everything else, updated far more recently than the sweeping
data.

Two sources:
  * polygons  services1.arcgis.com/IYiCpZoSIq9lAxi8 .../Public_Online_RPP_Map_WFL1/10
              "Streets with RPP Restrictions", 26 areas including overlap zones
              like "AREA AB" where either permit is valid.
  * hours     the city's RPP Enforcement Schedule PDF, which is where the time
              limit and enforced days actually live.

The polygons say where; the PDF says what. Neither says it alone.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

RPP_LAYER = ('https://services1.arcgis.com/IYiCpZoSIq9lAxi8/arcgis/rest/services'
             '/Public_Online_RPP_Map_WFL1/FeatureServer/10/query')
SCHEDULE_PDF = ('https://berkeleyca.gov/sites/default/files/documents/'
                'RPP%20Enforcement%20Schedule.pdf')

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'berkeley_rpp.json')

# "Area C   2 Hr Parking   Mon - Fri   8am - 7pm". The limit column wraps onto
# its own line in every row, so it is matched separately rather than inline.
_ROW = re.compile(
    r'Area\s+([A-Z]{1,2})\s{2,}(Mon[^\s]*\s*[-–]\s*\w+)\s{2,}'
    r'(\d+\s*am)\s*-\s*(\d+\s*pm)', re.IGNORECASE)

_DAYS = {'mon - fri': [1, 2, 3, 4, 5], 'mon – fri': [1, 2, 3, 4, 5],
         'mon - sat': [1, 2, 3, 4, 5, 6], 'mon – sat': [1, 2, 3, 4, 5, 6]}


def _hour(txt):
    m = re.match(r'(\d+)\s*(am|pm)', txt.strip(), re.IGNORECASE)
    if not m:
        return None
    h = int(m.group(1)) % 12
    if m.group(2).lower() == 'pm':
        h += 12
    return '%02d:00' % h


def parse_schedule(pdf_path):
    txt = subprocess.run(['pdftotext', '-layout', pdf_path, '-'],
                         capture_output=True, text=True, check=True).stdout
    out = {}
    for area, days, start, end in _ROW.findall(txt):
        key = days.lower().replace('–', '-')
        weekdays = _DAYS.get(key)
        if not weekdays:
            continue
        out[area.upper()] = {
            'limit_minutes': 120,      # every Berkeley area is a 2-hour limit
            'weekdays': weekdays,
            'start': _hour(start),
            'end': _hour(end),
        }
    parse_area_e(txt, out)
    return out


# Area E's row wraps as "Mon - Fri, / Sat*" with the footnote "Some streets
# enforce on Sat. Please check posted signage." The weekdays are certain;
# Saturday genuinely is not, so it is carried as a caveat rather than resolved
# one way or the other.
_ROW_E = re.compile(r'Area\s+E\s{2,}(\d+\s*am)\s*-\s*(\d+\s*pm)', re.IGNORECASE)


def parse_area_e(txt, out):
    if 'E' in out:
        return
    m = _ROW_E.search(txt)
    if not m:
        return
    out['E'] = {
        'limit_minutes': 120,
        'weekdays': [1, 2, 3, 4, 5],
        'start': _hour(m.group(1)),
        'end': _hour(m.group(2)),
        'note': 'Some Area E streets also enforce on Saturday - check the sign.',
    }


def combine(letters, schedule):
    """An overlap zone such as "AB" or "NE" is not a row in the table; it means
    either permit is valid there. Take the union of the constituent areas'
    enforced days, which is the most restrictive reading, and say which permits
    apply. If any constituent has no published hours, the whole zone stays
    unknown rather than half-guessed."""
    if letters in schedule:
        return schedule[letters]
    parts = [schedule.get(ch) for ch in letters]
    if not parts or any(p is None for p in parts):
        return None
    notes = [p['note'] for p in parts if p.get('note')]
    notes.append('A permit for area ' + ' or '.join(letters) + ' is valid here.')
    return {
        'limit_minutes': max(p['limit_minutes'] for p in parts),
        'weekdays': sorted(set(d for p in parts for d in p['weekdays'])),
        'start': min(p['start'] for p in parts),
        'end': max(p['end'] for p in parts),
        'note': ' '.join(notes),
    }


def fetch_areas():
    q = urllib.parse.urlencode({
        'where': '1=1', 'outFields': 'Area', 'outSR': 4326, 'f': 'geojson'})
    with urllib.request.urlopen(RPP_LAYER + '?' + q, timeout=90) as r:
        return json.load(r)


# --- point in polygon -------------------------------------------------------
def _in_ring(pt, ring):
    x, y = pt
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if (y1 > y) != (y2 > y):
            xt = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < xt:
                inside = not inside
    return inside


def _in_polygon(pt, poly):
    """poly is a GeoJSON Polygon coordinate array: [outer, hole, hole...]."""
    if not poly or not _in_ring(pt, poly[0]):
        return False
    for hole in poly[1:]:
        if _in_ring(pt, hole):
            return False
    return True


def build_index(geojson):
    """[(area_letters, bbox, [polygon, ...]), ...] with a bbox for cheap reject."""
    index = []
    for f in geojson.get('features', []):
        raw = (f['properties'].get('Area') or '').strip().upper()
        letters = raw.replace('AREA', '').strip()
        if not letters:
            continue
        geom = f.get('geometry') or {}
        polys = []
        if geom.get('type') == 'Polygon':
            polys = [geom['coordinates']]
        elif geom.get('type') == 'MultiPolygon':
            polys = geom['coordinates']
        if not polys:
            continue
        xs, ys = [], []
        for poly in polys:
            for x, y in poly[0]:
                xs.append(x)
                ys.append(y)
        index.append((letters, (min(xs), min(ys), max(xs), max(ys)), polys))
    return index


def area_for(lon, lat, index):
    for letters, bbox, polys in index:
        if lon < bbox[0] or lon > bbox[2] or lat < bbox[1] or lat > bbox[3]:
            continue
        for poly in polys:
            if _in_polygon((lon, lat), poly):
                return letters
    return None


def main():
    print('  fetching RPP areas', file=sys.stderr)
    geo = fetch_areas()
    with tempfile.TemporaryDirectory() as tmp:
        pdf = os.path.join(tmp, 'rpp.pdf')
        print('  fetching enforcement schedule', file=sys.stderr)
        urllib.request.urlretrieve(SCHEDULE_PDF, pdf)
        schedule = parse_schedule(pdf)

    index = build_index(geo)
    letters = sorted(set(a for a, _, _ in index))
    resolved = {}
    for a in letters:
        rule = combine(a, schedule)
        if rule:
            resolved[a] = rule
    missing = [a for a in letters if a not in resolved]
    print('  %d RPP polygons, %d areas, rules resolved for %d'
          % (len(index), len(letters), len(resolved)), file=sys.stderr)
    if missing:
        print('  no published hours for: %s (left unknown)' % ', '.join(missing),
              file=sys.stderr)

    with open(OUT, 'w') as fh:
        json.dump({'schedule': resolved,
                   'areas': [{'letters': a, 'bbox': list(b), 'polygons': p}
                             for a, b, p in index]},
                  fh, separators=(',', ':'))
    print('  wrote %s (%.0f kB)' % (OUT, os.path.getsize(OUT) / 1000.0),
          file=sys.stderr)


if __name__ == '__main__':
    main()
