export function strictJson(text: string, maximumBytes = 1048576): unknown {
  if (new TextEncoder().encode(text).length > maximumBytes)
    throw new Error('JSON_TOO_LARGE');
  let cursor = 0,
    nodes = 0;
  const whitespace = () => {
    while (cursor < text.length && /[ \t\r\n]/.test(text[cursor]!)) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    let escaped = false;
    while (cursor < text.length) {
      const char = text[cursor++]!;
      if (char === '"' && !escaped) {
        try {
          return JSON.parse(text.slice(start, cursor)) as string;
        } catch {
          throw new Error('INVALID_JSON_STRING');
        }
      }
      if (char.charCodeAt(0) < 32) throw new Error('INVALID_JSON_STRING');
      if (char === '\\' && !escaped) escaped = true;
      else escaped = false;
    }
    throw new Error('TRUNCATED_JSON');
  };
  const value = (depth: number): unknown => {
    if (depth > 64 || ++nodes > 50000) throw new Error('JSON_COMPLEXITY_LIMIT');
    whitespace();
    const char = text[cursor];
    if (char === '"') return string();
    if (char === '{') {
      cursor++;
      const result: Record<string, unknown> = Object.create(null),
        keys = new Set<string>();
      whitespace();
      if (text[cursor] === '}') {
        cursor++;
        return result;
      }
      while (true) {
        whitespace();
        if (text[cursor] !== '"') throw new Error('INVALID_JSON_OBJECT');
        const key = string();
        if (keys.has(key)) throw new Error('DUPLICATE_JSON_KEY');
        keys.add(key);
        whitespace();
        if (text[cursor++] !== ':') throw new Error('INVALID_JSON_OBJECT');
        result[key] = value(depth + 1);
        whitespace();
        const end = text[cursor++];
        if (end === '}') return result;
        if (end !== ',') throw new Error('INVALID_JSON_OBJECT');
      }
    }
    if (char === '[') {
      cursor++;
      const result: unknown[] = [];
      whitespace();
      if (text[cursor] === ']') {
        cursor++;
        return result;
      }
      while (true) {
        result.push(value(depth + 1));
        whitespace();
        const end = text[cursor++];
        if (end === ']') return result;
        if (end !== ',') throw new Error('INVALID_JSON_ARRAY');
      }
    }
    for (const [literal, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(literal, cursor)) {
        cursor += literal.length;
        return result;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      text.slice(cursor),
    );
    if (number) {
      cursor += number[0].length;
      const result = Number(number[0]);
      if (!Number.isFinite(result)) throw new Error('INVALID_JSON_NUMBER');
      return result;
    }
    throw new Error(
      cursor >= text.length ? 'TRUNCATED_JSON' : 'INVALID_JSON_TOKEN',
    );
  };
  const result = value(0);
  whitespace();
  if (cursor !== text.length) throw new Error('TRAILING_JSON_CONTENT');
  return result;
}
