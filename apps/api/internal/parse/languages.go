package parse

import (
	ts "github.com/tree-sitter/go-tree-sitter"
	tsgo "github.com/tree-sitter/tree-sitter-go/bindings/go"
	tsjs "github.com/tree-sitter/tree-sitter-javascript/bindings/go"
	tspy "github.com/tree-sitter/tree-sitter-python/bindings/go"
	tsts "github.com/tree-sitter/tree-sitter-typescript/bindings/go"
)

// The Phase 1 languages. Every kind below was read out of the actual grammars rather than
// remembered — they differ more than the family resemblance suggests, and a misspelled kind
// fails silently as a count of zero.

// javaScriptKinds is shared with TypeScript, which is a superset of it.
var javaScriptKinds = Kinds{
	Functions: []string{
		"function_declaration",
		"function_expression",
		"generator_function",
		"generator_function_declaration",
		"arrow_function",
		"method_definition",
	},
	Classes: []string{"class_declaration", "class"},
	Branches: []string{
		"if_statement",
		"for_statement",
		"for_in_statement",
		"while_statement",
		"do_statement",
		"switch_case",
		"catch_clause",
		// A ternary forks control flow as much as an if does, and minified-adjacent code
		// leans on it heavily.
		"ternary_expression",
	},
	Comments: []string{"comment"},
	Imports:  []string{"import_statement"},
	Statements: []string{
		"expression_statement",
		"lexical_declaration",
		"variable_declaration",
		"return_statement",
		"if_statement",
		"for_statement",
		"for_in_statement",
		"while_statement",
		"do_statement",
		"switch_statement",
		"try_statement",
		"throw_statement",
		"break_statement",
		"continue_statement",
		"empty_statement",
	},
	Async: []string{"async"},
}

func typeScriptKinds() Kinds {
	kinds := javaScriptKinds
	// TypeScript adds declarations that are classes in every sense that matters here.
	kinds.Classes = append([]string{
		"interface_declaration",
		"enum_declaration",
		"abstract_class_declaration",
	}, kinds.Classes...)
	kinds.Statements = append([]string{
		"type_alias_declaration",
		"interface_declaration",
		"enum_declaration",
	}, kinds.Statements...)
	return kinds
}

var goLanguage = &Language{
	Name:       "Go",
	Extensions: []string{".go"},
	Grammar:    func() *ts.Language { return ts.NewLanguage(tsgo.Language()) },
	Kinds: Kinds{
		Functions: []string{"function_declaration", "method_declaration", "func_literal"},
		// Go has no classes. A struct or an interface is the closest thing it has to one,
		// and counting `type_declaration` instead would count `type ID = string` as a class.
		Classes: []string{"struct_type", "interface_type"},
		Branches: []string{
			"if_statement",
			"for_statement",
			"expression_case",
			"type_case",
			"communication_case",
			"default_case",
			"select_statement",
		},
		Comments: []string{"comment"},
		// One per imported package rather than one per import block.
		Imports: []string{"import_spec"},
		Statements: []string{
			"expression_statement",
			"assignment_statement",
			"short_var_declaration",
			"var_declaration",
			"const_declaration",
			"return_statement",
			"if_statement",
			"for_statement",
			"expression_switch_statement",
			"type_switch_statement",
			"select_statement",
			"go_statement",
			"defer_statement",
			"send_statement",
			"inc_statement",
			"dec_statement",
			"break_statement",
			"continue_statement",
			"labeled_statement",
		},
		// Deliberately empty. Go has neither async/await nor promises, so asyncRatio is 0
		// for a Go module. Counting goroutines here would be inventing a meaning the schema
		// does not ask for, and a wrong number is worse than an honest zero.
		Async: nil,
	},
}

var javaScriptLanguage = &Language{
	Name:       "JavaScript",
	Extensions: []string{".js", ".jsx", ".mjs", ".cjs"},
	Grammar:    func() *ts.Language { return ts.NewLanguage(tsjs.Language()) },
	Kinds:      javaScriptKinds,
}

var typeScriptLanguage = &Language{
	Name:       "TypeScript",
	Extensions: []string{".ts", ".mts", ".cts"},
	Grammar:    func() *ts.Language { return ts.NewLanguage(tsts.LanguageTypescript()) },
	Kinds:      typeScriptKinds(),
}

// TSX needs its own grammar — the JSX ambiguity cannot be resolved by the plain TypeScript
// one — but it is the same language as far as RepoFeatures is concerned.
var tsxLanguage = &Language{
	Name:       "TypeScript",
	Extensions: []string{".tsx"},
	Grammar:    func() *ts.Language { return ts.NewLanguage(tsts.LanguageTSX()) },
	Kinds:      typeScriptKinds(),
}

var pythonLanguage = &Language{
	Name:       "Python",
	Extensions: []string{".py", ".pyi"},
	Grammar:    func() *ts.Language { return ts.NewLanguage(tspy.Language()) },
	Kinds: Kinds{
		Functions: []string{"function_definition", "lambda"},
		Classes:   []string{"class_definition"},
		Branches: []string{
			"if_statement",
			"elif_clause",
			"for_statement",
			"while_statement",
			"except_clause",
			"with_statement",
			"case_clause",
			"conditional_expression",
		},
		Comments: []string{"comment"},
		Imports:  []string{"import_statement", "import_from_statement"},
		Statements: []string{
			"expression_statement",
			"return_statement",
			"pass_statement",
			"if_statement",
			"for_statement",
			"while_statement",
			"try_statement",
			"with_statement",
			"raise_statement",
			"assert_statement",
			"break_statement",
			"continue_statement",
			"delete_statement",
			"global_statement",
			"nonlocal_statement",
		},
		Async: []string{"async"},
	},
}

func init() {
	register(goLanguage, javaScriptLanguage, typeScriptLanguage, tsxLanguage, pythonLanguage)
}
