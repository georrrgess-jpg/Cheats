from src.scrape_card import load_card
from parse_paste import parse

PASTE = """Waldo Cortes-Acosta vs Johnny Walker
Johnny Walker Over 45.5 Significant Strikes -115
Johnny Walker Under 45.5 Significant Strikes -105
Total Significant Strikes Over 99.5
-110
Cortes-Acosta Takedowns Over 0.5 +150
Over 2.5 Rounds +105
Walker by KO/TKO +300
some random text with no odds
Tatiana Suarez vs Virna Jandiroba
Suarez Takedowns Over 2.5 -120
Fight goes the distance Yes -250
"""


def test_paste_parser():
    card = load_card("UFC Vegas 124")
    df, un = parse(PASTE, card, "TestBook")
    got = set(zip(df.bout, df.market, df.selection, df.line.astype(str)))
    assert ("Cortes-Acosta-Walker", "SIG_OU", "Johnny Walker:OVER", "45.5") in got
    assert ("Cortes-Acosta-Walker", "SIG_TOT_OU", "OVER", "99.5") in got
    assert ("Cortes-Acosta-Walker", "TD_OU", "Waldo Cortes-Acosta:OVER", "0.5") in got
    assert ("Cortes-Acosta-Walker", "ROUNDS_OU", "OVER", "2.5") in got
    assert ("Cortes-Acosta-Walker", "METHOD", "Johnny Walker:KO", "") in got
    assert ("Suarez-Jandiroba", "TD_OU", "Tatiana Suarez:OVER", "2.5") in got
    assert ("Suarez-Jandiroba", "DIST", "YES", "") in got
