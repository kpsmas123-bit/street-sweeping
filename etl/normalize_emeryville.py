"""Emeryville: coded domains, and the cleanest sweeping schema of the three.

Source: services3.arcgis.com/ljOdqLVbHpS7dOJQ
        /Street_Sweeping_Routes_Authoritative_view/FeatureServer/0
776 polylines, last edited August 2024 -- far fresher than either Berkeley or
Oakland.

Real coded-value domains, unlike Oakland's bare strings:
    Period     1 Once Per Month, 2 Twice Per Month
    TimeOfDay  1 8pm-5am, 2 8am-noon
    DayOfWeek  weekday names
    RouteClass Commercial / Residential / Mixed Use / Separated Detail / Not Swept
    DayOfMonth free text: "1st", "2nd", "1st & 3rd", "1st or 2nd"

Two things this source will not tell you, both of which have to be said rather
than filled in:

  * It has no side-of-street at all. Every other city here distinguishes the two
    kerbs; Emeryville does not, so a block carries one schedule covering both
    sides and the app must not offer an odd/even choice it cannot support.
  * "1st or 2nd" is not a schedule. 88 records say it, and no amount of parsing
    turns "or" into a date. They are marked unknown.
"""
import re

import schedule as S

WEEKDAY = {'sunday': S.SUN, 'monday': S.MON, 'tuesday': S.TUE, 'wednesday': S.WED,
           'thursday': S.THU, 'friday': S.FRI, 'saturday': S.SAT}

# TimeOfDay 1 runs past midnight. schedule.spans_midnight() is what keeps that
# from evaluating as "never".
TIME = {1: ('20:00', '05:00'), 2: ('08:00', '12:00')}

ORDINAL = {'1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5}

# "1st & 3rd" is a schedule; "1st or 2nd" is a shrug.
_ORD_RE = re.compile(r'(1st|2nd|3rd|4th|5th)', re.IGNORECASE)
_AMBIGUOUS = re.compile(r'\bor\b', re.IGNORECASE)


def clean(v):
    return '' if v is None else str(v).strip()


def parse(attrs):
    """-> (schedule, confidence)."""
    route_class = clean(attrs.get('RouteClass'))
    day = clean(attrs.get('DayOfWeek')).lower()
    dom = clean(attrs.get('DayOfMonth'))
    tod = attrs.get('TimeOfDay')

    if route_class == 'Not Swept':
        return S.NONE, 'exempt'
    if not day or day not in WEEKDAY:
        return S.UNKNOWN, 'unknown'

    start, end = TIME.get(tod, (None, None))

    if _AMBIGUOUS.search(dom):
        # "1st or 2nd Thursday" -- the city itself is not committing, so neither
        # can we. But the weekday and the window ARE known, and dropping the
        # block entirely would report no data for a street that is definitely
        # swept. Carry the weekday and time with no ordinals, so the app can say
        # what is known and name what is not.
        sched = S.make('unknown', [], [WEEKDAY[day]], start, end)
        return sched, 'unknown'

    ordinals = [ORDINAL[m.lower()] for m in _ORD_RE.findall(dom)]
    if not ordinals:
        return S.UNKNOWN, 'unknown'

    sched = S.make('nth_weekday', ordinals, [WEEKDAY[day]], start, end)
    if start is None:
        return sched, 'no_time'
    return sched, 'ok'


def street_name(attrs):
    return clean(attrs.get('StreetName')).title()


def normalize(attrs, geometry):
    sched, confidence = parse(attrs)
    if sched['kind'] == 'none' and confidence == 'exempt':
        return None                     # not swept; nothing to say about it

    # Freeway ramps and connectors carry no day, no class and no time. There is
    # nothing to tell anyone about them, and shipping them as "unknown" would
    # put "check the sign" on stretches of I-80 with no kerb.
    if (sched['kind'] == 'unknown' and not sched['weekdays']
            and not clean(attrs.get('RouteClass'))):
        return None

    note = None
    if confidence == 'unknown' and sched['weekdays']:
        note = ('The city lists this as "%s %s" — which week is not stated, '
                'so go by the sign.' % (clean(attrs.get('DayOfMonth')),
                                        clean(attrs.get('DayOfWeek'))))

    return {
        'city': 'emeryville',
        'segment_id': 'em-%s' % attrs.get('OBJECTID'),
        'street': street_name(attrs),
        'sides': [{
            # One schedule for the whole block: the source records no sides, so
            # offering an odd/even choice would invent a distinction.
            'side': 'both',
            'hand': None,
            'addr_from': None, 'addr_to': None,
            'schedule': sched,
            'confidence': confidence,
            'note': note,
            'raw': {'day': clean(attrs.get('DayOfWeek')),
                    'dayOfMonth': clean(attrs.get('DayOfMonth')),
                    'timeOfDay': attrs.get('TimeOfDay'),
                    'routeClass': clean(attrs.get('RouteClass')),
                    'notes': clean(attrs.get('Notes'))},
        }],
        'one_way': None,
        'route': clean(attrs.get('RouteType')) or None,
        'geometry': geometry,
    }
