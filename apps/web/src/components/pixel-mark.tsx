const pixelRows = [
  "10000001",
  "11000011",
  "11111111",
  "00111100",
  "00111100",
  "11111111",
  "11000011",
  "10000001",
] as const;

/** AGNET's pixel bridge: independent agent nodes joined by a shared work surface. */
export function PixelMark({ className = "size-4" }: { className?: string }) {
  return <svg aria-hidden="true" className={className} fill="currentColor" shapeRendering="crispEdges" viewBox="0 0 8 8"><title>AGNET</title>{pixelRows.flatMap((row, y) => [...row].flatMap((cell, x) => cell === "1" ? [<rect height="1" key={`${x}-${y}`} width="1" x={x} y={y} />] : []))}</svg>;
}

export function PixelWordmark({ className = "font-brand text-sm" }: { className?: string }) {
  return <span className={className}>AGNET</span>;
}
