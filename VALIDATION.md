# Validation record

Date: 2026-10-18. All test papers are synthetic. The tests did not use private notes.

## Code changes after acceptance

After the acceptance tests on this page, the source code changed. The change was a structural refactor. It did not add features.

- The automatic tests pass after the change: 5 test files, 61 tests.
- `pnpm check` and `pnpm build` pass after the change.
- The real harness tests and the Obsidian interface tests below used the code before the change. These tests are not done again.
- The archive `artifacts/paper-concepts-0.1.0.zip` contains the code before the change.

## Automatic tests

At acceptance, `pnpm test` passed: 5 test files, 60 tests. `pnpm check` and `pnpm package` also passed.

The tests cover these areas:

- **Parsers.** Local PDF text and page offsets, rejection of scanned PDFs, cancellation, and offline CMap and font files. MinerU upload, status requests, download, timeout, and limits on attachment paths.
- **Harness adapters.** Three simulated CLIs. The tests cover the output protocols, arguments, login failure, removal of secrets from logs, unusual exit, timeout, and cancellation.
- **Note writes.**
  - Folder limits, papers with the same title, and Concept match by alias.
  - Sources that accumulate, kept properties, and kept personal annotations.
  - Links, edits at the same time, and renamed notes.
  - Recovery file by file, and duplicate imports.
- **Queue.**
  - One job at a time, and recovery of job state.
  - Copies of settings and prompts, and use of saved parsed text.
  - Import errors for each file, a new generation after a conflict, and interruption at shutdown.

The archive contains 204 file entries. It includes the PDF.js worker, 169 CMap entries, 16 font entries, and 13 WASM entries. Each resource folder contains its license.

## Real harnesses

Codex 0.162.1, Claude Code 2.1.300, and OpenCode v2.0.29 each analyzed a synthetic paper. Each CLI used its existing login.

The model field was empty. Each harness used its default model and its login. The plugin did not send model API requests directly.

For this short paper, Codex and OpenCode returned zero Concepts. Claude returned one Concept. The plugin accepts zero Concepts. Thus, a test does not force the model to make term pages.

## Obsidian interface

The host was Obsidian 1.14.4 on macOS. The tests used a separate vault at `/private/tmp/paper-concepts-acceptance`.

These results were correct:

- The plugin detected a PDF in the inbox folder. It saved the original PDF, parsed it in the worker, generated a result with a simulated harness, and saved the Markdown.
- Real Claude did **重新分析** (analyze again). The plugin used the saved parsed text again. After a restart, the plugin showed the completed jobs correctly.
- Real Claude updated an existing Attention Concept from `Controlled Attention Study`. The old `pc-id`, the custom properties, and the personal annotations stayed in the note.
- The native file selector imported `Controlled Attention Replication`. The build with all offline resources did local parsing, real Claude analysis, and automatic save.

During this job, Folder Notes 1.8.26 and Git 2.41.1 were also on. Folder Notes registered its commands correctly. Git showed the ready state. The test vault did not get unwanted folder index notes.

The automatic Git operations in the test vault were off. The tests did not push, pull, or commit.

The screenshot is `.impeccable/review/desktop.png`. A separate final review examined content preservation, the secret copy for each job, batch import, and resource packaging. The review found these items correct and approved the release.

## Areas not tested

- MinerU used a simulated service. The tests did not send a real token to the official service.
- A full set of real papers is not tested. The quality of scanned PDFs, two-column layouts, formulas, and tables needs more tests. Local parsing keeps the text in the PDF. It does not rebuild formulas or the page layout.
- The minimum supported version is Obsidian 1.11.4. The interface tests used version 1.14.4. Windows, Linux, and the minimum version are not tested.
- Drag-and-drop and the file selector use the same import function. The interface tests used the file selector and the inbox folder. They did not use a drag from Finder.
- The body merge keeps old material by section and by paragraph. If the model changes a section name, the old material can stay as an extra section. You can edit it later as usual Markdown.
- Cancel stops the local wait and the save steps. A task that MinerU received can continue on the MinerU service.

## MinerU changes and Markdown-only storage, 2026-10-18

After these changes, the automatic tests pass: 7 test files, 83 tests. `pnpm check` and `pnpm build` also pass.

The new tests cover these areas:

- **Settings.** The parser and the secret save immediately. Settings writes occur one after another.
- **Parsers.** Each parser has its own saved parse. An import with a different parser makes a new job.
- **MinerU API.** The official v4 methods, the request fields, the upload bytes, and the progress messages. Tokens that are not valid or expired, the daily limit, cancellation, and the three-minute test limit.
- **Settings controls.** Simulated native controls for the parser, the secret, the test result, and cancellation when the settings close.
- **PDF storage.** The PDF does not go into the vault. The plugin keeps a temporary copy until a parse is successful. It keeps the copy while another job for the same PDF needs it. If a new parser needs the PDF after the plugin deleted it, the job stops and asks for the PDF again.

These tests were not done:

- The tests did not operate the live Obsidian controls.
- The tests did not call MinerU with a real token.
- The tests did not move a real inbox file to the Obsidian trash. Simulated vaults do not have a trash.

`MINERU_API.md` shows how each API step agrees with the plugin.
