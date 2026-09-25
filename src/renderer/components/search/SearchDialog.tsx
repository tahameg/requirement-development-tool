import React, { useEffect, useRef, useState } from 'react';
import type { SearchHit } from '../../../shared/authoring.js';
import { objectLabels } from '../../../shared/hierarchy.js';
export function SearchDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (hit: SearchHit) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let cancelled = false;
    if (!query.trim()) { setHits([]); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => { void window.hlr.search(query).then(result => { if (cancelled) return; setLoading(false); if (result.ok) { setHits(result.value); setError(''); } else { setHits([]); setError(result.error); } }).catch(e => { if (!cancelled) { setError(String(e)); setLoading(false); } }); }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
  return <dialog className="hierarchy-dialog search-dialog" ref={dialog} aria-labelledby="search-title" onCancel={onClose}><div className="section-heading"><h2 id="search-title">Search workspace</h2><button onClick={onClose}>Close</button></div><input type="search" aria-label="Search all items" autoFocus placeholder="Search IDs, function names or item content…" maxLength={500} value={query} onChange={e => setQuery(e.target.value)} />{error && <p role="alert" className="error">{error}</p>}<p className="hint" role="status">{loading ? 'Searching…' : query.trim() ? `${hits.length} results${hits.length === 100 ? ' (first 100)' : ''}` : 'Enter a word or ID to search all object types.'}</p><div className="search-results">{hits.map(hit => <button key={hit.id} onClick={() => onOpen(hit)}><code>{hit.id}</code><strong>{hit.functionName} <small>{objectLabels[hit.objectType]}</small></strong><p>{hit.description}</p></button>)}</div></dialog>;
}
