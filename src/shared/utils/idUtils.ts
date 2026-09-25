import type { ProjectConfig, ObjectType } from '../types/config.js';
export function formatId(config: ProjectConfig, type: ObjectType, modulePrefixes: string[], functionPrefix: string, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid sequence');
  const object = config.objectTypes[type];
  const tokens = [object.usePrefix ? object.prefix : '', config.projectPrefix, ...modulePrefixes, functionPrefix];
  const id = [...tokens.filter(Boolean), String(sequence).padStart(3, '0')].join('-');
  if (config.idCasing === 'UPPER') return id.toUpperCase();
  if (config.idCasing === 'LOWER') return id.toLowerCase();
  return id;
}
