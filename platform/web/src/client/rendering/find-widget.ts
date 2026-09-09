/* The editor's find/replace widget: CodeMirror's search state, drawn on VS
   Code's shape — floating in the editor's top-right corner, flags inside the
   field, a match counter, replace folded away until it is wanted.

   CodeMirror's stock panel has no counter and no field the flags can sit
   inside, so this replaces the panel rather than restyling it. Everything it
   drives — findNext, replaceAll, the query itself — is CodeMirror's own. */

import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery,
  replaceAll, replaceNext, selectMatches, setSearchQuery,
} from "@codemirror/search";
import type { EditorState } from "@codemirror/state";
import { runScopeHandlers, type EditorView, type Panel } from "@codemirror/view";
import "./find-widget.css";

/* Counting every match in a 200k-line file costs more than the number tells the
   reader, so the count stops here and says it stopped. The read-only viewer's
   find bar draws the same line at the same place. */
const MATCH_LIMIT = 10000;

const glyph = {
  fold: "m6 9 6 6 6-6",
  up: "M12 19V6M6 12l6-6 6 6",
  down: "M12 5v13M6 12l6 6 6-6",
  all: "M4 7h11M4 12h11M4 17h7M17 15l2 2 3-4",
  close: "M18 6 6 18M6 6l12 12",
  replace: "M4 6h7M4 11h7M4 16h4M15 8v7M12 12l3 3 3-3",
  replaceAll: "M3 6h6M3 11h6M3 16h4M13 5v6M10 8l3 3 3-3M13 14v5M10 17l3 3 3-3",
};

function icon(path: keyof typeof glyph) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.innerHTML = `<path d="${glyph[path]}"/>`;
  return svg;
}

function action(label: string, path: keyof typeof glyph, onClick: () => void) {
  const button = document.createElement("button");
  button.className = "find-action";
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.appendChild(icon(path));
  button.addEventListener("click", onClick);
  return button;
}

/** A flag chip: a checkbox that shows as its own two-character name. */
function flag(label: string, text: string, onChange: () => void) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.addEventListener("change", onChange);
  const name = document.createElement("span");
  name.textContent = text;
  name.setAttribute("aria-hidden", "true");
  const chip = document.createElement("label");
  chip.className = "find-flag";
  chip.title = label;
  chip.append(input, name);
  input.setAttribute("aria-label", label);
  return { chip, input };
}

function field(placeholder: string) {
  const input = document.createElement("input");
  input.placeholder = placeholder;
  input.setAttribute("aria-label", placeholder);
  input.setAttribute("form", "");
  const box = document.createElement("div");
  box.className = "find-field";
  box.appendChild(input);
  return { box, input };
}

/** Where the current selection sits among the matches, and how many there are. */
function countMatches(state: EditorState, query: SearchQuery) {
  if (!query.valid) return { total: 0, current: 0, truncated: false };
  const main = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    total++;
    if (match.value.from === main.from && match.value.to === main.to) current = total;
    if (total >= MATCH_LIMIT) return { total, current, truncated: true };
  }
  return { total, current, truncated: false };
}

export function findWidget(view: EditorView): Panel {
  const search = field("Find");
  const replace = field("Replace");
  search.input.setAttribute("main-field", "true");

  const commit = () => view.dispatch({ effects: setSearchQuery.of(query()) });
  const caseFlag = flag("Match case", "Aa", commit);
  const wordFlag = flag("Match whole word", "ab", commit);
  const regexpFlag = flag("Use regular expression", ".*", commit);
  const query = () => new SearchQuery({
    search: search.input.value,
    replace: replace.input.value,
    caseSensitive: caseFlag.input.checked,
    wholeWord: wordFlag.input.checked,
    regexp: regexpFlag.input.checked,
    // both editors configure search({ literal: true }); the facet that carries
    // it is CodeMirror-internal, so the panel repeats the choice.
    literal: true,
  });
  search.box.append(caseFlag.chip, wordFlag.chip, regexpFlag.chip);
  for (const input of [search.input, replace.input]) {
    input.addEventListener("change", commit);
    input.addEventListener("keyup", commit);
  }

  const count = document.createElement("span");
  count.className = "find-count";
  count.setAttribute("role", "status");

  const previous = action("Previous match", "up", () => findPrevious(view));
  const next = action("Next match", "down", () => findNext(view));
  const all = action("Select all matches", "all", () => selectMatches(view));
  const findRow = document.createElement("div");
  findRow.className = "find-row";
  findRow.append(search.box, count, previous, next, all,
    action("Close", "close", () => closeSearchPanel(view)));

  const replaceRow = document.createElement("div");
  replaceRow.className = "find-row replace";
  replaceRow.append(replace.box,
    action("Replace", "replace", () => replaceNext(view)),
    action("Replace all", "replaceAll", () => replaceAll(view)));

  const fold = document.createElement("button");
  fold.className = "find-fold";
  fold.type = "button";
  fold.title = "Toggle replace";
  fold.setAttribute("aria-label", "Toggle replace");
  fold.appendChild(icon("fold"));

  const rows = document.createElement("div");
  rows.className = "find-rows";
  rows.append(findRow, replaceRow);

  const dom = document.createElement("div");
  dom.className = "find-widget";
  /* Most finds never replace anything, so replace starts folded away. */
  dom.dataset.replace = "closed";
  fold.setAttribute("aria-expanded", "false");
  fold.addEventListener("click", () => {
    const open = dom.dataset.replace === "closed";
    dom.dataset.replace = open ? "open" : "closed";
    fold.setAttribute("aria-expanded", String(open));
  });
  dom.addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target === search.input) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(view);
    } else if (event.key === "Enter" && event.target === replace.input) {
      event.preventDefault();
      replaceNext(view);
    } else if (runScopeHandlers(view, event, "search-panel")) {
      event.preventDefault();
    }
  });

  let shown: SearchQuery | undefined;
  const render = () => {
    const current = getSearchQuery(view.state);
    /* The query changes from outside too — the file tree opens a file on a
       project-search hit — so the fields follow it rather than the reverse. */
    if (!shown || !shown.eq(current)) {
      if (document.activeElement !== search.input) search.input.value = current.search;
      if (document.activeElement !== replace.input) replace.input.value = current.replace;
      caseFlag.input.checked = current.caseSensitive;
      wordFlag.input.checked = current.wholeWord;
      regexpFlag.input.checked = current.regexp;
      shown = current;
    }
    const invalid = !!current.search && !current.valid;
    search.box.classList.toggle("invalid", invalid);
    const { total, current: index, truncated } = countMatches(view.state, current);
    count.textContent = !current.search ? ""
      : invalid ? "Invalid pattern"
      : !total ? "No results"
      : `${index || "?"} of ${total}${truncated ? "+" : ""}`;
    count.classList.toggle("empty", !!current.search && (invalid || !total));
    for (const button of [previous, next, all]) button.disabled = !total;
  };
  render();

  return {
    dom,
    top: true,
    mount() {
      /* A read-only editor has nothing to replace, so it gets neither row. */
      if (view.state.readOnly) {
        replaceRow.remove();
        fold.remove();
        dom.classList.add("is-find-only");
      } else {
        dom.prepend(fold);
      }
      dom.appendChild(rows);
      render();
      /* CodeMirror focuses the field only on reopen, through [main-field]; the first open is the
         panel's own job. A panel opened for a file the user navigated to takes no focus — that
         would put the caret in the find field of a file they came to read. */
      if (view.hasFocus) {
        search.input.focus();
        search.input.select();
      }
    },
    update(update) {
      if (update.docChanged || update.selectionSet || update.transactions.some(tr => tr.effects.some(effect => effect.is(setSearchQuery))))
        render();
    },
  };
}
