import { useSettings, useTab, useTabLive } from "../../state/browser/hooks";
import { useTheme } from "../ui/theme";
import { toolbarPalette, type ToolbarPalette } from "../ui/toolbarColors";
import { previewedToolbarTab, usePeekToolbarPreview } from "../../state/peek/toolbarPreview";

export function useSitePalette(shownTabId: string): ToolbarPalette {
  const theme = useTheme();
  const tabId = usePeekToolbarPreview((p) => previewedToolbarTab(p, shownTabId));
  const hasUrl = useTab(tabId, (t) => !!t?.url);
  const themeColor = useTabLive(tabId, (l) => l.themeColor);
  const extendColor = useSettings((s) => s.extendWebsiteColor);
  return toolbarPalette(theme, extendColor && hasUrl ? themeColor : null);
}
