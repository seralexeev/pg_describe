export type Span = { start: number; length: number };

export type SqlStatement = {
  name: string;
  nameSpan: Span;
  text: string;
  params: string[];
  paramSpans: Span[];
  sourceOffsets: number[];
};

export type SqlFileError = Span & { message: string };

const TOKENS =
  /--[^\n]*|\/\*[\s\S]*?\*\/|[Ee]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|(\$\w*\$)[\s\S]*?\1|::|:[A-Za-z_]\w*|\w+|[\s\S]/g;

const NAME_ANNOTATION = /^\/\*\s*@name\s+(\w+)\s*\*\/$/d;

export const parseSqlFile = (source: string) => {
  const statements: SqlStatement[] = [];
  const errors: SqlFileError[] = [];
  let skipping = false;

  for (const match of source.matchAll(TOKENS)) {
    const [token] = match;
    const offset = match.index;
    const annotation = NAME_ANNOTATION.exec(token);
    const current = statements.at(-1);

    if (annotation?.indices?.[1] != null) {
      const name = annotation[1] as string;
      const nameSpan = {
        start: offset + annotation.indices[1][0],
        length: name.length,
      };
      skipping = statements.some((s) => s.name === name);
      if (skipping) {
        errors.push({ ...nameSpan, message: `Duplicate statement name '${name}'.` });
      } else {
        statements.push({
          name,
          nameSpan,
          text: '',
          params: [],
          paramSpans: [],
          sourceOffsets: [],
        });
      }
    } else if (skipping) {
      continue;
    } else if (current == null) {
      if (token.trim() !== '' && !/^(--|\/\*)/.test(token)) {
        errors.push({
          start: offset,
          length: token.length,
          message: 'SQL before the first @name annotation.',
        });
        skipping = true;
      }
    } else if (/^:[A-Za-z_]/.test(token)) {
      const param = token.slice(1);
      let index = current.params.indexOf(param);
      if (index === -1) {
        index = current.params.push(param) - 1;
        current.paramSpans.push({ start: offset + 1, length: param.length });
      }
      const placeholder = `$${index + 1}`;
      current.text += placeholder;
      current.sourceOffsets.push(...Array<number>(placeholder.length).fill(offset));
    } else {
      current.text += token;
      for (let i = 0; i < token.length; i++) {
        current.sourceOffsets.push(offset + i);
      }
    }
  }

  return {
    statements: statements.map(trim),
    errors: statements.length === 0 ? [] : errors,
  };
};

const trim = (statement: SqlStatement): SqlStatement => {
  const start = statement.text.length - statement.text.trimStart().length;
  const text = statement.text.trim().replace(/;$/, '').trimEnd();
  return {
    ...statement,
    text,
    sourceOffsets: statement.sourceOffsets.slice(start, start + text.length),
  };
};

export const sourceSpan = (statement: SqlStatement, position: number | undefined): Span => {
  if (position == null) {
    return statement.nameSpan;
  }
  const index = codePointToUtf16(statement.text, position - 1);
  const start = statement.sourceOffsets[index] ?? statement.sourceOffsets.at(-1);
  if (start == null) {
    return statement.nameSpan;
  }
  const word = /^\w+/.exec(statement.text.slice(index))?.[0].length ?? 1;
  return { start, length: word };
};

const codePointToUtf16 = (text: string, codePoints: number) => {
  let index = 0;
  for (let i = 0; i < codePoints && index < text.length; i++) {
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
  }
  return index;
};
