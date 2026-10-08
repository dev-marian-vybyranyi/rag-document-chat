# Sample documents

Public documents for trying the app and for the evaluation set (`scripts/eval/`). They are
stored **exactly as downloaded**, without edits, so the hash below identifies the file and
a question about them can be checked against the original.

| File | What it is | Source | Retrieved | License |
|---|---|---|---|---|
| `nist-ai-rmf-1.0.pdf` | NIST AI 100-1, *Artificial Intelligence Risk Management Framework (AI RMF 1.0)*, January 2023, 48 pages | https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf (DOI 10.6028/NIST.AI.100-1) | 2026-10-08 | Work of NIST, a US federal agency: not subject to copyright in the United States; NIST asks for attribution and notes that protection may apply abroad. See [NIST's statement](https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications). |
| `rfc8259-json.txt` | RFC 8259, *The JavaScript Object Notation (JSON) Data Interchange Format*, December 2017 | https://www.rfc-editor.org/rfc/rfc8259.txt | 2026-10-08 | Copyright (c) 2017 IETF Trust and the persons identified as the document authors. Distributed under the IETF Trust Legal Provisions (TLP), as stated in the notice inside the file; redistributed unmodified. |
| `rfc6749-oauth2.txt` | RFC 6749, *The OAuth 2.0 Authorization Framework*, October 2012 | https://www.rfc-editor.org/rfc/rfc6749.txt | 2026-10-08 | Copyright (c) 2012 IETF Trust and the persons identified as the document authors. IETF Trust Legal Provisions (TLP), as stated in the file; redistributed unmodified. |
| `rust-book-ownership.md` | *The Rust Programming Language*, chapter 4.1 "What Is Ownership?" (`src/ch04-01-what-is-ownership.md`) | https://github.com/rust-lang/book (commit `1500248d8f230566e4ec9f27fcbb8fe9e2898ab1`) | 2026-10-08 | MIT or Apache-2.0, at your option. Copies in `licenses/`. |
| `rust-book-generics.md` | *The Rust Programming Language*, chapter 10.1 "Generic Data Types" (`src/ch10-01-syntax.md`) | https://github.com/rust-lang/book (same commit) | 2026-10-08 | MIT or Apache-2.0, at your option. Copies in `licenses/`. |

## SHA-256

```
7576edb531d9848825814ee88e28b1795d3a84b435b4b797d3670eafdc4a89f1  nist-ai-rmf-1.0.pdf
61a5378f4255c720beb2a4b4a63b29540147c140f36988bf086291989b4cd2d7  rfc8259-json.txt
f204fc8661d6c92d2ec6e0b54808f961a9ad26e792f57f312d9528335519bd71  rfc6749-oauth2.txt
873724c6862ad0cc447becf0e818eb39a324c5d4bfa26ef721286aae1941c0ba  rust-book-ownership.md
c88e9d9404ce16c820b4f4f84af73f40b4eb4978020dc3a1cead90ba0ac2569a  rust-book-generics.md
```

## Notes for whoever writes questions about them

- The two Rust Book files are Markdown source for the book's build tool and still contain its
  `{{#include ...}}` / `{{#rustdoc_include ...}}` directives where the book inserts code
  listings. The listings themselves are not in the files, so ask about the prose, not about
  code that the text only refers to.
- The RFCs are plain text with page headers and footers (`Hardt  Standards Track  [Page 7]`)
  repeated every page; the PDF has real page numbers, which the app turns into citations.
- Each licensor's text is the authority, not this summary. Check the original before reusing a
  file outside this repository.
