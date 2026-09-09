"""Schedule model + date math shared by both city normalizers.

Weekdays are 0=Sun .. 6=Sat (matches JS Date.getDay(), which the frontend uses).
"""
from datetime import date, timedelta

SUN, MON, TUE, WED, THU, FRI, SAT = range(7)


def make(kind='unknown', ordinals=None, weekdays=None, start=None, end=None):
    return {
        'kind': kind,
        'ordinals': sorted(ordinals or []),
        'weekdays': sorted(weekdays or []),
        'start': start,
        'end': end,
    }


NONE = make('none')
UNKNOWN = make('unknown')


def nth_weekday_of_month(year, month, weekday, n):
    """The date of the nth `weekday` in `year`-`month`, or None if it doesn't exist.

    "2nd Monday" means the 2nd Monday appearing on the calendar page for that
    month -- NOT the Monday of the 2nd week. A month beginning on Tuesday has
    its 1st Monday on the 7th, so its 2nd Monday is the 14th.
    """
    if not 1 <= n <= 5:
        return None
    first = date(year, month, 1)
    # weekday(): Mon=0..Sun=6 -> our Sun=0..Sat=6
    first_dow = (first.weekday() + 1) % 7
    offset = (weekday - first_dow) % 7
    day = 1 + offset + (n - 1) * 7
    try:
        return date(year, month, day)
    except ValueError:
        return None


def occurs_on(sched, d):
    """Does `sched` sweep on date `d`? Holidays are applied separately."""
    kind = sched['kind']
    if kind in ('none', 'unknown'):
        return False
    dow = (d.weekday() + 1) % 7
    if dow not in sched['weekdays']:
        return False
    if kind == 'weekly':
        return True
    if kind == 'nth_weekday':
        # which ordinal occurrence of this weekday is d?
        nth = (d.day - 1) // 7 + 1
        return nth in sched['ordinals']
    return False


def next_occurrences(sched, after, limit=3, horizon_days=70, is_holiday=None,
                     holiday_rule='skip'):
    """Upcoming sweep dates strictly after `after` (a date).

    holiday_rule: 'skip' drops the sweep entirely; 'defer' would move it, but no
    city we support defers, so only 'skip' is implemented.
    """
    out = []
    d = after
    for _ in range(horizon_days):
        d = d + timedelta(days=1)
        if not occurs_on(sched, d):
            continue
        if is_holiday and is_holiday(d):
            if holiday_rule == 'skip':
                continue
            raise NotImplementedError('only skip is supported')
        out.append(d)
        if len(out) >= limit:
            break
    return out
