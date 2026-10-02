"""Cut files into chunks: one per function/class (tree-sitter), else 60-line windows."""
from dataclasses import dataclass
from functools import cache
from pathlib import PurePosixPath

from tree_sitter_language_pack import get_parser

WINDOW, OVERLAP = 60, 10
MAX_LINES, MAX_CHARS = 120, 4000

LANG_BY_EXT = {
    ".py": "python", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".cjs": "javascript", ".ts": "typescript", ".tsx": "tsx", ".go": "go", ".java": "java",
    ".rs": "rust", ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
    ".rb": "ruby", ".php": "php", ".md": "markdown", ".json": "json", ".yaml": "yaml",
    ".yml": "yaml", ".toml": "toml", ".html": "html", ".css": "css", ".sh": "bash",
    ".sql": "sql", ".kt": "kotlin", ".swift": "swift", ".cs": "csharp",
}
AST_LANGS = {"python", "javascript", "typescript", "tsx", "go", "java", "rust", "c", "cpp", "ruby", "php"}
DEF_TYPES = {
    "function_definition", "class_definition",                                  # python, c/cpp, php
    "function_declaration", "generator_function_declaration", "class_declaration",
    "method_definition", "abstract_class_declaration", "interface_declaration",
    "type_alias_declaration", "enum_declaration",                               # js/ts/java
    "method_declaration", "type_declaration",                                   # go/java/php
    "function_item", "impl_item", "struct_item", "enum_item", "trait_item", "mod_item",  # rust
    "class_specifier", "struct_specifier", "namespace_definition",              # c/cpp
    "method", "singleton_method", "class", "module",                            # ruby
}
WRAPPERS = {"decorated_definition": "definition", "export_statement": "declaration"}


@dataclass
class Chunk:
    path: str
    start_line: int
    end_line: int
    lang: str | None
    symbol: str | None
    content: str


def detect_lang(path: str) -> str | None:
    return LANG_BY_EXT.get(PurePosixPath(path).suffix.lower())


def line_windows(path, lines, lang, first_line=1, symbol=None) -> list[Chunk]:
    chunks = []
    for i in range(0, len(lines), WINDOW - OVERLAP):
        part = lines[i:i + WINDOW]
        if "".join(part).strip():
            start = first_line + i
            chunks.append(Chunk(path, start, start + len(part) - 1, lang, symbol, "\n".join(part)))
        if i + WINDOW >= len(lines):
            break
    return chunks


@cache
def _parser(lang: str):
    return get_parser(lang)


def _name(node) -> str | None:
    n = node.child_by_field_name("name")
    if n is None:  # C/C++: the name sits inside nested declarators
        n = node.child_by_field_name("declarator")
        while n is not None and n.child_by_field_name("declarator") is not None:
            n = n.child_by_field_name("declarator")
    return n.text.decode() if n is not None else None


def _has_def(node) -> bool:
    return any(c.type in DEF_TYPES or _has_def(c) for c in node.named_children)


def _ast_chunks(path: str, text: str, lang: str) -> list[Chunk]:
    lines = text.split("\n")
    tree = _parser(lang).parse(text.encode())
    chunks: list[Chunk] = []
    covered = [False] * len(lines)

    def emit(start: int, end: int, symbol: str | None) -> None:
        part = lines[start - 1:end]
        if end - start + 1 > MAX_LINES or sum(map(len, part)) > MAX_CHARS:
            chunks.extend(line_windows(path, part, lang, start, symbol))
        else:
            chunks.append(Chunk(path, start, end, lang, symbol, "\n".join(part)))
        for i in range(start - 1, end):
            covered[i] = True

    def visit(node, parent: str | None) -> None:
        for child in node.named_children:
            target = child
            if child.type in WRAPPERS:
                inner = child.child_by_field_name(WRAPPERS[child.type])
                target = inner if inner is not None else child
            if target.type not in DEF_TYPES:
                visit(child, parent)
                continue
            name = _name(target)
            symbol = f"{parent}.{name}" if parent and name else (name or parent)
            start, end = child.start_point[0] + 1, child.end_point[0] + 1
            if end - start + 1 > MAX_LINES and _has_def(target):
                visit(target, symbol)  # big class: one chunk per method
            else:
                emit(start, end, symbol)

    visit(tree.root_node, None)

    # Code between definitions (imports, constants, routes) -> header chunks.
    i = 0
    while i < len(lines):
        if covered[i]:
            i += 1
            continue
        j = i
        while j < len(lines) and not covered[j]:
            j += 1
        part = lines[i:j]
        if sum(1 for line in part if line.strip()) >= 2:
            chunks.extend(line_windows(path, part, lang, i + 1))
        i = j
    return sorted(chunks, key=lambda c: c.start_line)


def chunk_file(path: str, text: str, strategy: str = "ast") -> list[Chunk]:
    text = text.replace("\r\n", "\n")
    lang = detect_lang(path)
    if strategy == "ast" and lang in AST_LANGS:
        try:
            return _ast_chunks(path, text, lang)
        except Exception:  # parser problems must never stop indexing
            pass
    return line_windows(path, text.split("\n"), lang)
