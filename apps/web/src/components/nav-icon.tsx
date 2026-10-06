export function NavIcon({ kind }: { kind: string }) {
  const path =
    kind === 'daily'
      ? 'M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5'
      : kind === 'channels'
        ? 'M4 7h16v12H4z M8 3h8 M8 11h8 M8 15h5'
        : 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z';
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
