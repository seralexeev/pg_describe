import pg from 'pg';

import type { PgType } from './database.ts';

const RESULT_TYPES: Record<number, string> = {
  16: 'boolean',
  17: 'Buffer',
  20: 'string',
  21: 'number',
  23: 'number',
  26: 'number',
  114: 'unknown',
  700: 'number',
  701: 'number',
  1082: 'Date',
  1114: 'Date',
  1184: 'Date',
  1700: 'string',
  2950: 'string',
  3802: 'unknown',
};

const PARAM_TYPES: Record<number, string> = {
  ...RESULT_TYPES,
  20: 'number | bigint | string',
  1082: 'Date | string',
  1114: 'Date | string',
  1184: 'Date | string',
  1700: 'number | string',
};

export const JSON_TYPES = new Set([114, 3802]);

const textLiteral = pg.types.getTypeParser(25);

const hasTypeParser = (oid: number) => pg.types.getTypeParser(oid) !== textLiteral;

const union = (type: string) => (type.includes('|') ? `(${type})` : type);

export class TypeMapper {
  private readonly types;
  private readonly overrides;

  public constructor(types: Map<number, PgType>, overrides: Record<string, string>) {
    this.types = types;
    this.overrides = overrides;
  }

  public result(oid: number, elementNullable = false): string {
    const type = this.type(oid);
    const override = this.overrides[type.name];
    if (override != null) {
      return override;
    }
    if (type.array && hasTypeParser(oid)) {
      const element = this.result(type.elem);
      return elementNullable ? `(${element} | null)[]` : `${union(element)}[]`;
    }
    return RESULT_TYPES[oid] ?? this.enumType(type) ?? (hasTypeParser(oid) ? 'unknown' : 'string');
  }

  public param(oid: number): string {
    const type = this.type(oid);
    const override = this.overrides[type.name];
    if (override != null) {
      return override;
    }
    if (type.array) {
      return `readonly ${union(this.param(type.elem))}[]`;
    }
    return PARAM_TYPES[oid] ?? this.enumType(type) ?? 'string';
  }

  private type(oid: number) {
    const type = this.types.get(oid);
    if (type == null) {
      throw new Error(`Unknown Postgres type oid ${oid}`);
    }
    return type;
  }

  private enumType(type: PgType) {
    return type.labels?.map((label) => JSON.stringify(label)).join(' | ');
  }
}
