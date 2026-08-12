/** AGNET's pixel bridge: independent agent nodes joined by a shared work surface. */
export function PixelMark({ className = "size-4" }: { className?: string }) {
  return <svg aria-hidden="true" className={className} fill="currentColor" shapeRendering="crispEdges" viewBox="0 0 8 8"><title>AGNET</title><path d="M0 0h1v1h1v1h4V1h1V0h1v8H7V7H6V6H2v1H1v1H0zm2 3v2h4V3z" /></svg>;
}

export function PixelWordmark({ className = "font-brand text-sm" }: { className?: string }) {
  return <span className={className}>AGNET</span>;
}
