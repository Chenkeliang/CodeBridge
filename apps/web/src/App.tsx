import { Workbench } from "@/components/workbench";
import { DesignPreview } from "@/components/design-preview";

export default function App() {
  return new URLSearchParams(window.location.search).get("preview") === "design" ? <DesignPreview /> : <Workbench />;
}
