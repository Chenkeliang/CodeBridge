# Minimal Rich Composer and Carbon Interaction Polish

- Date: 2026-08-14
- Status: Approved design
- Scope: CodeBridge Web frontend only

## 1. Objective

Upgrade the Web conversation experience without changing any backend or Session runtime behavior:

1. Replace the plain-text Composer editing surface with a minimal rich Markdown editor.
2. Preserve pasted image and file attachment previews above the editing surface.
3. Simplify the Composer while retaining every existing capability.
4. Apply local frosted surfaces to Carbon floating interaction layers.
5. Reveal newly streamed Assistant paragraphs with restrained motion.

This work must not change Bridge APIs, Session Store authority, Coordinator behavior, queue semantics, Run cancellation, idempotency, attachment payloads, or the Markdown string submitted to the existing message endpoint.

## 2. Non-goals

- No backend, API, schema, database, Session runtime, or migration changes.
- No voice input.
- No collaborative editing.
- No byte-for-byte preservation of pasted Markdown syntax.
- No source/rich-text dual model.
- No visual table, formula, or Mermaid editor.
- No global glass treatment.
- No changes to queue ordering, Stop behavior, or submission recovery.

## 3. Interaction model

### 3.1 Composer structure

The Composer remains one rounded input surface with three vertical regions:

1. Attachment region, rendered only when attachments exist.
2. Rich Markdown editing region.
3. Minimal action row.

The action row contains:

- Left: `+` menu and current permission status.
- Right: current model menu, Stop when a Run is active, and Send.

There is no Markdown toolbar, preview tab, mode label, voice button, or persistent Enter hint.

### 3.2 Existing capability mapping

| Existing capability | New location or behavior |
| --- | --- |
| Image/file selection | `+` menu |
| Pasted image/file | Attachment region above the editor |
| Workspace context | `+` menu and direct `@` trigger |
| Flow selection | `+` menu |
| Agent commands | Direct `/` trigger |
| Permission mode | Lower-left status/menu |
| Model | Lower-right model menu |
| Reasoning effort | Model menu |
| Speed | Model menu |
| Send | Lower-right Send button and Enter |
| Newline | Shift+Enter |
| Stop | Visible while the authoritative active Run exists |
| Submit during active Run | Remains enabled and queues the next Turn |
| Queue display/control | Remains above the Composer |

Moving a control must not remove its current options, disabled states, labels, keyboard behavior, or API call.

### 3.3 Attachments

- Pasted or selected images render as removable thumbnails.
- Other files render as removable file cards.
- Attachments appear above the rich-text content inside the Composer.
- Markdown and attachments are submitted together through the existing atomic message command.
- Attachment read failures remain explicit and preserve the draft and all successfully read attachments.

## 4. Markdown editing

### 4.1 Editor boundary

Create a focused `MarkdownComposer` feature component backed by a mature ProseMirror/Tiptap editor core. It owns:

- Rich editor document state.
- Markdown paste parsing.
- Markdown typing shortcuts.
- IME-safe keyboard handling.
- Undo and redo.
- Markdown serialization before submission.

The editor does not own Session state, attachment persistence, queue state, model configuration, or network submission.

### 4.2 Supported rich semantics

Render these semantics directly in the editing surface:

- Paragraphs and line breaks.
- Headings.
- Ordered and unordered lists.
- Task lists.
- Blockquotes.
- Links.
- Bold, italic, and strike-through.
- Inline code.

Keep these as editable source-style blocks:

- Fenced code.
- Tables.
- Math.
- Mermaid.
- Unsupported Markdown extensions.

Unsupported or malformed input must remain visible as text or a source block. Parsing must never silently delete content.

### 4.3 Serialization

The editor document is the frontend source of truth while composing. Before submission it is serialized to canonical Markdown and passed as the existing `message` string.

Semantic output is preserved, but equivalent syntax may be normalized. For example, `*bold*` may serialize as `**bold**`.

The serialized Markdown must round-trip through the existing conversation `Markdown` renderer with equivalent visible meaning.

### 4.4 Keyboard and trigger behavior

- Enter submits unless a command/context picker is handling the key.
- Shift+Enter inserts a line break.
- IME composition never submits.
- `/` command discovery and `@` Workspace context discovery retain their current filtering and keyboard navigation.
- Paste prioritizes clipboard files as attachments and parses clipboard text as Markdown when text is present.

## 5. Visual system

### 5.1 Token and component layering

Follow the existing design hierarchy:

```text
DESIGN.md → semantic tokens → shadcn base components → feature components
```

Add semantic floating-surface tokens rather than raw colors in feature components. Carbon floating layers may use translucent surfaces, stronger local borders, and backdrop blur. Paper uses the same geometry with a more opaque surface.

Expose frosted styling as an explicit base-component variant for floating components such as `PopoverContent` and `SelectContent`. Do not apply it globally.

### 5.2 Allowed frosted surfaces

Frosted treatment is allowed only on:

- Composer.
- Popovers and menus.
- Command and context pickers.
- Command Palette.

The Agent Rail, Session Panel, Header, conversation canvas, Timeline content, and ordinary cards remain opaque.

Amend `docs/orchestration/DESIGN.md` so it prohibits global glass while explicitly allowing restrained Carbon frosted interaction layers.

## 6. Assistant motion

- Newly appearing Assistant paragraphs fade in and translate upward by 6–8px with a short stagger.
- The active unsealed Timeline Segment shows a blinking accent caret.
- Historical snapshot hydration, Timeline paging, and Session switching do not replay reveal animation.
- Completed segments remain memoized.
- `prefers-reduced-motion: reduce` disables reveal, caret blinking, Composer breathing, and other nonessential motion.

Motion must not change layout measurements, scroll anchoring, or event processing.

## 7. Data and authority boundaries

The frontend data path remains:

```text
Editor document
  → canonical Markdown string
  → existing safe submit helper
  → existing atomic Session message API
  → authoritative Session Store refresh
  → existing Markdown renderer
```

No optimistic Timeline event is fabricated. Stop continues to use the authoritative active Run and Runtime version. Queue cancel and Resume continue to use their existing versioned commands.

## 8. Error handling

- Markdown parsing failure: retain the original clipboard text as plain text/source content.
- Serialization failure: block submission and show an explicit Composer error; do not clear the draft or attachments.
- Attachment read failure: retain the draft and successful attachments and surface the file error.
- Definite message rejection: preserve the current rejection behavior.
- Unknown message acceptance: retain the existing idempotency key and lookup recovery.

## 9. Accessibility

- The editor has an accessible message label and exposes editable semantics.
- Every icon-only action retains an accessible name and tooltip where currently present.
- Permission, model, Stop, Send, attachment removal, command, and context actions remain keyboard reachable.
- Focus indicators use semantic tokens and meet theme contrast requirements.
- Status is never conveyed by color alone.
- Reduced-motion behavior is mandatory.

## 10. Validation

### 10.1 Editor tests

- Paste representative Markdown and assert rich document semantics.
- Serialize the document and assert canonical Markdown.
- Round-trip headings, lists, task lists, links, emphasis, quote, and inline code.
- Preserve malformed and unsupported content.
- Verify Chinese IME does not submit.
- Verify Enter, Shift+Enter, `/`, and `@`.
- Verify undo/redo.

### 10.2 Composer regression tests

- Paste and select image/file attachments.
- Show attachments above editor content and remove each independently.
- Preserve permission options.
- Preserve all model, reasoning, and speed options.
- Preserve Flow and Workspace actions in the `+` menu.
- Keep Send enabled during an active Run.
- Keep authoritative Stop behavior.
- Preserve safe submission recovery and queue behavior.
- Verify empty-Session and active-Session Composer states.

### 10.3 Visual and motion tests

- Carbon frosted variants only appear on approved floating surfaces.
- Paper and Carbon geometry remain identical.
- Historical Timeline content does not receive reveal animation.
- New active Assistant paragraphs receive staggered reveal.
- Only an unsealed active Segment receives the caret.
- Reduced motion disables all new effects.

### 10.4 Repository validation

Run the focused Web tests, Web typecheck/build, full repository tests, build, and lint. Any unrelated baseline failure must be reported explicitly rather than hidden.

## 11. Completion criteria

The work is complete when:

1. Markdown pasted into the Composer appears as rich content.
2. The submitted canonical Markdown renders equivalently in the user Timeline message.
3. Existing attachment, command, context, Flow, permission, model, queue, Stop, and safe-submit behavior remains usable.
4. The Composer matches the approved minimal layout.
5. Carbon frosted treatment is local and token-driven.
6. Assistant motion does not replay on history and respects reduced motion.
7. No backend or Session runtime file is changed.
