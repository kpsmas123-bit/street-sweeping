"""Run: python3 -m unittest discover -s etl -v"""
import unittest
from datetime import date
import schedule as S


class NthWeekday(unittest.TestCase):
    def test_month_starting_on_the_weekday_itself(self):
        # June 2026 starts on a Monday -> 1st Mon is the 1st, 2nd is the 8th.
        self.assertEqual(S.nth_weekday_of_month(2026, 6, S.MON, 1), date(2026, 6, 1))
        self.assertEqual(S.nth_weekday_of_month(2026, 6, S.MON, 2), date(2026, 6, 8))

    def test_month_starting_mid_week_pushes_first_occurrence_late(self):
        # Sep 2026 starts Tuesday. 1st Mon is the 7th, so the 2nd Mon is the 14th
        # -- NOT the 8th, which is what "Monday of the 2nd week" would give.
        self.assertEqual(S.nth_weekday_of_month(2026, 9, S.MON, 1), date(2026, 9, 7))
        self.assertEqual(S.nth_weekday_of_month(2026, 9, S.MON, 2), date(2026, 9, 14))

    def test_month_starting_day_before(self):
        # Oct 2026 starts Thursday: 1st Fri is the 2nd, 1st Thu is the 1st.
        self.assertEqual(S.nth_weekday_of_month(2026, 10, S.THU, 1), date(2026, 10, 1))
        self.assertEqual(S.nth_weekday_of_month(2026, 10, S.FRI, 1), date(2026, 10, 2))

    def test_fifth_occurrence_may_not_exist(self):
        self.assertIsNone(S.nth_weekday_of_month(2026, 9, S.MON, 5))   # only 4 Mondays
        self.assertEqual(S.nth_weekday_of_month(2026, 9, S.TUE, 5), date(2026, 9, 29))

    def test_february_non_leap_and_leap(self):
        self.assertEqual(S.nth_weekday_of_month(2026, 2, S.SUN, 4), date(2026, 2, 22))
        self.assertIsNone(S.nth_weekday_of_month(2026, 2, S.SUN, 5))
        # Feb 2032 is a leap year starting Sunday -> five Sundays.
        self.assertEqual(S.nth_weekday_of_month(2032, 2, S.SUN, 5), date(2032, 2, 29))

    def test_out_of_range_ordinals(self):
        self.assertIsNone(S.nth_weekday_of_month(2026, 9, S.MON, 0))
        self.assertIsNone(S.nth_weekday_of_month(2026, 9, S.MON, 6))


class OccursOn(unittest.TestCase):
    def test_nth_weekday_matches_only_listed_ordinals(self):
        sched = S.make('nth_weekday', [1, 3], [S.MON], '09:00', '12:00')
        self.assertTrue(S.occurs_on(sched, date(2026, 9, 7)))    # 1st Mon
        self.assertFalse(S.occurs_on(sched, date(2026, 9, 14)))  # 2nd Mon
        self.assertTrue(S.occurs_on(sched, date(2026, 9, 21)))   # 3rd Mon
        self.assertFalse(S.occurs_on(sched, date(2026, 9, 28)))  # 4th Mon

    def test_ordinal_is_calendar_occurrence_not_week_number(self):
        # Sep 2026: the 7th is the 1st Monday even though it falls in week 2.
        sched = S.make('nth_weekday', [1], [S.MON], '09:00', '12:00')
        self.assertTrue(S.occurs_on(sched, date(2026, 9, 7)))

    def test_weekly_ignores_ordinals(self):
        sched = S.make('weekly', [], [S.TUE, S.THU], '12:30', '15:30')
        for day in (8, 10, 15, 17, 22, 24):
            self.assertTrue(S.occurs_on(sched, date(2026, 9, day)))
        self.assertFalse(S.occurs_on(sched, date(2026, 9, 9)))  # Wednesday

    def test_none_and_unknown_never_occur(self):
        for d in range(1, 29):
            self.assertFalse(S.occurs_on(S.NONE, date(2026, 9, d)))
            self.assertFalse(S.occurs_on(S.UNKNOWN, date(2026, 9, d)))


class NextOccurrences(unittest.TestCase):
    def test_strictly_after_the_given_date(self):
        sched = S.make('nth_weekday', [1, 3], [S.MON], '09:00', '12:00')
        got = S.next_occurrences(sched, date(2026, 9, 7), limit=2)
        self.assertEqual(got, [date(2026, 9, 21), date(2026, 10, 5)])

    def test_crosses_month_and_year_boundaries(self):
        sched = S.make('nth_weekday', [1], [S.FRI], '09:00', '12:00')
        got = S.next_occurrences(sched, date(2026, 12, 10), limit=2)
        self.assertEqual(got, [date(2027, 1, 1), date(2027, 2, 5)])

    def test_holiday_is_skipped_not_deferred(self):
        sched = S.make('nth_weekday', [1], [S.FRI], '09:00', '12:00')
        newyear = date(2027, 1, 1)
        got = S.next_occurrences(sched, date(2026, 12, 10), limit=1,
                                 is_holiday=lambda d: d == newyear)
        self.assertEqual(got, [date(2027, 2, 5)])  # January's sweep vanishes

    def test_none_schedule_returns_nothing(self):
        self.assertEqual(S.next_occurrences(S.NONE, date(2026, 9, 1)), [])


if __name__ == '__main__':
    unittest.main()
