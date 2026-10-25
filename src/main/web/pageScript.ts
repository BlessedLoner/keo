/**
 * Runs inside each page, in an isolated JavaScript world of Keo's own: the page's scripts
 * share the DOM but cannot see this code or its element refs, and nothing here reaches the
 * page's variables. It reads the page's structure (roles, names, values) and acts on one
 * element by ref. Refs carry the document's tag (p3e12 = element 12 of document 3), so a ref
 * from a page that has since navigated can never point at an element of the new page.
 *
 * Plain JavaScript in a string: it is sent to the browser as is, never bundled.
 */
export const PAGE_SCRIPT = String.raw`(function (docTag) {
  var refs = new Map();
  var ids = new WeakMap();
  var next = 1;
  function refOf(e) {
    var r = ids.get(e);
    if (!r) { r = docTag + 'e' + next++; ids.set(e, r); refs.set(r, new WeakRef(e)); }
    return r;
  }
  function el(ref) {
    var w = refs.get(ref);
    var e = w && w.deref();
    return e && e.isConnected ? e : null;
  }
  function squash(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function text(e) { return squash(e.innerText != null ? e.innerText : e.textContent); }
  function tag(e) { return e.tagName ? e.tagName.toLowerCase() : ''; }
  function inputType(e) { return tag(e) === 'input' ? (e.getAttribute('type') || 'text').toLowerCase() : ''; }
  var INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', file: 'file', search: 'searchbox', number: 'spinbutton' };
  var INTERACTIVE = /^(button|link|textbox|searchbox|combobox|listbox|checkbox|radio|switch|slider|spinbutton|file|option|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem)$/;
  var BLOCK = /^(address|article|aside|blockquote|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|thead|tfoot|tr|td|th|ul|br)$/;
  function editableRoot(e) { return e.isContentEditable && !(e.parentElement && e.parentElement.isContentEditable); }
  function roleOf(e) {
    var r = e.getAttribute('role');
    if (r) return r.split(' ')[0].toLowerCase();
    var t = tag(e);
    if (t === 'a') return e.hasAttribute('href') ? 'link' : '';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'input') { var ty = inputType(e); return ty === 'hidden' ? '' : INPUT_ROLES[ty] || 'textbox'; }
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return e.multiple || e.size > 1 ? 'listbox' : 'combobox';
    if (t === 'option') return 'option';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'dialog') return 'dialog';
    if (editableRoot(e)) return 'textbox';
    var ti = e.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0 && (e.onclick || e.hasAttribute('onclick') || e.hasAttribute('jsaction') || e.hasAttribute('data-action'))) return 'button';
    return '';
  }
  function labelledBy(e) {
    var lb = e.getAttribute('aria-labelledby');
    if (!lb) return '';
    var root = e.getRootNode();
    return squash(lb.split(/\s+/).map(function (id) { var x = root.getElementById ? root.getElementById(id) : e.ownerDocument.getElementById(id); return x ? text(x) : ''; }).join(' '));
  }
  function nameOf(e, role) {
    var a = squash(e.getAttribute('aria-label'));
    if (a) return a;
    var lb = labelledBy(e);
    if (lb) return lb;
    var t = tag(e);
    if (t === 'input' || t === 'textarea' || t === 'select') {
      if (e.labels && e.labels.length) { var l = squash(Array.prototype.map.call(e.labels, text).join(' ')); if (l) return l; }
      var ty = inputType(e);
      if ((ty === 'submit' || ty === 'button' || ty === 'reset') && e.value) return squash(e.value);
      if (ty === 'submit') return 'Submit';
      if (ty === 'image' && e.alt) return squash(e.alt);
      return squash(e.getAttribute('placeholder') || e.title || e.getAttribute('name') || '');
    }
    if (t === 'img') return squash(e.alt);
    if (role === 'textbox' || role === 'combobox' || role === 'searchbox') return squash(e.getAttribute('aria-placeholder') || e.getAttribute('data-placeholder') || e.getAttribute('placeholder') || e.title || '');
    var tt = text(e);
    if (tt) return tt;
    var img = e.querySelector && e.querySelector('img[alt]');
    return squash(e.title || (img && img.alt) || '');
  }
  function secretKind(e) {
    var ty = inputType(e);
    var ac = (e.getAttribute('autocomplete') || '').toLowerCase();
    var hint = [e.getAttribute('name'), e.id, e.getAttribute('aria-label'), e.getAttribute('placeholder')].join(' ');
    if (ty === 'password' || /current-password|new-password|one-time-code/.test(ac) || /passw|passcode|\bpin\b|one.?time.?(code|password)|\botp\b/i.test(hint)) return 'password';
    if (/cc-number|cc-csc|cc-exp/.test(ac) || /card.?number|cardnum|\bcvc\b|\bcvv\b|security.?code|expir/i.test(hint)) return 'payment';
    return null;
  }
  function valueOf(e) {
    var t = tag(e);
    if (t === 'input') {
      var ty = inputType(e);
      if (ty === 'checkbox' || ty === 'radio' || ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'image') return null;
      if (secretKind(e)) return e.value ? '(hidden)' : '';
      if (ty === 'file') return Array.prototype.map.call(e.files || [], function (f) { return f.name; }).join(', ');
      return e.value;
    }
    if (t === 'textarea') return e.value;
    if (t === 'select') return Array.prototype.map.call(e.selectedOptions, function (o) { return squash(o.label || o.text); }).join(', ');
    if (e.isContentEditable) return text(e);
    return e.getAttribute('aria-valuetext') || e.getAttribute('aria-valuenow');
  }
  function visible(e) {
    var st = e.ownerDocument.defaultView.getComputedStyle(e);
    if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    var rs = e.getClientRects();
    return rs.length > 0 && (rs[0].width > 0 || rs[0].height > 0);
  }
  function deepActive() {
    var a = document.activeElement;
    for (var i = 0; a && i < 20; i++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (tag(a) === 'iframe') { var d = null; try { d = a.contentDocument; } catch (x) { d = null; } if (d && d.activeElement && d.activeElement !== d.body) { a = d.activeElement; continue; } if (d && d.body && d.body.isContentEditable) { a = d.body; } }
      break;
    }
    return a;
  }
  function inForm(e) { return !!(e.form || (e.closest && e.closest('form'))); }
  function submits(e) {
    var t = tag(e), ty = inputType(e);
    if (t === 'button') return (e.getAttribute('type') || 'submit').toLowerCase() === 'submit' && inForm(e);
    return (ty === 'submit' || ty === 'image') && inForm(e);
  }
  function info(e) {
    var role = roleOf(e);
    var t = tag(e);
    return {
      ref: refOf(e),
      role: role,
      name: nameOf(e, role).slice(0, 160),
      tag: t,
      type: inputType(e) || null,
      id: e.id ? String(e.id).slice(0, 80) : null,
      href: t === 'a' && e.href ? String(e.href).slice(0, 300) : null,
      submits: submits(e),
      inForm: inForm(e),
      editable: t === 'textarea' || (t === 'input' && !/^(checkbox|radio|button|submit|reset|image|file|range|color)$/.test(inputType(e))) || e.isContentEditable,
      secret: secretKind(e),
      multiline: t === 'textarea' || e.isContentEditable
    };
  }
  function q(s) { return '"' + String(s).replace(/"/g, "'") + '"'; }
  function lineFor(e, it) {
    var s = '[' + it.ref + '] ' + it.role + (it.type && !/^(text|submit|button|checkbox|radio|file|search|number)$/.test(it.type) ? '[' + it.type + ']' : '') + ' ' + q(it.name);
    var v = valueOf(e);
    if (v != null && v !== '' && it.role !== 'link' && it.role !== 'button') { v = String(v); s += ' = ' + q(v.length > 300 ? v.slice(0, 300) + '… (' + v.length + ' characters)' : v); }
    var flags = [];
    if (e.checked || e.getAttribute('aria-checked') === 'true') flags.push('checked');
    if (e.getAttribute('aria-selected') === 'true' || (tag(e) === 'option' && e.selected)) flags.push('selected');
    if (e.getAttribute('aria-expanded') === 'true') flags.push('expanded');
    if (e.getAttribute('aria-expanded') === 'false') flags.push('collapsed');
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') flags.push('disabled');
    if (e.required || e.getAttribute('aria-required') === 'true') flags.push('required');
    if (e.readOnly) flags.push('read-only');
    if (e.getAttribute('aria-invalid') === 'true') flags.push('invalid');
    if (it.secret) flags.push(it.secret === 'password' ? 'password field: the user types it' : 'payment field: the user types it');
    if (it.submits) flags.push('submits the form');
    if (deepActive() === e) flags.push('focused');
    if (it.role === 'file') { if (e.multiple) flags.push('multiple'); if (e.accept) flags.push('accepts ' + e.accept); if (!visible(e)) flags.push('hidden input'); }
    if (flags.length) s += ' (' + flags.join(', ') + ')';
    if (it.href) { var h = it.href; try { var u = new URL(h); h = (u.origin === location.origin ? '' : u.host) + u.pathname + u.search; } catch (x) { } s += ' -> ' + h.slice(0, 120); }
    if (tag(e) === 'select') {
      var opts = Array.prototype.slice.call(e.options, 0, 40).map(function (o) { return q(squash(o.label || o.text)); });
      s += ' options: ' + opts.join(' | ') + (e.options.length > 40 ? ' | … (' + e.options.length + ')' : '');
    }
    return s;
  }
  function snapshot(o) {
    var lines = [], items = [], chars = 0, truncated = false, line = '';
    var mode = o.mode || 'all';
    function push(s) {
      if (truncated) return;
      if (chars + s.length > o.maxChars || items.length > o.maxElements) { truncated = true; return; }
      lines.push(s); chars += s.length + 1;
    }
    function flush() { var s = squash(line); line = ''; if (s && mode !== 'interactive') push(s.length > 1000 ? s.slice(0, 1000) + '…' : s); }
    function walkChildren(n) {
      var kids = n.childNodes;
      for (var i = 0; i < kids.length && !truncated; i++) walk(kids[i]);
    }
    function walk(n) {
      if (truncated) return;
      if (n.nodeType === 3) { if (mode !== 'interactive') line += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      var e = n, t = tag(e);
      if (/^(script|style|noscript|template|svg|canvas|head|meta|link)$/.test(t)) return;
      if (t === 'slot') { var as = e.assignedNodes({ flatten: true }); for (var k = 0; k < as.length; k++) walk(as[k]); return; }
      if (e.getAttribute('aria-hidden') === 'true') return;
      var role = roleOf(e);
      var shown = visible(e);
      if (!shown && !(role === 'file')) {
        var st = e.ownerDocument.defaultView.getComputedStyle(e);
        if (st.display === 'none') return;
        if (st.display === 'contents') { walkChildren(e.shadowRoot || e); return; }
      }
      var block = BLOCK.test(t);
      if (block) flush();
      if (t === 'iframe') {
        flush();
        var d = null;
        try { d = e.contentDocument; } catch (x) { d = null; }
        if (d && d.body) walk(d.body);
        else push('[frame from ' + (function () { try { return new URL(e.src).host; } catch (x) { return 'another site'; } })() + ': not readable]');
        return;
      }
      if (role === 'dialog' || role === 'alertdialog') { flush(); push('--- dialog ' + q(nameOf(e, role).slice(0, 120)) + ' ---'); walkChildren(e.shadowRoot || e); flush(); push('--- end of dialog ---'); return; }
      if (role === 'heading') { flush(); var lv = Number(e.getAttribute('aria-level')) || Number((/^h([1-6])$/.exec(t) || [])[1]) || 2; if (mode !== 'interactive') push(new Array(lv + 1).join('#') + ' ' + text(e).slice(0, 300)); return; }
      if (INTERACTIVE.test(role) && (shown || role === 'file')) {
        flush();
        var it = info(e);
        if (mode !== 'text') { items.push(it); push(lineFor(e, it)); }
        else if (it.name) line += ' ' + it.name + ' ';
        var container = /^(listbox|combobox|menu|menubar|tablist|tree|radiogroup)$/.test(role) && tag(e) !== 'select';
        if (!container || it.editable) return;
      }
      if (shown && e.shadowRoot) walkChildren(e.shadowRoot);
      else walkChildren(e);
      if (block) flush();
    }
    var start = o.within ? el(o.within) : document.body;
    if (!start) return { error: 'gone' };
    walk(start);
    flush();
    var act = deepActive();
    return { url: location.href, title: document.title, lines: lines, items: items, truncated: truncated, focused: act && act !== document.body && ids.get(act) ? ids.get(act) : null };
  }
  function frameOffset(e) {
    var win = e.ownerDocument.defaultView, ox = 0, oy = 0;
    while (win && win.frameElement) { var fe = win.frameElement, fr = fe.getBoundingClientRect(); ox += fr.left + fe.clientLeft; oy += fr.top + fe.clientTop; win = fe.ownerDocument.defaultView; }
    return { x: ox, y: oy };
  }
  return {
    snapshot: snapshot,
    el: el,
    describe: function (ref) { var e = el(ref); return e ? info(e) : null; },
    point: function (ref) {
      var e = el(ref);
      if (!e) return null;
      e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      var rs = e.getClientRects();
      var r = rs.length ? rs[0] : e.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var root = e.getRootNode();
      var hit = root.elementFromPoint ? root.elementFromPoint(x, y) : null;
      var lab = hit && tag(hit) === 'label' && hit.control === e;
      var off = frameOffset(e);
      return { x: x + off.x, y: y + off.y, topmost: r.width >= 2 && r.height >= 2 && !!hit && (hit === e || e.contains(hit) || lab) };
    },
    clickEl: function (ref) { var e = el(ref); if (!e) return false; e.click(); return true; },
    focusEl: function (ref) { var e = el(ref); if (!e) return false; e.scrollIntoView({ block: 'center', behavior: 'instant' }); e.focus(); return true; },
    prepFill: function (ref) {
      var e = el(ref);
      if (!e) return { error: 'gone' };
      var it = info(e);
      if (it.secret) return { error: it.secret };
      if (!it.editable) return { error: 'not_editable', role: it.role };
      if (e.disabled || e.readOnly || e.getAttribute('aria-readonly') === 'true') return { error: 'read_only' };
      e.scrollIntoView({ block: 'center', behavior: 'instant' });
      e.focus();
      if (e.isContentEditable) {
        var d = e.ownerDocument, sel = d.getSelection(), rg = d.createRange();
        rg.selectNodeContents(e); sel.removeAllRanges(); sel.addRange(rg);
      } else { try { e.select(); } catch (x) { } }
      return { kind: e.isContentEditable ? 'editable' : tag(e), focused: deepActive() === e };
    },
    value: function (ref) { var e = el(ref); return e ? valueOf(e) : null; },
    setNative: function (ref, v) {
      var e = el(ref);
      if (!e || e.isContentEditable) return false;
      var proto = tag(e) === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(e, v);
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    select: function (ref, want) {
      var e = el(ref);
      if (!e) return { error: 'gone' };
      if (tag(e) !== 'select') return { error: 'not_select', role: roleOf(e) };
      if (e.disabled) return { error: 'disabled' };
      var w = squash(want).toLowerCase();
      var opts = Array.prototype.slice.call(e.options);
      var lab = function (o) { return squash(o.label || o.text); };
      var o = opts.filter(function (x) { return lab(x).toLowerCase() === w; })[0] || opts.filter(function (x) { return x.value === want; })[0];
      if (!o) { var part = opts.filter(function (x) { return lab(x).toLowerCase().indexOf(w) >= 0; }); if (part.length === 1) o = part[0]; }
      if (!o) return { error: 'no_option', options: opts.slice(0, 60).map(lab) };
      if (o.disabled) return { error: 'option_disabled' };
      e.focus();
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, o.value);
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: lab(e.selectedOptions[0] || o), value: e.value };
    },
    fileInfo: function (ref) {
      var e = el(ref);
      if (!e) return null;
      return { isFile: tag(e) === 'input' && inputType(e) === 'file', multiple: !!e.multiple, accept: e.accept || '', disabled: !!e.disabled };
    },
    files: function (ref) { var e = el(ref); return e && e.files ? Array.prototype.map.call(e.files, function (f) { return f.name; }) : []; },
    active: function () {
      var a = deepActive();
      if (!a || a === document.body || a === document.documentElement) return null;
      var it = info(a);
      return { ref: it.ref, role: it.role, name: it.name, tag: it.tag, editable: it.editable, multiline: it.multiline, secret: it.secret, value: it.editable ? String(valueOf(a) || '').slice(-2000) : null };
    },
    pasteHtml: function (html, plain) {
      var a = deepActive();
      if (!a) return 'no_focus';
      var dt = new DataTransfer();
      dt.setData('text/html', html);
      dt.setData('text/plain', plain);
      var ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
      a.dispatchEvent(ev);
      if (ev.defaultPrevented) return 'paste_event';
      if (a.isContentEditable && a.ownerDocument.execCommand('insertHTML', false, html)) return 'insert_html';
      return 'not_handled';
    },
    hasText: function (s) {
      var w = squash(s).toLowerCase();
      function inDoc(d) {
        if (!d || !d.body) return false;
        if (squash(d.body.innerText).toLowerCase().indexOf(w) >= 0) return true;
        var fs = d.querySelectorAll('iframe');
        for (var i = 0; i < fs.length; i++) { var c = null; try { c = fs[i].contentDocument; } catch (x) { c = null; } if (inDoc(c)) return true; }
        return false;
      }
      return inDoc(document);
    },
    page: function () { return { url: location.href, title: document.title, ready: document.readyState }; }
  };
})`;
