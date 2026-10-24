/**
 * Python regular expressions in JavaScript. Python's \w and \b are Unicode-aware ("é" is a word character), named
 * groups use (?P<name>…); JavaScript needs the u flag and explicit Unicode classes for the same behaviour.
 */
const WORD = "\\p{L}\\p{N}_";
const cache = new Map<string, RegExp>();

function translate(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      const n = pattern[i + 1];
      i += 1;
      if (n === "w") out += inClass ? WORD : `[${WORD}]`;
      else if (n === "W") out += inClass ? `^${WORD}` : `[^${WORD}]`;
      else if (n === "b" && !inClass) out += `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
      else if (n === "B" && !inClass) out += `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;
      else if (n === "Z" && !inClass) out += "$(?![\\s\\S])";
      else if (n === "A" && !inClass) out += "^";
      else if (/[A-Za-z0-9.\\^$|?*+()[\]{}\/-]/.test(n)) out += `\\${n}`;
      else out += n === " " ? " " : `\\x${n.charCodeAt(0).toString(16).padStart(2, "0")}`;
      continue;
    }
    if (c === "[" && !inClass) inClass = true;
    else if (c === "]" && inClass) inClass = false;
    if (!inClass && c === "(" && pattern.startsWith("(?P<", i)) {
      out += "(?<";
      i += 3;
      continue;
    }
    if (!inClass && c === "(" && pattern.startsWith("(?P=", i)) {
      const end = pattern.indexOf(")", i);
      out += `\\k<${pattern.slice(i + 4, end)}>`;
      i = end;
      continue;
    }
    out += c;
  }
  return out;
}

/** Compile a Python pattern (flags: "i" for re.I, "m" for re.M, "s" for re.S, "g" for findall/sub). */
export function pyRe(pattern: string, flags = ""): RegExp {
  const key = `${flags}/${pattern}`;
  let rx = cache.get(key);
  if (!rx) {
    rx = new RegExp(translate(pattern), `${flags}u`);
    cache.set(key, rx);
  }
  rx.lastIndex = 0;
  return rx;
}

/** re.search(pattern, text, flags) → match or null. */
export function reSearch(pattern: string, text: string, flags = ""): RegExpExecArray | null {
  return pyRe(pattern, flags.replace("g", "")).exec(text);
}

/** re.match: anchored at the start. */
export function reMatch(pattern: string, text: string, flags = ""): RegExpExecArray | null {
  const m = pyRe(`(?:${pattern})`, `${flags.replace("g", "")}y`).exec(text);
  return m;
}
