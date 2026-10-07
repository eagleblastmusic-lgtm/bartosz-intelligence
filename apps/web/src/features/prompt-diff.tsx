import { useMemo } from 'react';
export function PromptDiff({ base, draft }: { base: string; draft: string }) {
  const diff = useMemo(() => {
    const old = base.split('\n'),
      next = draft.split('\n');
    let first = 0,
      oldEnd = old.length,
      nextEnd = next.length;
    while (first < oldEnd && first < nextEnd && old[first] === next[first])
      first++;
    while (
      oldEnd > first &&
      nextEnd > first &&
      old[oldEnd - 1] === next[nextEnd - 1]
    ) {
      oldEnd--;
      nextEnd--;
    }
    return {
      first,
      removed: old.slice(first, oldEnd),
      added: next.slice(first, nextEnd),
    };
  }, [base, draft]);
  return (
    <details>
      <summary>Zmiany linii w nowym drafcie</summary>
      {base === draft ? (
        <p>Brak zmian.</p>
      ) : (
        <>
          <p className="metadata">
            Zmieniony blok od linii {diff.first + 1}. Usunięte:{' '}
            {diff.removed.length}, dodane: {diff.added.length}.
          </p>
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {diff.removed.slice(0, 200).map((line, index) => (
              <div key={'old' + index}>
                <span aria-label="Usunięto">− </span>
                <del>{line || ' '}</del>
              </div>
            ))}
            {diff.added.slice(0, 200).map((line, index) => (
              <div key={'new' + index}>
                <span aria-label="Dodano">+ </span>
                <ins>{line || ' '}</ins>
              </div>
            ))}
          </div>
          {(diff.removed.length > 200 || diff.added.length > 200) && (
            <p>
              Podgląd pokazuje do 200 linii każdej strony. Pełna treść pozostaje
              dostępna w porównaniu wersji.
            </p>
          )}
        </>
      )}
    </details>
  );
}
