const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const {JSDOM} = require('jsdom')

const sitesSource = fs.readFileSync('js/content/ai-chat-sites.js', 'utf8')
const chatSource = fs.readFileSync('js/content/ai-chat.js', 'utf8')

const FALLBACK_TEXTS = ['generic reader text']

/**
 * Runs the real content scripts inside a jsdom window, the way the extension injects them,
 * with the few globals they expect (defaults.js, html-doc.js) stubbed.
 */
function load(html, {url = 'https://claude.ai/chat/abc', settings = {}} = {}) {
  const dom = new JSDOM(html, {url, runScripts: 'outside-only', pretendToBeVisual: true})
  const win = dom.window
  const context = dom.getInternalVMContext()
  win.console = {log() {}, warn() {}, error() {}}
  win.defaults = {aiChatCode: 'announce', aiChatTables: 'read', aiChatThinking: 'skip', aiChatCitations: 'skip'}
  win.getSettings = async () => settings
  win.waitMillis = ms => new Promise(resolve => setTimeout(resolve, ms))
  win.fallbackCalls = []
  win.readAloudDoc = {
    getCurrentIndex: () => 0,
    getTexts: (index, quietly) => {
      win.fallbackCalls.push([index, quietly])
      return index == 0 ? FALLBACK_TEXTS : null
    },
    getSelectedText: () => 'fallback selection',
  }
  vm.runInContext(sitesSource, context)
  Object.assign(win.aiChatTuning, {pollMillis: 5, settleMillis: 120, observeMillis: 40, stallMillis: 400})
  vm.runInContext(chatSource, context)
  // Arrays made inside the jsdom realm have a different Array.prototype, which strict
  // deepEqual rejects; hand tests plain arrays.
  const inner = win.readAloudDoc
  const doc = {
    getCurrentIndex: () => inner.getCurrentIndex(),
    getTexts: async (...args) => {
      const texts = await inner.getTexts(...args)
      return texts && Array.from(texts)
    },
    getSelectedText: () => inner.getSelectedText(),
  }
  return {win, doc}
}

async function read(env, index = 0) {
  env.doc.getCurrentIndex()
  return env.doc.getTexts(index)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function reply(inner, attrs = 'data-testid="assistant-message"') {
  return `<div ${attrs}>${inner}</div>`
}

const CLAUDE_REPLY = `
  <h2 class="sr-only">Claude responded: Hi there</h2>
  <div data-testid="thinking-block"><div class="standard-markdown"><p>Secret reasoning.</p></div></div>
  <div class="standard-markdown">
    <h2>Heading One</h2>
    <p>First paragraph with <strong>bold</strong> and <a href="https://x.test">a link</a>.<sup><a href="#1">1</a></sup>
       <span data-testid="citation-chip">Source chip</span></p>
    <ol><li>Step one</li><li><p>Loose step two</p></li></ol>
    <ul><li>Bullet</li></ul>
    <pre><code class="language-python">a = 1\nb = 2\n</code></pre>
    <table><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td>30</td></tr></table>
    <p>Final paragraph.</p>
  </div>
  <div><button>Copy</button><button>Retry</button></div>`

const CLAUDE_PAGE = `<main>
  <div data-testid="user-message"><p>First question</p></div>
  ${reply('<div class="standard-markdown"><p>Old reply.</p></div>')}
  <div data-testid="user-message"><p>Second question</p></div>
  ${reply(CLAUDE_REPLY)}
</main>`

// ---------------------------------------------------------------- Claude

test('claude: reads only the last reply, skipping chrome, reasoning, citations; announces code', async () => {
  const texts = await read(load(CLAUDE_PAGE))
  assert.deepEqual(texts, [
    'Heading One',
    'First paragraph with bold and a link.',
    '1. Step one',
    '2. Loose step two',
    'Bullet',
    'Python code block, 2 lines.',
    'Name, Age.',
    'Ann, 30.',
    'Final paragraph.',
  ])
})

test('claude: second layout (data-perf-row, font-claude-response, no markdown wrapper)', async () => {
  const html = `
    <div data-testid="transcript-row" data-perf-row="user"><div class="font-user-message"><p>Q</p></div></div>
    <div data-testid="transcript-row" data-perf-row="assistant">
      <div class="font-claude-response"><p>Answer B1.</p><p>Answer B2.</p></div>
      <button>Copy</button>
    </div>`
  assert.deepEqual(await read(load(html)), ['Answer B1.', 'Answer B2.'])
})

test('claude: pre-redesign layout (.font-claude-message)', async () => {
  const html = `<div class="font-user-message">Q</div><div class="font-claude-message"><p>Old style answer.</p></div>`
  assert.deepEqual(await read(load(html)), ['Old style answer.'])
})

test('claude: a match that wraps the whole conversation is not treated as one reply', async () => {
  const html = `<div data-testid="assistant-message"><div data-testid="user-message">Q</div><p>Everything</p></div>`
  const env = load(html)
  assert.deepEqual(await read(env), FALLBACK_TEXTS)
  assert.equal(env.win.fallbackCalls.length, 1)
})

test('claude: reasoning and citations are read when the settings say so', async () => {
  const env = load(CLAUDE_PAGE, {settings: {aiChatThinking: 'read', aiChatCitations: 'read'}})
  const texts = await read(env)
  assert.equal(texts[0], 'Secret reasoning.')
  assert.ok(texts.includes('First paragraph with bold and a link. Source chip'), texts.join('|'))
})

test('code setting: skip drops it, read reads it line by line', async () => {
  const skipped = await read(load(CLAUDE_PAGE, {settings: {aiChatCode: 'skip'}}))
  assert.ok(!skipped.some(t => /code block|a = 1/.test(t)))
  const spoken = await read(load(CLAUDE_PAGE, {settings: {aiChatCode: 'read'}}))
  const i = spoken.indexOf('a = 1')
  assert.ok(i >= 0 && spoken[i + 1] == 'b = 2', spoken.join('|'))
})

test('tables setting: announce and skip', async () => {
  const announced = await read(load(CLAUDE_PAGE, {settings: {aiChatTables: 'announce'}}))
  assert.ok(announced.includes('Table, 2 rows, 2 columns.'))
  assert.ok(!announced.includes('Ann, 30.'))
  const skipped = await read(load(CLAUDE_PAGE, {settings: {aiChatTables: 'skip'}}))
  assert.ok(!skipped.some(t => /Table|Ann/.test(t)))
})

test('invalid setting values fall back to the defaults', async () => {
  const texts = await read(load(CLAUDE_PAGE, {settings: {aiChatCode: 'bogus', aiChatThinking: 42}}))
  assert.ok(texts.includes('Python code block, 2 lines.'))
  assert.ok(!texts.includes('Secret reasoning.'))
})

test('hidden content is not read', async () => {
  const html = reply(`<div class="standard-markdown">
    <p>Visible.</p><p aria-hidden="true">Aria hidden.</p><p hidden>Attr hidden.</p>
    <p style="display:none">Css hidden.</p><span class="katex"><span class="katex-html" aria-hidden="true">x2</span>
    <span class="katex-mathml"><math><semantics><mi>x</mi><mo>=</mo><mn>2</mn><annotation encoding="application/x-tex">x=2</annotation></semantics></math></span></span></div>`)
  const texts = await read(load(html))
  assert.deepEqual(texts, ['Visible.', 'x = 2'.replace(/ /g, '')])
})

test('bare <sup> (an exponent) is kept; <sup> holding a link is dropped', async () => {
  const html = reply('<div class="standard-markdown"><p>10<sup>3</sup> and note<sup><a href="#n">1</a></sup></p></div>')
  assert.deepEqual(await read(load(html)), ['103 and note'])
})

// ------------------------------------------------------------- choosing a reply

test('picks the reply most visible in the viewport, else the last', async () => {
  const html = `<div data-testid="user-message">Q1</div>${reply('<p id="a">Reply A</p>')}
    <div data-testid="user-message">Q2</div>${reply('<p id="b">Reply B</p>')}`
  const env = load(html)
  const [a, b] = env.win.document.querySelectorAll('[data-testid="assistant-message"]')
  env.win.innerHeight = 800
  a.getBoundingClientRect = () => ({top: 100, bottom: 700})
  b.getBoundingClientRect = () => ({top: 900, bottom: 1500})
  assert.deepEqual(await read(env), ['Reply A'])

  const offscreen = load(html)
  const [a2, b2] = offscreen.win.document.querySelectorAll('[data-testid="assistant-message"]')
  a2.getBoundingClientRect = () => ({top: -900, bottom: -100})
  b2.getBoundingClientRect = () => ({top: 2000, bottom: 2600})
  assert.deepEqual(await read(offscreen), ['Reply B'])
})

test('a new play request starts a fresh session and re-picks the reply', async () => {
  const env = load(`${reply('<p>Reply A</p>')}${reply('<p>Reply B</p>')}`)
  const [a, b] = env.win.document.querySelectorAll('[data-testid="assistant-message"]')
  a.getBoundingClientRect = () => ({top: 0, bottom: 100})
  b.getBoundingClientRect = () => ({top: 5000, bottom: 5100})
  assert.deepEqual(await read(env), ['Reply A'])
  a.getBoundingClientRect = () => ({top: -500, bottom: -400})
  b.getBoundingClientRect = () => ({top: 0, bottom: 100})
  assert.deepEqual(await read(env), ['Reply B'])
})

// ------------------------------------------------------------------- Grok

const GROK_PAGE = `
  <div class="flex items-end"><div class="message-bubble"><div class="response-content-markdown"><p>User question</p></div></div></div>
  <div class="flex items-start"><div class="message-bubble">
    <div class="thinking-container"><p>Thinking about it</p></div>
    <div class="response-content-markdown">
      <p>Answer para one.</p>
      <div class="not-prose"><div><span>python</span><button>Copy</button></div><pre><code>print(1)</code></pre></div>
      <p>Answer para two.</p>
    </div>
  </div></div>`

test('grok: excludes user bubbles and reasoning, announces code in its wrapper', async () => {
  const env = load(GROK_PAGE, {url: 'https://grok.com/chat/1'})
  assert.deepEqual(await read(env), ['Answer para one.', 'Code block, 1 line.', 'Answer para two.'])
})

test('grok: code read aloud; reasoning read when enabled', async () => {
  const env = load(GROK_PAGE, {url: 'https://grok.com/chat/1', settings: {aiChatCode: 'read', aiChatThinking: 'read'}})
  assert.deepEqual(await read(env), ['Thinking about it', 'Answer para one.', 'print(1)', 'Answer para two.'])
})

test('grok: with only user bubbles on the page, falls back to the generic reader', async () => {
  const html = '<div class="items-end"><div class="message-bubble"><p>Only me</p></div></div>'
  assert.deepEqual(await read(load(html, {url: 'https://grok.com/'})), FALLBACK_TEXTS)
})

// ---------------------------------------------------------------- fallbacks

test('falls back to the generic reader when no reply is found', async () => {
  const env = load('<p>Landing page</p>')
  assert.deepEqual(await read(env), FALLBACK_TEXTS)
  assert.equal(env.doc.getSelectedText(), 'fallback selection')
})

test('falls back when a reply is found but yields nothing even with every skip rule off', async () => {
  const env = load(reply(''))
  assert.deepEqual(await read(env), FALLBACK_TEXTS)
})

test('a reply whose only content is deliberately skipped is not treated as a broken selector', async () => {
  const env = load(reply('<div class="standard-markdown"><pre>x = 1</pre></div>'), {settings: {aiChatCode: 'skip'}})
  assert.deepEqual(await read(env), [])
  assert.equal(await env.doc.getTexts(1), null)
  assert.equal(env.win.fallbackCalls.length, 0)
})

test('unsupported hosts use the generic reader', async () => {
  const env = load(reply('<p>x</p>'), {url: 'https://example.com/'})
  assert.deepEqual(await read(env), FALLBACK_TEXTS)
})

test('every configured selector is valid', () => {
  const {win} = load('<p></p>')
  for (const [host, site] of Object.entries(win.aiChatSites)) {
    const selectors = [...site.assistantMessages, site.userMessages, ...site.notWithin, ...site.content,
      ...site.skip, ...site.thinking, ...site.citations, ...site.codeBlockContainers, ...site.streaming]
    for (const selector of selectors.filter(Boolean)) {
      assert.doesNotThrow(() => win.document.querySelector(selector), `${host}: ${selector}`)
    }
  }
})

// ---------------------------------------------------------------- streaming

const para = (text) => `<p>${text}</p>`

test('streaming (explicit marker): pages are released as paragraphs complete', async () => {
  const env = load(`<div data-testid="user-message">Q</div>
    <div data-testid="assistant-message" data-is-streaming="true"><div class="standard-markdown">${para('One.')}${para('Tw')}</div></div>`)
  const message = env.win.document.querySelector('[data-testid="assistant-message"]')
  const body = message.querySelector('.standard-markdown')
  env.doc.getCurrentIndex()

  assert.deepEqual(await env.doc.getTexts(0), ['One.'])          // 'Tw' may still be growing
  assert.equal(await env.doc.getTexts(1, true), null)            // peeking ahead never blocks...
  assert.deepEqual(await env.doc.getTexts(0), ['One.'])          // ...and pages are memoized

  const next = env.doc.getTexts(1)
  await sleep(30)
  body.lastElementChild.textContent = 'Two.'
  body.insertAdjacentHTML('beforeend', para('Thr'))
  assert.deepEqual(await next, ['Two.'])

  const last = env.doc.getTexts(2)
  await sleep(30)
  body.lastElementChild.textContent = 'Three.'
  message.setAttribute('data-is-streaming', 'false')
  assert.deepEqual(await last, ['Three.'])
  assert.equal(await env.doc.getTexts(3), null)
  assert.deepEqual(await env.doc.getTexts(1), ['Two.'])          // rewinding still works
})

test('streaming (inferred from DOM changes) when the site has no marker', async () => {
  const env = load(`<div class="message-bubble"><div class="response-content-markdown">${para('One.')}${para('Two')}</div></div>`,
    {url: 'https://grok.com/chat/1'})
  const body = env.win.document.querySelector('.response-content-markdown')
  env.doc.getCurrentIndex()
  const first = env.doc.getTexts(0)
  await sleep(10)                                                // inside the initial observation window
  body.lastElementChild.textContent = 'Two.'
  body.insertAdjacentHTML('beforeend', para('Three'))
  assert.deepEqual(await first, ['One.', 'Two.'])                // 'Three' may still be growing: held back

  const second = env.doc.getTexts(1)
  await sleep(10)
  body.lastElementChild.textContent = 'Three.'
  body.insertAdjacentHTML('beforeend', para('Fou'))
  assert.deepEqual(await second, ['Three.'])
  assert.deepEqual(await env.doc.getTexts(2), ['Fou'])           // changes stop; the last paragraph is released
  assert.equal(await env.doc.getTexts(3), null)
})

test('streaming: reply re-mounted by the site is found again', async () => {
  const env = load(`<div data-testid="user-message">Q</div>
    <div data-testid="assistant-message" data-is-streaming="true"><div class="standard-markdown">${para('One.')}${para('Tw')}</div></div>`)
  env.doc.getCurrentIndex()
  assert.deepEqual(await env.doc.getTexts(0), ['One.'])

  const next = env.doc.getTexts(1)
  await sleep(20)
  env.win.document.querySelector('[data-testid="assistant-message"]').remove()
  env.win.document.body.insertAdjacentHTML('beforeend',
    `<div data-testid="assistant-message" data-is-streaming="false"><div class="standard-markdown">${para('One.')}${para('Two.')}${para('Three.')}</div></div>`)
  assert.deepEqual(await next, ['Two.', 'Three.'])
  assert.equal(await env.doc.getTexts(2), null)
})

test('streaming: a reply that stops making progress is eventually read to the end', async () => {
  const env = load(`<div data-testid="assistant-message" data-is-streaming="true"><div class="standard-markdown">${para('One.')}${para('Two')}</div></div>`)
  env.doc.getCurrentIndex()
  assert.deepEqual(await env.doc.getTexts(0), ['One.'])
  assert.deepEqual(await env.doc.getTexts(1), ['Two'])           // after stallMillis
  assert.equal(await env.doc.getTexts(2), null)
})

test('a newer play request supersedes a pending streaming wait', async () => {
  const env = load(`<div data-testid="assistant-message" data-is-streaming="true"><div class="standard-markdown">${para('One.')}${para('Two')}</div></div>`)
  env.doc.getCurrentIndex()
  await env.doc.getTexts(0)
  const stale = env.doc.getTexts(1)
  await sleep(20)
  env.doc.getCurrentIndex()
  assert.equal(await stale, null)
})
