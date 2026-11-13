# AI chat sites (claude.ai, grok.com)

On Claude and Grok, Read Aloud reads **one reply** instead of guessing at the whole page.

## What it does

- **Picks the reply for you.** Press play (or the Alt+O shortcut) and it reads the reply most visible in the window, or the last reply if none is on screen. Highlighted text is still read instead, as everywhere else.
- **Reads prose, not chrome.** Buttons, "Copy / Retry" rows, screen-reader headings such as "Claude responded:", and your own messages are ignored.
- **Headings and lists are spoken as separate paragraphs**, with numbered lists numbered.
- **Starts before the reply is finished.** If the reply is still being written, reading starts as soon as the first paragraph is complete and keeps up as more arrives.
- **Falls back gracefully.** If a site changes its markup and the reply can't be found, the normal page reader is used instead of showing an error.

## Settings

Options page, under the audio settings:

| Setting | Choices (default first) |
| --- | --- |
| Code blocks | Announce only ("Python code block, 14 lines."), Skip, Read aloud |
| Tables | Read aloud (row by row, cells separated by commas), Announce only, Skip |
| Reasoning sections | Skip, Read aloud |
| Citations | Skip, Read aloud |

## When a site stops working

Claude and Grok change their markup often, and **the selectors in this repo were assembled from public reports of each site's DOM, not checked against a live session**. All selectors live in one file, [`js/content/ai-chat-sites.js`](../../js/content/ai-chat-sites.js).

Symptoms and what they mean:

- *Reads the whole page / sidebar text:* none of `assistantMessages` matched, so the generic reader took over. The extension's console prints `no assistant messages matched`.
- *Reads your own message, or several replies:* `assistantMessages` matched the wrong element. Tighten it, or add the wrapper class of user messages to `notWithin` / `userMessages`.
- *Reads buttons, labels or "thinking" text:* add selectors to `skip` or `thinking`.
- *Skips most of the reply:* `content` points at a region that no longer holds the prose. Remove the entry to read the whole reply.
- *Reading stops early while a reply is being written, or pauses ~4 s at the end:* the site's `streaming` marker no longer matches. Fix or remove it; without a marker, streaming is inferred from live page changes.

To find the right selectors:

1. Open the chat, right-click inside a reply, choose **Inspect**.
2. Walk up the element tree to the element that wraps just that one reply. Look for a stable `data-testid`, `data-*` or semantic class, and avoid long auto-generated utility class lists.
3. In the Console, check it: `document.querySelectorAll('YOUR SELECTOR')` should return one element per reply (and not the user's messages).
4. Put it first in `assistantMessages`. Tiers are tried in order and the first tier that matches wins, so keep the older selectors below it.
5. Reload the extension and try again. `npm test` checks that every selector in the file is syntactically valid; `tests/ai-chat.test.js` has sample page structures you can extend.

## Not included (yet)

- A speaker button next to each reply (ChatGPT has one via `js/content/chatgpt.js`).
- Reading a whole conversation, or different voices for you and the assistant.
- Splitting a long paragraph at sentence boundaries to start speech sooner while it is still being generated.
