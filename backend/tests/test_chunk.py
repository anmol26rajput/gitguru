from gitguru.chunk import chunk_file, detect_lang, line_windows
from tests.conftest import FIXTURE_REPO


def spans(chunks):
    return [(c.start_line, c.end_line, c.symbol) for c in chunks]


def test_python_functions_classes_and_header():
    text = (FIXTURE_REPO / "auth.py").read_text()
    assert spans(chunk_file("auth.py", text)) == [
        (1, 7, None),
        (8, 10, "hash_password"),
        (13, 18, "verify_login"),
        (21, 33, "SessionStore"),
    ]


def test_python_two_functions():
    text = (FIXTURE_REPO / "retry.py").read_text()
    symbols = [c.symbol for c in chunk_file("retry.py", text) if c.symbol]
    assert symbols == ["compute_backoff_delay", "retry_with_backoff"]


def test_javascript_function_declaration():
    text = (FIXTURE_REPO / "server.js").read_text()
    chunks = chunk_file("server.js", text)
    auth = [c for c in chunks if c.symbol == "requireAuth"]
    assert [(c.start_line, c.end_line) for c in auth] == [(4, 9)]


def test_go_function():
    text = (FIXTURE_REPO / "utils/strings.go").read_text()
    chunks = chunk_file("utils/strings.go", text)
    assert (6, 8, "Slugify") in spans(chunks)


def test_big_class_is_split_into_methods():
    body = "\n".join(f"        x{i} = {i}" for i in range(65))  # class > 120 lines
    text = f"class Big:\n    def a(self):\n{body}\n\n    def b(self):\n{body}\n"
    chunks = chunk_file("big.py", text)
    assert [c.symbol for c in chunks if c.symbol] == ["Big.a", "Big.b"]


def test_long_function_is_split_into_windows():
    body = "\n".join(f"    x{i} = {i}" for i in range(200))
    text = f"def long():\n{body}\n"
    chunks = chunk_file("long.py", text)
    assert len(chunks) >= 3
    assert all(c.symbol == "long" for c in chunks)
    assert all(c.end_line - c.start_line + 1 <= 60 for c in chunks)


def test_crlf_line_numbers_match_lf():
    text = (FIXTURE_REPO / "auth.py").read_text()
    assert spans(chunk_file("auth.py", text.replace("\n", "\r\n"))) == spans(chunk_file("auth.py", text))


def test_unknown_language_uses_line_windows():
    text = "\n".join(f"line {i}" for i in range(1, 131))
    chunks = chunk_file("notes.txt", text)
    assert [(c.start_line, c.end_line) for c in chunks] == [(1, 60), (51, 110), (101, 130)]


def test_line_strategy_ignores_ast():
    text = (FIXTURE_REPO / "auth.py").read_text()
    chunks = chunk_file("auth.py", text, strategy="line")
    assert [(c.start_line, c.symbol) for c in chunks] == [(1, None)]


def test_line_windows_skip_blank_windows():
    assert line_windows("a.txt", ["", "  ", ""], None) == []


def test_detect_lang():
    assert detect_lang("a/b.py") == "python"
    assert detect_lang("x.tsx") == "tsx"
    assert detect_lang("Makefile") is None
