package parse

import (
	"strings"
	"testing"
)

func count(t *testing.T, name, source string) FileStats {
	t.Helper()

	counter := NewCounter()
	defer counter.Close()

	stats, ok := counter.Count(name, []byte(source))
	if !ok {
		t.Fatalf("Count(%s) reported the language as unsupported", name)
	}
	return stats
}

func TestGo(t *testing.T) {
	stats := count(t, "a.go", `package m

import "fmt"
import "os"

type T struct{ a int }
type I interface{ M() }

// a line comment
/* a block
   comment */
func f(x int) error {
	if x > 0 {
		for i := range 3 {
			if i > 1 {
				return nil
			}
		}
	}
	return nil
}

func (t T) m() {}`)

	assertEqual(t, "Functions", stats.Functions, 2)
	// Go has no classes; a struct and an interface are the closest things it has.
	assertEqual(t, "Classes", stats.Classes, 2)
	assertEqual(t, "Imports", stats.Imports, 2)
	assertEqual(t, "Branches", stats.Branches, 3)
	// One line comment plus a two-line block comment.
	assertEqual(t, "CommentLines", stats.CommentLines, 3)
	assertEqual(t, "MaxNesting", stats.MaxNesting, 3)
	assertEqual(t, "Language", stats.Language, "Go")
}

func TestGoHasNoAsync(t *testing.T) {
	// A deliberate zero rather than an oversight. Go has neither async/await nor promises,
	// and counting goroutines instead would be inventing a meaning the schema never asked
	// for — a wrong number is worse than an honest zero.
	stats := count(t, "a.go", `package m
func f() { go func(){}() }`)

	if stats.AsyncFunctions != 0 {
		t.Errorf("AsyncFunctions = %d, want 0", stats.AsyncFunctions)
	}
}

func TestTypeScript(t *testing.T) {
	stats := count(t, "a.ts", `import { a } from "x"
interface I { n: number }
enum E { A }
class C {
  async m(): Promise<void> { await g() }
  n() { if (1) {} }
}
// comment
function f(a?: number) {
  for (const x of []) { if (x) {} }
  return a ? 1 : 2
}`)

	assertEqual(t, "Functions", stats.Functions, 3)
	// interface, enum, class — TypeScript's declarations are classes in the sense that
	// matters here, and each is counted exactly once.
	assertEqual(t, "Classes", stats.Classes, 3)
	assertEqual(t, "Imports", stats.Imports, 1)
	assertEqual(t, "AsyncFunctions", stats.AsyncFunctions, 1)
	assertEqual(t, "Language", stats.Language, "TypeScript")
}

func TestClassesAreNotCountedTwice(t *testing.T) {
	// A keyword token carries the same kind string as its rule: `class C {}` contains a
	// `class_declaration` and, inside it, the anonymous `class` keyword whose kind is also
	// "class". Before the named-node guard this counted every class twice, in silence.
	for _, name := range []string{"a.js", "a.ts", "a.tsx"} {
		if got := count(t, name, "class C {}").Classes; got != 1 {
			t.Errorf("%s: Classes = %d, want 1", name, got)
		}
	}

	// The same trap in Python, where `lambda` is both a node kind and a keyword.
	if got := count(t, "a.py", "f = lambda x: x").Functions; got != 1 {
		t.Errorf("python lambda: Functions = %d, want 1", got)
	}
}

func TestClassExpressionsStillCount(t *testing.T) {
	// The fix had to keep these: `class` is the node kind for an anonymous class expression
	// as well as the keyword, and only the expression is a named node.
	if got := count(t, "a.js", "const C = class {}").Classes; got != 1 {
		t.Errorf("Classes = %d, want 1", got)
	}
}

func TestPython(t *testing.T) {
	stats := count(t, "a.py", `import os
from x import y

class C:
    async def m(self):
        await self.n()

# comment
def f(a):
    if a:
        for i in a:
            while i:
                pass`)

	assertEqual(t, "Functions", stats.Functions, 2)
	assertEqual(t, "Classes", stats.Classes, 1)
	assertEqual(t, "Imports", stats.Imports, 2)
	assertEqual(t, "Branches", stats.Branches, 3)
	assertEqual(t, "MaxNesting", stats.MaxNesting, 3)
	assertEqual(t, "AsyncFunctions", stats.AsyncFunctions, 1)
}

func TestJavaScriptArrowAndAsync(t *testing.T) {
	stats := count(t, "a.js", `const f = async () => { await g() }
function h() { try {} catch (e) {} }`)

	assertEqual(t, "Functions", stats.Functions, 2)
	assertEqual(t, "AsyncFunctions", stats.AsyncFunctions, 1)
	// A catch clause is a branch: control reaches it or it does not.
	assertEqual(t, "Branches", stats.Branches, 1)
}

func TestAsyncDoesNotLeakOutOfANestedFunction(t *testing.T) {
	// Markers are read from direct children only. Scanning the subtree would mark the outer
	// function async because an inner one is.
	stats := count(t, "a.js", `function outer() { const inner = async () => {} }`)

	assertEqual(t, "Functions", stats.Functions, 2)
	assertEqual(t, "AsyncFunctions", stats.AsyncFunctions, 1)
}

func TestNestedFunctionsKeepTheirOwnLengths(t *testing.T) {
	// Every statement belongs to exactly one function. Without a fresh accumulator per
	// function, an outer function's length would absorb every inner one's.
	stats := count(t, "a.js", `function outer() {
  const a = 1
  function inner() {
    const b = 2
    const c = 3
  }
}`)

	assertEqual(t, "Functions", stats.Functions, 2)
	// outer: the lexical declaration of `a` plus the inner declaration. inner: two.
	if stats.StatementSum < 3 {
		t.Errorf("StatementSum = %d, want the statements split across both functions", stats.StatementSum)
	}
}

func TestNestingIsMeasuredPerFunctionAndPerFile(t *testing.T) {
	stats := count(t, "a.go", `package m
func shallow() { if true {} }
func deep() { if true { for {} } }`)

	// The file's deepest point is two branches down, inside deep().
	assertEqual(t, "MaxNesting", stats.MaxNesting, 2)
	// Each function contributes its own depth: one plus two.
	assertEqual(t, "NestingSum", stats.NestingSum, 3)
}

func TestLinesOfCodeIgnoresBlankLines(t *testing.T) {
	stats := count(t, "a.go", "package m\n\n\nfunc f() {}\n\n")
	assertEqual(t, "LinesOfCode", stats.LinesOfCode, 2)
}

func TestBlockCommentsCountEveryLineTheySpan(t *testing.T) {
	stats := count(t, "a.go", "package m\n/*\na\nb\n*/\nfunc f() {}")
	assertEqual(t, "CommentLines", stats.CommentLines, 4)
}

func TestBrokenSourceStillCounts(t *testing.T) {
	// tree-sitter is error-tolerant by design. Refusing to count anything that does not
	// parse cleanly would drop a lot of ordinary source — and a repository mid-refactor is
	// still a repository.
	stats := count(t, "a.go", `package m
func f() {
	if x > 0 {
	return nil
}`)

	if stats.Functions != 1 {
		t.Errorf("Functions = %d, want 1 even from unbalanced source", stats.Functions)
	}
}

func TestUnsupportedExtensions(t *testing.T) {
	counter := NewCounter()
	defer counter.Close()

	for _, name := range []string{"logo.png", "README.md", "Makefile", "a.rs"} {
		if _, ok := counter.Count(name, []byte("whatever")); ok {
			t.Errorf("Count(%s) claimed support", name)
		}
	}
}

func TestOneCounterHandlesEveryLanguageInTurn(t *testing.T) {
	// The grammar is swapped lazily, so a mixed repository walked by one counter must not
	// parse a Python file with the grammar left over from the previous Go file.
	counter := NewCounter()
	defer counter.Close()

	sources := []struct{ name, source, language string }{
		{"a.go", "package m\nfunc f() {}", "Go"},
		{"b.py", "def f():\n    pass", "Python"},
		{"c.ts", "function f() {}", "TypeScript"},
		{"d.go", "package m\nfunc g() {}", "Go"},
		{"e.js", "function h() {}", "JavaScript"},
	}

	for _, s := range sources {
		stats, ok := counter.Count(s.name, []byte(s.source))
		if !ok {
			t.Fatalf("%s unsupported", s.name)
		}
		if stats.Language != s.language {
			t.Errorf("%s: Language = %q, want %q", s.name, stats.Language, s.language)
		}
		if stats.Functions != 1 {
			t.Errorf("%s: Functions = %d, want 1", s.name, stats.Functions)
		}
	}
}

func TestSupportedIsTheArchiveWalkersPredicate(t *testing.T) {
	// The archive walker takes this, which is what keeps the 2,000-file cap counting files
	// that will actually be parsed rather than every image in the repository.
	for _, name := range []string{"a.go", "a.ts", "a.tsx", "a.js", "a.jsx", "a.mjs", "a.py"} {
		if !Supported(name) {
			t.Errorf("Supported(%s) = false", name)
		}
	}
	for _, name := range []string{"a.png", "a.md", "a.rs", "a"} {
		if Supported(name) {
			t.Errorf("Supported(%s) = true", name)
		}
	}
}

func TestNamesAreStableAndDeduplicated(t *testing.T) {
	// .ts and .tsx need different grammars but are one language in RepoFeatures, and a
	// repository with none of these gets a 422 naming exactly this list.
	names := Names()
	joined := strings.Join(names, ",")

	if len(names) != 4 {
		t.Fatalf("Names() = %v, want four languages", names)
	}
	for _, want := range []string{"Go", "JavaScript", "Python", "TypeScript"} {
		if !strings.Contains(joined, want) {
			t.Errorf("Names() = %v, missing %s", names, want)
		}
	}
	if strings.Join(Names(), ",") != joined {
		t.Error("Names() is not stable between calls")
	}
}

func assertEqual[T comparable](t *testing.T, field string, got, want T) {
	t.Helper()
	if got != want {
		t.Errorf("%s = %v, want %v", field, got, want)
	}
}
