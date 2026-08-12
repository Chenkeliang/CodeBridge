/** AGNET's pixel portal: a doorway of light — the gateway between channels and agents.
 *  The light wedge is an evenodd cutout, so the accent surface behind shows through. */
export function PixelMark({ className = "size-4" }: { className?: string }) {
  return <svg aria-hidden="true" className={className} fill="currentColor" shapeRendering="crispEdges" viewBox="0 0 8 8"><title>AGNET</title><path d="M1 1h6v6H1zM4 2h1v1H4zM4 3h2v1H4zM4 4h2v1H4zM4 5h1v1H4z" fillRule="evenodd" /></svg>;
}

export function PixelWordmark({ className = "font-brand text-sm" }: { className?: string }) {
  return <span className={className}>AGNET</span>;
}
