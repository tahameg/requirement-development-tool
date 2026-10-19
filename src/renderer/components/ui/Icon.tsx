import React from 'react';
import type { Column, ObjectType } from '../../../shared/types/config.js';

// Square caps and miter joins keep every glyph as sharp as the rest of the UI.
const paths = {
  requirement: 'M4 4h16v16H4z M8 9l2 2 4-4 M8 15h8',
  dictionary: 'M5 3h12l2 2v16H7l-2-2z M5 19h14 M9 7h6 M9 11h6',
  entity: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  action: 'M13 2L5 14h6l-1 8 8-12h-6z',
  component: 'M3 3h18v18H3z M3 9h18',
  subcomponent: 'M3 3h13v13H3z M8 8h13v13H8z',
  requirementSet: 'M6 3h9l4 4v14H6z M15 3v4h4 M9 11h7 M9 15h7 M9 19h4',
  plus: 'M12 4v16 M4 12h16',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M15 15l6 6',
  settings: 'M10 2h4l1 3 3 1.5 3-1.5 2 3.5-2.5 2v3l2.5 2-2 3.5-3-1.5L15 19l-1 3h-4l-1-3-3-1.5-3 1.5-2-3.5 2.5-2v-3L1 8.5 3 5l3 1.5L9 5z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  sliders: 'M4 6h10 M18 6h2 M14 4v4 M4 12h4 M12 12h8 M8 10v4 M4 18h12 M20 18h0 M16 16v4',
  save: 'M4 4h13l3 3v13H4z M8 4v5h8V4 M8 20v-6h8v6',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 20h16',
  upload: 'M12 15V3 M7 8l5-5 5 5 M4 20h16',
  users: 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M1 21v-2a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v2 M16 4a4 4 0 0 1 0 8 M19 14a5 5 0 0 1 4 5v2',
  user: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2',
  history: 'M3 12a9 9 0 1 0 3-6.7 M3 3v5h5 M12 7v5l3 3',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4 M12 15v2',
  unlock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 7.5-2',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  close: 'M5 5l14 14 M19 5L5 19',
  check: 'M4 12l5 5L20 6',
  warning: 'M12 3l10 18H2z M12 10v5 M12 17v2',
  info: 'M3 3h18v18H3z M12 10v7 M12 7v1',
  link: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  server: 'M3 4h18v6H3z M3 14h18v6H3z M7 7h1 M7 17h1',
  plug: 'M9 2v6 M15 2v6 M6 8h12v4a6 6 0 0 1-12 0z M12 18v4',
  logout: 'M10 4H4v16h6 M15 8l4 4-4 4 M8 12h11',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  folderOpen: 'M3 5h6l2 2h10v3 M3 5v14h16l3-9H6l-3 9',
  filePlus: 'M6 3h9l4 4v14H6z M15 3v4h4 M12 11v6 M9 14h6',
  grid: 'M3 3h8v8H3z M13 3h8v8h-8z M3 13h8v8H3z M13 13h8v8h-8z',
  more: 'M5 11h2v2H5z M11 11h2v2h-2z M17 11h2v2h-2z',
  arrowUp: 'M12 20V4 M5 11l7-7 7 7',
  arrowDown: 'M12 4v16 M5 13l7 7 7-7',
  arrowRight: 'M4 12h16 M13 5l7 7-7 7',
  key: 'M8 11a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M11 13l9-9 M16 8l3 3 M14 10l2 2',
  mail: 'M3 5h18v14H3z M3 5l9 8 9-8',
  ban: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M5.6 5.6l12.8 12.8',
  crown: 'M3 7l5 5 4-7 4 7 5-5-2 12H5z',
  shield: 'M12 2l8 3v7c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V5z',
  refresh: 'M20 11a8 8 0 0 0-14-5L3 9 M3 3v6h6 M4 13a8 8 0 0 0 14 5l3-3 M21 21v-6h-6',
  offline: 'M2 2l20 20 M8.5 16.5a5 5 0 0 1 7 0 M5 12.5a10 10 0 0 1 4-2.4 M19 12.5a10 10 0 0 0-3-2 M1.5 9a15 15 0 0 1 4-2.6 M22.5 9a15 15 0 0 0-11-4 M12 20h0',
  keyboard: 'M2 6h20v12H2z M6 10h1 M10 10h1 M14 10h1 M18 10h1 M7 14h10',
  home: 'M3 11l9-8 9 8 M5 9v12h14V9 M10 21v-6h4v6',
  database: 'M12 3c5 0 8 1.3 8 3s-3 3-8 3-8-1.3-8-3 3-3 8-3z M4 6v12c0 1.7 3 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3 3 8 3s8-1.3 8-3',
  hash: 'M9 3L7 21 M17 3l-2 18 M4 8h17 M3 16h17',
  type: 'M4 5h16 M12 5v15 M8 20h8',
  paragraph: 'M4 5h16 M4 10h16 M4 15h16 M4 20h10',
  markdown: 'M2 5h20v14H2z M5 15V9l3 3 3-3v6 M16 9v6 M13.5 12.5L16 15l2.5-2.5',
  list: 'M9 6h12 M9 12h12 M9 18h12 M3 5h2v2H3z M3 11h2v2H3z M3 17h2v2H3z',
  toggle: 'M2 7h20v10H2z M12 7h10v10H12z',
  calendar: 'M3 5h18v16H3z M3 10h18 M8 2v5 M16 2v5',
  grip: 'M8 5h2v2H8z M14 5h2v2h-2z M8 11h2v2H8z M14 11h2v2h-2z M8 17h2v2H8z M14 17h2v2h-2z',
  sparkle: 'M12 2v6 M12 16v6 M2 12h6 M16 12h6 M5 5l3 3 M16 16l3 3 M19 5l-3 3 M8 16l-3 3',
  pause: 'M6 4h4v16H6z M14 4h4v16h-4z',
  undo: 'M9 14L4 9l5-5 M4 9h11a5 5 0 0 1 0 10h-3',
  copy: 'M8 8h12v12H8z M4 16V4h12',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return <svg className={`icon${className ? ` ${className}` : ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="square" strokeLinejoin="miter" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
    {title && <title>{title}</title>}<path d={paths[name]} />
  </svg>;
}
export const objectIcons: Record<ObjectType, IconName> = { REQUIREMENT: 'requirement', DATA_DICTIONARY: 'dictionary', ENTITY: 'entity', ACTION: 'action' };
export const columnIcons: Record<Column['type'], IconName> = {
  string: 'type', text: 'paragraph', markdown: 'markdown', enum: 'list', number: 'hash', boolean: 'toggle', date: 'calendar', reference: 'link',
};
