//includes html-doc.js and ai-chat-sites.js

/**
 * Reads one AI chat reply (claude.ai, grok.com) instead of the whole page.
 *
 * - Picks the reply to read: the one most visible in the viewport, else the last.
 *   (Highlighted text is still handled by content.js and wins over this.)
 * - Reads only the reply's prose. Code blocks, tables, reasoning sections and citation
 *   chips are skipped / announced / read according to the aiChat* settings.
 * - If the reply is still being generated, hands text to the reader in pages as
 *   paragraphs complete, so speech can start before generation finishes.
 * - If the site's markup isn't recognized, defers to the generic page reader (html-doc.js).
 *
 * Selectors live in ai-chat-sites.js.
 */
readAloudDoc = (function(fallback) {
  var SETTING_NAMES = ["aiChatCode", "aiChatTables", "aiChatThinking", "aiChatCitations"]
  var CHOICES = {
    aiChatCode: ["announce", "skip", "read"],
    aiChatTables: ["read", "announce", "skip"],
    aiChatThinking: ["skip", "read"],
    aiChatCitations: ["skip", "read"],
  }

  // Never read the contents of these.
  var SKIP_TAGS = new Set(("script style noscript template svg canvas iframe object embed head " +
    "button input select textarea img picture video audio annotation annotation-xml").split(" "))
  // These flow within a paragraph; everything else starts a new one.
  var INLINE_TAGS = new Set(("a abbr b bdi bdo cite code data del dfn em font i ins kbd mark q s samp " +
    "small span strong sub sup time tt u var wbr").split(" "))

  var hostKey = location.hostname.replace(/^www\./, "")
  var site = aiChatSites[hostKey]
  var session = null
  var warnedSelectors = new Set()


  // ---------------------------------------------------------------- public API

  return {
    getCurrentIndex: function() {
      startSession()    // a new play request always starts a fresh session
      return 0
    },

    getTexts: getTexts,

    getSelectedText: function() {
      return fallback.getSelectedText()
    },
  }

  async function getTexts(index, quietly) {
    var s = session || startSession()
    if (s.fallback) return fallback.getTexts(index, quietly)
    await s.ready
    if (s !== session) return null                      // superseded by a newer play request

    // Pages are memoized so rewinding, or the reader peeking ahead, always sees the same text.
    if (index < s.pages.length) return s.pages[index]
    if (index > s.pages.length) return null

    var stallDeadline = Date.now() + aiChatTuning.stallMillis
    var lastSig = null
    var cache = null
    var cacheVersion = -1
    while (true) {
      if (s !== session) return null
      var target = resolveTarget(s)
      if (!target) return endSession(s)                 // the reply disappeared

      if (!cache || cacheVersion !== s.version) {
        cacheVersion = s.version
        cache = extractBlocks(contentRoots(target, s.opts), s.opts)
      }
      var blocks = cache
      var streaming = isStreaming(s, target)

      if (!blocks.length && !streaming && !s.pages.length) {
        // Found a reply but couldn't read anything from it. If that holds even with every
        // skip rule off, our selectors no longer fit the page: use the generic reader.
        var lenient = extractBlocks(contentRoots(target, lenientOpts()), lenientOpts())
        if (!lenient.length) {
          console.warn("[Read Aloud] ai-chat: reply found but no text extracted; using generic reader")
          s.fallback = true
          return fallback.getTexts(index, quietly)
        }
        return []
      }

      // While streaming, the last block may still be growing, so hold it back.
      var available = streaming ? Math.max(0, blocks.length - 1) : blocks.length
      var sig = blocks.length + ":" + (blocks.length ? blocks[blocks.length - 1].length : 0)
      if (sig !== lastSig) {
        lastSig = sig
        stallDeadline = Date.now() + aiChatTuning.stallMillis
      }
      if (streaming && Date.now() > stallDeadline) {
        console.warn("[Read Aloud] ai-chat: reply stopped making progress; reading what is there")
        streaming = false
        available = blocks.length
      }

      if (available > s.delivered) {
        var page = blocks.slice(s.delivered, available)
        s.delivered = available
        s.pages.push(page)
        return page
      }
      if (!streaming) return endSession(s)              // nothing new and nothing coming
      if (quietly) return null                          // peeking ahead must not block
      await waitMillis(aiChatTuning.pollMillis)
    }
  }


  // ------------------------------------------------------------------ session

  function startSession() {
    if (session) stopWatching(session)
    var s = session = {pages: [], delivered: 0, version: 0, lastChange: 0, ready: null, observer: null}
    if (!site) {
      s.fallback = true
      return s
    }
    var messages = listAssistantMessages()
    if (!messages.length) {
      console.warn("[Read Aloud] ai-chat: no assistant messages matched on " + hostKey + "; using generic reader")
      s.fallback = true
      return s
    }
    s.target = pickTarget(messages)
    s.index = messages.indexOf(s.target)
    s.wasLast = s.index === messages.length - 1
    s.opts = buildOpts({})
    console.log("[Read Aloud] ai-chat: " + site.name + " reply " + (s.index + 1) + " of " + messages.length)
    s.ready = prepare(s)
    return s
  }

  async function prepare(s) {
    try {
      s.opts = buildOpts(await getSettings(SETTING_NAMES))
      watch(s)
      // Sites with no streaming marker get a short look for live changes before we decide.
      if (!selectorSaysStreaming(s.target)) await waitMillis(aiChatTuning.observeMillis)
    }
    catch (err) {
      console.error(err)
    }
  }

  function endSession(s) {
    stopWatching(s)
    return null
  }

  function buildOpts(settings) {
    settings = settings || {}
    var opts = {}
    for (var name of SETTING_NAMES) {
      var value = settings[name] != null ? settings[name] : (typeof defaults != "undefined" ? defaults[name] : null)
      if (!CHOICES[name].includes(value)) value = CHOICES[name][0]
      opts[name] = value
    }
    var skip = [].concat(site.skip || [])
    if (opts.aiChatThinking == "skip") skip = skip.concat(site.thinking || [])
    if (opts.aiChatCitations == "skip") skip = skip.concat(site.citations || [])
    return {
      code: opts.aiChatCode,
      tables: opts.aiChatTables,
      skipSelectors: skip,
      thinkingSelectors: opts.aiChatThinking == "read" ? (site.thinking || []) : [],
      citationSelectors: opts.aiChatCitations == "skip" ? (site.citations || []) : [],
      codeBlockContainers: site.codeBlockContainers || [],
    }
  }

  function lenientOpts() {
    return buildOpts({aiChatCode: "read", aiChatTables: "read", aiChatThinking: "read", aiChatCitations: "read"})
  }


  // ------------------------------------------------------------ finding the reply

  function listAssistantMessages() {
    for (var tier of site.assistantMessages) {
      var found = []
      for (var el of safeQueryAll(document, tier)) {
        if ((site.notWithin || []).some(function(sel) {return safeClosest(el, sel)})) continue
        // A match that contains a user message is a wrapper around the conversation.
        if (site.userMessages && safeQuery(el, site.userMessages)) continue
        found.push(el)
      }
      var outermost = found.filter(function(el) {
        return !found.some(function(other) {return other !== el && other.contains(el)})
      })
      if (outermost.length) return outermost
    }
    return []
  }

  function pickTarget(messages) {
    var viewHeight = window.innerHeight || document.documentElement.clientHeight || 0
    var best = messages[messages.length - 1]
    var bestVisible = 0
    for (var el of messages) {
      var rect = el.getBoundingClientRect()
      var visible = Math.max(0, Math.min(rect.bottom, viewHeight) - Math.max(rect.top, 0))
      if (visible > 0 && visible >= bestVisible) {   // ties go to the later reply
        best = el
        bestVisible = visible
      }
    }
    return best
  }

  // The site may re-mount a reply when streaming ends; find it again if so.
  function resolveTarget(s) {
    if (s.target.isConnected) return s.target
    var messages = listAssistantMessages()
    var target = s.wasLast ? messages[messages.length - 1] : messages[s.index]
    if (!target) return null
    s.target = target
    watch(s)
    s.version++
    s.lastChange = Date.now()
    return target
  }

  // Where the prose is: configured content regions that are not inside skipped sections,
  // else the whole reply.
  function contentRoots(target, opts) {
    var roots = []
    var add = function(el) {if (!roots.includes(el)) roots.push(el)}
    for (var sel of site.content || []) {
      if (safeMatches(target, sel)) add(target)
      safeQueryAll(target, sel).forEach(add)
    }
    if (roots.length) {
      // Reasoning sections can sit beside the content region rather than inside it.
      for (var sel of opts.thinkingSelectors) safeQueryAll(target, sel).forEach(add)
      roots.sort(function(a, b) {
        return a === b ? 0 : (a.compareDocumentPosition(b) & 4 /* FOLLOWING */) ? -1 : 1
      })
    }
    roots = roots.filter(function(el) {
      for (var node = el; node && node !== target.parentElement; node = node.parentElement) {
        if (shouldSkip(node, opts)) return false
        if (node === target) break
      }
      return true
    })
    roots = roots.filter(function(el) {
      return !roots.some(function(other) {return other !== el && other.contains(el)})
    })
    return roots.length ? roots : [target]
  }


  // ---------------------------------------------------------------- streaming

  function selectorSaysStreaming(target) {
    return (site.streaming || []).some(function(sel) {
      return safeMatches(target, sel) || safeQuery(target, sel) || safeClosest(target, sel)
    })
  }

  function isStreaming(s, target) {
    if (selectorSaysStreaming(target)) {
      s.sawMarker = true
      return true
    }
    // Once the site's own marker has been seen working, believe it when it says "finished".
    // Otherwise (no marker, or it never showed up) infer from live changes to the reply.
    if (s.sawMarker) return false
    return s.lastChange > 0 && Date.now() - s.lastChange < aiChatTuning.settleMillis
  }

  function watch(s) {
    stopWatching(s)
    if (typeof MutationObserver == "undefined") return
    s.observer = new MutationObserver(function(records) {
      for (var r of records) {
        var meaningful = r.type == "characterData" ||
          Array.from(r.addedNodes).concat(Array.from(r.removedNodes)).some(function(n) {return (n.textContent || "").trim()})
        if (meaningful) {
          s.lastChange = Date.now()
          s.version++
          return
        }
      }
    })
    s.observer.observe(s.target, {childList: true, characterData: true, subtree: true})
  }

  function stopWatching(s) {
    if (s.observer) {
      s.observer.disconnect()
      s.observer = null
    }
  }


  // --------------------------------------------------------------- extraction

  /**
   * Turns DOM regions into an array of paragraph strings.
   * Uses only node types, tag names and textContent (not innerText, which is
   * meaningless on detached nodes) so the result doesn't depend on layout.
   */
  function extractBlocks(roots, opts) {
    var blocks = []
    var buf = ""
    var prefix = ""

    for (var root of roots) walk(root)
    flush()
    return blocks

    function normalize(text) {
      return text.replace(/[\s ​]+/g, " ").trim()
    }

    function pushBlock(text) {
      blocks.push(prefix + text)
      prefix = ""
    }

    function flush() {
      var text = normalize(buf)
      buf = ""
      if (text) pushBlock(text)
    }

    function walk(node) {
      if (node.nodeType == 3) {
        buf += node.nodeValue
        return
      }
      if (node.nodeType != 1) return
      if (shouldSkip(node, opts)) return

      var tag = node.localName
      if (isCodeBlock(node, opts)) return code(node)
      if (tag == "table") return table(node)
      if (tag == "math") {
        buf += " " + inlineText(node) + " "
        return
      }
      if (tag == "sup" && isCitationSup(node, opts)) return
      if (tag == "br" || tag == "hr") return flush()
      if (tag == "li") {
        flush()
        prefix = listMarker(node)
        children(node)
        flush()
        prefix = ""
        return
      }

      var block = !INLINE_TAGS.has(tag)
      if (block) flush()
      children(node)
      if (block) flush()
    }

    function children(node) {
      for (var child = node.firstChild; child; child = child.nextSibling) walk(child)
    }

    // text of a node with skipped elements removed, kept inline
    function inlineText(node) {
      if (node.nodeType == 3) return node.nodeValue
      if (node.nodeType != 1 || shouldSkip(node, opts)) return ""
      var text = ""
      for (var child = node.firstChild; child; child = child.nextSibling) text += inlineText(child)
      return text
    }

    function code(el) {
      flush()
      if (opts.code == "skip") return
      var pre = el.localName == "pre" ? el : safeQuery(el, "pre")
      var text = (pre || el).textContent.replace(/^\s*\n/, "").replace(/\s+$/, "")
      var lines = text.split(/\r?\n/).filter(function(line) {return line.trim()})
      if (opts.code == "read") {
        for (var line of lines) pushBlock(normalize(line))
      }
      else {
        var lang = codeLanguage(el, pre)
        var label = lang ? lang + " code block" : "code block"
        pushBlock(label.charAt(0).toUpperCase() + label.slice(1) + ", " + plural(lines.length, "line") + ".")
      }
    }

    function table(el) {
      flush()
      if (opts.tables == "skip") return
      var rows = Array.from(el.querySelectorAll("tr"))
      if (opts.tables == "announce") {
        var columns = rows.reduce(function(max, tr) {return Math.max(max, cellsOf(tr).length)}, 0)
        pushBlock("Table, " + plural(rows.length, "row") + ", " + plural(columns, "column") + ".")
        return
      }
      for (var tr of rows) {
        var texts = cellsOf(tr)
          .map(function(cell) {return extractBlocks([cell], opts).join(" ")})
          .filter(Boolean)
        if (texts.length) {
          var row = texts.join(", ")
          pushBlock(/[.!?]$/.test(row) ? row : row + ".")
        }
      }
    }
  }

  function cellsOf(tr) {
    return Array.from(tr.children).filter(function(c) {return c.localName == "th" || c.localName == "td"})
  }

  function listMarker(li) {
    var list = li.parentElement
    if (!list || list.localName != "ol") return ""
    var n = parseInt(list.getAttribute("start"), 10)
    if (isNaN(n)) n = 1
    for (var sib = li.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.localName == "li") n++
    }
    return n + ". "
  }

  function isCodeBlock(el, opts) {
    if (el.localName == "pre") return true
    return opts.codeBlockContainers.some(function(sel) {return safeMatches(el, sel)}) && !!safeQuery(el, "pre")
  }

  function codeLanguage(el, pre) {
    var candidates = [pre, pre && safeQuery(pre, "code"), el]
    for (var c of candidates) {
      if (!c) continue
      var attr = c.getAttribute("data-language") || c.getAttribute("data-lang")
      if (attr) return attr.trim().toLowerCase()
      var match = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(c.getAttribute("class") || "")
      if (match) return match[1].toLowerCase()
    }
    return ""
  }

  // <sup> that holds a link is a footnote/citation marker; a bare <sup> is probably an exponent.
  function isCitationSup(el, opts) {
    return !!safeQuery(el, "a[href]") || opts.citationSelectors.some(function(sel) {return safeMatches(el, sel)})
  }

  function shouldSkip(el, opts) {
    if (SKIP_TAGS.has(el.localName)) return true
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") == "true") return true
    if (opts.skipSelectors.some(function(sel) {return safeMatches(el, sel)})) return true
    return isCssHidden(el)
  }

  function isCssHidden(el) {
    try {
      var style = window.getComputedStyle(el)
      return style.display == "none" || style.visibility == "hidden"
    }
    catch (err) {
      return false
    }
  }

  function plural(n, word) {
    return n + " " + word + (n == 1 ? "" : "s")
  }


  // ---------------------------------------------------------- selector safety
  // One bad selector must not take down extraction for the whole site.

  function warnBad(selector, err) {
    if (warnedSelectors.has(selector)) return
    warnedSelectors.add(selector)
    console.warn("[Read Aloud] ai-chat: invalid selector " + selector, err)
  }

  function safeMatches(el, selector) {
    try {return el.matches(selector)}
    catch (err) {warnBad(selector, err); return false}
  }

  function safeClosest(el, selector) {
    try {return el.closest(selector)}
    catch (err) {warnBad(selector, err); return null}
  }

  function safeQuery(root, selector) {
    try {return root.querySelector(selector)}
    catch (err) {warnBad(selector, err); return null}
  }

  function safeQueryAll(root, selector) {
    try {return Array.from(root.querySelectorAll(selector))}
    catch (err) {warnBad(selector, err); return []}
  }
})(readAloudDoc)
