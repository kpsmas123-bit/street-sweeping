"""Oakland: coded-value domain lookup.

Source: services.arcgis.com/9tC74aDHuml0x5Yz .../StreetSweeping/FeatureServer/0
Transcribed from paper maps by a GIS intern in 2013; last edited June 2021.

Two domains are keyed by FIELD NAME, never by code alone -- 'M1' and 'M2' mean
different things in the day domain than in the time domain.
"""
import schedule as S

# --- DAY domain (StreetSweepingD) -------------------------------------------
# value -> (kind, ordinals, weekdays)
_WEEKLY = {
    'E':     [S.SUN, S.MON, S.TUE, S.WED, S.THU, S.FRI, S.SAT],
    'EEH':   [S.SUN, S.MON, S.TUE, S.WED, S.THU, S.FRI, S.SAT],
    'EESSH': [S.MON, S.TUE, S.WED, S.THU, S.FRI],
    'MF':    [S.MON, S.TUE, S.WED, S.THU, S.FRI],
    'ME':    [S.MON],
    'TE':    [S.TUE],
    'WE':    [S.WED],
    'THE':   [S.THU],
    'FE':    [S.FRI],
    'S':     [S.SAT],
    'SU':    [S.SUN],
    'MWF':   [S.MON, S.WED, S.FRI],
    'TTH':   [S.TUE, S.THU],
    'TTHE':  [S.TUE, S.THU],
    'TTHS':  [S.TUE, S.THU, S.SAT],
    'TFE':   [S.TUE, S.FRI],
    'MTHE':  [S.MON, S.THU],
    'THFE':  [S.THU, S.FRI],
    'MFE':   [S.MON, S.FRI],
}

_NTH = {
    'M1': ([1], S.MON),   'M2': ([2], S.MON),   'M13': ([1, 3], S.MON), 'M24': ([2, 4], S.MON),
    'T1': ([1], S.TUE),   'T2': ([2], S.TUE),   'T13': ([1, 3], S.TUE), 'T24': ([2, 4], S.TUE),
    'W2': ([2], S.WED),   'W4': ([4], S.WED),   'W13': ([1, 3], S.WED), 'FW': ([1], S.WED),
    'TH1': ([1], S.THU),  'TH2': ([2], S.THU),  'TH4': ([4], S.THU),    'TH13': ([1, 3], S.THU),
    'F1': ([1], S.FRI),   'F2': ([2], S.FRI),   'F4': ([4], S.FRI),     'F13': ([1, 3], S.FRI),
}

# Codes that mean "no sweeping here", with the confidence they imply.
_NO_SWEEP = {
    'N':     'exempt',      # No Sweeping (Exempt)
    'NS':    'exempt',      # No Sweeping (within city limit)
    'NS-UC': 'exempt',      # Uncontrolled condition
    'NS-H':  'exempt',      # Highway
    'NS-O':  'exempt',      # Outside city limit
    'NS-A':  'exempt',      # Alleyway
    'N-S':   'no_signage',  # No signage posted
    'N-O':   'exempt',      # No odd addresses on this block
    'N-E':   'exempt',      # No even addresses on this block
    'O':     'exempt',      # "There is no this side of the street"
}

# Codes that are not schedules at all -- they redirect you elsewhere.
SIDE_POINTER = 'MS'   # this side lives on the other of two coincident lines
_OPAQUE = {'DM': 'unknown', 'missing': 'unknown'}   # 'missing' is undocumented but real (85 recs)

# --- TIME domain (StreetSweepingT) ------------------------------------------
_TIME = {
    'M1':  ('00:00', '03:00'),
    'M2':  ('03:00', '06:00'),
    'M23': ('02:00', '03:00'),
    'M68': ('06:00', '08:00'),
    'M3':  ('09:00', '12:00'),
    'A1':  ('12:30', '15:30'),
    'NA':  (None, None),
}


def clean(v):
    """Empty cells in this service are ' ' (a single space), not null."""
    if v is None:
        return ''
    return str(v).strip()


def parse_side(day_code, time_code, doublecheck):
    """One side of one block -> (schedule, confidence) or None if this line
    does not represent that side at all."""
    day = clean(day_code)
    time = clean(time_code)

    if day == SIDE_POINTER:
        return None          # the other coincident line carries this side
    if not day:
        return S.UNKNOWN, 'unknown'
    if day in _OPAQUE:
        return S.UNKNOWN, _OPAQUE[day]
    if day in _NO_SWEEP:
        return S.NONE, _NO_SWEEP[day]

    start, end = _TIME.get(time, (None, None))

    if day in _WEEKLY:
        sched = S.make('weekly', [], _WEEKLY[day], start, end)
    elif day in _NTH:
        ordinals, weekday = _NTH[day]
        sched = S.make('nth_weekday', ordinals, [weekday], start, end)
    else:
        return S.UNKNOWN, 'unknown'      # code outside the documented domain

    if start is None:
        confidence = 'no_time'           # a real sweep day with no posted window
    elif clean(doublecheck).upper() == 'Y':
        confidence = 'flagged'           # Oakland's own QC flag
    else:
        confidence = 'ok'
    return sched, confidence


def street_name(a):
    parts = [clean(a.get('PREFIX')), clean(a.get('NAME')),
             clean(a.get('TYPE')), clean(a.get('SUFFIX'))]
    return ' '.join(p for p in parts if p)


def normalize(attrs, geometry):
    """One source feature -> one normalized segment with 1-2 sides, or None."""
    sides = []
    for label, dayf, timef, f_add, t_add in (
        ('odd',  'DAY_ODD',  'TIME_ODD',  'L_F_ADD', 'L_T_ADD'),
        ('even', 'DAY_EVEN', 'TIME_EVEN', 'R_F_ADD', 'R_T_ADD'),
    ):
        parsed = parse_side(attrs.get(dayf), attrs.get(timef), attrs.get('DOUBLECK'))
        if parsed is None:
            continue
        sched, confidence = parsed
        sides.append({
            'side': label,
            'addr_from': clean(attrs.get(f_add)) or None,
            'addr_to': clean(attrs.get(t_add)) or None,
            'schedule': sched,
            'confidence': confidence,
            'raw': {'day': clean(attrs.get(dayf)), 'time': clean(attrs.get(timef))},
        })
    if not sides:
        return None
    return {
        'city': 'oakland',
        'segment_id': 'oak-%s' % attrs.get('OBJECTID'),
        'street': street_name(attrs),
        'sides': sides,
        'one_way': clean(attrs.get('ONE_WAY')) or None,
        'route': clean(attrs.get('ROUTE')) or None,
        'geometry': geometry,
    }
