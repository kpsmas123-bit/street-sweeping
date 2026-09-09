# Street Sweeping — Berkeley & Oakland

Park, open it on your phone, find out whether you're about to be ticketed and
when you need to move.

**Advisory only. Posted signs are the legal authority.** City data is transcribed,
years old in places, and wrong in places. Read the sign before you walk away.

## How it works

Static site, no backend. The ETL runs offline and commits normalized JSON; the
page loads it, snaps your GPS fix to the nearest block, and asks you one question
the phone cannot answer for itself — which side of the street you're on.

```
etl/fetch.py              pull both cities' ArcGIS layers (server-side reprojection to WGS84)
etl/parse_berkeley_pdf.py Berkeley's schedule PDFs -> etl/berkeley_schedule.json (run by hand)
etl/normalize_*.py        city-specific -> one shared schema
etl/schedule.py           nth-weekday-of-month date math
etl/build.py              -> data/*.json
index.html app.js style.css sw.js   the app
```

Build:

```bash
python3 etl/fetch.py && python3 etl/build.py
python3 -m unittest discover -s etl -t etl
```

No Node, no build step, no dependencies outside the standard library. The PDF
parser needs poppler (`brew install poppler`), which is why it runs by hand
rather than in CI.

## Why the side of the street is a tap, not a sensor

Phone GPS is 3–5 m in open sky and 10–30 m under Berkeley's tree canopy. Two
parking lanes are 8–10 m apart. The error is the size of the thing being
measured, so heading inference would be guessing with extra steps. The map draws
the block as two offset lines and you tap yours. Two seconds, never wrong.

Published apps that tried the alternatives get this wrong in public: one NYC app
picks the nearest sign to the GPS point, which routinely grabs the opposite curb.

## What the data actually says

**Oakland** — one ArcGIS layer, 23,862 centerlines, schedules as coded values in
`DAY_ODD`/`TIME_ODD`/`DAY_EVEN`/`TIME_EVEN`. Side is modeled by address parity.

The `SIDEOFSTREET` field is a red herring: it is blank on 97% of records. The
real marker is `MS` in a *day* field, which never appears in both day fields at
once — `DAY_ODD = 'MS'` means this line carries the even side only. 2,059 records
(8.6%) are these one-sided major-street lines, in ~1,030 near-coincident pairs;
`build.py` folds each pair into one segment so the UI never stacks two
untappable lines on top of each other.

Empty cells are `' '`, not null. `TIME_* = 'NA'` on a real sweep day happens 11
times in 18,492 — surfaced as `no_time` rather than guessed at. `missing` is a
real, undocumented `DAY_EVEN` value (85 records).

The companion `StreetSweepingRS` layer looks like a decoder ring for these codes
and is not one: 57 of 67 code pairs map to more than one `StSweeping` string
(`('MS','NA')` maps to 22). Its fields are not row-aligned with the schedule
codes. Do not validate against it.

**Berkeley** — the schedule is *not* in the GIS, contrary to what you would
guess. Layer 6's `Route` is null on 3,012 of 3,101 records and the remainder is
prose. The city's three residential schedule PDFs are the real source, and they
are better than the GIS: side, address range, ordinal weekday and AM/PM per
block face, plus the parity rule stated outright —

> "even numbered addresses on the south and west sides of the streets, and odd
> numbered addresses on the north and east sides. Opposite sides of the street
> are usually swept on different days."

Joined on normalized street name + address overlap, that covers 1,325 of 3,101
centerlines with a true odd/even answer. The remaining blocks fall back to a
spatial join against layer 7's route geometry, which recovers two schedules per
block but cannot say which side is which — those render as "Side A / Side B" and
the UI says so.

Name normalization has to absorb the GIS's quirks: it uppercases, splits
"McGee" into "MC GEE", and truncates at 20 characters ("MARTIN LUTHER KING J").

## Holidays

Neither dataset carries holiday logic, so `data/holidays.json` is hand-maintained
from the cities' own pages. **Re-verify every December and extend the lists.**

Berkeley states its rule: *"streets are no longer swept on holidays. When
scheduled street sweeping falls on a holiday, the impacted streets will be swept
on their next regularly scheduled day."* That is a skip, not a make-up day.

Oakland publishes the dates but does not say whether a missed sweep is made up.
Both readings agree the sweep does not happen that day, so the app suppresses it
either way and says explicitly that the make-up is unknown.

## Reminders

There is no push. The Notification Triggers API was abandoned and Web Push needs
a server holding VAPID keys, which would mean giving up the no-backend property.
Instead the app exports a recurring `.ics` with a 12-hour alarm — which is what
people already do by hand, and which does not silently stop working. Note the
event does *not* exclude city holidays; a calendar RRULE cannot express that.

## Refresh

`.github/workflows/refresh.yml` re-runs the ETL monthly and opens a PR if the
output diffs. A diff means a city changed something, which is exactly what you
want to see — and also exactly what a broken parse looks like, so read it.
Check `dropped_no_schedule` in `data/meta.json`: a large swing usually means a
parser broke rather than a real change. Verify dates, not row counts — a
correction often keeps the row count identical.

## Known gaps

- 88 Berkeley blocks have two schedules but no side attribution.
- Berkeley's PDFs give AM/PM; the 9–12 / 12:30–3:30 clock times come from the
  matching GIS route codes (`1stFRI912`, `1stFRI1230330`), so they are derived
  rather than stated in the PDF.
- Berkeley's `Opt-Out` column (per-address exemptions) is parsed but not used.
- Oakland's data has not been edited since June 2021; Berkeley's PDFs are dated
  March 2022. The UI says so rather than implying freshness.
- No enforcement-vs-sweeping distinction: a swept street may still be ticketed,
  and vice versa.
