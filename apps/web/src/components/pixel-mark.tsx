/** AGNET's pixel bridge: a tied arch over a shared deck, with water reflections below. */
export function PixelMark({ className = "size-4" }: { className?: string }) {
  return <svg aria-hidden="true" className={className} fill="currentColor" shapeRendering="crispEdges" viewBox="0 0 8 8"><title>AGNET</title><path d="M3 1h2v1H3zM2 2h1v1H2zM5 2h1v1H5zM1 3h1v2H1zM6 3h1v2H6zM0 5h8v1H0zM2 7h1v1H2zM4 7h1v1H4zM6 7h1v1H6z" /></svg>;
}

export function PixelWordmark({ className = "font-brand text-sm" }: { className?: string }) {
  return <span className={className}>AGNET</span>;
}
