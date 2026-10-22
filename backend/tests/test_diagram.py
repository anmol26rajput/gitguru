from collections import Counter

from gitguru.diagram import collapse, extract_imports, file_edges, resolve, to_mermaid


def test_extract_imports_per_language():
    assert extract_imports("a/b.py", "import os\nfrom .util import x\nfrom . import y\nfrom pkg.sub import z\n", "python") == ["os", ".util", ".y", "pkg.sub"]
    assert extract_imports("w.js", 'import a from "./a";\nconst b = require("../b");\nexport { c } from "./c";\n', "javascript") == ["./a", "../b", "./c"]
    assert extract_imports("m.go", 'package m\nimport (\n  "fmt"\n  "example.com/app/util"\n)\n', "go") == ["fmt", "example.com/app/util"]
    assert extract_imports("A.java", "import com.acme.util.Strings;\nimport com.acme.model.*;\n", "java") == ["com.acme.util.Strings", "com.acme.model.*"]
    assert extract_imports("x.rb", "require 'set'", "ruby") == []


PATHS = {"src/app/main.py", "src/app/util.py", "src/app/db/__init__.py", "web/a.ts", "web/lib/b.tsx",
         "web/lib/index.ts", "go/util/s.go", "go/util/s_test.go", "j/com/acme/util/Strings.java"}


def test_resolve():
    assert resolve(".util", "src/app/main.py", "python", PATHS, None) == "src/app/util.py"
    assert resolve("app.db", "src/app/main.py", "python", PATHS, None) == "src/app/db/__init__.py"
    assert resolve("os", "src/app/main.py", "python", PATHS, None) is None
    assert resolve("./lib/b", "web/a.ts", "typescript", PATHS, None) == "web/lib/b.tsx"
    assert resolve("./lib", "web/a.ts", "typescript", PATHS, None) == "web/lib/index.ts"
    assert resolve("react", "web/a.ts", "typescript", PATHS, None) is None
    assert resolve("example.com/app/go/util", "go/main.go", "go", PATHS, "example.com/app") == "go/util/s.go"
    assert resolve("com.acme.util.Strings", "j/Main.java", "java", PATHS, None) == "j/com/acme/util/Strings.java"


def test_collapse_falls_back_to_files_when_one_package():
    edges = Counter({("src/pkg/a.py", "src/pkg/b.py"): 2, ("src/pkg/b.py", "src/pkg/c.py"): 1, ("tests/t.py", "src/pkg/a.py"): 1})
    nodes = {n for e in collapse(edges) for n in e}
    assert "src/pkg/a.py" in nodes  # 2 modules (<5) → file nodes


def test_collapse_four_modules_still_uses_file_nodes():
    # shaped like psf/requests: 4 modules would be 4 boxes, so files are shown instead
    edges = Counter({
        ("src/requests/a.py", "src/requests/b.py"): 3, ("src/requests/b.py", "src/requests/c.py"): 2,
        ("tests/t.py", "src/requests/a.py"): 1, ("tests/testserver/s.py", "src/requests/b.py"): 1,
        ("docs/conf.py", "src/requests/c.py"): 1,
    })
    nodes = {n for e in collapse(edges) for n in e}
    assert "src/requests/a.py" in nodes and "tests/t.py" in nodes


def test_collapse_keeps_top_25_and_drops_self_loops():
    edges = Counter({(f"m{i}/x/f.py", f"m{i+1}/x/f.py"): 1 for i in range(40)})
    edges[("m0/x/a.py", "m0/x/b.py")] = 5
    out = collapse(edges)
    nodes = {n for e in out for n in e}
    assert len(nodes) <= 25 and all(a != b for a, b in out)


def test_mermaid_escapes_hostile_names():
    m = to_mermaid(Counter({('we"ird]', "x-->y;"): 1, ("a\nb\rc", "x-->y;"): 1}))
    assert len(m.splitlines()) == 1 + 3 + 2 and '"a b c"' in m  # newlines in names cannot break a node line
    assert m.startswith("graph LR") and 'we#quot;ird]' in m and '"x-->y;"' in m
    assert all(line.split("[")[0].strip().startswith("n") for line in m.splitlines()[1:] if "[" in line)


def test_no_edges_gives_empty_string():
    assert to_mermaid(Counter()) == ""


# beyond the brief: the parts the contract tests don't reach
def test_file_edges_module_of_and_go_module():
    from gitguru.diagram import go_module_of, module_of

    files = {"pkg/a.py": "from . import b\nfrom .b import x\nimport pkg.a\n", "pkg/b.py": "", "README.md": "import x"}
    assert file_edges(files, None) == Counter({("pkg/a.py", "pkg/b.py"): 2})  # no self-loop
    assert module_of("a/b/c/d.py") == "a/b" and module_of("a/d.py") == "a" and module_of("d.py") == "(root)"
    assert go_module_of({"go.mod": "// c\nmodule example.com/app\n\ngo 1.22\n"}) == "example.com/app"
    assert go_module_of({"sub/go.mod": "module x\n"}) is None


def test_collapse_falls_back_when_modules_have_only_internal_edges():
    edges = Counter({(f"{m}/x/1.py", f"{m}/x/2.py"): 1 for m in "abc"})
    out = collapse(edges)
    assert out and {n for e in out for n in e} == {f"{m}/x/{i}.py" for m in "abc" for i in "12"}


def test_file_edges_fast_at_5000_files():
    import time

    src = "import os\nimport numpy.linalg\nimport requests\nfrom pkg.sub import z\nimport yaml\n"
    files = {f"src/p{i % 50}/m{i}.py": src for i in range(5000)}
    t = time.perf_counter()
    assert not file_edges(files, None)
    assert time.perf_counter() - t < 2
