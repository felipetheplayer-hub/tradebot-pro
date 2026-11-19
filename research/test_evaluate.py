import unittest

from evaluate import outcomes, signals, summarize


def bar(price):
    return (price, price + .2, price - .2, price)


class EvaluationTest(unittest.TestCase):
    def test_future_cannot_change_signal_and_gap_resets_lookback(self):
        bars = {i * 60: bar(100 + i) for i in range(205)}
        original = dict(signals(bars))
        self.assertEqual(original[200 * 60], [1, 1, 0])
        changed = {**bars, 200 * 60: bar(250)}
        observed = dict(signals(changed))
        self.assertEqual(original[200 * 60], observed[200 * 60])
        self.assertEqual(observed[201 * 60], [-1, -1, 1])
        del changed[199 * 60]
        self.assertEqual(dict(signals(changed))[201 * 60], [0, 0, 0])

    def test_outcomes_exclude_split_crossings_and_missing_ticks(self):
        bars = {i * 60: bar(10 + i) for i in range(5)}
        ticks = {125: 10, 185: 10, 245: 11}
        sample = list(outcomes(bars, 120, 245, ticks, 5))
        self.assertEqual(sample, [(120, [1, 0, 0], 0)])
        self.assertEqual(list(outcomes(bars, 120, 245, ticks, 10)), [])
        r = summarize(sample, 120, 245, .95)['rules']['dois_fechamentos']
        self.assertEqual((r['wins'], r['losses'], r['equal_prices'], r['net_per_100']), (0, 1, 1, -100))
        self.assertIsNone(summarize([], 120, 245)['rules']['rsi2_media200']['accuracy'])
