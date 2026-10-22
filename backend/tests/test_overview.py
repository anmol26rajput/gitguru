import json
from collections import Counter

import pytest

from gitguru import ask, diagram, llm, overview
from gitguru.overview import FlowStep, Overview, Part, Term, build_overview, clean, flow_mermaid
from gitguru.style import PLAIN_LANGUAGE

PATHS = {"src/app.py", "src/util/io.py", "README.md"}


def make(**kw) -> Overview:
    base = dict(summary="It does a thing.", how_it_works=[FlowStep(label="Start", detail="begins")],
                parts=[Part(name="App", path="src/app.py", what="the app")], glossary=[Term(term="API", meaning="a door")])
    return Overview(**{**base, **kw})


def test_clean_drops_invented_parts_keeps_directory_prefix():
    o = make(parts=[Part(name="Real", path="src/app.py", what="a"), Part(name="Ghost", path="ghost.py", what="b"),
                    Part(name="Dir", path="src/util/", what="c"), Part(name="Dot", path="./src", what="d")])
    assert [p.name for p in clean(o, PATHS).parts] == ["Real", "Dir", "Dot"]


def test_clean_dedupes_terms_and_cuts_to_maxima():
    o = make(glossary=[Term(term="API", meaning="1"), Term(term="api", meaning="2")] + [Term(term=f"t{i}", meaning="m") for i in range(20)],
             how_it_works=[FlowStep(label=f"s{i}", detail="d") for i in range(12)],
             parts=[Part(name=f"p{i}", path="src/app.py", what="w") for i in range(15)])
    c = clean(o, PATHS)
    assert c.glossary[0].meaning == "1" and len(c.glossary) == 12 and len({t.term.lower() for t in c.glossary}) == 12
    assert len(c.how_it_works) == 8 and len(c.parts) == 10


def test_long_label_is_truncated_at_a_word_boundary_not_rejected():
    o = make(how_it_works=[FlowStep(label="word " * 20, detail="d"), FlowStep(label="x" * 100, detail="d")])
    a, b = clean(o, PATHS).how_it_works
    assert len(a.label) <= 60 and a.label.endswith("word…") and len(b.label) == 60 and b.label.endswith("…")


def test_clean_strips_backticks_and_normalises_part_paths():
    o = make(summary="Uses `requests.get()`.", how_it_works=[FlowStep(label="`go`", detail="calls `f()`")],
             parts=[Part(name="A`", path=" `./src/app.py/` ", what="runs `main`"), Part(name="D", path="/src/util", what="w")],
             glossary=[Term(term="`API`", meaning="a `door`")])
    c = clean(o, PATHS)
    assert "`" not in c.model_dump_json()
    assert [p.path for p in c.parts] == ["src/app.py", "src/util"]


def test_prompt_forbids_code_names_in_flow_text():
    assert "no backticks" in overview.SYSTEM and "only in a part's" in overview.SYSTEM


def test_flow_mermaid_chains_and_escapes():
    steps = [FlowStep(label="One", detail=""), FlowStep(label='Two "hostile"\n#', detail=""), FlowStep(label="Three", detail="")]
    m = flow_mermaid(steps)
    assert m.splitlines()[0] == "graph LR"
    assert 's0["One"]' in m and 's1["Two #quot;hostile#quot; #35;"]' in m
    assert "s0 --> s1" in m and "s1 --> s2" in m and "s2 -->" not in m
    assert flow_mermaid([]) == ""


def test_flow_mermaid_is_left_to_right_up_to_five_steps_then_top_down():
    steps = lambda n: [FlowStep(label=f"S{i}", detail="") for i in range(n)]
    assert flow_mermaid(steps(5)).startswith("graph LR") and flow_mermaid(steps(6)).startswith("graph TD")
    assert flow_mermaid(steps(1)).startswith("graph LR")


def test_build_overview_prompt_and_result(monkeypatch):
    seen = []
    monkeypatch.setattr(overview.llm, "complete_json", lambda m, schema: seen.append((m, schema)) or make())
    files = {"README.md": "R" * 4000, "a/x.py": "pass"}
    out = build_overview("o/r", files, Counter({("a", "b"): 2}))
    assert out == make() and seen[0][1] is Overview
    system, user = seen[0][0][0]["content"], seen[0][0][-1]["content"]
    assert PLAIN_LANGUAGE in system and "untrusted" in system
    assert "R" * 3000 in user and "R" * 3001 not in user and "a/" in user and "a -> b" in user


def test_schema_accepts_overview_kind(ready_repo, conn):
    conn.execute("INSERT INTO repo_artifacts (repo_id, kind, content) VALUES (%s, 'overview', '{}')", (ready_repo,))
    assert conn.execute("SELECT count(*) FROM repo_artifacts WHERE kind = 'overview'").fetchone()[0] == 1


def test_overview_context_returns_overview_text_when_row_exists(ready_repo, conn):
    conn.execute("INSERT INTO repo_artifacts (repo_id, kind, content) VALUES (%s, 'overview', %s)",
                 (ready_repo, make(summary="Tiny auth.").model_dump_json()))
    text = ask.overview_context(conn, ready_repo)
    assert "Tiny auth." in text and "Start: begins" in text and "App (src/app.py): the app" in text
