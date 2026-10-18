import React, { useEffect, useState } from 'react';
import type { SearchHit } from '../../../shared/authoring.js';
import { objectLabels } from '../../../shared/hierarchy.js';
import { Modal } from '../ui/Modal.js';
import { Alert, Code } from '../ui/primitives.js';
import { Icon, objectIcons } from '../ui/Icon.js';
export function SearchDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (hit: SearchHit) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!query.trim()) { setHits([]); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => { void window.hlr.search(query).then(result => { if (cancelled) return; setLoading(false); if (result.ok) { setHits(result.value); setError(''); } else { setHits([]); setError(result.error); } }).catch(e => { if (!cancelled) { setError(String(e)); setLoading(false); } }); }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);
  return <Modal title="Search workspace" icon="search" onClose={onClose} labelledBy="search-title" width="lg" className="search-dialog">
    <label className="search-box"><Icon name="search" size={20} /><input type="search" aria-label="Search all items" autoFocus placeholder="IDs, requirement set names, item text…" maxLength={500} value={query} onChange={e => setQuery(e.target.value)} /></label>
    {error && <Alert>{error}</Alert>}
    <p className="hint" role="status">{loading ? 'Searching…' : query.trim() ? `${hits.length} results${hits.length === 100 ? ' (first 100)' : ''}` : 'Type a word or an ID. Search covers all four object types.'}</p>
    <div className="search-results">{hits.map(hit => <button key={hit.id} className={`search-hit type-${hit.objectType}`} onClick={() => onOpen(hit)}>
      <Icon name={objectIcons[hit.objectType]} size={18} /><span className="hit-main"><Code>{hit.id}</Code><strong>{hit.requirementSetName}</strong><p>{hit.description}</p></span><small>{objectLabels[hit.objectType]}</small><Icon name="arrowRight" />
    </button>)}</div>
  </Modal>;
}
