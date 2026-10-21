---
name: Paper Concepts
description: Native Obsidian desktop surface that changes imported PDFs into linked paper knowledge.
colors:
  interactive-accent: "var(--interactive-accent)"
  background-primary: "var(--background-primary)"
  background-secondary: "var(--background-secondary)"
  background-hover: "var(--background-modifier-hover)"
  background-border: "var(--background-modifier-border)"
  text-normal: "var(--text-normal)"
  text-on-accent: "var(--text-on-accent)"
  text-muted: "var(--text-muted)"
  text-success: "var(--text-success)"
  text-error: "var(--text-error)"
typography:
  view-title:
    fontFamily: "inherit"
    fontSize: "var(--h2-size)"
  section-title:
    fontFamily: "inherit"
    fontSize: "var(--h4-size)"
  ui-medium:
    fontFamily: "inherit"
    fontSize: "var(--font-ui-medium)"
  ui-small:
    fontFamily: "inherit"
    fontSize: "var(--font-ui-small)"
  ui-smaller:
    fontFamily: "monospace"
    fontSize: "var(--font-ui-smaller)"
rounded:
  medium: "var(--radius-m)"
spacing:
  action-gap: "8px"
  drop-gap: "10px"
  log-inset: "12px"
  detail-gap: "14px"
  control-gap: "16px"
  row-inset: "20px"
  section-inset: "32px"
components:
  button-primary:
    backgroundColor: "{colors.interactive-accent}"
    textColor: "{colors.text-on-accent}"
    typography: "{typography.ui-medium}"
  button-secondary:
    backgroundColor: "{colors.background-hover}"
    textColor: "{colors.text-normal}"
    typography: "{typography.ui-medium}"
  drop-zone:
    backgroundColor: "{colors.background-secondary}"
    rounded: "{rounded.medium}"
    padding: "32px 24px"
  task-row:
    typography: "{typography.ui-medium}"
    padding: "20px 0"
  status-success:
    textColor: "{colors.text-success}"
    typography: "{typography.ui-small}"
  status-error:
    textColor: "{colors.text-error}"
    typography: "{typography.ui-small}"
  log-block:
    backgroundColor: "{colors.background-secondary}"
    typography: "{typography.ui-smaller}"
    padding: "{spacing.log-inset}"
---

# Design System: Paper Concepts

## Overview

**Creative North Star: "The Native Obsidian Workbench"**

Paper Concepts is a workbench in Obsidian. It uses the active desktop theme and the native Obsidian controls. The content area is quiet. Thus, a researcher can go from PDF import to job records without a new visual language.

Spacing, type size, and status text make the visual hierarchy. The Chinese labels are direct and functional. The reviewed screen is dark because the host theme is dark. The design system does not have its own light or dark palette. The accent, surface, divider, and status colors are theme variables.

**Key Characteristics:**

- Native Obsidian desktop frame and controls.
- Surfaces that use the theme, with no brand palette.
- Compact job records that are easy to read, with functional Chinese text.
- Flat surfaces, a drop area with a dashed border, and thin dividers.

## Colors

The palette is semantic, and the host theme controls it. Use the Obsidian variables. Thus, the active theme sets all colors.

### Primary

- **Theme Accent** (`var(--interactive-accent)`): Primary actions, the drag-over indication, and the visible focus outline.

### Secondary

- **Success Signal** (`var(--text-success)`): Completed job states.

### Tertiary

- **Error Signal** (`var(--text-error)`): Failed job states and error messages in the job row.

### Neutral

- **Workspace Canvas** (`var(--background-primary)`): The surface of the view.
- **Raised Surface** (`var(--background-secondary)`): The drop area and the open log block.
- **Interaction Surface** (`var(--background-modifier-hover)`): The hover and drag indication on the drop area and on native controls.
- **Theme Divider** (`var(--background-modifier-border)`): The dashed border of the drop area and the dividers between job rows.
- **Normal Text** (`var(--text-normal)`): Primary labels and the text in native Obsidian controls.
- **Muted Text** (`var(--text-muted)`): Supporting text, metadata, inactive states, and the log label.
- **Accent Text** (`var(--text-on-accent)`): Text on the primary action button.

### Named Rules

**The Host Theme Rule.** Do not add hex colors to the project. All surface, text, accent, and state colors come from Obsidian variables.

## Typography

**Display Font:** the font of the active Obsidian interface theme
**Body Font:** the font of the active Obsidian interface theme
**Label/Mono Font:** the monospace font of the host, for log output

**Character:** The type hierarchy is quiet and functional. Native Obsidian heading sizes make the two section levels. Smaller theme UI sizes make the job metadata and the status text easy to read.

### Hierarchy

- **View title** (`var(--h2-size)`): The `论文知识库` (paper library) view heading.
- **Section title** (`var(--h4-size)`): The `处理记录` (job records) heading and other section labels.
- **UI text** (`var(--font-ui-medium)`): Paper names and the text of native controls.
- **Meta / status** (`var(--font-ui-small)`): Harness, parser, time stamp, queue status, and muted supporting text.
- **Log** (`var(--font-ui-smaller)`): Monospace job output in the log block that opens and closes.

### Named Rules

**The Functional Copy Rule.** Keep labels direct, short, and related to the task. The Chinese UI text gives the name of the action or the state. Do not use promotional language.

## Layout

The view is designed for the sidebar. It has `12px` padding and no maximum width. The header is one line: the `论文知识库` title at one edge, and three native `clickable-icon` buttons at the other edge (import, pause/resume the queue, settings). Below it is a one-line drop strip and a faint context line that is cut with an ellipsis. The whole view accepts dropped PDFs; the strip shows the drag-over state.

Jobs are in two sections with small muted section labels. `进行中` lists every job that has not succeeded (active, queued, failed, cancelled, interrupted) as full rows. `已完成` is a compact list that opens and closes. It shows 10 papers first, and a `显示更多` button adds more.

## Elevation & Depth

The design is flat by default. It uses the primary and secondary surfaces of the active theme, a dashed border around the drop area, and thin dividers between job records. It does not use custom shadows, gradients, or floating cards.

### Named Rules

**The Flat-by-Default Rule.** Show depth with the tonal surfaces and dividers of the theme. Do not add shadows or decorative effects to the project.

## Shapes

The drop area is the only custom surface with rounded corners. It uses the Obsidian medium radius (`var(--radius-m)`) and a one-pixel dashed border. Job records use the page surface and a one-pixel line at the bottom. They do not have a card outline. Native buttons, settings fields, dropdowns, secret fields, and text areas keep the shape of the active Obsidian controls. The drop area shows a two-pixel accent focus outline with a three-pixel offset.

## Components

### Buttons

- **Shape:** The native Obsidian button, with no plugin-specific shape.
- **Primary:** The `mod-cta` action uses the theme accent. The `导入 PDF` (import PDF) button and the save button in the settings use it.
- **Hover / Focus:** The theme controls these states. The plugin does not add a shadow or motion.
- **Secondary:** The default native button. The `配置知识库` (set up library) button, the queue controls, and the job actions use it.

### Drop zone

- **Style:** A vertical stack at the center, on the secondary theme surface. It has a one-pixel dashed border, the medium radius, and `32px 24px` padding.
- **State:** On hover and on drag-over, the border changes to the accent color and the surface changes to the theme hover color. Keyboard focus shows a two-pixel accent outline with a three-pixel offset.

### Task records

- **Unfinished jobs:** A transparent `article` row with a bottom divider. The first line has the file name (at most two lines) and the state. The active job shows one line with the current phase. A failed job shows one alert line. Small native buttons (`取消`, `重试`, `改用 MinerU`) and a `⋯` menu button are below.
- **Completed jobs:** One line each: the file name without `.pdf`, cut with an ellipsis, and a short date. A click opens the paper. The tooltip shows the full name, harness, parser, and time. The `⋯` button (shown on hover) and the context menu hold `打开论文`, `按当前设置重新分析`, and `查看日志`.
- **States:** Completed text uses the theme success color. Failed text and error messages use the theme error color. Other phases use muted text.

### Inputs / fields

- **Style:** The settings use the native Obsidian `Setting`, dropdown, secret, and text area controls.
- **Focus:** Keep the focus style of the host controls. Prompt text areas have the full width and a minimum height of `130px`. The user can change their height. Their line height is `1.6`.

### Logs and status

- **Status:** The queue context and the states that are not final use small muted UI text. The success and error states use semantic theme colors.
- **Log block:** `查看日志` (show log) in the `⋯` menu opens the log under its row. Its `pre` content uses the secondary surface, an `8px` inset, small monospace text, and line wrap. Its maximum height is `220px`. If the content is longer, the block scrolls.

## Do's and Don'ts

### Do:

- **Do** use the native Obsidian controls and the variables of the active theme.
- **Do** keep the Chinese labels direct, and keep the status and metadata lines short.
- **Do** keep the job rows flat, with one-pixel theme dividers between them and semantic status colors.
- **Do** keep the keyboard focus on the drop area visible, with the two-pixel accent outline and the three-pixel offset.

### Don't:

- **Don't** add a hex palette, gradients, shadows, custom fonts, or a brand frame.
- **Don't** change job records into floating cards. Keep their transparent surface and their bottom divider.
- **Don't** replace the host navigation, and do not add a second application frame in the plugin view.
- **Don't** use decorative text. Do not use a status color without a state meaning.
