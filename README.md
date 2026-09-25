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

`L_*` and `R_*` are left and right of the *digitization* direction, which is
arbitrary — odd addresses are on the left only about 60% of the time. Assuming
odd is always left mislabels 4,992 of the 12,226 features that populate both
ranges, printing "Odd" beside an even address range. Assign the range to the
side by its own parity instead.

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

## The sheet

The map is full-bleed; the answer sits in a sheet over it with three stops, the
way an iOS sheet behaves:

| stop | what stays visible |
|---|---|
| open | everything — sides, verdict, compass, reminder, the disclaimer |
| peek | down to the end of the verdict: the answer, still readable |
| minimal | the handle and the street name — the map gets ~87% of the screen |

Drag the handle, flick it (velocity carries to the next stop even if the finger
barely moved), tap it to cycle, or use the keyboard. The map re-centres on each
stop so the block stays clear of whatever the sheet still covers; that offset has
a single owner, since applying it in two places once pushed the block off screen.

## Both sides, always

The app never shows a single verdict. Each side states its own, and you match it
to the nearest house number.

An earlier build pre-selected one side and printed one confident answer for it.
That is a coin flip on any street whose sides sweep on different days — and they
usually do. Parker St sweeps odd/north on the 2nd Wednesday and even/south on the
2nd Tuesday, so at 10am on a 2nd Wednesday the two sides read "Move now" and
"Clear". Collapsing that into one headline is how the app puts someone on the
wrong kerb, which it did.

Tapping a card only highlights that side on the map. Nothing about the answer
depends on the app guessing where the car is.

## What ships

A block is worth shipping if it has anything real to tell a driver — not only a
sweeping schedule. A block in a permit zone, or one with a kerb regulation (a red
kerb, a bus stop, a two-hour meter), matters even where it is never swept.
Filtering on sweeping alone dropped 265 Berkeley blocks carrying a permit zone
and 265 Oakland blocks carrying a kerb regulation — restrictions the driver is
subject to regardless.

| | blocks | permit zone | kerb regulation |
|---|---|---|---|
| Oakland | 10,658 | 897 | 2,107 |
| Berkeley | 1,765 | 753 | — |
| Emeryville | 414 | — | — |

## Permit zones

The commonest citation after sweeping.

**Berkeley** publishes both halves: areas on a separate ArcGIS org updated far
more recently than the sweeping data, and the hours in an enforcement-schedule
PDF. 753 blocks carry an area and its two-hour rule, resolved at build time so
the client never fetches the 480 kB of polygons. Overlap zones like "AB" take
the union of their constituents' enforced days; Area E's Saturday footnote is
carried as a caveat rather than resolved either way.

**Oakland** publishes the zones (842 kerb lines, A–R, no H) but *not* the hours
or the limit, and they vary by zone — not on the RPP pages, not in the feature
service. So 915 Oakland blocks carry a zone letter and the app says the hours
are unpublished. Borrowing Berkeley's two-hour rule would be presenting a guess
as a regulation.

## Which way the side faces

Each side is tagged with the compass direction it faces, so "east side" is
usable when no house number is in sight. It is derived, not published: take the
centerline's bearing, and which hand of the line the side's addresses sit on
(`L_*` is left of the digitization direction in both cities), and turn 90°.

Guards, because a wrong compass letter points someone at the wrong curb:

- Blocks that bend are skipped — a curved street has no single bearing.
  Straightness (end-to-end over path length) must be at least 0.9.
- The two sides of a street must come out opposite. If they do not, the tag is
  dropped from both rather than guessed. This runs again after major-street
  pairs are folded, since those two sides come from two separate features.

That leaves a compass on 91% of Oakland sides and 87% of Berkeley's, with zero
inconsistent pairs in either city.

Berkeley's PDFs *do* carry a compass column, and it is not used for this: it
contradicts its own address ranges on 31 of 708 rows. Deriving both cities the
same way keeps the letter consistent with the address range printed beside it.

**The address range is the reliable check** — you confirm it by reading the
nearest door. The compass is the parenthetical, and the app presents it that way.
The optional live compass (`deviceorientation`, permission-gated on iOS) exists
to make that parenthetical actionable.

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

- 87 Berkeley blocks have two schedules but no side attribution.
- 9% of Oakland sides and 13% of Berkeley's have no compass tag, because the
  block bends or the two sides disagreed. Those show the address range alone.
- Berkeley's PDFs give AM/PM; the 9–12 / 12:30–3:30 clock times come from the
  matching GIS route codes (`1stFRI912`, `1stFRI1230330`), so they are derived
  rather than stated in the PDF.
- Berkeley's `Opt-Out` column (per-address exemptions) is parsed but not used.
- Oakland's data has not been edited since June 2021; Berkeley's PDFs are dated
  March 2022. The UI says so rather than implying freshness.
- No enforcement-vs-sweeping distinction: a swept street may still be ticketed,
  and vice versa.

## The NFC sticker

A cheap NTAG213 sticker on the door pillar, written with any NFC writer app to:

    https://kpsmas123-bit.github.io/street-sweeping/?nfc=1

Tap the phone to it as you walk away. `nfc=1` means "I just parked": it stamps
the time so the app can tell you how long the car has been there, then goes
straight to locating. No unlock-and-hunt-for-the-app.

The overhead view puts the car on the block from GPS, which is all GPS can
honestly do. Which kerb it sits on is still your tap — the two kerbs are 8–10 m
apart and a phone fix is 3–30 m. The car waits in the middle of the road until
you place it, so there is never a default answer to be wrong about.

## Payload

The full city files are 2.6 MB (Oakland) and 0.4 MB (Berkeley) — too slow to
parse on a phone when the whole promise is an instant answer on an NFC tap.

`data/tiles/<city>/<x>_<y>.json` is a 0.01° grid, about 1.1 km × 0.9 km per
cell: 105 cells for Oakland, median 30 kB. The app loads the cell you are
standing in and nothing else. Neighbours are fetched only when the nearest block
in that cell is more than 60 m away, which usually means the answer is across a
boundary. Blocks straddling a boundary are filed under every cell they touch, so
a cell is never missing a block you could be standing on.

The whole-city files stay, for two reasons: the service worker pre-caches them
so the app works offline in a cell never visited, and they are the fallback when
a tile fetch finds nothing.

## Privacy, and one structural problem

The parked-car location never leaves the device. It is written to `localStorage`
and read back; there is no backend, no account, no analytics, and the only
outbound navigation is the Apple Maps walk-back the user taps themselves.

**But `localStorage` is scoped to an origin, and GitHub Pages project sites are
paths on a shared one.** Every site under `kpsmas123-bit.github.io` —
`street-sweeping`, `civicvoice`, `desk`, `campaign-tracker`,
`berkeley-precinct-map`, `labor-organizing-model`, `samkp-com` — shares a single
storage bucket, because origin is scheme + host + port and the path is not part
of it. An XSS bug in any one of those can read this app's parked session: the
car's coordinates, which are usually near home.

The only real fix is a separate origin — a custom domain for this app. Until
then:

- the session expires after 36 hours rather than being kept indefinitely,
- there is a **Forget my spot** control,
- and the other six sites should be treated as inside this app's trust boundary.

Related: no repo named `kpsmas123-bit.github.io` exists today. If one is ever
created it can register a root-scoped service worker controlling `/street-sweeping/`
and every other path, which is worse than shared storage. Don't create it
casually.

GitHub Pages cannot set response headers, so the CSP is a `<meta>` tag. That
cannot express `frame-ancestors` — clickjacking protection is simply unavailable
on Pages — but `connect-src 'self'` does mean a compromised CDN script could not
post the stored location anywhere.

## Moving to Cloudflare Pages

Worth doing, and it fixes two separate problems rather than one.

**It gives the app its own origin.** `street-sweeping.pages.dev` does not share
`localStorage` with any other project, which is the only real fix for the shared
bucket described above.

**It can set response headers.** GitHub Pages cannot, which is why the CSP here
is a `<meta>` tag missing `frame-ancestors`, and why every asset URL carries a
`?v=` query string to defeat a fixed ten-minute cache. `_headers` in this repo
replaces both: a full CSP, `nosniff`, `no-referrer`, a `Permissions-Policy`
limiting the app to the sensors it actually uses, and per-path cache rules that
keep the shell fresh while letting tiles cache for a day.

Setup, once:

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git,
   and pick this repo.
2. Build command: **none**. Build output directory: **`/`** (the repo root is
   the site).
3. Deploy. `_headers` and `_redirects` are picked up automatically.
4. **Rewrite the NFC sticker** to the new origin — the old URL keeps working but
   writes its session to the old, shared bucket.

GitHub Pages can stay as it is; `_headers` and `_redirects` are inert there, so
both deploys work from the same branch. Once Cloudflare is the real one, the
`?v=` query strings and the `<meta>` CSP can go.

## Deploying

GitHub Pages serves every file with `Cache-Control: max-age=600`, so a returning
visitor can run ten minutes of stale JavaScript against fresh data — and a schema
change between the two shows a wrong answer rather than failing loudly.

Two defences, and you need both:

1. `index.html` references `app.js?v=N` and `style.css?v=N`. **Bump `N` in
   `index.html` and in `sw.js`'s asset list whenever either file changes.**
2. The service worker refetches the shell with `cache: 'reload'`, which covers
   returning visitors once it is installed. It cannot help the very first load
   after a deploy, which is what (1) is for.

Bump `CACHE` in `sw.js` on any deploy that renames or moves a file.
