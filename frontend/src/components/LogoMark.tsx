// Nox's mark: a crescent cut out of a disc.
//
// Nox is night. The shape is one circle with another subtracted from it, which
// is why it reads at 20px in a header and still reads as a favicon — the
// silhouette survives when the detail cannot.

export default function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Nox"
      fill="none"
    >
      <defs>
        <mask id="nox-crescent">
          {/* White keeps, black cuts. The offset disc is what makes the
              crescent, rather than drawing two arcs and hoping they meet. */}
          <rect width="32" height="32" fill="black" />
          <circle cx="16" cy="16" r="13" fill="white" />
          <circle cx="22" cy="13" r="11" fill="black" />
        </mask>
        <linearGradient id="nox-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="1" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.65" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="13" fill="url(#nox-fill)" mask="url(#nox-crescent)" />
      {/* One star, off the crescent's open side. Two would be a pattern; none
          would be a moon and not a mark. */}
      <circle cx="24" cy="24" r="2" fill="currentColor" opacity="0.9" />
    </svg>
  );
}
