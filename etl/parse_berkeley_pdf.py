"""Berkeley's residential schedule PDFs -> etl/berkeley_schedule.json.

This is the authoritative Berkeley source and it beats the GIS layers outright:
it carries side, address range, ordinal weekday, and AM/PM per block face. The
GIS spatial join can only tell you that two routes run along a street; this tells
you which side each one is.

The PDFs state the parity rule in their own header:

    "even numbered addresses on the south and west sides of the streets, and odd
     numbered addresses on the north and east sides. Opposite sides of the street
     are usually swept on different days."

They are static (published 2022-03), so this runs by hand rather than in the
monthly refresh -- that keeps poppler out of CI. Re-run it if the city
republishes the PDFs, and commit the regenerated JSON.

Requires: poppler (`brew install poppler` / `apt-get install poppler-utils`).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize_berkeley import normalize_street   # noqa: E402  (single source of truth)

BASE = 'https://berkeleyca.gov/sites/default/files/2022-03/'
PDFS = ['StreetSweepingSchedule_StNamesA-G.pdf',
        'StreetSweepingSchedule_StNamesH-Z.pdf',
        'StreetSweepingSchedule_StNumbered.pdf']
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'berkeley_schedule.json')

ROW = re.compile(
    r'^\s*(\d+)\s+(.+?)\s+([NSEW])\s+(\d+)\s+(\d+)\s+'
    r'((?:1st|2nd|3rd|4th)\s+\w+)\s+(AM|PM)\s*(.*)$')

# The PDF header's rule, used only as a fallback.
#
# The rule is "odd on the north and east sides", but on 31 of 708 rows the
# compass letter contradicts the row's own address range -- Grizzly Peak is
# marked E (odd by the rule) while carrying 400-1530. The address range wins:
# it is what the user can actually check, by reading the nearest house number,
# and it keeps the side label consistent with the range shown beside it.
SIDE_PARITY = {'N': 'odd', 'E': 'odd', 'S': 'even', 'W': 'even'}


def side_of(compass, lo, hi):
    if lo % 2 == hi % 2:              # range is unambiguously one parity
        return 'odd' if lo % 2 else 'even'
    return SIDE_PARITY[compass]       # mixed range: fall back to the stated rule
HOURS = {'AM': ('09:00', '12:00'), 'PM': ('12:30', '15:30')}


def extract(path):
    txt = subprocess.run(['pdftotext', '-layout', path, '-'],
                         capture_output=True, text=True, check=True).stdout
    rows = []
    for line in txt.splitlines():
        m = ROW.match(line.rstrip())
        if not m:
            continue
        rte, street, side, lo, hi, day, ampm, rest = m.groups()
        ordinal = {'1st': 1, '2nd': 2, '3rd': 3, '4th': 4}[day.split()[0]]
        weekday = {'mon': 1, 'tue': 2, 'tues': 2, 'wed': 3, 'thur': 4, 'thurs': 4,
                   'fri': 5}[day.split()[1].lower().rstrip('.')]
        start, end = HOURS[ampm]
        rows.append({
            'route': rte,
            'street': street.strip(),
            'key': normalize_street(street),
            'side': side_of(side, int(lo), int(hi)),
            'compass': side,
            'lo': int(lo), 'hi': int(hi),
            'ordinal': ordinal, 'weekday': weekday,
            'start': start, 'end': end,
            'opt_out': bool(re.search(r'\d', rest.split()[-1]) if rest.split() else False),
        })
    return rows


def main():
    rows = []
    with tempfile.TemporaryDirectory() as tmp:
        for name in PDFS:
            dest = os.path.join(tmp, name)
            print('  fetching %s' % name, file=sys.stderr)
            urllib.request.urlretrieve(BASE + name, dest)
            got = extract(dest)
            print('    %d rows' % len(got), file=sys.stderr)
            rows.extend(got)
    rows.sort(key=lambda r: (r['key'], r['lo'], r['side']))
    with open(OUT, 'w') as fh:
        json.dump({'source': BASE, 'rows': rows}, fh, indent=1, sort_keys=True)
    print('  wrote %s: %d rows, %d streets'
          % (OUT, len(rows), len(set(r['key'] for r in rows))), file=sys.stderr)


if __name__ == '__main__':
    main()
