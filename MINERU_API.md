# MinerU API correspondence

Date of review: 2026-10-18. Source: the [official documentation](https://mineru.net/apiManage/docs).

The plugin uses the v4 file API with a token. It does not use the Agent API, which has no token.

| Step | Official contract | Plugin behavior |
|---|---|---|
| Request upload | POST `/api/v4/file-urls/batch` | Sends one `files` entry with `name` and `data_id` |
| Model | `model_version` | Selects `vlm`, and sets table and formula extraction to on |
| Authentication | `Authorization: Bearer <token>` | Sends the header only to the official API host |
| Upload | PUT the file bytes to `data.file_urls[0]` | Sends the PDF bytes with no headers |
| Submission | The upload starts the task automatically | Does not send a second request |
| Poll | GET `/api/v4/extract-results/batch/{batch_id}` | Reads `data.extract_result[0]` |
| Progress | `state` and `extract_progress` | Shows the queue state and the page count, if the API gives it |
| Result | `full_zip_url` when `state` is `done` | Downloads the ZIP with no token |
| Markdown | `full.md` in the ZIP | Keeps `full.md` and the images beside it |

## Result ZIP

The plugin keeps these files:

- `full.md`, the parsed Markdown.
- The images in the same folder as `full.md` or in its subfolders: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, and `.svg`. The image links in `full.md` use relative paths, for example `images/<name>.jpg`.

The plugin saves these files in `<assets>/<PDF hash>/parsed/mineru-v1/`. The relative image links stay correct. The plugin does not keep `layout.json`, the `_model.json` and `_content_list.json` files, or the copy of the PDF.

The model reads only the Markdown text. If the model copies an image link into a note, the plugin changes the link to the saved image.

## Errors

The plugin gives a clear message for these API codes:

- `A0202`: the token is not valid.
- `A0211`: the token expired.
- `-60018`: you used all tasks of the daily limit.

For other codes, the plugin shows the server message, the HTTP status, and the code. Error messages do not show the token.

## Limits

- The maximum file size is 200 MB. The plugin examines the size before the upload.
- The maximum page count is 200 pages. The service examines the page count and gives code `-60006`.

## API test in the settings

The settings test uses the same parser and HTTP client as the paper jobs. It sends a synthetic one-page PDF that is part of the plugin. It does not read vault files, call a harness, or write notes. It stops after three minutes. You can cancel it.

## Test coverage

The contract tests use simulated responses. A live test needs a selected secret in Obsidian. The live test button was not used during this change.
