# Paper Concepts

Paper Concepts is an Obsidian desktop plugin. It changes academic PDFs into linked Paper notes and Concept notes in your vault.

The plugin does not call a model API directly. It uses an AI harness that you installed and logged in to on your computer: Codex, Claude Code, or OpenCode. The plugin uses the login of that harness. It does not read or copy your credentials.

The default analysis language is Chinese. You can change the language in the prompt templates.

## Features

- **Paper notes.** Each PDF gives one Paper note with metadata, a structured analysis, and a link to the parsed text.
- **Only Markdown in your vault.** The plugin does not keep the PDF in the knowledge folder. It keeps the parsed Markdown and the images from MinerU.
- **Concept notes that grow.** A Concept collects knowledge from many papers. The plugin finds existing Concepts by name and alias, and adds only new information.
- **Plain Markdown.** Notes use YAML properties and Obsidian wiki links. You can edit all notes with usual Obsidian tools.
- **Safe updates.** The plugin keeps your personal annotation sections and your custom properties. It does not delete paragraphs from earlier versions of a note.
- **Local parsing by default.** The plugin extracts PDF text on your computer. MinerU cloud parsing is an option that you must select.
- **A queue that you can resume.** Jobs run one at a time. If Obsidian stops, the next start continues from the last saved step.
- **Prompts that you can edit.** You can change four prompt templates. Each job keeps a copy of its settings and prompts.

## How it works

1. You import a PDF. The plugin keeps a temporary copy of the PDF in its `runtime/` folder, outside the knowledge folder. The same PDF with the same parser uses one job.
2. The plugin parses the PDF to Markdown. It saves the Markdown and the images in the assets folder, and uses them again for the same PDF and parser.
3. After a parse is successful, the plugin deletes the temporary PDF copy.
4. The plugin makes a snapshot of the Paper and Concept notes in your knowledge folder.
5. The plugin copies the parsed text and the notes into a temporary folder. The harness reads only this folder, in read-only mode.
6. The harness returns one JSON object. The plugin makes sure that the JSON agrees with a fixed schema.
7. The plugin makes sure that all links in the result go to notes that exist.
8. The plugin writes the notes. It records each file change before it writes, so it can continue after a crash.
9. The plugin deletes the temporary folder.

This workflow comes from [cognitio](https://github.com/TerenceLiu98/cognitio): read the paper, look for existing knowledge, and then use that knowledge again.

## Requirements

- Obsidian desktop 1.11.4 or later. The plugin does not operate on mobile.
- One of these harnesses, installed and logged in:

| Harness | Supported major version | Executable name |
|---|---|---|
| Codex | 0 | `codex` |
| Claude Code | 2 | `claude` |
| OpenCode | 2 | `opencode` |

- Optional: a [MinerU](https://mineru.net) token for scanned PDFs or complex layouts.

The acceptance tests used macOS. Windows and Linux are not tested.

## Installation

### From a release

1. Download `paper-concepts-<version>.zip` from the Releases page.
2. Extract the archive.
3. Copy the `paper-concepts` folder into `<your vault>/.obsidian/plugins/`.
4. In Obsidian, open **Settings > Community plugins**.
5. Select the switch for **Paper Concepts**.

Copy all files from the archive. The plugin must have `pdf.worker.mjs`, the `pdf-resources/` folder, and `THIRD_PARTY_NOTICES.txt`.

To update the plugin, replace the files in the plugin folder. Do not delete `data.json` or the `runtime/` folder. They contain your settings and your job records.

### From source

You must have Node.js 22.13 or later and pnpm 11.17.0.

```sh
git clone https://github.com/ecwu/obsidian-paper-concepts.git
cd obsidian-paper-concepts
pnpm install
pnpm build
```

Copy the contents of `dist/` into `<your vault>/.obsidian/plugins/paper-concepts/`.

## Setup

1. Open **Settings > Paper Concepts**.
2. In **知识目录** (knowledge folder), type a vault-relative path. For example: `100-Research/190-Paper Library`.
3. Optional: change the names of the subfolders. One subfolder must not be inside another subfolder.
4. In **AI Harness**, select Codex, Claude Code, or OpenCode.
5. If the harness is not on your `PATH`, type the absolute path of the executable.
6. Optional: type a model name. If you leave the field empty, the plugin uses the default model of the harness.
7. Click **检测 Harness** (check harness). The plugin shows the version of the executable. It does not send a model request.
8. Click **保存并初始化目录** (save and create folders).

The plugin keeps existing files. It creates only the folders that are missing.

### Folder layout

```text
<knowledge folder>/
├── 000-Inbox/      PDFs that you put here go into the queue, then to the trash
├── 100-Papers/     one note for each paper
├── 200-Concepts/   one note for each concept
└── Assets/
    └── <PDF hash>/parsed/<parser>-v1/
        ├── full.md       parsed Markdown
        ├── images/       images from MinerU
        └── parsed.json   parse metadata
```

### MinerU (optional)

MinerU sends the PDF to the MinerU cloud service. Use it only if you agree to send the file.

1. Save your MinerU token in the Obsidian secret storage.
2. In **MinerU Token**, select that secret. The plugin does not write the token to its settings file.
3. In **PDF 解析器** (PDF parser), select MinerU. Or, if a local parse fails, use **改用 MinerU** (use MinerU) on that job.

The parser and the secret save immediately when you change them. Other fields save when you click the save button at the bottom of the page.

To test the selected secret, click **测试 MinerU API** (test MinerU API). The test sends a synthetic one-page PDF and waits for the Markdown. It tests authentication, upload, parsing, and download. The test uses parsing quota. It does not read vault files, and it does not call a harness. The result shows below the controls. You can cancel the test. The test stops after three minutes.

MinerU gives a ZIP file. The plugin keeps `full.md` and the images in the ZIP. It does not keep the JSON layout files or the copy of the PDF.

New imports use the selected parser. An import of the same PDF with a different parser makes a new job. A retry keeps the original settings. If MinerU fails, the plugin does not start local parsing.

The maximum PDF for MinerU is 200 MB and 200 pages. The plugin uses the [official v4 file API](https://mineru.net/apiManage/docs). `MINERU_API.md` shows how each API step agrees with the plugin.

## Usage

### Import PDFs

Use one of these methods:

- Click the book icon in the ribbon. Then drag PDFs onto the plugin view.
- Click **导入 PDF** (import PDF) and select one or more files.
- Use the command **导入 PDF** from the command palette.
- Copy PDFs into the inbox folder.

The plugin examines the inbox folder every two seconds. A file goes into the queue when its size and time stamp stay the same for three examinations. Then the plugin moves the inbox file to the trash that you set in Obsidian. If a file continues to change for five minutes, the plugin stops and shows a message. The file stays in the inbox folder. A file that is not a valid PDF also stays in the inbox folder.

### Manage jobs

The plugin view shows all jobs for the current knowledge folder.

| Button | Result |
|---|---|
| **暂停队列** (pause queue) | The current job continues. The next jobs wait. |
| **取消** (cancel) | Stops the current job, or removes a job from the queue. |
| **重试原任务** (retry job) | Runs the job again with its original settings and prompts. |
| **按当前设置重新分析** (analyze again with current settings) | Makes a new job with your current settings and prompts. If the parser is the same, the plugin uses the saved parsed text again. |
| **改用 MinerU** (use MinerU) | Shows on a failed local job. Makes a new job that uses MinerU to parse the PDF. |
| **打开论文** (open paper) | Opens the Paper note. |
| **查看日志** (show log) | Shows the steps of the job: the parse result, the existing knowledge, each file that the model reads or searches, and the planned writes. Each line shows one time only. |

### Note properties

A Paper note has these properties: `title`, `type: paper`, `pc-id`, `pc-source` (the PDF hash), `authors`, `year`, `doi`, `arxiv`, `tags`, `source` (a link to the parsed text), `pc-parser`, `pc-prompt`, `created`, and `updated`.

A Concept note has these properties: `title`, `type: concept`, `pc-id`, `aliases`, `tags`, `sources`, `created`, and `updated`.

The plugin finds notes by `type` and `pc-id`. Do not copy a note and keep the same `pc-id`. If two notes have the same `pc-id`, the plugin stops.

### Prompts

You can edit four templates in the settings: workflow, Paper format, Concept format, and writing rules. The JSON output contract is separate, and you cannot change it.

A prompt change has an effect only on new jobs. To compare the result, use **按当前设置重新分析** (analyze again with current settings).

## Data and safety

- The plugin writes only in the knowledge folder that you select. It does not write through symbolic links.
- The harness operates in a temporary folder with a copy of the materials. It cannot edit your vault.
- The prompt tells the harness to ignore instructions in the PDF text.
- Local parsing does not use the network. MinerU sends the PDF to the MinerU service.
- The plugin removes tokens and passwords from logs.
- Each job keeps records in `.obsidian/plugins/paper-concepts/runtime/jobs/<job id>/`: the job record, the harness result, and the file change journal.
- The temporary PDF copy is in `.obsidian/plugins/paper-concepts/runtime/sources/`. The plugin deletes it after a successful parse, if no other job for the same PDF needs it.

## Errors and recovery

- **Scanned PDF.** Local parsing gives an error if the PDF has too little text. The plugin keeps the temporary PDF copy. The plugin does not change to MinerU automatically. Use **改用 MinerU** (use MinerU).
- **A new parser after a successful parse.** The plugin deleted the PDF copy after the first successful parse. If you select a different parser and analyze the paper again, the job stops and tells you to import the PDF again.
- **Notes change during analysis.** If a note in the knowledge folder changes during a job, the plugin generates the result one more time. If the notes change again, the job stops. The plugin keeps the existing files and the generated result.
- **Interrupted writes.** The plugin uses the file change journal to continue. If you edited a file after the plugin wrote it, the plugin stops. It does not overwrite your edit.
- **Obsidian closes.** The plugin stops the harness process. At the next start, the job continues from the last saved step.

## Known limitations

- The merge rule keeps old paragraphs. If the model changes a heading or a paragraph, a note can contain the old text and the new text. This rule prevents data loss. You can remove the duplicate text manually.
- Local parsing keeps only the text in the PDF. It does not rebuild formulas, tables, or the page layout.
- If you cancel a MinerU job, the remote task can continue on the MinerU service.
- The tests did not use a real MinerU token.

## Development

```sh
pnpm install
pnpm check     # type check
pnpm test      # unit tests
pnpm build     # build into dist/
pnpm dev       # rebuild main.js when a source file changes
pnpm package   # build and make artifacts/paper-concepts-<version>.zip
```

`pnpm dev` does not copy `styles.css`. After you change the styles, run `pnpm build` again.

The unit tests use generated PDFs, temporary folders, simulated harness CLIs, and a simulated MinerU service. `scripts/smoke.ts` runs a real harness on a synthetic paper.

### Source layout

| File | Purpose |
|---|---|
| `src/main.ts` | Plugin start, commands, and inbox examination |
| `src/engine.ts` | Job queue and the parse, generate, and write pipeline |
| `src/harness.ts` | Harness CLI adapters. The `HARNESSES` table has all provider differences. |
| `src/result.ts` | JSON schema and validation for the harness result |
| `src/knowledge.ts` | Knowledge snapshot, Concept match, note merge, and journal write |
| `src/links.ts` | Link resolution and link rewrite |
| `src/parsers.ts` | Local PDF.js parser |
| `src/mineru.ts` | MinerU v4 API client, result ZIP extraction, and the API test |
| `src/parse-cache.ts` | Storage of parsed text for the next jobs |
| `src/settings.ts` | Settings, validation, and the folder layout |
| `src/scoped-vault.ts` | Vault access that stays in the knowledge folder |
| `src/jobs.ts` | Rules for job phases |
| `src/inbox.ts` | Detection of stable files in the inbox |
| `src/runtime.ts` | Job records and the temporary PDF copies on disk |
| `src/ui.ts` | Plugin view and settings tab |

Obsidian file operations go through the `VaultPort` interface in `src/types.ts`. Thus, the tests can use an in-memory vault.

`VALIDATION.md` records the results of real harness tests and Obsidian interface tests. `DESIGN.md` gives the interface rules.

## Acknowledgements

The Paper and Concept model and the "search first, then use again" workflow come from [cognitio](https://github.com/TerenceLiu98/cognitio). Paper Concepts is a separate implementation for Obsidian.

The plugin includes [PDF.js](https://github.com/mozilla/pdf.js), [yaml](https://github.com/eemeli/yaml), and [fflate](https://github.com/101arrowz/fflate). Their licenses are in `THIRD_PARTY_NOTICES.txt` in the build output.

## License

[MIT](LICENSE)
