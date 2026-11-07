from pathlib import Path
import pandas as pd
from src.names import norm, resolve
from src.odds import label_to_key, parse_bfo, csv_selection_to_key
from src.clean import of_pair, mmss, method_bucket, parse_weight_class

FIX = Path(__file__).parent / "fixtures"


def test_norm_and_resolve():
    assert norm("Mantas Kondratavičius") == norm("Mantas Kondratavicius")
    assert norm("Waldo Cortes Acosta") == norm("Waldo Cortes-Acosta")
    assert norm("Ko Seokhyeon") == norm("Seokhyeon Ko")
    cand = {"1": "Waldo Cortes-Acosta", "2": "Johnny Walker", "3": "Nina Milosevic", "4": "Jose Delano"}
    assert resolve("Cortes Acosta Waldo", cand)[0] == "1"
    assert resolve("Nina Nikolija Milošević", cand)[0] == "3"
    assert resolve("José Mauro Delano", cand)[0] == "4"
    assert resolve("Totally Unknown", cand)[0] is None


def test_clean_parsers():
    assert of_pair("12 of 30") == (12.0, 30.0)
    assert mmss("4:07") == 247
    assert method_bucket("Decision - Split ") == "S-DEC"
    assert method_bucket("TKO - Doctor's Stoppage") == "DOC"
    assert parse_weight_class("UFC Women's Strawweight Title Bout") == ("Strawweight", "F", True, False)


def test_label_to_key():
    A, B = ["Waldo Cortes-Acosta", "Cortes-Acosta"], ["Johnny Walker", "Walker"]
    assert label_to_key("Over 2&#189; rounds", A, B, None) == "ROUNDS_OU|OVER|2.5"
    assert label_to_key("Walker wins by TKO/KO", A, B, None) == "METHOD|B:KO"
    assert label_to_key("Any other result", A, B, "METHOD|B:KO") == "NOT:METHOD|B:KO"
    assert label_to_key("Cortes-Acosta wins in round 2", A, B, None) == "ROUND|A:R2"
    assert label_to_key("Fight won't start round 3", A, B, None) == "NOT:START_RD|YES|3"
    assert label_to_key("Not Walker inside distance", A, B, None) == "NOT:ITD|B"
    assert label_to_key("Walker (scorecards = no action)", A, B, None) is None


def test_parse_bfo_fixture():
    card = pd.DataFrame({"bout_key": ["Cortes-Acosta-Walker"], "a_id": ["a"], "b_id": ["b"],
                         "fighter_a": ["Waldo Cortes-Acosta"], "fighter_b": ["Johnny Walker"]})
    q, issues = parse_bfo((FIX / "bfo_event.html").read_text(), card, {"a": "Waldo Cortes-Acosta", "b": "Johnny Walker"})
    assert len(q) > 50
    ml = q[q.key == "ML|A"]
    assert len(ml) >= 3 and (ml.american < 0).all()      # Cortes-Acosta is the favorite in the fixture
    assert set(q.bout_key) == {"Cortes-Acosta-Walker"}


def test_csv_keys():
    side = lambda n: "A" if "Walker" in n else ("B" if "Acosta" in n else None)
    assert csv_selection_to_key("SIG_OU", "Johnny Walker:OVER", "45.5", side) == "SIG|A|OVER|45.5"
    assert csv_selection_to_key("SIG_TOT_OU", "UNDER", "99.5", side) == "SIG|TOT|UNDER|99.5"
    assert csv_selection_to_key("TD_OU", "Johnny Walker:UNDER", "0.5", side) == "TD|A|UNDER|0.5"
    assert csv_selection_to_key("START_RD", "NO", "2", side) == "NOT:START_RD|YES|2"
