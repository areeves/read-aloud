/**
 * Selector tables for the AI chat extractor (ai-chat.js).
 *
 * Chat UIs change their markup often. When a site stops working this file is the
 * only thing that should need editing, so keep old and new selectors side by side.
 *
 * IMPORTANT: these selectors were assembled from public reports of each site's DOM
 * (cited per entry) and have NOT been verified against a live, signed-in session.
 * If a site starts reading the wrong text, see docs/usage/ai-chat.md for how to check
 * and fix them. If none of the `assistantMessages` tiers match, the extension falls
 * back to the generic page reader rather than failing.
 *
 * Fields:
 *   assistantMessages  Array of selector "tiers". The first tier that matches at least
 *                      one acceptable element wins, so a loose last-resort selector
 *                      can't pollute a precise one. Inside a tier, commas union.
 *   notWithin          An element matching assistantMessages is NOT an assistant message
 *                      if it sits inside one of these (e.g. user bubbles).
 *   userMessages       Used as a sanity guard: an element that contains a user message
 *                      is a conversation wrapper, not a single reply, and is rejected.
 *   content            Where the prose lives inside a message. If present, only these
 *                      regions are read (so toolbars etc. are ignored). Otherwise the
 *                      whole message is read.
 *   skip               Always ignored: UI chrome, screen-reader-only headings, etc.
 *   thinking           Reasoning / "thought process" sections (setting: aiChatThinking).
 *   citations          Source chips and footnote markers (setting: aiChatCitations).
 *   codeBlockContainers  Wrapper elements that hold a <pre> plus a header (language
 *                      label, copy button). Treated as a code block when they contain
 *                      a <pre>. Plain <pre> is always treated as a code block.
 *   streaming          Matches while a reply is still being generated. Checked on the
 *                      message, its descendants and its ancestors. If a site has no
 *                      entry the extractor infers streaming from live DOM changes.
 */
var aiChatSites = {
  "claude.ai": {
    name: "Claude",

    assistantMessages: [
      // Transcript redesign, reported Oct 2026 (sho7650/obsidian-AI-exporter#534,
      // captured from a live page on 2026-10-07).
      '[data-testid="assistant-message"], [data-cds="AssistantMessage"]',
      // Same redesign as seen by another tool (adityatiwari12/H2AI-AI-Water-Consumption#12).
      // The two reports disagree on which attributes exist, hence both.
      '[data-perf-row="assistant"]',
      // Pre-redesign.
      '.font-claude-response, .font-claude-message',
      // Last resort: #534 says the streaming flag sits on the assistant node.
      '[data-is-streaming]',
    ],
    userMessages: '[data-testid="user-message"], [data-perf-row="user"], .font-user-message',
    notWithin: [],
    content: ['.standard-markdown'],   // unchanged across the redesign per #534

    skip: [
      'h2.sr-only',                         // "Claude responded:" screen-reader heading (#534)
      '[data-testid*="action-bar" i]',      // copy / retry / date row (guess)
    ],
    thinking: [
      '[data-testid*="thinking" i]',        // guess; not verified
      '[class*="thinking" i]',
      '[data-testid*="reasoning" i]',
    ],
    citations: [
      '[data-testid*="citation" i]',        // guess; not verified
      '[class*="citation" i]',
    ],
    codeBlockContainers: [],
    streaming: ['[data-is-streaming="true"]'],
  },

  "grok.com": {
    name: "Grok",

    assistantMessages: [
      // Bubble class from several exporters. They tell user from assistant by
      // alternation, not by attribute, so we exclude user bubbles via notWithin.
      '.message-bubble',
    ],
    userMessages: '.items-end .message-bubble',     // user bubbles sit under .items-end (ai-prompts-toc README)
    notWithin: ['.items-end'],
    content: ['.response-content-markdown'],         // ai-prompts-toc README

    skip: [],
    thinking: ['.thinking-container'],              // ai-prompts-toc README
    citations: ['[data-testid*="citation" i]'],     // guess; not verified
    codeBlockContainers: ['div.not-prose'],         // code block wrapper per the Markdown exporter userscript
    streaming: [],                                  // none known; inferred from DOM changes
  },
}

/**
 * Timing knobs, in milliseconds. Exposed so tests can shrink them.
 */
var aiChatTuning = {
  pollMillis: 250,          // how often to re-check a streaming reply for new paragraphs
  settleMillis: 4000,       // no DOM change for this long = reply is finished (when site has no streaming selector)
  observeMillis: 300,       // one-time watch at start to detect streaming when site has no streaming selector
  stallMillis: 60000,       // give up waiting for a streaming reply that stops making progress
}
