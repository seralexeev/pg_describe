import type { Config } from './config.ts';
import type { Describer, DescribeResult } from './database.ts';
import type { LockEntry } from './lock.ts';
import { type SqlStatement, parseSqlFile, sourceSpan, type Span } from './sql_file.ts';
import { JSON_TYPES, TypeMapper } from './types.ts';

export const DiagnosticCode = {
  Syntax: 1001,
  Describe: 1002,
  Columns: 1003,
  Database: 1004,
} as const;

export type Diagnostic = Span & { code: number; message: string };

export enum SpanKind {
  Verbatim = 0,
}

export enum SpanFeature {
  Hover = 1 << 0,
  Definition = 1 << 3,
  References = 1 << 6,
  DocumentHighlights = 1 << 7,
  Rename = 1 << 8,
}

export type SpanMapping = [
  virtualStart: number,
  virtualLength: number,
  originalStart: number,
  originalLength: number,
  kind: SpanKind,
  features?: number,
];

export type CompiledStatement = {
  statement: SqlStatement;
  entry: LockEntry | undefined;
};

export type CompiledFile = {
  declaration: string;
  mappings: SpanMapping[];
  diagnostics: Diagnostic[];
  statements: CompiledStatement[];
};

const PARAM_FEATURES =
  SpanFeature.Hover | SpanFeature.Definition | SpanFeature.References | SpanFeature.DocumentHighlights;

export const camelCase = (name: string) =>
  name.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export const compileSqlFile = async (
  config: Config,
  describer: Describer,
  source: string,
): Promise<CompiledFile> => {
  const { statements, errors } = parseSqlFile(source);
  const diagnostics: Diagnostic[] = errors.map(({ message, ...span }) => ({
    ...span,
    message,
    code: DiagnosticCode.Syntax,
  }));
  const results = await describer.describe(statements.map((s) => s.text));
  const mapper = new TypeMapper(describer.types, config.types);
  const declaration = new Declaration();
  const compiled: CompiledStatement[] = [];

  statements.forEach((statement, i) => {
    const result = results[i] as DescribeResult;
    const compiledStatement = compileStatement(statement, result, mapper);
    diagnostics.push(...compiledStatement.diagnostics);
    declaration.write(statement, compiledStatement.types);
    compiled.push({ statement, entry: compiledStatement.entry });
  });

  return {
    declaration: declaration.text,
    mappings: declaration.mappings,
    diagnostics,
    statements: compiled,
  };
};

type StatementTypes = {
  params: string[];
  row: string[];
  rows: LockEntry['rows'];
};

const compileStatement = (statement: SqlStatement, result: DescribeResult, mapper: TypeMapper) => {
  if (!result.ok) {
    return {
      diagnostics: [
        {
          ...sourceSpan(statement, result.position),
          code: DiagnosticCode.Describe,
          message: result.message,
        },
      ],
      types: undefined,
      entry: undefined,
    };
  }

  const { params, columns, rows } = result.described;
  const keys = columns.map((c) => camelCase(c.name));
  const duplicate = keys.find((key, i) => keys.indexOf(key) !== i);
  const unnamed = columns.some((c) => c.name === '?column?');
  if (duplicate != null || unnamed) {
    return {
      diagnostics: [
        {
          ...statement.nameSpan,
          code: DiagnosticCode.Columns,
          message:
            duplicate == null
              ? 'Every column needs a name; add an AS alias.'
              : `Column '${duplicate}' appears more than once.`,
        },
      ],
      types: undefined,
      entry: undefined,
    };
  }

  const json = statement.params.filter((_, i) => JSON_TYPES.has(params[i]!.type));
  const entry: LockEntry = {
    rows: columns.length === 0 ? 'none' : rows,
    columns: keys,
    ...(json.length > 0 ? { json } : {}),
  };
  const types: StatementTypes = {
    params: statement.params.map((name, i) => {
      const param = params[i]!;
      return param.nullable
        ? `${name}?: ${mapper.param(param.type)} | null`
        : `${name}: ${mapper.param(param.type)}`;
    }),
    row: columns.map(
      (c, i) =>
        `${keys[i]}: ${mapper.result(c.type, c.elementNullable)}${c.nullable ? ' | null' : ''}`,
    ),
    rows: entry.rows,
  };
  return { diagnostics: [], types, entry };
};

class Declaration {
  public text = "import type { SqlQuery } from 'pg-describe';\n";
  public readonly mappings: SpanMapping[] = [];

  public write(statement: SqlStatement, types: StatementTypes | undefined) {
    this.text += 'export declare const ';
    this.map(statement.name, statement.nameSpan);
    if (types == null) {
      this.text += ': SqlQuery<any, any, "many">;\n';
      return;
    }
    this.text += ': SqlQuery<';
    if (types.params.length === 0) {
      this.text += 'void';
    } else {
      this.text += '{ ';
      types.params.forEach((field, i) => {
        const name = statement.params[i]!;
        this.map(name, statement.paramSpans[i]!, PARAM_FEATURES);
        this.text += `${field.slice(name.length)}; `;
      });
      this.text += '}';
    }
    this.text += `, ${types.row.length === 0 ? 'never' : `{ ${types.row.join('; ')} }`}, "${types.rows}">;\n`;
  }

  private map(text: string, original: Span, features?: number) {
    const mapping: SpanMapping = [this.text.length, text.length, original.start, original.length, SpanKind.Verbatim];
    if (features != null) {
      mapping.push(features);
    }
    this.mappings.push(mapping);
    this.text += text;
  }
}

export const renderRuntimeModule = (statements: Array<{ statement: SqlStatement; entry: LockEntry }>) =>
  [
    "import { sqlQuery } from 'pg-describe';",
    ...statements.map(({ statement, entry }) => {
      const shape = { name: statement.name, params: statement.params, ...entry };
      return `export const ${statement.name} = sqlQuery(${JSON.stringify(statement.text)}, ${JSON.stringify(shape)});`;
    }),
    '',
  ].join('\n');
