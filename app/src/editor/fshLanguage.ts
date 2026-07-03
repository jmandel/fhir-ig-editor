// FSH syntax for Monaco. The spec's first choice is the TextMate grammar from
// SUSHI's vscode extension via a monaco-textmate shim; that shim needs onigasm
// (a wasm regex engine) + the .tmLanguage.json, which is extra offline weight and
// a second wasm to instantiate. A native Monarch tokenizer gives good FSH
// highlighting with zero extra deps and no second wasm — the pragmatic offline
// choice. (If TextMate fidelity is later wanted, register it alongside; the
// editor setup is the seam.)

import type * as MonacoNS from 'monaco-editor';

export const FSH_LANGUAGE_ID = 'fsh';

const KEYWORDS = [
  'Alias',
  'Profile',
  'Extension',
  'Instance',
  'InstanceOf',
  'Invariant',
  'ValueSet',
  'CodeSystem',
  'RuleSet',
  'Mapping',
  'Logical',
  'Resource',
  'Parent',
  'Id',
  'Title',
  'Description',
  'Expression',
  'XPath',
  'Severity',
  'Usage',
  'Source',
  'Target',
  'Context',
];

// Rule-level operator words that follow a `* path` in rules.
const RULE_KEYWORDS = [
  'obeys',
  'contains',
  'named',
  'and',
  'or',
  'only',
  'include',
  'exclude',
  'codes',
  'where',
  'valueset',
  'system',
  'from',
  'insert',
  'MS',
  'SU',
  'TU',
  'N',
  'D',
];

export const fshMonarch: MonacoNS.languages.IMonarchLanguage = {
  defaultToken: '',
  ignoreCase: false,
  keywords: KEYWORDS,
  ruleKeywords: RULE_KEYWORDS,
  tokenizer: {
    root: [
      // Line comments and block comments.
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],

      // Entity declaration keywords at line start (e.g. `Profile:`).
      [/^[A-Za-z]+(?=\s*:)/, { cases: { '@keywords': 'keyword', '@default': '' } }],

      // Caret paths (^short, ^definition) and metadata carets.
      [/\^[A-Za-z][\w.[\]]*/, 'attribute.name'],

      // Codes: #foo, system#code, "quoted"#code.
      [/#"[^"]*"/, 'string.escape'],
      [/#[^\s)]+/, 'string.escape'],

      // Canonical URLs / references in strings.
      [/"/, 'string', '@string'],

      // Cardinalities like 1..*, 0..1.
      [/\b\d+\.\.(?:\d+|\*)/, 'number'],
      [/\b\d+(?:\.\d+)?\b/, 'number'],

      // Aliases / canonical tokens like $foo.
      [/\$[\w-]+/, 'variable'],

      // Rule bullet.
      [/^\s*\*/, 'delimiter'],

      // Assignment / flag operators.
      [/[=:]/, 'operator'],
      [/->/, 'operator'],

      // Rule keywords vs identifiers.
      [
        /[A-Za-z_][\w-]*/,
        { cases: { '@ruleKeywords': 'keyword.operator', '@default': 'identifier' } },
      ],
    ],
    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
    comment: [
      [/[^/*]+/, 'comment'],
      [/\*\//, 'comment', '@pop'],
      [/[/*]/, 'comment'],
    ],
  },
};

export const fshLanguageConfig: MonacoNS.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
  ],
  autoClosingPairs: [
    { open: '"', close: '"' },
    { open: '(', close: ')' },
    { open: '[', close: ']' },
  ],
};

let registered = false;
export function registerFsh(monaco: typeof MonacoNS): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: FSH_LANGUAGE_ID, extensions: ['.fsh'] });
  monaco.languages.setMonarchTokensProvider(FSH_LANGUAGE_ID, fshMonarch);
  monaco.languages.setLanguageConfiguration(FSH_LANGUAGE_ID, fshLanguageConfig);
}
